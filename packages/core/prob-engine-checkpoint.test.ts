import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_EXPERTS,
  ProbEngine,
  candidateExperts,
  contextFeatures,
  ContextTracker,
  type FeatureMap,
} from "./index.js";
import {
  saveProbEngineCheckpoint,
  loadProbEngineCheckpoint,
  ensureCheckpointTable,
  serializeProbEngine,
} from "./prob-engine-checkpoint.js";

describe("ProbEngine Checkpointing & Serialization", () => {
  let dir: string;
  let db: { raw: DatabaseSync };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prob-chk-"));
    const raw = new DatabaseSync(join(dir, "test.db"));
    ensureCheckpointTable(raw);
    db = { raw };
  });

  afterEach(() => {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serializes and deserializes ProbEngine state with identical predictions", () => {
    const engine1 = new ProbEngine({ alpha: 2, share: 0.01 });

    const examples = [
      { cur: "status", feat: { daypart: "morning", app: "com.slack" }, actual: "ask" },
      { cur: "ask", feat: { daypart: "morning", app: "com.slack" }, actual: "status" },
      { cur: "status", feat: { daypart: "morning", app: "com.slack" }, actual: "ask" },
      { cur: "ask", feat: { daypart: "morning", app: "com.slack" }, actual: "settings" },
    ];

    for (const ex of examples) {
      engine1.observe(ex.cur, ex.feat, ex.actual);
    }

    const state = engine1.toJSON();
    const engine2 = ProbEngine.fromJSON(state, { alpha: 2, share: 0.01 });

    const testFeat: FeatureMap = { daypart: "morning", app: "com.slack" };
    const p1 = engine1.predict("status", testFeat);
    const p2 = engine2.predict("status", testFeat);

    expect(p2.probs).toEqual(p1.probs);
    expect(p2.temperature).toBe(p1.temperature);
    expect(p2.active).toEqual(p1.active);
    expect(p2.weights).toEqual(p1.weights);
    expect(engine2.examplesSeen).toBe(engine1.examplesSeen);

    // Further learning yields matching outcomes on both
    const loss1 = engine1.observe("status", testFeat, "ask");
    const loss2 = engine2.observe("status", testFeat, "ask");
    expect(loss2.logLoss).toBeCloseTo(loss1.logLoss, 10);
    expect(loss2.probOfActual).toBeCloseTo(loss1.probOfActual, 10);
  });

  it("persists and loads checkpoints to and from SQLite", () => {
    const engine = new ProbEngine();
    engine.observe("status", {}, "ask");
    engine.observe("ask", {}, "status");

    const features = { daypart: "afternoon", app: "com.exocortex" };
    saveProbEngineCheckpoint(db, "device-alpha", 42, "ask", features, engine);

    const loaded = loadProbEngineCheckpoint(db, "device-alpha");
    expect(loaded).not.toBeNull();
    expect(loaded!.device_id).toBe("device-alpha");
    expect(loaded!.last_seq).toBe(42);
    expect(loaded!.last_screen).toBe("ask");
    expect(JSON.parse(loaded!.last_features)).toEqual(features);

    const restoredEngine = ProbEngine.fromJSON(JSON.parse(loaded!.engine_json));
    expect(restoredEngine.examplesSeen).toBe(2);

    // Upsert / conflict resolution test
    engine.observe("status", {}, "settings");
    saveProbEngineCheckpoint(db, "device-alpha", 45, "settings", features, engine);

    const updated = loadProbEngineCheckpoint(db, "device-alpha");
    expect(updated!.last_seq).toBe(45);
    expect(updated!.last_screen).toBe("settings");
  });

  it("integrates triage category into ContextTracker and cur+triage expert", () => {
    const tracker = new ContextTracker();
    tracker.updateTriage("phone-triage", "urgent");

    const snapshot = tracker.snapshot("phone-triage", Date.now());
    expect(snapshot.triage).toBe("urgent");

    const features = contextFeatures(snapshot, "status");
    expect(features.triage).toBe("urgent");

    const engine = new ProbEngine();
    const dist = engine.predict("status", features);
    expect(dist.active).toContain("cur+triage");
  });

  describe("expert set changes", () => {
    const trained = (n = 60): ProbEngine => {
      const e = new ProbEngine();
      const acts = ["status", "ask", "setup"];
      for (let i = 0; i < n; i++) e.observe(acts[i % 3], { daypart: i % 2 ? "morning" : "evening", app: "com.slack" }, acts[(i + 1) % 3]);
      return e;
    };
    const sane = (d: { probs: Array<{ prob: number }>; weights: Record<string, number> }) => {
      expect(d.probs.every((p) => Number.isFinite(p.prob) && p.prob >= 0)).toBe(true);
      expect(d.probs.reduce((a, p) => a + p.prob, 0)).toBeCloseTo(1, 9);
      expect(Object.values(d.weights).every(Number.isFinite)).toBe(true);
    };

    it("loads a checkpoint saved with N experts into N+1 without NaN, via SQLite", () => {
      const old = trained();
      saveProbEngineCheckpoint(db, "dev", 7, "status", { daypart: "morning" }, old);
      const state = JSON.parse(loadProbEngineCheckpoint(db, "dev")!.engine_json);
      expect(state.logW.length).toBe(DEFAULT_EXPERTS.length);

      const next = ProbEngine.fromJSON(state, { experts: [...DEFAULT_EXPERTS, ...candidateExperts(["light"])] });
      const f: FeatureMap = { daypart: "morning", app: "com.slack", light: "dim" };
      const d = next.predict("status", f);
      sane(d);
      expect(d.active).toContain("cur+light");
      // The new expert starts at the uniform prior (before renormalising with the saved weights).
      const n = DEFAULT_EXPERTS.length + 1;
      const lw = next.toJSON().logW;
      const norm = Math.log(state.logW.reduce((a: number, v: number) => a + Math.exp(v), 0) + 1 / n);
      expect(lw[n - 1]).toBeCloseTo(-Math.log(n) - norm, 10);
      expect(lw[0]).toBeCloseTo(state.logW[0] - norm, 10);
      const r = next.observe("status", f, "ask");
      expect(Number.isFinite(r.logLoss)).toBe(true);
      sane(next.predict("ask", f));
      expect(next.toJSON().logW.every(Number.isFinite)).toBe(true);
    });

    it("leaves predictions unchanged when the expert set is identical", () => {
      const old = trained();
      const same = ProbEngine.fromJSON(old.toJSON());
      const f: FeatureMap = { daypart: "evening", app: "com.slack" };
      expect(same.predict("ask", f)).toEqual(old.predict("ask", f));
      expect(same.toJSON().logW).toEqual(old.toJSON().logW);
    });

    it("maps weights by name when experts are reordered or dropped", () => {
      const old = trained();
      const st = old.toJSON();
      const reordered = [...DEFAULT_EXPERTS].reverse();
      const rev = ProbEngine.fromJSON(st, { experts: reordered });
      const f: FeatureMap = { daypart: "morning", app: "com.slack" };
      const wOld = old.predict("status", f).weights;
      const wRev = rev.predict("status", f).weights;
      for (const k of Object.keys(wOld)) expect(wRev[k]).toBeCloseTo(wOld[k], 10);

      const dropped = ProbEngine.fromJSON(st, { experts: DEFAULT_EXPERTS.slice(0, 5) });
      sane(dropped.predict("status", f));
      const lw = dropped.toJSON().logW;
      expect(lw.reduce((a, v) => a + Math.exp(v), 0)).toBeCloseTo(1, 9);
    });

    it("tolerates a short or non-finite logW by falling back to the uniform prior", () => {
      const st = trained().toJSON();
      st.logW = st.logW.slice(0, 3);
      st.logW[1] = Number.NaN;
      const e = ProbEngine.fromJSON(st);
      sane(e.predict("status", { daypart: "morning", app: "com.slack" }));
      expect(e.toJSON().logW.every(Number.isFinite)).toBe(true);
    });
  });
});
