// Parses a thumbnail WebVTT file (`sprite.jpg#xywh=x,y,w,h` cues) for scrub previews.

export interface ThumbCue {
  start: number;
  end: number;
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const toSeconds = (t: string) => {
  const parts = t.trim().split(":").map(Number);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
};

export function parseThumbnailVtt(text: string, baseUrl: string): ThumbCue[] {
  const cues: ThumbCue[] = [];
  const blocks = text.replace(/\r/g, "").split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    const timing = lines.findIndex((l) => l.includes("-->"));
    if (timing < 0 || !lines[timing + 1]) continue;
    const [a, b] = lines[timing]!.split("-->");
    const [file, frag] = lines[timing + 1]!.split("#xywh=");
    const xywh = frag?.split(",").map(Number);
    if (!file || !xywh || xywh.length !== 4 || xywh.some(Number.isNaN)) continue;
    const [x, y, w, h] = xywh as [number, number, number, number];
    cues.push({ start: toSeconds(a!), end: toSeconds(b!), url: new URL(file, baseUrl).toString(), x, y, w, h });
  }
  return cues;
}

/** Binary search for the cue covering time t. */
export function cueAt(cues: ThumbCue[], t: number): ThumbCue | undefined {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cues[mid]!;
    if (t < c.start) hi = mid - 1;
    else if (t >= c.end) lo = mid + 1;
    else return c;
  }
  return cues.length && t >= cues[cues.length - 1]!.end ? cues[cues.length - 1] : undefined;
}
