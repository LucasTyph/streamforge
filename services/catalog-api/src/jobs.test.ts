import { describe, expect, it } from "vitest";
import { deriveVideoStatus, jobStatusEvent, nextJobState } from "./jobs.js";

const REQUIRED = ["probe", "transcode"];

describe("nextJobState", () => {
  it("follows PENDING -> RUNNING -> SUCCEEDED | FAILED", () => {
    expect(nextJobState(undefined, "RUNNING")).toBe("RUNNING");
    expect(nextJobState("PENDING", "RUNNING")).toBe("RUNNING");
    expect(nextJobState("RUNNING", "SUCCEEDED")).toBe("SUCCEEDED");
    expect(nextJobState("RUNNING", "FAILED")).toBe("FAILED");
  });
  it("treats SUCCEEDED as terminal (redeliveries can't undo it)", () => {
    expect(nextJobState("SUCCEEDED", "RUNNING")).toBeNull();
    expect(nextJobState("SUCCEEDED", "FAILED")).toBeNull();
    expect(nextJobState("SUCCEEDED", "SUCCEEDED")).toBeNull();
  });
  it("lets a DLQ redrive restart a failed job", () => {
    expect(nextJobState("FAILED", "RUNNING")).toBe("RUNNING");
    expect(nextJobState("FAILED", "SUCCEEDED")).toBe("SUCCEEDED");
  });
});

describe("deriveVideoStatus", () => {
  const j = (task: string, state: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED") => ({ task, state });
  it("is PROCESSING while any task is running or partly done", () => {
    expect(deriveVideoStatus("UPLOADED", [j("probe", "RUNNING")], REQUIRED)).toBe("PROCESSING");
    expect(deriveVideoStatus("UPLOADED", [j("probe", "SUCCEEDED")], REQUIRED)).toBe("PROCESSING");
  });
  it("is READY only when every required task succeeded", () => {
    expect(deriveVideoStatus("PROCESSING", [j("probe", "SUCCEEDED"), j("transcode", "SUCCEEDED")], REQUIRED)).toBe("READY");
    expect(deriveVideoStatus("PROCESSING", [j("probe", "SUCCEEDED"), j("transcode", "SUCCEEDED")], [...REQUIRED, "thumbnail"])).toBe(
      "PROCESSING",
    );
  });
  it("is FAILED if any task failed", () => {
    expect(deriveVideoStatus("PROCESSING", [j("probe", "SUCCEEDED"), j("transcode", "FAILED")], REQUIRED)).toBe("FAILED");
  });
  it("leaves UPLOADING videos alone", () => {
    expect(deriveVideoStatus("UPLOADING", [j("probe", "RUNNING")], REQUIRED)).toBe("UPLOADING");
  });
});

describe("jobStatusEvent schema", () => {
  it("accepts the Go worker's JSON", () => {
    const goJson = {
      type: "job.status",
      videoId: "5f2b8c1e-7a3d-4f6e-9b0a-1c2d3e4f5a6b",
      task: "transcode",
      state: "SUCCEEDED",
      attempt: 1,
      result: { master: "x/hls/master.m3u8" },
      at: "2026-11-09T18:00:00.123456789Z",
    };
    expect(jobStatusEvent.safeParse(goJson).success).toBe(true);
  });
  it("rejects unknown tasks", () => {
    expect(jobStatusEvent.safeParse({ type: "job.status", task: "rm -rf", state: "RUNNING" }).success).toBe(false);
  });
});
