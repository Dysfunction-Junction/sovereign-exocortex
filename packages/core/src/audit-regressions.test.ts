import { describe, it, expect } from "vitest";
import { ExocortexDatabase } from "./db.js";
import { CandidatePool } from "./pool.js";
import { isClockExpired } from "./clocks.js";
import { PreCognitiveEngine } from "./precognitive.js";
import { DryRunCache } from "./dry-run.js";
import { clusterEventsToPatterns } from "./mishmash-rank.js";
import { LifecycleTier, PatternKind, TaskCategory, type WorkflowPattern } from "./types.js";

const mk = (id: string, score: number, observedAt: string): WorkflowPattern => ({
  id,
  name: id,
  description: "",
  kind: PatternKind.Sequence,
  taskCategory: TaskCategory.Coding,
  tier: LifecycleTier.Candidate,
  tierEnteredAt: observedAt,
  keepClockExpiresAt: null,
  reusabilityCount: 0,
  promotionScore: score,
  lastObservedAt: observedAt,
  lastExecutedAt: null,
  timesPrompted: 0,
  timesAccepted: 0,
  timesDismissed: 0,
  triggerSignature: { sourceApps: [] },
  createdBy: "t",
  createdAt: observedAt,
  updatedAt: observedAt,
});

describe("audit regressions (core)", () => {
  it("CandidatePool.addOrUpdate does not compound decay on untouched items across calls", () => {
    const pool = new CandidatePool(5);
    const t0 = "2026-01-01T00:00:00.000Z";
    const now = new Date("2026-01-31T00:00:00.000Z"); // exactly one half-life (30d)
    const r1 = pool.addOrUpdate([mk("a", 8, t0)], mk("b", 1, t0), 1.0, now);
    const a1 = r1.pool.find((p) => p.id === "a")!;
    expect(a1.promotionScore).toBeCloseTo(4, 6);
    // Same instant again: no further decay may occur
    const r2 = pool.addOrUpdate(r1.pool, mk("c", 1, t0), 1.0, now);
    expect(r2.pool.find((p) => p.id === "a")!.promotionScore).toBeCloseTo(4, 6);
  });

  it("CandidatePool with zero capacity does not throw", () => {
    const pool = new CandidatePool(0);
    const res = pool.addOrUpdate([], mk("a", 1, "2026-01-01T00:00:00.000Z"));
    expect(res.insertedOrUpdated).toBe(false);
    expect(res.pool).toHaveLength(0);
  });

  it("isClockExpired treats an unparseable timestamp as expired (fail closed)", () => {
    expect(isClockExpired("not-a-date", new Date())).toBe(true);
  });

  it("PreCognitiveEngine does not report an expired/released stage as pre-staged on SCREEN_OFF", () => {
    const cache = new DryRunCache();
    const engine = new PreCognitiveEngine(cache);
    const first = engine.handleScreenStateChange("SCREEN_OFF", 1000, () => ({
      candidateId: "c1",
      payload: {},
      summary: "s",
    }));
    expect(first.isPreStaged).toBe(true);
    cache.clearProposal(first.preStagedProposalId!);
    const second = engine.handleScreenStateChange("SCREEN_OFF", 2000);
    expect(second.isPreStaged).toBe(false);
    expect(second.preStagedProposalId).toBeUndefined();
    expect(engine.getReadyProposal()).toBeNull();
  });

  it("PreCognitiveEngine hesitation score is never NaN", () => {
    const engine = new PreCognitiveEngine(new DryRunCache());
    expect(engine.recordTouchInteraction(Number.NaN)).toBe(0.05);
  });

  it("insertProposal fails closed to shadow=1 when shadow is omitted", () => {
    const db = new ExocortexDatabase({ path: ":memory:" });
    db.registerDevice({
      device_id: "d",
      name: "d",
      platform: "linux",
      pubkey_spki: new Uint8Array([1]),
      key_attested: 0,
      scopes: [],
      enrolled_at: 1,
    });
    const ev = db.ingestEvent("d", { event_id: "e1", kind: "observation", ts_device: 1, schema_ver: 1, payload: {} });
    const base = {
      created_seq: ev.event.seq,
      policy_type: "PRAGMATIC" as const,
      tier: 1 as const,
      summary: "s",
      action: "{}",
      action_hash: new Uint8Array([1]),
      efe: 0,
      risk_term: 0,
      ambiguity_term: 0,
      state: "STAGED" as const,
      expires_at: 1,
      updated_at: 1,
    };
    db.insertProposal({ ...base, proposal_id: "p_omitted" } as any);
    db.insertProposal({ ...base, proposal_id: "p_live", shadow: 0 });
    expect(db.getProposal("p_omitted")?.shadow).toBe(1);
    expect(db.getProposal("p_live")?.shadow).toBe(0);
    db.close();
  });

  it("clusterEventsToPatterns honours TelemetryEvent.packageName and numeric timestamps", () => {
    const ts = Date.parse("2026-10-01T00:00:00.000Z");
    const out = clusterEventsToPatterns(
      [
        { packageName: "com.a", timestamp: ts },
        { packageName: "com.a", timestamp: ts + 1000 },
        { packageName: "com.b", timestamp: ts },
      ],
      "2026-10-08T00:00:00.000Z",
    );
    expect(out.map((p) => p.id).sort()).toEqual(["cluster-com.a", "cluster-com.b"]);
    const a = out.find((p) => p.id === "cluster-com.a")!;
    expect(a.promotionScore).toBe(20);
    expect(a.lastObservedAt).toBe(new Date(ts + 1000).toISOString());
  });

  it("recordShadowLabel: an inferred label never overwrites a human tap label", () => {
    const db = new ExocortexDatabase({ path: ":memory:" });
    const now = Date.now();
    db.registerDevice({
      device_id: "dev_lbl", name: "dev_lbl", platform: "linux", pubkey_spki: new Uint8Array([0]),
      key_attested: 0, scopes: ["telemetry:write"], enrolled_at: now, revoked_at: null,
    });
    const ev = db.ingestEvent("dev_lbl", { event_id: "evt_lbl", kind: "telemetry", ts_device: 1, schema_ver: 1, payload: {} });
    db.insertProposal({
      proposal_id: "prop_tap", created_seq: ev.event.seq, invariant_id: null, policy_type: "PRAGMATIC",
      tier: 1, summary: "s", action: "{}", action_hash: new Uint8Array([1]), efe: 1, risk_term: 0.1,
      ambiguity_term: 0.05, state: "SURFACED", shadow: 1, expires_at: now + 60000, updated_at: now,
    });
    db.recordShadowLabel({ proposal_id: "prop_tap", label: "wanted", actual: JSON.stringify({ source: "tap" }), ts: now });
    db.recordShadowLabel({ proposal_id: "prop_tap", label: "ignored", actual: JSON.stringify({ source: "inferred" }), ts: now + 1 });
    expect(db.getShadowLabels("prop_tap")[0].label).toBe("wanted");
    // a later tap still replaces an earlier tap, and inferred can replace inferred
    db.recordShadowLabel({ proposal_id: "prop_tap", label: "not_wanted", actual: JSON.stringify({ source: "tap" }), ts: now + 2 });
    expect(db.getShadowLabels("prop_tap")[0].label).toBe("not_wanted");
    db.close();
  });
});
