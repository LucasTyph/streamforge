export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
export const PROGRESS_URL = process.env.NEXT_PUBLIC_PROGRESS_URL ?? "http://localhost:4001";

export type VideoStatus = "UPLOADING" | "UPLOADED" | "PROCESSING" | "READY" | "FAILED";
export type JobTask = "probe" | "transcode" | "thumbnail";

export interface Job {
  task: JobTask;
  state: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
  attempts: number;
  error: string | null;
}

export interface Video {
  id: string;
  title: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  status: VideoStatus;
  failureReason: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  playbackUrl: string | null;
  posterUrl: string | null;
  thumbnailsVttUrl: string | null;
  jobs?: Job[];
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  email: string;
  isAdmin: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    credentials: "include",
    headers: init.body ? { "Content-Type": "application/json" } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export const fmtBytes = (n: number) =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

export const fmtDuration = (s: number | null) => {
  if (s == null || !Number.isFinite(s)) return "–";
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};
