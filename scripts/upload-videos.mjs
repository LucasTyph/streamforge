#!/usr/bin/env node
// Uploads video files through the public API exactly like the browser does (presigned
// multipart), then waits for each to reach READY or FAILED and checks HLS playback.
// Usage: node scripts/upload-videos.mjs [--expect READY|FAILED] file...
// Env: API_URL (default http://localhost:4000), SEED_USER_EMAIL / SEED_USER_PASSWORD.
import { open, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

const API = process.env.API_URL ?? "http://localhost:4000";
const args = process.argv.slice(2);
let expect;
if (args[0] === "--expect") [, expect] = args.splice(0, 2);
if (!args.length) {
  console.error("usage: upload-videos.mjs [--expect READY|FAILED] file...");
  process.exit(2);
}

let cookie = "";
async function api(path, body) {
  const res = await fetch(API + path, {
    method: body ? "POST" : "GET",
    headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
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
    const parts = await Promise.all(
      urls.map(async ({ partNumber, url }) => {
        const start = (partNumber - 1) * upload.partSize;
        const len = Math.min(upload.partSize, size - start);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, start);
        const res = await fetch(url, { method: "PUT", body: buf });
        if (!res.ok) throw new Error(`part ${partNumber}: ${res.status}`);
        return { partNumber, etag: res.headers.get("etag") };
      }),
    );
    await api(`/videos/${video.id}/upload/complete`, { parts });
  } finally {
    await fh.close();
  }
  return { id: video.id, file, uploadedAt: Date.now() };
}

async function waitFor({ id, file, uploadedAt }) {
  for (;;) {
    const v = await api(`/videos/${id}`);
    if (v.status === "READY" || v.status === "FAILED") {
      const secs = ((Date.now() - uploadedAt) / 1000).toFixed(1);
      let detail = v.status === "FAILED" ? `reason="${v.failureReason}"` : "";
      if (v.status === "READY") {
        const master = await fetch(v.playbackUrl).then((r) => r.text());
        const variants = master.split("\n").filter((l) => l.endsWith(".m3u8"));
        const first = await fetch(new URL(variants[0], v.playbackUrl)).then((r) => r.text());
        const segs = first.split("\n").filter((l) => l.endsWith(".ts")).length;
        detail = `${v.width}x${v.height} ${v.durationSeconds?.toFixed(1)}s variants=[${variants.join(", ")}] segments(${variants[0]})=${segs}`;
      }
      const jobs = v.jobs.map((j) => `${j.task}:${j.state}/${j.attempts}`).join(" ");
      return { file: basename(file), id, status: v.status, secs, detail, jobs };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const uploads = await Promise.all(args.map(uploadOne));
const results = await Promise.all(uploads.map(waitFor));
let ok = true;
for (const r of results) {
  const bad = expect && r.status !== expect;
  ok &&= !bad;
  console.log(`${bad ? "FAIL" : "ok  "} ${r.file.padEnd(32)} ${r.status.padEnd(6)} ${r.secs.padStart(5)}s  ${r.detail}  [${r.jobs}]`);
}
process.exit(ok ? 0 : 1);
