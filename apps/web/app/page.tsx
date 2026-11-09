"use client";

import { Film } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { UploadDropzone } from "@/components/upload-dropzone";
import { VideoCard, VideoCardSkeleton } from "@/components/video-card";
import { api, type Video } from "@/lib/api";
import { useLive } from "@/lib/live";
import { useSession } from "@/lib/session";

export default function LibraryPage() {
  const { user, error: sessionError } = useSession();
  const [videos, setVideos] = useState<Video[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    () =>
      api<{ items: Video[] }>("/videos")
        .then((r) => (setVideos(r.items), setError(null)))
        .catch((e) => setError((e as Error).message)),
    [],
  );
  const { progress, connected } = useLive(!!user, refresh);

  useEffect(() => {
    if (user) refresh();
  }, [user, refresh]);

  // Safety net if the live stream is down: poll while anything is still processing.
  const busy = videos?.some((v) => v.status === "UPLOADED" || v.status === "PROCESSING");
  useEffect(() => {
    if (!busy || connected) return;
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [busy, connected, refresh]);

  return (
    <>
      <AppHeader user={user} live={user ? connected : undefined} />
      <main className="mx-auto max-w-6xl space-y-8 px-4 py-8 md:px-6">
        <section className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Library</h1>
          <p className="text-sm text-muted-foreground">Upload a clip and watch it move through the pipeline in real time.</p>
        </section>

        {user && <UploadDropzone onChange={refresh} />}

        {(error || sessionError) && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-300">
            Couldn&apos;t load your library: {error ?? sessionError}.{" "}
            <button className="underline" onClick={refresh}>
              Try again
            </button>
          </div>
        )}

        <section>
          {videos === null ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <VideoCardSkeleton key={i} />
              ))}
            </div>
          ) : videos.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-16 text-center">
              <Film className="size-10 text-muted-foreground" />
              <p className="font-medium">No videos yet</p>
              <p className="text-sm text-muted-foreground">Drop a video above. Short clips are ready in seconds.</p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="library-grid">
              {videos.map((v) => (
                <VideoCard key={v.id} video={v} live={progress} />
              ))}
            </div>
          )}
        </section>
      </main>
    </>
  );
}
