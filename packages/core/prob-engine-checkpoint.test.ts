import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ProbEngine,
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
});
