// Pure multipart-upload planning/validation logic (unit tested).

export const S3_MIN_PART = 5 * 1024 * 1024;
export const S3_MAX_PARTS = 10_000;

export class UploadError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export interface UploadPlan {
  partSize: number;
  partCount: number;
}

/** Splits `size` bytes into parts of `partSize` (grown if needed to stay within S3's part limit). */
export function planUpload(size: number, partSize: number, maxBytes: number): UploadPlan {
  if (!Number.isInteger(size) || size <= 0) throw new UploadError("File is empty");
  if (size > maxBytes) throw new UploadError(`File is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
  let ps = Math.max(partSize, S3_MIN_PART);
  if (Math.ceil(size / ps) > S3_MAX_PARTS) ps = Math.ceil(size / S3_MAX_PARTS);
  return { partSize: ps, partCount: Math.ceil(size / ps) };
}

export function assertVideoContentType(contentType: string) {
  if (!/^video\/[\w.+-]+$/.test(contentType)) throw new UploadError("Only video files can be uploaded");
}

export function assertPartNumbers(partNumbers: number[], partCount: number) {
  for (const n of partNumbers) {
    if (!Number.isInteger(n) || n < 1 || n > partCount) throw new UploadError(`Invalid part number ${n}`);
  }
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

/** Every part 1..partCount exactly once; returns them sorted (S3 requires ascending order). */
export function normalizeCompletedParts(parts: CompletedPart[], partCount: number): CompletedPart[] {
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  if (sorted.length !== partCount || sorted.some((p, i) => p.partNumber !== i + 1)) {
    throw new UploadError(`Expected parts 1..${partCount}, each exactly once`);
  }
  if (sorted.some((p) => p.etag.trim() === "")) throw new UploadError("Every part needs an ETag");
  return sorted;
}

/** Deterministic object key for a video's source file. */
export function rawKeyFor(videoId: string) {
  return `uploads/${videoId}/source`;
}
