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

describe("report: calibration intervals and pre-registered baselines", () => {
  const dist = (cands: Array<[string, number]>) => ({ cands: cands.map(([value, prob]) => ({ value, prob })), other: 0.1 });
  function seed(raw: DatabaseSync, i: number, actual: string, eng: string, avg: string, pers: string, cold = false, dt = 1000, withBaselines = true) {
    const baselines = withBaselines
      ? { avg_usage: { ...dist([[avg, 0.6]]), n: 40, cell: "overall", cold_start: cold }, persistence: { ...dist([[pers, 0.6]]), repeat_rate: 0.5 } }
      : undefined;
    logPrediction(raw, guess({ made_seq: i * 10, made_at: T0 + i * 100_000, candidates: [{ value: eng, prob: 0.6 }], context: baselines ? { baselines } : {} }));
    resolveWithAction(raw, "d1", { seq: i * 10 + 1, ts: T0 + i * 100_000 + dt, value: actual });
  }

  it("adds Wilson 95% bounds to every calibration bin", () => {
    const raw = fresh();
    for (let i = 1; i <= 10; i++) seed(raw, i, i <= 6 ? "ask" : "x", "ask", "ask", "ask");
    const bin = computePredictionReport(loadPredictionRows(raw)).calibration[0];
    expect(bin.n).toBe(10);
    expect(bin.observedRate).toBeCloseTo(0.6);
    expect(bin.lo95).toBeGreaterThan(0.26);
    expect(bin.lo95).toBeLessThan(0.6);
    expect(bin.hi95).toBeGreaterThan(0.6);
    expect(bin.hi95).toBeLessThan(0.89);
    expect(formatPredictionReport(computePredictionReport(loadPredictionRows(raw)))).toContain("95% CI");
  });

  it("scores engine, avg_usage and persistence on identical rows, excluding cold start and legacy rows", () => {
    const raw = fresh();
    seed(raw, 1, "ask", "ask", "ask", "setup"); // persistence wrong
    seed(raw, 2, "ask", "ask", "setup", "ask"); // avg_usage wrong
    seed(raw, 3, "ask", "setup", "ask", "ask", true); // cold start: excluded
    seed(raw, 4, "ask", "ask", "ask", "ask", false, 1000, false); // legacy: no baselines
    const r = computePredictionReport(loadPredictionRows(raw));
    expect(r.baselines).toMatchObject({ n: 2, coldStart: 1, legacy: 1 });
    expect(r.baselines.engine.top1).toBe(1);
    expect(r.baselines.avg_usage.top1).toBe(0.5);
    expect(r.baselines.persistence.top1).toBe(0.5);
    expect(r.baselines.engine.logLoss!).toBeCloseTo(-Math.log(0.6));
    expect(r.baselines.avg_usage.logLoss!).toBeGreaterThan(r.baselines.engine.logLoss!);
    expect(r.baselines.avg_usage.logLoss!).toBeCloseTo((-Math.log(0.6) - Math.log(0.4)) / 2);
  });

  it("unconditional block includes EXPIRED rows that have an actual", () => {
    const raw = fresh();
    seed(raw, 1, "ask", "ask", "ask", "ask");
    seed(raw, 2, "ask", "ask", "setup", "ask", false, 200_000); // lands after the 60s horizon -> EXPIRED
    seed(raw, 3, "ask", "setup", "ask", "ask", false, 200_000);
    logPrediction(raw, guess({ made_seq: 99, made_at: T0 + 9_000_000 })); // open, no actual
    const r = computePredictionReport(loadPredictionRows(raw));
    expect(r.scored).toBe(1);
    expect(r.baselines.n).toBe(1);
    expect(r.unconditional.n).toBe(3);
    expect(r.unconditional.top1).toBeCloseTo(2 / 3);
    expect(r.unconditional.baselines.n).toBe(3);
    expect(r.unconditional.top1WilsonUpper!).toBeGreaterThan(r.unconditional.top1WilsonLower!);
  });
});

describe("streams", () => {
  it("a stream-filtered resolve leaves screen predictions open when an app action arrives", () => {
    const raw = fresh();
    logPrediction(raw, guess({ made_seq: 1 })); // legacy row: no context.stream, counts as "screen"
    logPrediction(raw, guess({ made_seq: 2, context: { stream: "app" } }));
    expect(resolveWithAction(raw, "d1", { seq: 3, ts: T0 + 1000, value: "ask" }, "app")).toBe(1);
    let rows = loadPredictionRows(raw);
    expect(rows.find((r) => r.made_seq === 1)!.outcome).toBeNull();
    expect(rows.find((r) => r.made_seq === 2)!.outcome).toBe("HIT");
    // The default stream is "screen": it resolves the legacy row and leaves nothing app-side to touch.
    expect(resolveWithAction(raw, "d1", { seq: 4, ts: T0 + 2000, value: "setup" })).toBe(1);
    rows = loadPredictionRows(raw);
    expect(rows.find((r) => r.made_seq === 1)!.outcome).toBe("MISS");
  });

  it("loads one stream's rows on request and keeps the stream in the stored context", () => {
    const raw = fresh();
    logPrediction(raw, guess({ made_seq: 1 }));
    logPrediction(raw, guess({ made_seq: 2, context: { stream: "app" } }));
    expect(loadPredictionRows(raw).length).toBe(2);
    expect(loadPredictionRows(raw, 0, "app").map((r) => r.made_seq)).toEqual([2]);
    expect(loadPredictionRows(raw, 0, "screen").map((r) => r.made_seq)).toEqual([1]);
    expect(loadPredictionRows(raw, 0, "app")[0].context.stream).toBe("app");
  });
});
