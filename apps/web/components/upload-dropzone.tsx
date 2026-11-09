"use client";

import { UploadCloud, X } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Progress } from "@/components/ui/progress";
import { fmtBytes } from "@/lib/api";
import { type PartProgress, uploadVideo } from "@/lib/upload";
import { cn } from "@/lib/utils";

interface ActiveUpload {
  key: string;
  name: string;
  parts: PartProgress[];
  error?: string;
  done?: boolean;
  controller: AbortController;
}

const MAX_BYTES = 200 * 1024 * 1024;

/** Drag-and-drop upload with per-chunk progress. Calls onChange when the library should refresh. */
export function UploadDropzone({ onChange }: { onChange: () => void }) {
  const [uploads, setUploads] = useState<ActiveUpload[]>([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const patch = (key: string, p: Partial<ActiveUpload>) =>
    setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...p } : u)));

  function start(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      if (file.size > MAX_BYTES) {
        toast.error(`${file.name} is larger than 200 MB`);
        continue;
      }
      const key = `${file.name}-${Date.now()}-${Math.random()}`;
      const controller = new AbortController();
      setUploads((list) => [{ key, name: file.name, parts: [], controller }, ...list]);
      uploadVideo(
        file,
        { onStart: (_v, parts) => (patch(key, { parts }), onChange()), onProgress: (parts) => patch(key, { parts }) },
        controller.signal,
      )
        .then(() => {
          patch(key, { done: true });
          setTimeout(() => setUploads((l) => l.filter((u) => u.key !== key)), 2500);
        })
        .catch((err) => {
          const msg = controller.signal.aborted ? "Cancelled" : (err as Error).message;
          patch(key, { error: msg });
          if (!controller.signal.aborted) toast.error(`${file.name}: ${msg}`);
        })
        .finally(onChange);
    }
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onDragOver={(e) => (e.preventDefault(), setDragging(true))}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => (e.preventDefault(), setDragging(false), start(e.dataTransfer.files))}
        onClick={() => input.current?.click()}
        data-testid="dropzone"
        className={cn(
          "flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition",
          dragging ? "border-primary bg-primary/5" : "border-border hover:border-muted-foreground/50 hover:bg-muted/30",
        )}
      >
        <UploadCloud className={cn("size-8", dragging ? "text-primary" : "text-muted-foreground")} />
        <span className="font-medium">Drop videos here or click to choose</span>
        <span className="text-sm text-muted-foreground">
          Up to 200 MB and 5 minutes each · uploads go straight to storage in parallel chunks
        </span>
        <input
          ref={input}
          type="file"
          accept="video/*"
          multiple
          hidden
          data-testid="file-input"
          onChange={(e) => {
            if (e.target.files) start(e.target.files);
            e.target.value = "";
          }}
        />
      </button>

      {uploads.map((u) => {
        const total = u.parts.reduce((s, p) => s + p.total, 0);
        const loaded = u.parts.reduce((s, p) => s + p.loaded, 0);
        const pct = total ? Math.round((loaded / total) * 100) : 0;
        return (
          <div key={u.key} className="rounded-xl border bg-card p-4">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate font-medium">{u.name}</span>
              <span className={cn("shrink-0 tabular-nums", u.error ? "text-red-500" : u.done ? "text-emerald-500" : "text-muted-foreground")}>
                {u.error ?? (u.done ? "Uploaded · processing…" : `${pct}% · ${fmtBytes(loaded)} / ${fmtBytes(total)}`)}
              </span>
              {!u.done && !u.error && (
                <button aria-label="Cancel upload" onClick={() => u.controller.abort()} className="text-muted-foreground hover:text-red-500">
                  <X className="size-4" />
                </button>
              )}
            </div>
            <Progress value={pct} className="mt-3" />
            <div className="mt-2 flex gap-0.5" title="Per-chunk progress">
              {u.parts.map((p) => (
                <div key={p.partNumber} className="h-1 flex-1 overflow-hidden rounded bg-muted">
                  <div
                    className={cn("h-full", p.state === "retrying" ? "bg-amber-400" : p.state === "done" ? "bg-emerald-500" : "bg-primary/70")}
                    style={{ width: `${(p.loaded / p.total) * 100}%` }}
                  />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
