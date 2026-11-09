export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type VideoStatus = "UPLOADING" | "UPLOADED" | "PROCESSING" | "READY" | "FAILED";

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
  createdAt: string;
}

export interface User {
  id: string;
  email: string;
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
