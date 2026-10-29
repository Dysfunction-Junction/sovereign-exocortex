import { describe, it, expect } from "vitest";
import { UsageBaseline, BASELINE_WINDOW_MS } from "./usage-baseline.js";

const T0 = 1_800_000_000_000;
const sum = (d: { cands: Array<{ prob: number }>; other: number }) => d.cands.reduce((s, c) => s + c.prob, 0) + d.other;

describe("UsageBaseline", () => {
  it("is cold start under 10 actions: uniform over seen actions plus OTHER, flagged", () => {
    const b = new UsageBaseline();
    for (let i = 0; i < 9; i++) b.observe(i % 3 === 0 ? "a" : "b", T0 + i * 1000, "morning");
    const { avg_usage } = b.predict(T0 + 9000, "morning");
    expect(avg_usage.cold_start).toBe(true);
    expect(avg_usage.n).toBe(9);
    expect(avg_usage.cands.map((c) => c.prob)).toEqual([1 / 3, 1 / 3]);
    expect(avg_usage.other).toBeCloseTo(1 / 3);
    // the 10th action ends cold start
    b.observe("a", T0 + 9000, "morning");
    expect(b.predict(T0 + 10_000, "morning").avg_usage.cold_start).toBe(false);
  });

  it("empty baseline is all OTHER", () => {
    const { avg_usage } = new UsageBaseline().predict(T0, "night");
    expect(avg_usage).toMatchObject({ cands: [], other: 1, n: 0, cold_start: true });
  });

  it("uses add-0.5 smoothed trailing share, summing to 1", () => {
    const b = new UsageBaseline();
    for (let i = 0; i < 12; i++) b.observe(i < 9 ? "a" : "b", T0 + i, "evening"); // 9 a, 3 b
    const { avg_usage } = b.predict(T0 + 20, "evening");
    // daypart n=12 < 30 so overall cell; denom = 12 + 0.5*3
    expect(avg_usage.cell).toBe("overall");
    expect(avg_usage.cands[0].value).toBe("a");
    expect(avg_usage.cands[0].prob).toBeCloseTo(9.5 / 13.5);
    expect(avg_usage.cands[1].prob).toBeCloseTo(3.5 / 13.5);
    expect(avg_usage.other).toBeCloseTo(0.5 / 13.5);
    expect(sum(avg_usage)).toBeCloseTo(1);
  });

  it("uses the daypart cell when it has at least 30 actions, else falls back to overall", () => {
    const b = new UsageBaseline();
    for (let i = 0; i < 29; i++) b.observe("a", T0 + i, "morning");
    for (let i = 0; i < 10; i++) b.observe("b", T0 + 100 + i, "evening");
    let p = b.predict(T0 + 200, "morning").avg_usage;
    expect(p.cell).toBe("overall"); // morning has 29 < 30
    expect(p.n).toBe(39);
    b.observe("a", T0 + 150, "morning"); // morning = 30
    p = b.predict(T0 + 200, "morning").avg_usage;
    expect(p.cell).toBe("daypart");
    expect(p.n).toBe(30);
    expect(p.cands[0].value).toBe("a");
    // b was never seen in the morning but is smoothed, not zero
    expect(p.cands.find((c) => c.value === "b")!.prob).toBeCloseTo(0.5 / (30 + 1.5));
    expect(sum(p)).toBeCloseTo(1);
    // evening has 10 < 30: falls back to overall (40)
    const e = b.predict(T0 + 200, "evening").avg_usage;
    expect(e.cell).toBe("overall");
    expect(e.n).toBe(40);
  });

  it("expires actions older than 14 days", () => {
    const b = new UsageBaseline();
    for (let i = 0; i < 15; i++) b.observe("old", T0 + i, "night");
    for (let i = 0; i < 10; i++) b.observe("new", T0 + BASELINE_WINDOW_MS + 1000 + i, "night");
    const p = b.predict(T0 + BASELINE_WINDOW_MS + 2000, "night").avg_usage;
    expect(b.size).toBe(10);
    expect(p.cands.map((c) => c.value)).toEqual(["new"]);
    expect(p.n).toBe(10);
  });

  it("pre-registration: the baseline for guess k reflects only actions up to k, never the answer", () => {
    const seq = ["a", "b", "a", "a", "b", "a", "b", "b", "a", "a", "a", "b", "b", "a"];
    const logged: Array<ReturnType<UsageBaseline["predict"]>> = [];
    const live = new UsageBaseline();
    seq.forEach((a, i) => {
      live.observe(a, T0 + i * 1000, "afternoon");
      logged.push(live.predict(T0 + i * 1000, "afternoon"));
    });
    // Rebuild each prefix independently: identical output means nothing later leaked in.
    for (let k = 0; k < seq.length; k++) {
      const prefix = new UsageBaseline();
      for (let i = 0; i <= k; i++) prefix.observe(seq[i], T0 + i * 1000, "afternoon");
      expect(logged[k]).toEqual(prefix.predict(T0 + k * 1000, "afternoon"));
    }
  });

  it("persistence: smoothed repeat rate on the last action, rest follows average usage", () => {
    const b = new UsageBaseline();
    // a a a a b b b b b b -> 10 actions, 9 transitions, 8 repeats
    for (const [i, a] of ["a", "a", "a", "a", "b", "b", "b", "b", "b", "b"].entries()) b.observe(a, T0 + i, "night");
    const { avg_usage, persistence } = b.predict(T0 + 20, "night");
    expect(persistence.repeat_rate).toBeCloseTo((8 + 1) / (9 + 2));
    const r = persistence.repeat_rate;
    const avgB = avg_usage.cands.find((c) => c.value === "b")!.prob;
    expect(persistence.cands[0].value).toBe("b");
    expect(persistence.cands[0].prob).toBeCloseTo((1 - r) * avgB + r);
    expect(persistence.other).toBeCloseTo((1 - r) * avg_usage.other);
    expect(sum(persistence)).toBeCloseTo(1);
  });

  it("persistence with no previous action equals average usage", () => {
    const p = new UsageBaseline().predict(T0, "night");
    expect(p.persistence.cands).toEqual(p.avg_usage.cands);
    expect(p.persistence.other).toBe(p.avg_usage.other);
  });
});
