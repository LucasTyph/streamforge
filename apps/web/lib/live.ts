"use client";

// Live pipeline updates over Server-Sent Events from progress-svc.
import { useEffect, useRef, useState } from "react";
import { PROGRESS_URL, type JobTask } from "./api";

export interface TaskProgress {
  stage: string;
  percent: number;
}
/** videoId -> task -> latest progress */
export type ProgressMap = Record<string, Partial<Record<JobTask, TaskProgress>>>;

type LiveEvent =
  | { kind: "progress"; videoId: string; task: JobTask; stage: string; percent: number }
  | { kind: "video"; videoId: string; status: string };

/**
 * Subscribes to the signed-in user's live stream. `onVideoChanged` fires when a video's
 * status changes (the caller refetches it). EventSource reconnects on its own.
 */
export function useLive(enabled: boolean, onVideoChanged: (videoId: string) => void) {
  const [progress, setProgress] = useState<ProgressMap>({});
  const [connected, setConnected] = useState(false);
  const cb = useRef(onVideoChanged);
  cb.current = onVideoChanged;

  useEffect(() => {
    if (!enabled) return;
    const es = new EventSource(`${PROGRESS_URL}/events`, { withCredentials: true });
    es.addEventListener("hello", () => setConnected(true));
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      let e: LiveEvent;
      try {
        e = JSON.parse(m.data);
      } catch {
        return;
      }
      if (e.kind === "progress") {
        setProgress((p) => ({
          ...p,
          [e.videoId]: { ...p[e.videoId], [e.task]: { stage: e.stage, percent: e.percent } },
        }));
      } else if (e.kind === "video") {
        cb.current(e.videoId);
      }
    };
    return () => es.close();
  }, [enabled]);

  return { progress, connected };
}
