import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./auth.js";
import {
  S3_MAX_PARTS,
  S3_MIN_PART,
  UploadError,
  assertPartNumbers,
  assertVideoContentType,
  normalizeCompletedParts,
  planUpload,
} from "./uploads.js";

const MB = 1024 * 1024;

describe("planUpload", () => {
  it("splits into fixed-size parts with a smaller last part", () => {
    expect(planUpload(100 * MB, 8 * MB, 200 * MB)).toEqual({ partSize: 8 * MB, partCount: 13 });
    expect(planUpload(1, 8 * MB, 200 * MB)).toEqual({ partSize: 8 * MB, partCount: 1 });
  });
  it("never goes below the S3 minimum part size", () => {
    expect(planUpload(20 * MB, 1 * MB, 200 * MB).partSize).toBe(S3_MIN_PART);
  });
  it("grows the part size to stay under the S3 part limit", () => {
    const p = planUpload(60_000 * MB, 5 * MB, Infinity);
    expect(p.partCount).toBeLessThanOrEqual(S3_MAX_PARTS);
  });
  it("rejects empty and oversized files", () => {
    expect(() => planUpload(0, 8 * MB, 200 * MB)).toThrow(UploadError);
    expect(() => planUpload(201 * MB, 8 * MB, 200 * MB)).toThrow(/200 MB/);
  });
});

describe("validation", () => {
  it("accepts only video content types", () => {
    expect(() => assertVideoContentType("video/mp4")).not.toThrow();
    expect(() => assertVideoContentType("image/png")).toThrow(UploadError);
    expect(() => assertVideoContentType("video/mp4; x=<script>")).toThrow(UploadError);
  });
  it("rejects out-of-range part numbers", () => {
    expect(() => assertPartNumbers([1, 2, 3], 3)).not.toThrow();
    expect(() => assertPartNumbers([0], 3)).toThrow();
    expect(() => assertPartNumbers([4], 3)).toThrow();
  });
  it("requires every part exactly once and sorts them", () => {
    const parts = [
      { partNumber: 2, etag: '"b"' },
      { partNumber: 1, etag: '"a"' },
    ];
    expect(normalizeCompletedParts(parts, 2).map((p) => p.partNumber)).toEqual([1, 2]);
    expect(() => normalizeCompletedParts(parts, 3)).toThrow(/1..3/);
    expect(() => normalizeCompletedParts([...parts, { partNumber: 2, etag: '"b"' }], 2)).toThrow();
    expect(() => normalizeCompletedParts([{ partNumber: 1, etag: " " }], 1)).toThrow(/ETag/);
  });
});

describe("password hashing", () => {
  it("verifies the right password and rejects the wrong one", async () => {
    const h = await hashPassword("correct horse");
    expect(h).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(h, "correct horse")).toBe(true);
    expect(await verifyPassword(h, "wrong")).toBe(false);
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
  });
});
