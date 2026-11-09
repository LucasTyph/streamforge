import { describe, expect, it } from "vitest";
import { cueAt, parseThumbnailVtt } from "./vtt";

// Same format the Go thumbnail worker writes (media.SpriteVTT).
const vtt = `WEBVTT

00:00:00.000 --> 00:00:01.000
sprite.jpg#xywh=0,0,160,90

00:00:01.000 --> 00:00:02.000
sprite.jpg#xywh=160,0,160,90

00:00:02.000 --> 00:00:02.500
sprite.jpg#xywh=0,90,160,90
`;

describe("parseThumbnailVtt", () => {
  const cues = parseThumbnailVtt(vtt, "http://cdn.test/v1/thumbs/sprite.vtt");
  it("parses cues and resolves sprite URLs relative to the VTT", () => {
    expect(cues).toHaveLength(3);
    expect(cues[2]).toEqual({ start: 2, end: 2.5, url: "http://cdn.test/v1/thumbs/sprite.jpg", x: 0, y: 90, w: 160, h: 90 });
  });
  it("finds the cue for a time, clamping past the end", () => {
    expect(cueAt(cues, 0)?.x).toBe(0);
    expect(cueAt(cues, 1.5)?.x).toBe(160);
    expect(cueAt(cues, 9)?.y).toBe(90);
    expect(cueAt([], 1)).toBeUndefined();
  });
  it("ignores malformed blocks", () => {
    expect(parseThumbnailVtt("WEBVTT\n\nnot a cue\n\n00:00:00.000 --> 00:00:01.000\nnope.jpg", "http://x/")).toEqual([]);
  });
});
