import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn() } }));
vi.mock("./api", () => ({ getPendingProposals: vi.fn() }));

import { App as CapacitorApp } from "@capacitor/app";
import { createProposalPoller, startForegroundProposalPolling } from "./proposalPoller";
import { proposalManager } from "./proposals";
import type { PendingProposal } from "./api";

const P = (id: string): PendingProposal => ({
  proposalId: id,
  candidateId: "c",
  summary: "s",
  riskLevel: "low",
  requiresBiometric: false,
  approvalNonce: "n",
  expiresAt: Date.now() + 60_000,
});

beforeEach(() => {
  vi.useFakeTimers();
  proposalManager.clear();
});
afterEach(() => vi.useRealTimers());

describe("proposal poller (P6a)", () => {
  it("polls immediately then every interval, ingesting proposals", async () => {
    const fetchPending = vi.fn().mockResolvedValue([P("a")]);
    const ingest = vi.fn();
    const poller = createProposalPoller({ fetchPending, ingest, intervalMs: 10_000 });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchPending).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ proposalId: "a" }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchPending).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("stops polling after stop()", async () => {
    const fetchPending = vi.fn().mockResolvedValue([]);
    const poller = createProposalPoller({ fetchPending, ingest: vi.fn(), intervalMs: 10_000 });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchPending).toHaveBeenCalledTimes(1);
    expect(poller.isRunning()).toBe(false);
  });

  it("is single-flight: overlapping pollNow calls share one request", async () => {
    let resolve!: (v: PendingProposal[]) => void;
    const fetchPending = vi.fn(() => new Promise<PendingProposal[]>((r) => (resolve = r)));
    const poller = createProposalPoller({ fetchPending, ingest: vi.fn() });
    const a = poller.pollNow();
    const b = poller.pollNow();
    expect(fetchPending).toHaveBeenCalledTimes(1);
    resolve([]);
    await Promise.all([a, b]);
    const c = poller.pollNow(); // a finished poll no longer blocks a new one
    expect(fetchPending).toHaveBeenCalledTimes(2);
    resolve([]);
    await c;
  });

  it("backs off exponentially on errors, caps it, never rejects, and recovers", async () => {
    const fetchPending = vi.fn().mockRejectedValue(new Error("down"));
    const poller = createProposalPoller({ fetchPending, ingest: vi.fn(), intervalMs: 10_000, maxBackoffMs: 40_000 });
    poller.start();
    await vi.advanceTimersByTimeAsync(0); // call 1 fails -> next in 20s
    expect(fetchPending).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchPending).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000); // 20s elapsed
    expect(fetchPending).toHaveBeenCalledTimes(2); // fails -> next in 40s (cap)
    await vi.advanceTimersByTimeAsync(39_000);
    expect(fetchPending).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchPending).toHaveBeenCalledTimes(3); // fails -> still 40s (capped)
    await vi.advanceTimersByTimeAsync(40_000);
    expect(fetchPending).toHaveBeenCalledTimes(4);
    fetchPending.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(40_000); // call 5 succeeds -> back to 10s
    expect(fetchPending).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchPending).toHaveBeenCalledTimes(6);
    poller.stop();
    await expect(poller.pollNow()).resolves.toBeUndefined();
  });

  it("an ingest error on one proposal does not drop the others", async () => {
    const ingest = vi.fn((p: { proposalId: string }) => {
      if (p.proposalId === "bad") throw new Error("boom");
    });
    const poller = createProposalPoller({ fetchPending: vi.fn().mockResolvedValue([P("bad"), P("good")]), ingest });
    await poller.pollNow();
    expect(ingest).toHaveBeenCalledTimes(2);
  });

  it("ingested proposals reach proposalManager subscribers (what BiometricApprovalModal renders)", async () => {
    const seen: string[][] = [];
    const unsub = proposalManager.subscribe((l) => seen.push(l.filter((p) => p.state === "pending").map((p) => p.proposalId)));
    const poller = createProposalPoller({
      fetchPending: vi.fn().mockResolvedValue([P("x"), P("x")]),
      ingest: (p) => void proposalManager.ingestProposal(p),
    });
    await poller.pollNow();
    unsub();
    expect(seen.at(-1)).toEqual(["x"]);
    expect(proposalManager.getPending()).toHaveLength(1);
  });
});

describe("foreground wiring", () => {
  it("starts on mount, stops when backgrounded, restarts when foregrounded, and removes the listener", async () => {
    let cb!: (s: { isActive: boolean }) => void;
    const remove = vi.fn();
    vi.mocked(CapacitorApp.addListener).mockImplementation(((_: string, fn: typeof cb) => {
      cb = fn;
      return Promise.resolve({ remove });
    }) as never);
    const poller = { start: vi.fn(), stop: vi.fn(), pollNow: vi.fn(), isRunning: vi.fn() };
    const dispose = startForegroundProposalPolling(poller);
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.start).toHaveBeenCalledTimes(1);
    cb({ isActive: false });
    expect(poller.stop).toHaveBeenCalledTimes(1);
    cb({ isActive: true });
    expect(poller.start).toHaveBeenCalledTimes(2);
    dispose();
    expect(remove).toHaveBeenCalled();
    expect(poller.stop).toHaveBeenCalledTimes(2);
  });

  it("degrades silently when the app plugin throws or rejects", async () => {
    vi.mocked(CapacitorApp.addListener).mockImplementation((() => Promise.reject(new Error("no plugin"))) as never);
    const poller = { start: vi.fn(), stop: vi.fn(), pollNow: vi.fn(), isRunning: vi.fn() };
    const dispose = startForegroundProposalPolling(poller);
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.start).toHaveBeenCalled();
    expect(() => dispose()).not.toThrow();
  });
});
