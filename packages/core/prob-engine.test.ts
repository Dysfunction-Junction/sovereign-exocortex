import { describe, it, expect } from "vitest";
import {
  OTHER,
  ProbEngine,
  baselineEngine,
  benchmarkAgainstSystemSuggestion,
  compareLogLoss,
  contextFeatures,
  prequential,
  summarize,
  type Example,
} from "./prob-engine.js";
import { timeContext, type PredictionContext } from "./prediction-log.js";

/** Deterministic PRNG so every run sees the same data. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

describe("probability mass", () => {
  it("knows nothing at first: all mass on OTHER", () => {
    const d = new ProbEngine().predict("home");
    expect(d.probs).toEqual([{ value: OTHER, prob: 1 }]);
  });

  it("always sums to 1 with every probability in (0,1], however the data looks", () => {
    const rnd = mulberry32(7);
    const e = new ProbEngine();
    const acts = ["a", "b", "c", "d", "e"];
    for (let i = 0; i < 300; i++) {
      const cur = acts[Math.floor(rnd() * acts.length)];
      const feats: Record<string, string> = {};
      if (rnd() < 0.7) feats.daypart = ["night", "morning", "evening"][Math.floor(rnd() * 3)];
      if (rnd() < 0.4) feats.network = rnd() < 0.5 ? "wifi" : "cell";
      const d = e.predict(cur, feats);
      expect(sum(d.probs.map((p) => p.prob))).toBeCloseTo(1, 10);
      for (const p of d.probs) {
        expect(p.prob).toBeGreaterThan(0);
        expect(p.prob).toBeLessThanOrEqual(1);
      }
      e.observe(cur, feats, acts[Math.floor(rnd() * acts.length)]);
    }
  });

  it("gives never-seen actions finite loss through the OTHER class", () => {
    const e = new ProbEngine();
    e.observe("a", {}, "b");
    const r = e.observe("a", {}, "brand-new");
    expect(Number.isFinite(r.logLoss)).toBe(true);
    expect(r.probOfActual).toBeGreaterThan(0);
    expect(e.predict("a").probs.some((p) => p.value === "brand-new")).toBe(true);
  });
});

describe("Dirichlet posterior predictive", () => {
  it("matches the closed form for a single bigram expert", () => {
    const alpha = 2;
    const beta = 1;
    const e = new ProbEngine({ experts: [{ name: "bigram", features: [] }], alpha, beta, share: 0, calibrateEvery: 1e9 });
    for (const y of ["b", "b", "b", "c"]) e.observe("a", {}, y);
    // Unigram over {b:3, c:1}, support b,c,OTHER (k = 3), N = 4.
    const uni = (n: number): number => (n + beta / 3) / (4 + beta);
    const pb = (3 + alpha * uni(3)) / (4 + alpha);
    const pc = (1 + alpha * uni(1)) / (4 + alpha);
    const pOther = (0 + alpha * uni(0)) / (4 + alpha);
    const d = e.predict("a");
    const got = Object.fromEntries(d.probs.map((p) => [p.value, p.prob]));
    expect(got.b).toBeCloseTo(pb, 12);
    expect(got.c).toBeCloseTo(pc, 12);
    expect(got[OTHER]).toBeCloseTo(pOther, 12);
    expect(pb + pc + pOther).toBeCloseTo(1, 12);
  });

  it("falls back to the unigram for a current action it has never left", () => {
    const e = new ProbEngine({ experts: [{ name: "bigram", features: [] }], share: 0, calibrateEvery: 1e9 });
    for (const y of ["b", "b", "c"]) e.observe("a", {}, y);
    const d = e.predict("never-seen-current");
    expect(d.probs[0].value).toBe("b");
  });
});

describe("learning from context", () => {
  /** After "home", the next action depends on time of day; 5% noise. */
  function dayparted(n: number, seed: number): Example[] {
    const rnd = mulberry32(seed);
    const out: Example[] = [];
    for (let i = 0; i < n; i++) {
      const daypart = rnd() < 0.5 ? "morning" : "evening";
      const noise = rnd() < 0.05;
      const target = daypart === "morning" ? "mail" : "video";
      const actual = noise ? (target === "mail" ? "video" : "mail") : target;
      out.push({ current: "home", features: { daypart, weekend: "0" }, actual });
    }
    return out;
  }

  it("beats the frequency baseline by a statistically significant margin when context matters", () => {
    const data = dayparted(400, 11);
    const eng = prequential(data, new ProbEngine());
    const base = prequential(data, baselineEngine());
    const cmp = compareLogLoss(eng, base);
    expect(cmp.significantlyBetter).toBe(true);
    expect(cmp.meanLogLossGain).toBeGreaterThan(0.2);
    expect(summarize(eng).top1!).toBeGreaterThan(summarize(base).top1! + 0.2);
  });

  it("moves mixture weight onto the experts that carry the signal", () => {
    const e = new ProbEngine();
    for (const ex of dayparted(300, 5)) e.observe(ex.current, ex.features, ex.actual);
    const w = e.predict("home", { daypart: "morning", weekend: "0" }).weights;
    expect(w["cur+daypart"]).toBeGreaterThan(w["bigram"]);
    expect(w["cur+daypart"]).toBeGreaterThan(w["cur+weekend"]);
  });

  it("is not meaningfully hurt by features that are pure noise", () => {
    const rnd = mulberry32(3);
    const data: Example[] = [];
    for (let i = 0; i < 400; i++) {
      data.push({
        current: "home",
        features: { daypart: ["night", "morning", "evening"][Math.floor(rnd() * 3)], network: rnd() < 0.5 ? "wifi" : "cell" },
        actual: rnd() < 0.7 ? "mail" : "video",
      });
    }
    const eng = summarize(prequential(data, new ProbEngine()));
    const base = summarize(prequential(data, baselineEngine()));
    expect(eng.meanLogLoss!).toBeLessThan(base.meanLogLoss! + 0.03);
    expect(compareLogLoss(prequential(data, baselineEngine()), prequential(data, new ProbEngine())).significantlyBetter).toBe(false);
  });

  it("sleeps experts whose features are missing instead of guessing", () => {
    const e = new ProbEngine();
    for (const ex of dayparted(60, 2)) e.observe(ex.current, ex.features, ex.actual);
    const withNone = e.predict("home", {});
    expect(withNone.active).toEqual(expect.arrayContaining(["unigram", "bigram"]));
    expect(withNone.active).not.toContain("cur+daypart");
    expect(sum(withNone.probs.map((p) => p.prob))).toBeCloseTo(1, 10);
    const withDaypart = e.predict("home", { daypart: "morning" });
    expect(withDaypart.active).toContain("cur+daypart");
  });
});

describe("calibration", () => {
  it("fits a temperature above 1 and lowers log loss when the experts are overconfident", () => {
    const rnd = mulberry32(21);
    const data: Example[] = [];
    // Pure noise over 4 actions, plus a 25-valued feature the experts will overfit.
    for (let i = 0; i < 1200; i++) {
      data.push({
        current: "home",
        features: { app: `app${Math.floor(rnd() * 25)}`, place: `p${Math.floor(rnd() * 25)}` },
        actual: ["a", "b", "c", "d"][Math.floor(rnd() * 4)],
      });
    }
    const loose = { alpha: 0.05, beta: 0.05, share: 0.2 };
    const raw = new ProbEngine({ ...loose, calibrateEvery: 1e9 });
    const cal = new ProbEngine({ ...loose, calibrateEvery: 20, calibrationMin: 40 });
    const rawLoss = summarize(prequential(data, raw)).meanLogLoss!;
    const calLoss = summarize(prequential(data, cal)).meanLogLoss!;
    expect(cal.currentTemperature).toBeGreaterThan(1.05);
    expect(calLoss).toBeLessThan(rawLoss);
  });

  it("leaves a well-calibrated engine near T = 1", () => {
    const rnd = mulberry32(8);
    const data: Example[] = [];
    for (let i = 0; i < 800; i++) data.push({ current: "home", features: {}, actual: rnd() < 0.6 ? "a" : "b" });
    const e = new ProbEngine();
    prequential(data, e);
    expect(e.currentTemperature).toBeGreaterThan(0.7);
    expect(e.currentTemperature).toBeLessThan(1.4);
  });
});

describe("scoring", () => {
  it("summarises proper scores and ECE for a trivially predictable stream", () => {
    const data: Example[] = Array.from({ length: 200 }, () => ({ current: "a", features: {}, actual: "b" }));
    const s = summarize(prequential(data, new ProbEngine()));
    expect(s.top1!).toBeGreaterThan(0.95);
    expect(s.meanLogLoss!).toBeLessThan(0.2);
    expect(s.meanBrier!).toBeLessThan(0.1);
    expect(s.ece!).toBeLessThan(0.1);
  });

  it("returns nulls for an empty series and refuses mismatched comparisons", () => {
    expect(summarize([])).toMatchObject({ n: 0, meanLogLoss: null, ece: null });
    const a = prequential([{ current: "a", features: {}, actual: "b" }], new ProbEngine());
    expect(() => compareLogLoss(a, [])).toThrow(RangeError);
    expect(compareLogLoss(a, a).significantlyBetter).toBe(false);
  });

  it("rejects invalid hyperparameters", () => {
    expect(() => new ProbEngine({ alpha: 0 })).toThrow(RangeError);
    expect(() => new ProbEngine({ share: 1 })).toThrow(RangeError);
    expect(() => new ProbEngine({ experts: [] })).toThrow(RangeError);
    expect(() => new ProbEngine().predict("")).toThrow(TypeError);
  });
});

describe("determinism", () => {
  it("replays to bit-identical predictions", () => {
    const rnd = mulberry32(99);
    const data: Example[] = Array.from({ length: 250 }, () => ({
      current: ["a", "b"][Math.floor(rnd() * 2)],
      features: { daypart: ["morning", "evening"][Math.floor(rnd() * 2)] },
      actual: ["x", "y", "z"][Math.floor(rnd() * 3)],
    }));
    const a = new ProbEngine();
    const b = new ProbEngine();
    for (const ex of data) {
      a.observe(ex.current, ex.features, ex.actual);
      b.observe(ex.current, ex.features, ex.actual);
    }
    expect(a.predict("a", { daypart: "morning" })).toEqual(b.predict("a", { daypart: "morning" }));
    expect(a.currentTemperature).toBe(b.currentTemperature);
  });
});

describe("contextFeatures", () => {
  it("buckets numeric signals and omits what is missing", () => {
    const ctx: PredictionContext = {
      time: timeContext(Date.UTC(2026, 9, 10, 20, 30), -300),
      app: { package: "com.example" },
      device: { screen_state: "ON", battery_pct: 15, charging: false, network: "wifi", idle_ms: 30_000 },
      ambient: { temp_c: 21.5 },
      location: { lat: 30.2672, lon: -97.7431 },
    };
    const f = contextFeatures(ctx, "status");
    expect(f).toMatchObject({
      prev: "status",
      daypart: "afternoon",
      weekend: "1",
      app: "com.example",
      screen_state: "ON",
      battery: "0-20",
      charging: "0",
      network: "wifi",
      idle: "5s-1m",
      temp: "18-24",
      place: "30.3,-97.7",
    });
    expect(contextFeatures(undefined)).toEqual({});
    expect(contextFeatures({ time: ctx.time }).battery).toBeUndefined();
  });

  it("extracts sys_suggest from system_suggestions", () => {
    const ctx: PredictionContext = {
      system_suggestions: {
        primary_action: "open_url",
        actions: ["open_url", "copy"],
      },
    };
    const f = contextFeatures(ctx);
    expect(f.sys_suggest).toBe("open_url");
  });
});

describe("benchmarkAgainstSystemSuggestion", () => {
  it("evaluates accuracy, coverage, agreement rate, and advantage against on-device system suggestions", () => {
    const items = [
      { actual: "open_url", exocortexTop: "open_url", systemSuggestion: "open_url" },
      { actual: "open_url", exocortexTop: "open_url", systemSuggestion: "view_map" },
      { actual: "view_map", exocortexTop: "call_phone", systemSuggestion: "view_map" },
      { actual: "setup", exocortexTop: "setup", systemSuggestion: "setup" },
      { actual: "settings", exocortexTop: "settings", systemSuggestion: "" }, // missing suggestion
    ];
    const bench = benchmarkAgainstSystemSuggestion(items);
    expect(bench.totalEvaluated).toBe(5);
    expect(bench.eligibleEvaluated).toBe(4);
    expect(bench.coverage).toBe(0.8);
    expect(bench.exocortexHits).toBe(3); // 3 of 4 eligible
    expect(bench.systemHits).toBe(3); // 3 of 4 eligible
    expect(bench.bothHit).toBe(2);
    expect(bench.exoOnlyHits).toBe(1);
    expect(bench.sysOnlyHits).toBe(1);
    expect(bench.agreementRate).toBe(0.5); // 2 of 4 had matching top prediction
    expect(bench.exocortexAccuracy).toBe(0.75);
    expect(bench.systemAccuracy).toBe(0.75);
    expect(bench.exocortexAdvantage).toBe(0);
    expect(bench.mcNemarSignificant).toBe(false);
  });

  it("handles empty items or items with no system suggestions gracefully", () => {
    expect(benchmarkAgainstSystemSuggestion([]).totalEvaluated).toBe(0);
    expect(benchmarkAgainstSystemSuggestion([{ actual: "a", exocortexTop: "a", systemSuggestion: null }]).eligibleEvaluated).toBe(0);
  });
});
