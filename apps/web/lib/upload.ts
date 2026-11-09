// Chunked, parallel, resumable-per-part upload to presigned S3 URLs.
import { api, type Video } from "./api";

export interface PartProgress {
  partNumber: number;
  loaded: number;
  total: number;
  state: "pending" | "uploading" | "done" | "retrying";
}

export interface UploadCallbacks {
  onStart?(video: Video, parts: PartProgress[]): void;
  onProgress?(parts: PartProgress[]): void;
}

/** PUTs one chunk; resolves with the part's ETag. Swappable for tests. */
export type PutPart = (
  url: string,
  body: Blob,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
) => Promise<string>;

export const xhrPut: PutPart = (url, body, onProgress, signal) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.timeout = 120_000;
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      const etag = xhr.getResponseHeader("ETag");
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
      else reject(new Error(`Part upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.ontimeout = () => reject(new Error("Part upload timed out"));
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });

/** Runs `fn` over items with at most `limit` in flight. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function withRetry<T>(fn: () => Promise<T>, attempts: number, onRetry: () => void, signal: AbortSignal) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || signal.aborted) throw err;
      onRetry();
      await new Promise((r) => setTimeout(r, 500 * 2 ** (i - 1)));
    }
  }
}

interface CreateResponse {
  video: Video;
  upload: { uploadId: string; partSize: number; partCount: number };
}

export async function uploadVideo(
  file: File,
  cb: UploadCallbacks,
  signal: AbortSignal,
  opts: { concurrency?: number; putPart?: PutPart } = {},
): Promise<Video> {
  const put = opts.putPart ?? xhrPut;
  const { video, upload } = await api<CreateResponse>("/videos", {
    body: { filename: file.name, contentType: file.type || "application/octet-stream", sizeBytes: file.size },
  });
  const parts: PartProgress[] = Array.from({ length: upload.partCount }, (_, i) => ({
    partNumber: i + 1,
    loaded: 0,
    total: Math.min(upload.partSize, file.size - i * upload.partSize),
    state: "pending",
  }));
  cb.onStart?.(video, parts);
  const emit = () => cb.onProgress?.(parts.map((p) => ({ ...p })));

  try {
    const urls = new Map<number, string>();
    for (let i = 0; i < parts.length; i += 100) {
      const batch = parts.slice(i, i + 100).map((p) => p.partNumber);
      const res = await api<{ urls: { partNumber: number; url: string }[] }>(`/videos/${video.id}/upload/parts`, {
        body: { partNumbers: batch },
      });
      for (const u of res.urls) urls.set(u.partNumber, u.url);
    }

    const completed = await pool(parts, opts.concurrency ?? 4, async (p) => {
      const start = (p.partNumber - 1) * upload.partSize;
      const blob = file.slice(start, start + p.total);
      const etag = await withRetry(
        () => {
          p.state = "uploading";
          p.loaded = 0;
          emit();
          return put(urls.get(p.partNumber)!, blob, (loaded) => ((p.loaded = loaded), emit()), signal);
        },
        3,
        () => ((p.state = "retrying"), emit()),
        signal,
      );
      p.state = "done";
      p.loaded = p.total;
      emit();
      return { partNumber: p.partNumber, etag };
    });

    return await api<Video>(`/videos/${video.id}/upload/complete`, { body: { parts: completed } });
  } catch (err) {
    await api(`/videos/${video.id}/upload/abort`, { method: "POST" }).catch(() => {});
    throw err;
  }
}
