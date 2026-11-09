import { Badge } from "@/components/ui/badge";
import type { VideoStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

const styles: Record<VideoStatus, string> = {
  UPLOADING: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
  UPLOADED: "bg-sky-500/15 text-sky-600 dark:text-sky-300",
  PROCESSING: "bg-violet-500/15 text-violet-600 dark:text-violet-300",
  READY: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
  FAILED: "bg-red-500/15 text-red-600 dark:text-red-300",
};

const labels: Record<VideoStatus, string> = {
  UPLOADING: "Uploading",
  UPLOADED: "Queued",
  PROCESSING: "Processing",
  READY: "Ready",
  FAILED: "Failed",
};

export function StatusBadge({ status, className }: { status: VideoStatus; className?: string }) {
  return (
    <Badge variant="secondary" className={cn("border-0 font-medium", styles[status], className)} data-status={status}>
      {labels[status]}
    </Badge>
  );
}
