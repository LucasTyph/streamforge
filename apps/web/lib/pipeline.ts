import type { JobTask, Video } from "./api";
import type { ProgressMap } from "./live";

export type StageState = "pending" | "running" | "done" | "failed";

export interface Stage {
  key: "uploaded" | JobTask | "ready";
  label: string;
  state: StageState;
  percent: number;
  detail?: string;
}

/** Mirrors the worker's ladder (go/internal/media.PlanRenditions) for display only. */
export function renditionLabels(width: number | null, height: number | null) {
  if (!width || !height) return ["360p", "720p"];
  const short = Math.min(width, height);
  const rungs = [360, 720].filter((h) => h <= short);
  return (rungs.length ? rungs : [short - (short % 2)]).map((h) => `${h}p`);
}

function taskStage(v: Video, live: ProgressMap, task: JobTask): Pick<Stage, "state" | "percent" | "detail"> {
  const job = v.jobs?.find((j) => j.task === task);
  const p = live[v.id]?.[task];
  if (job?.state === "SUCCEEDED") return { state: "done", percent: 100 };
  if (job?.state === "FAILED") return { state: "failed", percent: p?.percent ?? 0, detail: job.error ?? undefined };
  if (job?.state === "RUNNING" || (p && p.percent < 100)) {
    const detail = job && job.attempts > 1 ? `attempt ${job.attempts}` : undefined;
    return { state: "running", percent: Math.round(p?.percent ?? 0), detail };
  }
  return { state: "pending", percent: 0 };
}

export function stagesFor(v: Video, live: ProgressMap): Stage[] {
  const uploaded: Stage = {
    key: "uploaded",
    label: "Uploaded",
    state: v.status === "UPLOADING" ? "running" : v.status === "FAILED" && !v.jobs?.length ? "failed" : "done",
    percent: v.status === "UPLOADING" ? 0 : 100,
  };
  const stages: Stage[] = [
    uploaded,
    { key: "probe", label: "Probing", ...taskStage(v, live, "probe") },
    { key: "transcode", label: `Transcoding (${renditionLabels(v.width, v.height).join(", ")})`, ...taskStage(v, live, "transcode") },
    { key: "thumbnail", label: "Thumbnails", ...taskStage(v, live, "thumbnail") },
    { key: "ready", label: "Ready", state: v.status === "READY" ? "done" : "pending", percent: v.status === "READY" ? 100 : 0 },
  ];
  return stages;
}

const WEIGHTS: Record<JobTask, number> = { probe: 0.1, transcode: 0.7, thumbnail: 0.2 };

/** Weighted overall progress for compact displays (library cards). */
export function overallPercent(v: Video, live: ProgressMap) {
  if (v.status === "READY") return 100;
  return Math.round(
    (Object.keys(WEIGHTS) as JobTask[]).reduce((sum, t) => sum + WEIGHTS[t] * taskStage(v, live, t).percent, 0),
  );
}

/** Human label for the step currently running. */
export function currentStep(v: Video, live: ProgressMap) {
  const running = stagesFor(v, live).find((s) => s.state === "running");
  return running?.label ?? (v.status === "UPLOADED" ? "Queued" : v.status.toLowerCase());
}
