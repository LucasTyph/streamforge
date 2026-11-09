import { AlertTriangle, Film } from "lucide-react";
import Link from "next/link";
import { Progress } from "@/components/ui/progress";
import { fmtDuration, type Video } from "@/lib/api";
import type { ProgressMap } from "@/lib/live";
import { currentStep, overallPercent } from "@/lib/pipeline";
import { StatusBadge } from "./status-badge";

export function VideoCard({ video: v, live }: { video: Video; live: ProgressMap }) {
  const processing = v.status === "UPLOADED" || v.status === "PROCESSING";
  return (
    <Link
      href={`/videos/${v.id}`}
      data-testid="video-card"
      data-video-id={v.id}
      className="group overflow-hidden rounded-xl border bg-card transition hover:border-primary/50 hover:shadow-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <div className="relative aspect-video bg-muted">
        {v.posterUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- served by the media bucket/CDN
          <img src={v.posterUrl} alt="" loading="lazy" className="size-full object-cover transition group-hover:scale-[1.02]" />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            {v.status === "FAILED" ? <AlertTriangle className="size-8 text-red-400" /> : <Film className="size-8 animate-pulse" />}
          </div>
        )}
        {v.durationSeconds != null && (
          <span className="absolute right-2 bottom-2 rounded bg-black/75 px-1.5 py-0.5 text-xs font-medium text-white tabular-nums">
            {fmtDuration(v.durationSeconds)}
          </span>
        )}
      </div>
      <div className="space-y-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="line-clamp-1 font-medium" title={v.title}>
            {v.title}
          </h3>
          <StatusBadge status={v.status} className="shrink-0" />
        </div>
        {processing ? (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">{currentStep(v, live)}…</p>
            <Progress value={overallPercent(v, live)} />
          </div>
        ) : v.status === "FAILED" ? (
          <p className="line-clamp-2 text-xs text-red-500 dark:text-red-400">{v.failureReason ?? "Processing failed"}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {v.width && v.height ? `${v.width}×${v.height}` : "–"} · {new Date(v.createdAt).toLocaleDateString()}
          </p>
        )}
      </div>
    </Link>
  );
}

export function VideoCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="aspect-video animate-pulse bg-muted" />
      <div className="space-y-2 p-3">
        <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
        <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}
