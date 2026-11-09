import { describe, expect, it } from "vitest";
import { pool, withRetry } from "./upload";

describe("pool", () => {
  it("keeps at most `limit` tasks in flight and preserves order", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await pool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(peak).toBe(3);
  });
});

describe("withRetry", () => {
  it("retries until success", async () => {
    let calls = 0;
    let retries = 0;
    const v = await withRetry(
      async () => {
        if (++calls < 3) throw new Error("flaky");
        return "ok";
      },
      3,
      () => retries++,
      new AbortController().signal,
    );
    expect(v).toBe("ok");
    expect(retries).toBe(2);
  });

  it("gives up after the last attempt", async () => {
    await expect(withRetry(() => Promise.reject(new Error("down")), 2, () => {}, new AbortController().signal)).rejects.toThrow("down");
  });
});
