"use client";

import type Hls from "hls.js";
import { Maximize, Pause, Play, Settings, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fmtDuration } from "@/lib/api";
import { cn } from "@/lib/utils";
import { cueAt, parseThumbnailVtt, type ThumbCue } from "@/lib/vtt";

interface Level {
  index: number;
  /** short side, so portrait 360x640 is "360p" like the worker names it */
  height: number;
  bitrate: number;
}

/** Adaptive HLS player: hls.js, quality selector, sprite-sheet scrub previews. */
export function Player({ src, poster, thumbnailsVtt }: { src: string; poster?: string | null; thumbnailsVtt?: string | null }) {
  const video = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const hls = useRef<Hls | null>(null);
  const [levels, setLevels] = useState<Level[]>([]);
  const [selected, setSelected] = useState(-1); // -1 = auto
  const [playingLevel, setPlayingLevel] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [cues, setCues] = useState<ThumbCue[]>([]);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    let destroyed = false;
    (async () => {
      const { default: HlsJs } = await import("hls.js");
      if (destroyed) return;
      if (HlsJs.isSupported()) {
        const h = new HlsJs({ capLevelToPlayerSize: false });
        hls.current = h;
        h.on(HlsJs.Events.MANIFEST_PARSED, (_e, d) =>
          setLevels(
            d.levels.map((l, index) => ({ index, height: Math.min(l.width || l.height, l.height), bitrate: l.bitrate })).sort((a, b) => b.height - a.height),
          ),
        );
        h.on(HlsJs.Events.LEVEL_SWITCHED, (_e, d) => setPlayingLevel(d.level));
        h.on(HlsJs.Events.ERROR, (_e, d) => d.fatal && setError(`Playback error: ${d.details}`));
        h.loadSource(src);
        h.attachMedia(el);
      } else if (el.canPlayType("application/vnd.apple.mpegurl")) {
        el.src = src; // Safari: native HLS (no manual quality selection)
      } else {
        setError("This browser can't play HLS video.");
      }
    })();
    return () => {
      destroyed = true;
      hls.current?.destroy();
      hls.current = null;
    };
  }, [src]);

  useEffect(() => {
    if (!thumbnailsVtt) return;
    fetch(thumbnailsVtt)
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => setCues(parseThumbnailVtt(t, thumbnailsVtt)))
      .catch(() => setCues([]));
  }, [thumbnailsVtt]);

  const toggle = useCallback(() => {
    const el = video.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  }, []);

  const chooseLevel = (v: string) => {
    const n = Number(v);
    setSelected(n);
    if (hls.current) hls.current.currentLevel = n; // -1 re-enables ABR
  };

  const tAt = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - r.left, 0), r.width);
    return { x, t: duration ? (x / r.width) * duration : 0 };
  };

  const cue = hover ? cueAt(cues, hover.t) : undefined;
  const levelName = (i: number | null) => (i == null ? "" : `${levels.find((l) => l.index === i)?.height ?? "?"}p`);

  return (
    <div
      ref={box}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "k") (e.preventDefault(), toggle());
        if (e.key === "ArrowRight" && video.current) video.current.currentTime += 5;
        if (e.key === "ArrowLeft" && video.current) video.current.currentTime -= 5;
      }}
      className="group relative aspect-video overflow-hidden rounded-xl bg-black outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <video
        ref={video}
        data-testid="player-video"
        poster={poster ?? undefined}
        playsInline
        onClick={toggle}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
        onProgress={(e) => {
          const b = e.currentTarget.buffered;
          if (b.length) setBuffered(b.end(b.length - 1));
        }}
        className="size-full"
      />

      {!playing && !error && (
        <button
          aria-label="Play"
          onClick={toggle}
          className="absolute inset-0 m-auto flex size-16 items-center justify-center rounded-full bg-black/60 text-white transition hover:scale-105 hover:bg-primary"
        >
          <Play className="ml-1 size-7" />
        </button>
      )}
      {error && <div className="absolute inset-x-0 top-0 bg-red-600/90 px-3 py-2 text-sm text-white">{error}</div>}

      <div
        className={cn(
          "absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 pt-10 pb-2 text-white transition-opacity",
          playing ? "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" : "opacity-100",
        )}
      >
        {/* seek bar with scrub preview */}
        <div
          ref={bar}
          data-testid="seek-bar"
          className="relative h-4 cursor-pointer"
          onMouseMove={(e) => setHover(tAt(e.clientX))}
          onMouseLeave={() => setHover(null)}
          onClick={(e) => {
            if (video.current) video.current.currentTime = tAt(e.clientX).t;
          }}
        >
          <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded bg-white/25">
            <div className="absolute inset-y-0 left-0 rounded bg-white/40" style={{ width: `${duration ? (buffered / duration) * 100 : 0}%` }} />
            <div className="absolute inset-y-0 left-0 rounded bg-primary" style={{ width: `${duration ? (time / duration) * 100 : 0}%` }} />
          </div>
          {hover && (
            <div
              className="pointer-events-none absolute bottom-6 -translate-x-1/2 overflow-hidden rounded-md border border-white/20 bg-black shadow-xl"
              style={{ left: Math.min(Math.max(hover.x, (cue?.w ?? 60) / 2), (bar.current?.clientWidth ?? 0) - (cue?.w ?? 60) / 2) }}
              data-testid="scrub-preview"
            >
              {cue && (
                <div
                  style={{
                    width: cue.w,
                    height: cue.h,
                    backgroundImage: `url("${cue.url}")`,
                    backgroundPosition: `-${cue.x}px -${cue.y}px`,
                  }}
                />
              )}
              <div className="px-1.5 py-0.5 text-center text-xs tabular-nums">{fmtDuration(hover.t)}</div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 text-sm">
          <button aria-label={playing ? "Pause" : "Play"} onClick={toggle} className="hover:text-primary">
            {playing ? <Pause className="size-5" /> : <Play className="size-5" />}
          </button>
          <button
            aria-label={muted ? "Unmute" : "Mute"}
            onClick={() => video.current && (video.current.muted = !video.current.muted)}
            className="hover:text-primary"
          >
            {muted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
          </button>
          <span className="tabular-nums">
            {fmtDuration(time)} / {fmtDuration(duration)}
          </span>
          <div className="ml-auto flex items-center gap-3">
            {levels.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger aria-label="Quality" data-testid="quality-menu" className="flex items-center gap-1 hover:text-primary">
                  <Settings className="size-4" />
                  <span className="text-xs">{selected === -1 ? `Auto${playingLevel != null ? ` (${levelName(playingLevel)})` : ""}` : levelName(selected)}</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="top">
                  <DropdownMenuLabel>Quality</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={String(selected)} onValueChange={chooseLevel}>
                    <DropdownMenuRadioItem value="-1">Auto</DropdownMenuRadioItem>
                    {levels.map((l) => (
                      <DropdownMenuRadioItem key={l.index} value={String(l.index)}>
                        {l.height}p <span className="ml-auto pl-3 text-xs text-muted-foreground">{Math.round(l.bitrate / 1000)} kbps</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <button aria-label="Fullscreen" onClick={() => box.current?.requestFullscreen?.()} className="hover:text-primary">
              <Maximize className="size-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
