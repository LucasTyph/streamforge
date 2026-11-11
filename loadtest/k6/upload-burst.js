// Upload burst: VUS users each upload one clip through the real presigned multipart flow
// at the same moment (create -> presign -> PUT parts -> complete). Measures the upload
// path only; processing time is covered by the batch benchmark.
// Run: make load-upload  (VUS=10, FILE=media/demo/demo-01.mp4)
import { check, fail } from "k6";
import { Trend } from "k6/metrics";
import { api, login, req } from "./lib.js";

const file = open(__ENV.FILE || "../../media/demo/demo-01.mp4", "b");
const VUS = Number(__ENV.VUS || 10);
const uploadTime = new Trend("upload_total_ms", true);

export const options = {
  scenarios: { burst: { executor: "per-vu-iterations", vus: VUS, iterations: 1, maxDuration: "5m" } },
  thresholds: { checks: ["rate==1"], http_req_failed: ["rate==0"] },
  summaryTrendStats: ["avg", "med", "p(95)", "max"],
};

export function setup() {
  return { cookie: login() };
}

export default function ({ cookie }) {
  const t0 = Date.now();
  const size = file.byteLength;
  const created = api("POST", "/videos", cookie, { filename: `k6-${__VU}.mp4`, contentType: "video/mp4", sizeBytes: size }, { step: "create" });
  if (created.status !== 201) fail(`create: ${created.status} ${created.body}`);
  const { video, upload } = created.json();
  const partNumbers = Array.from({ length: upload.partCount }, (_, i) => i + 1);
  const urls = api("POST", `/videos/${video.id}/upload/parts`, cookie, { partNumbers }, { step: "presign" }).json("urls");

  const parts = urls.map(({ partNumber, url }) => {
    const start = (partNumber - 1) * upload.partSize;
    const res = req("PUT", url, file.slice(start, Math.min(start + upload.partSize, size)), { tags: { step: "put_part" }, timeout: "120s" });
    check(res, { "part stored": (r) => r.status === 200 && !!r.headers.Etag });
    return { partNumber, etag: res.headers.Etag };
  });

  const done = api("POST", `/videos/${video.id}/upload/complete`, cookie, { parts }, { step: "complete" });
  check(done, { "upload complete": (r) => r.status === 200 && r.json("status") !== "UPLOADING" });
  uploadTime.add(Date.now() - t0);
}
