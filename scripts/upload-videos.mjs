#!/usr/bin/env node
// Uploads video files through the public API exactly like the browser does (presigned
// multipart), then waits for each to reach READY or FAILED and checks HLS playback.
// Usage: node scripts/upload-videos.mjs [--expect READY|FAILED] [--verify] [--json out.json] file...
//   --verify  check every HLS variant of READY videos: ENDLIST present, every segment
//             fetchable, segment durations add up to the video duration (no gaps/duplicates)
//   --json    write timings and results for benchmarks
// Env: API_URL (default http://localhost:4000), SEED_USER_EMAIL / SEED_USER_PASSWORD.
import { open, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { basename, extname } from "node:path";

// fetch() that also reaches *.localhost hosts (the k3d ingress): browsers resolve them to
// loopback, but glibc in WSL does not. Connect to 127.0.0.1 and keep the real Host header,
// which presigned S3 URLs need (the signature covers the host).
function xfetch(url, init = {}) {
  const u = new URL(url);
  if (!u.hostname.endsWith(".localhost")) return fetch(url, { signal: AbortSignal.timeout(60_000), ...init });
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: u.port || 80, path: u.pathname + u.search, method: init.method ?? "GET",
        headers: { ...init.headers, host: u.host }, timeout: 60_000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString();
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: { get: (h) => [].concat(res.headers[h.toLowerCase()] ?? [])[0] ?? null },
            text: async () => body,
            json: async () => JSON.parse(body),
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timeout: ${url}`)));
    req.on("error", reject);
    req.end(init.body);
  });
}

const API = process.env.API_URL ?? "http://localhost:4000";
// Like the browser: 4 parts in flight per file; FILES uploads in parallel (default 5).
const FILES = Number(process.env.UPLOAD_CONCURRENCY ?? 5);
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}
const args = process.argv.slice(2);
let expect, jsonOut, verify = false;
for (;;) {
  if (args[0] === "--expect") [, expect] = args.splice(0, 2);
  else if (args[0] === "--json") [, jsonOut] = args.splice(0, 2);
  else if (args[0] === "--verify") verify = args.splice(0, 1).length > 0;
  else break;
}
if (!args.length) {
  console.error("usage: upload-videos.mjs [--expect READY|FAILED] [--verify] [--json out.json] file...");
  process.exit(2);
}

/** Returns a list of integrity problems for a READY video's HLS output (empty = intact). */
async function verifyHls(v, variants) {
  const problems = [];
  for (const variant of variants) {
    const url = new URL(variant, v.playbackUrl).toString();
    const text = await xfetch(url).then((r) => r.text());
    if (!text.includes("#EXT-X-ENDLIST")) problems.push(`${variant}: no ENDLIST`);
    const segs = text.split("\n").filter((l) => l.endsWith(".ts"));
    if (new Set(segs).size !== segs.length) problems.push(`${variant}: duplicate segments`);
    const total = [...text.matchAll(/#EXTINF:([\d.]+)/g)].reduce((a, m) => a + Number(m[1]), 0);
    if (Math.abs(total - v.durationSeconds) > 0.5) problems.push(`${variant}: ${total.toFixed(1)}s of segments for a ${v.durationSeconds.toFixed(1)}s video`);
    const heads = await pool(segs, 8, (seg) => xfetch(new URL(seg, url).toString(), { method: "HEAD" }).then((r) => r.status));
    const missing = heads.filter((c) => c !== 200).length;
    if (missing) problems.push(`${variant}: ${missing} of ${segs.length} segments missing`);
  }
  return problems;
}

let cookie = "";
async function api(path, body) {
  const res = await xfetch(API + path, {
    method: body ? "POST" : "GET",
    headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${data?.error}`);
  return data;
}

await api("/auth/login", {
  email: process.env.SEED_USER_EMAIL ?? "demo@streamforge.local",
  password: process.env.SEED_USER_PASSWORD ?? "demo-password",
});

async function uploadOne(file) {
  const { size } = await stat(file);
  const contentType = extname(file).toLowerCase() === ".mov" ? "video/quicktime" : "video/mp4";
  const { video, upload } = await api("/videos", { filename: basename(file), contentType, sizeBytes: size });
  const partNumbers = Array.from({ length: upload.partCount }, (_, i) => i + 1);
  const { urls } = await api(`/videos/${video.id}/upload/parts`, { partNumbers });
  const fh = await open(file);
  try {
    const parts = await pool(urls, 4, async ({ partNumber, url }) => {
        const start = (partNumber - 1) * upload.partSize;
        const len = Math.min(upload.partSize, size - start);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, start);
        const res = await xfetch(url, { method: "PUT", body: buf, headers: { "content-length": String(buf.length) } });
        if (!res.ok) throw new Error(`part ${partNumber}: ${res.status}`);
        return { partNumber, etag: res.headers.get("etag") };
    });
    await api(`/videos/${video.id}/upload/complete`, { parts });
  } finally {
    await fh.close();
  }
  return { id: video.id, file, uploadedAt: Date.now() };
}

async function waitFor({ id, file, uploadedAt }) {
  for (;;) {
    // tolerate transient errors (pods restarting during chaos runs)
    const v = await api(`/videos/${id}`).catch(() => null);
    if (v && (v.status === "READY" || v.status === "FAILED")) {
      const secs = (Date.now() - uploadedAt) / 1000;
      let detail = v.status === "FAILED" ? `reason="${v.failureReason}"` : "";
      let problems = [];
      if (v.status === "READY") {
        const master = await xfetch(v.playbackUrl).then((r) => r.text());
        const variants = master.split("\n").filter((l) => l.endsWith(".m3u8"));
        const first = await xfetch(new URL(variants[0], v.playbackUrl).toString()).then((r) => r.text());
        const segs = first.split("\n").filter((l) => l.endsWith(".ts")).length;
        detail = `${v.width}x${v.height} ${v.durationSeconds?.toFixed(1)}s variants=[${variants.join(", ")}] segments(${variants[0]})=${segs}`;
        if (verify) {
          problems = await verifyHls(v, variants);
          if (!v.posterUrl || !v.thumbnailsVttUrl) problems.push("thumbnails missing");
          detail += problems.length ? `  INTEGRITY: ${problems.join("; ")}` : "  intact";
        }
      }
      const attempts = Object.fromEntries(v.jobs.map((j) => [j.task, j.attempts]));
      const jobs = v.jobs.map((j) => `${j.task}:${j.state}/${j.attempts}`).join(" ");
      return { file: basename(file), id, status: v.status, secs, detail, jobs, attempts, problems };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Start watching each video as soon as its own upload completes, so time-to-ready is
// measured per video (upload complete -> READY), not from the end of the whole batch.
const startedAt = Date.now();
const results = await Promise.all(await pool(args, FILES, async (f) => waitFor(await uploadOne(f)).catch((e) => { throw e; })).catch((e) => { console.error(e); process.exit(1); }));
const totalSeconds = (Date.now() - startedAt) / 1000;
let ok = true;
for (const r of results) {
  const bad = (expect && r.status !== expect) || r.problems.length > 0;
  ok &&= !bad;
  console.log(`${bad ? "FAIL" : "ok  "} ${r.file.padEnd(32)} ${r.status.padEnd(6)} ${r.secs.toFixed(1).padStart(5)}s  ${r.detail}  [${r.jobs}]`);
}
const sorted = results.map((r) => r.secs).sort((a, b) => a - b);
const pct = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
const summary = {
  videos: results.length,
  ready: results.filter((r) => r.status === "READY").length,
  totalSeconds: Number(totalSeconds.toFixed(1)),
  videosPerMinute: Number(((results.length / totalSeconds) * 60).toFixed(2)),
  timeToReadyP50: Number(pct(0.5).toFixed(1)),
  timeToReadyP95: Number(pct(0.95).toFixed(1)),
  extraAttempts: results.reduce((a, r) => a + Object.values(r.attempts).reduce((x, n) => x + Math.max(0, n - 1), 0), 0),
  integrityProblems: results.reduce((a, r) => a + r.problems.length, 0),
};
if (results.length > 1) console.log("summary " + JSON.stringify(summary));
if (jsonOut) await writeFile(jsonOut, JSON.stringify({ summary, results }, null, 1));
process.exit(ok ? 0 : 1);
