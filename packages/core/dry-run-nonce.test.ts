import { describe, it, expect, vi } from "vitest";

const timingSafeEqualSpy = vi.hoisted(() => vi.fn());

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  timingSafeEqualSpy.mockImplementation(actual.timingSafeEqual);
  return { ...actual, timingSafeEqual: timingSafeEqualSpy };
});

import { DryRunCache } from "./dry-run.js";

describe("DryRunCache.release nonce comparison (C3)", () => {
  it("uses crypto.timingSafeEqual for same-length nonces and never throws on a length mismatch", () => {
    const cache = new DryRunCache();
    const p = cache.set("c1", {}, "s");
    timingSafeEqualSpy.mockClear();

    const wrongSameLength = "0".repeat(p.approvalNonce.length);
    const bad = cache.release(p.proposalId, wrongSameLength);
    expect(bad.ok).toBe(false);
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);

    const short = cache.release(p.proposalId, "abc");
    expect(short.ok).toBe(false);
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1); // length guard short-circuits; timingSafeEqual would throw

    // wrong nonces did not burn the proposal
    expect(cache.get(p.proposalId)).not.toBeNull();
    expect(cache.release(p.proposalId, p.approvalNonce).ok).toBe(true);
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(2);
  });
});
