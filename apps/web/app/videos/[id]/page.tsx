"use client";

import { Activity, AlertTriangle, ArrowLeft, Check, Circle, Loader2, X } from "lucide-react";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { Player } from "@/components/player";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ApiError, api, fmtBytes, fmtDuration, traceUrl, type Video } from "@/lib/api";
import { useLive } from "@/lib/live";
import { type Stage, stagesFor } from "@/lib/pipeline";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

function StageIcon({ state }: { state: Stage["state"] }) {
  if (state === "done") return <Check className="size-4 text-emerald-500" />;
  if (state === "running") return <Loader2 className="size-4 animate-spin text-primary" />;
  if (state === "failed") return <X className="size-4 text-red-500" />;
  return <Circle className="size-3 text-muted-foreground/50" />;
}

export default function VideoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user } = useSession();
  const [video, setVideo] = useState<Video | null>(null);
  const [notFound, setNotFound] = useState(false);

  const refresh = useCallback(
    () =>
      api<Video>(`/videos/${id}`)
        .then(setVideo)
        .catch((e) => e instanceof ApiError && e.status === 404 && setNotFound(true)),
    [id],
  );
  const { progress, connected } = useLive(!!user, (videoId) => videoId === id && refresh());

  useEffect(() => {
    if (user) refresh();
  }, [user, refresh]);

  // Refresh job states when progress events arrive for a task we still show as pending.
  const live = progress[id];
  useEffect(() => {
    if (live && video && video.status !== "READY" && video.status !== "FAILED") {
      const unknown = Object.keys(live).some((t) => !video.jobs?.some((j) => j.task === t));
      if (unknown) refresh();
    }
  }, [live, video, refresh]);

  return (
    <>
      <AppHeader user={user} live={user ? connected : undefined} />
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 md:px-6">
        <Link href="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Library
        </Link>

        {notFound ? (
          <p className="rounded-xl border border-dashed py-16 text-center text-muted-foreground">This video doesn&apos;t exist or isn&apos;t yours.</p>
        ) : !video ? (
          <div className="aspect-video animate-pulse rounded-xl bg-muted" />
        ) : (
          <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
            <div className="space-y-4">
              {video.status === "READY" && video.playbackUrl ? (
                <Player src={video.playbackUrl} poster={video.posterUrl} thumbnailsVtt={video.thumbnailsVttUrl} />
              ) : (
                <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-muted">
                  {video.posterUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={video.posterUrl} alt="" className="absolute inset-0 size-full object-cover opacity-40 blur-sm" />
                  )}
                  <div className="relative text-center">
                    {video.status === "FAILED" ? (
                      <>
                        <AlertTriangle className="mx-auto size-10 text-red-500" />
                        <p className="mt-2 font-medium">Processing failed</p>
                        <p className="text-sm text-muted-foreground" data-testid="failure-reason">
                          {video.failureReason}
                        </p>
                      </>
                    ) : (
                      <>
                        <Loader2 className="mx-auto size-10 animate-spin text-primary" />
                        <p className="mt-2 font-medium">Processing…</p>
                        <p className="text-sm text-muted-foreground">The player appears as soon as the video is ready.</p>
                      </>
                    )}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-xl font-semibold tracking-tight">{video.title}</h1>
                <StatusBadge status={video.status} />
              </div>
            </div>

            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Pipeline</CardTitle>
                </CardHeader>
                <CardContent>
                  <ol className="space-y-3" data-testid="pipeline-stages">
                    {stagesFor(video, progress).map((s) => (
                      <li key={s.key} data-stage={s.key} data-state={s.state} className="space-y-1.5">
                        <div className="flex items-center gap-2 text-sm">
                          <span className="flex size-5 items-center justify-center">
                            <StageIcon state={s.state} />
                          </span>
                          <span className={cn(s.state === "pending" && "text-muted-foreground")}>{s.label}</span>
                          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                            {s.state === "running" ? `${s.percent}%` : s.detail}
                          </span>
                        </div>
                        {s.state === "running" && <Progress value={s.percent} className="pl-7" />}
                        {s.state === "failed" && s.detail && <p className="pl-7 text-xs text-red-500">{s.detail}</p>}
                      </li>
                    ))}
                  </ol>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Details</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                    {[
                      ["File", video.filename],
                      ["Size", fmtBytes(video.sizeBytes)],
                      ["Duration", fmtDuration(video.durationSeconds)],
                      ["Resolution", video.width && video.height ? `${video.width}×${video.height}` : "–"],
                      ["Uploaded", new Date(video.createdAt).toLocaleString()],
                      ["ID", video.id],
                    ].map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-muted-foreground">{k}</dt>
                        <dd className="truncate" title={v ?? ""}>
                          {v}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {video.traceId && (
                    <a
                      href={traceUrl(video.traceId)}
                      target="_blank"
                      rel="noreferrer"
                      data-testid="trace-link"
                      className="mt-4 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                    >
                      <Activity className="size-4" /> View pipeline trace
                    </a>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
