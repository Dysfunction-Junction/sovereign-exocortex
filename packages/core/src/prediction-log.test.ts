import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  computePredictionReport,
  ensurePredictionTables,
  expireStale,
  formatPredictionReport,
  loadPredictionRows,
  logPrediction,
  predictNext,
  predictionId,
  resolveWithAction,
  type PredictionInput,
} from "./prediction-log.js";

const T0 = 1_800_000_000_000;

function fresh(): DatabaseSync {
  const raw = new DatabaseSync(":memory:");
  ensurePredictionTables(raw);
  return raw;
}

function guess(over: Partial<PredictionInput> = {}): PredictionInput {
  return {
    device_id: "d1",
    made_seq: 1,
    made_at: T0,
    horizon_ms: 60_000,
    context_key: "screen:status|evening",
    candidates: [
      { value: "ask", prob: 0.6 },
      { value: "setup", prob: 0.3 },
    ],
    ...over,
  };
}

describe("predictNext", () => {
  it("ranks successors of the current item by frequency", () => {
    const h = ["status", "ask", "status", "ask", "status", "setup", "recent"];
    const c = predictNext(h, "status");
    expect(c.map((x) => x.value)).toEqual(["ask", "setup"]);
    expect(c[0].prob).toBeCloseTo(2 / 3);
    expect(c[1].prob).toBeCloseTo(1 / 3);
  });

  it("falls back to overall frequency for an unseen current item", () => {
    const c = predictNext(["a", "a", "b"], "zzz");
    expect(c[0]).toEqual({ value: "a", prob: 2 / 3 });
  });

  it("returns no guess without history", () => {
    expect(predictNext([], "a")).toEqual([]);
  });

  it("breaks ties deterministically and caps at k", () => {
    const c = predictNext(["x", "b", "x", "a", "x", "c", "x", "d"], "x", 2);
    expect(c.map((x) => x.value)).toEqual(["a", "b"]);
  });
});

describe("logPrediction", () => {
  it("is idempotent per device and sequence", () => {
    const raw = fresh();
    expect(logPrediction(raw, guess())).toBe(predictionId("d1", 1));
    expect(logPrediction(raw, guess())).toBeNull();
    expect(loadPredictionRows(raw)).toHaveLength(1);
  });

  it("rejects malformed guesses before writing", () => {
    const raw = fresh();
    expect(() => logPrediction(raw, guess({ candidates: [] }))).toThrow(TypeError);
    expect(() => logPrediction(raw, guess({ candidates: [{ value: "a", prob: 0.7 }, { value: "b", prob: 0.7 }] }))).toThrow(/sum/);
    expect(() => logPrediction(raw, guess({ candidates: [{ value: "a", prob: Number.NaN }] }))).toThrow(TypeError);
    expect(() => logPrediction(raw, guess({ horizon_ms: 0 }))).toThrow(TypeError);
    expect(loadPredictionRows(raw)).toHaveLength(0);
  });

  it("makes both tables append-only", () => {
    const raw = fresh();
    logPrediction(raw, guess());
    resolveWithAction(raw, "d1", { seq: 2, ts: T0 + 1000, value: "ask" });
    expect(() => raw.exec("UPDATE predictions SET context_key = 'x'")).toThrow(/append-only/);
    expect(() => raw.exec("DELETE FROM predictions")).toThrow(/append-only/);
    expect(() => raw.exec("UPDATE prediction_outcomes SET outcome = 'MISS'")).toThrow(/append-only/);
    expect(() => raw.exec("DELETE FROM prediction_outcomes")).toThrow(/append-only/);
  });
});

describe("resolveWithAction", () => {
  it("records a HIT when the top-1 guess happens inside the horizon", () => {
    const raw = fresh();
    logPrediction(raw, guess());
    expect(resolveWithAction(raw, "d1", { seq: 2, ts: T0 + 5000, value: "ask" })).toBe(1);
    const [r] = loadPredictionRows(raw);
    expect(r).toMatchObject({ outcome: "HIT", actual: "ask", hit_rank: 1, latency_ms: 5000, actual_seq: 2 });
  });

  it("records a MISS with the real action and its rank among the candidates", () => {
    const raw = fresh();
    logPrediction(raw, guess());
    resolveWithAction(raw, "d1", { seq: 2, ts: T0 + 1000, value: "setup" });
    expect(loadPredictionRows(raw)[0]).toMatchObject({ outcome: "MISS", actual: "setup", hit_rank: 2 });
  });

  it("keeps a MISS the model never ranked, with no rank", () => {
    const raw = fresh();
    logPrediction(raw, guess());
    resolveWithAction(raw, "d1", { seq: 2, ts: T0 + 1000, value: "search" });
    expect(loadPredictionRows(raw)[0]).toMatchObject({ outcome: "MISS", actual: "search", hit_rank: null });
  });

  it("expires a guess when the next action comes after the horizon but still records it", () => {
    const raw = fresh();
    logPrediction(raw, guess());
    resolveWithAction(raw, "d1", { seq: 2, ts: T0 + 120_000, value: "ask" });
    expect(loadPredictionRows(raw)[0]).toMatchObject({ outcome: "EXPIRED", actual: "ask", latency_ms: 120_000 });
  });

  it("ignores earlier or same-sequence actions and other devices", () => {
    const raw = fresh();
    logPrediction(raw, guess({ made_seq: 5 }));
    expect(resolveWithAction(raw, "d1", { seq: 5, ts: T0 + 1, value: "ask" })).toBe(0);
    expect(resolveWithAction(raw, "d1", { seq: 4, ts: T0 + 1, value: "ask" })).toBe(0);
    expect(resolveWithAction(raw, "d2", { seq: 9, ts: T0 + 1, value: "ask" })).toBe(0);
    expect(loadPredictionRows(raw)[0].outcome).toBeNull();
  });

  it("never resolves a guess twice", () => {
    const raw = fresh();
    logPrediction(raw, guess());
    resolveWithAction(raw, "d1", { seq: 2, ts: T0 + 1000, value: "ask" });
    expect(resolveWithAction(raw, "d1", { seq: 3, ts: T0 + 2000, value: "setup" })).toBe(0);
    expect(loadPredictionRows(raw)[0]).toMatchObject({ outcome: "HIT", actual_seq: 2 });
  });
});

describe("expireStale", () => {
  it("expires only open guesses past their horizon", () => {
    const raw = fresh();
    logPrediction(raw, guess({ made_seq: 1, made_at: T0 }));
    logPrediction(raw, guess({ made_seq: 2, made_at: T0 + 200_000 }));
    expect(expireStale(raw, T0 + 100_000)).toBe(1);
    const rows = loadPredictionRows(raw);
    expect(rows[0]).toMatchObject({ outcome: "EXPIRED", actual: null });
    expect(rows[1].outcome).toBeNull();
    expect(expireStale(raw, T0 + 100_000)).toBe(0);
  });
});

describe("computePredictionReport", () => {
  function seed(raw: DatabaseSync, spec: Array<[string, string, string]>): void {
    // [context, top1 guess, actual]
    spec.forEach(([ctx, top, actual], i) => {
      logPrediction(raw, guess({
        made_seq: i * 2 + 1,
        made_at: T0 + i * 1000,
        context_key: ctx,
        candidates: [{ value: top, prob: 0.6 }, { value: "other", prob: 0.2 }],
      }));
      resolveWithAction(raw, "d1", { seq: i * 2 + 2, ts: T0 + i * 1000 + 500, value: actual });
    });
  }

  it("reports hit rates, baseline, calibration and the miss distribution", () => {
    const raw = fresh();
    seed(raw, [
      ["screen:status", "ask", "ask"],
      ["screen:status", "ask", "ask"],
      ["screen:status", "ask", "setup"],
      ["screen:status", "ask", "recent"],
    ]);
    const r = computePredictionReport(loadPredictionRows(raw));
    expect(r.scored).toBe(4);
    expect(r.hits).toBe(2);
    expect(r.top1).toBe(0.5);
    expect(r.baselineTop1).toBe(0.5);
    expect(r.beatsBaseline).toBe(false);
    expect(r.calibration).toHaveLength(1);
    expect(r.calibration[0]).toMatchObject({ n: 4, observedRate: 0.5 });
    expect(r.calibration[0].meanPredicted).toBeCloseTo(0.6);
    const g = r.guide[0];
    expect(g).toMatchObject({ context_key: "screen:status", top1: "ask", n: 4 });
    expect(g.actual.map((a) => [a.value, a.n])).toEqual([["ask", 2], ["recent", 1], ["setup", 1]]);
    expect(g.actual.reduce((s, a) => s + a.prob, 0)).toBeCloseTo(1);
  });

  it("beats the baseline only when it genuinely does better", () => {
    const raw = fresh();
    seed(raw, [
      ["c", "ask", "ask"],
      ["c", "ask", "ask"],
      ["c", "ask", "ask"],
      ["c", "ask", "setup"],
    ]);
    const r = computePredictionReport(loadPredictionRows(raw));
    expect(r.top1).toBe(0.75);
    expect(r.baselineTop1).toBe(0.75);
    expect(r.beatsBaseline).toBe(false);
  });

  it("counts open and expired guesses but scores only HIT and MISS", () => {
    const raw = fresh();
    logPrediction(raw, guess({ made_seq: 1 }));
    logPrediction(raw, guess({ made_seq: 3, made_at: T0 + 10 }));
    resolveWithAction(raw, "d1", { seq: 2, ts: T0 + 100_000, value: "ask" });
    const r = computePredictionReport(loadPredictionRows(raw));
    expect(r).toMatchObject({ total: 2, expired: 1, open: 1, scored: 0, top1: null, beatsBaseline: null });
  });

  it("handles an empty log", () => {
    const r = computePredictionReport([]);
    expect(r).toMatchObject({ total: 0, scored: 0, top1: null, top3: null, baselineTop1: null, guide: [] });
    expect(formatPredictionReport(r)).toContain("n/a");
  });

  it("filters by time window when loading", () => {
    const raw = fresh();
    logPrediction(raw, guess({ made_seq: 1, made_at: T0 }));
    logPrediction(raw, guess({ made_seq: 2, made_at: T0 + 5000 }));
    expect(loadPredictionRows(raw, T0 + 1000)).toHaveLength(1);
  });
});
