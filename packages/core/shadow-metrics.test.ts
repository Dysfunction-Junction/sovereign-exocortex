import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  computeSameHourYesterdayBaseline,
  computeShadowMetrics,
  evaluateSystemSuggestionDecisions,
  formatShadowReport,
  loadShadowRows,
  type ShadowRow,
} from "./shadow-metrics.js";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const OPTS = { nowMs: NOW, minLabels: 20 };

function row({ id, ...over }: Partial<ShadowRow> & { id: string }): ShadowRow {
  return {
    proposal_id: id,
    shadow: 1,
    decision: "SURFACE",
    mode: "MAINTENANCE",
    gate_ts: NOW - DAY,
    label: null,
    label_source: null,
    ...over,
  };
}

function rows(spec: Record<string, number>): ShadowRow[] {
  const out: ShadowRow[] = [];
  let i = 0;
  for (const [label, n] of Object.entries(spec)) {
    for (let k = 0; k < n; k++) {
      out.push(
        row({
          id: `p${i++}`,
          label: label === "none" ? null : (label as ShadowRow["label"]),
        }),
      );
    }
  }
  return out;
}

describe("computeShadowMetrics", () => {
  it("computes precision, coverage and counts", () => {
    const m = computeShadowMetrics(rows({ wanted: 18, not_wanted: 2, ignored: 5, already_did: 3, none: 2 }), OPTS);
    expect(m.surfaced).toBe(30);
    expect(m.wanted).toBe(18);
    expect(m.notWanted).toBe(2);
    expect(m.precision).toBeCloseTo(0.9, 10);
    expect(m.pessimisticPrecision).toBeCloseTo(18 / 25, 10);
    expect(m.coverage).toBeCloseTo(20 / 30, 10);
    expect(m.unlabeled).toBe(2);
    expect(m.verdict).toBe("pass");
    expect(m.breakerTripped).toBe(false);
  });

  it("returns null precision and insufficient_data with no tapped labels", () => {
    const m = computeShadowMetrics(rows({ ignored: 4 }), OPTS);
    expect(m.precision).toBeNull();
    expect(m.wilsonLower).toBeNull();
    expect(m.verdict).toBe("insufficient_data");
    expect(m.breakerTripped).toBe(false);
  });

  it("reports insufficient_data below minLabels even if precision is perfect", () => {
    const m = computeShadowMetrics(rows({ wanted: 5 }), OPTS);
    expect(m.precision).toBe(1);
    expect(m.verdict).toBe("insufficient_data");
  });

  it("fails and trips breaker when precision is below threshold with enough labels", () => {
    const m = computeShadowMetrics(rows({ wanted: 15, not_wanted: 10 }), OPTS);
    expect(m.precision).toBeCloseTo(0.6, 10);
    expect(m.verdict).toBe("fail");
    expect(m.breakerTripped).toBe(true);
  });

  it("wilson lower bound is below the point estimate", () => {
    const m = computeShadowMetrics(rows({ wanted: 18, not_wanted: 2 }), OPTS);
    expect(m.wilsonLower!).toBeGreaterThan(0.68);
    expect(m.wilsonLower!).toBeLessThan(0.9);
  });

  it("excludes rows outside the window, non-shadow rows and non-SURFACE rows", () => {
    const data = [
      ...rows({ wanted: 20 }),
      row({ id: "old", label: "not_wanted", gate_ts: NOW - 15 * DAY }),
      row({ id: "live", label: "not_wanted", shadow: 0 }),
      row({ id: "queued", label: "not_wanted", decision: "QUEUE" }),
    ];
    const m = computeShadowMetrics(data, OPTS);
    expect(m.surfaced).toBe(20);
    expect(m.precision).toBe(1);
  });

  it("counts focus regret from SURFACE rows in DEEP_FOCUS", () => {
    const data = [
      row({ id: "a", mode: "DEEP_FOCUS", label: "already_did" }),
      row({ id: "d", mode: "DEEP_FOCUS", label: "ignored" }),
      row({ id: "e", mode: "DEEP_FOCUS", label: "wanted", label_source: "tap" }),
      row({ id: "f", mode: "DEEP_FOCUS", label: "not_wanted", label_source: "inferred" }),
      row({ id: "b", mode: "DEEP_FOCUS", decision: "QUEUE" }),
      row({ id: "c" }),
    ];
    const metrics = computeShadowMetrics(data, OPTS);
    expect(metrics.focusRegret).toBe(4);
    expect(metrics.focusOutcomes).toEqual({ wanted: 1, notWanted: 0, inferredWanted: 0, inferredNotWanted: 1, alreadyDid: 1, ignored: 1, unlabeled: 0 });
  });

  it("splits label sources and honours explicit source", () => {
    const data = [
      row({ id: "a", label: "wanted", label_source: "tap" }),
      row({ id: "b", label: "ignored", label_source: "inferred" }),
      row({ id: "c", label: "wanted", label_source: "inferred" }),
    ];
    const m = computeShadowMetrics(data, OPTS);
    expect(m.tapped).toBe(1);
    expect(m.inferred).toBe(2);
  });

  it("flags heuristic_scorer when the baseline is not beaten", () => {
    const data = rows({ wanted: 23, not_wanted: 2 });
    const m = computeShadowMetrics(data, { ...OPTS, baselinePrecision: 0.95 });
    expect(m.baselineGap).toBeCloseTo(0.92 - 0.95, 10);
    expect(m.verdict).toBe("heuristic_scorer");
    const ok = computeShadowMetrics(data, { ...OPTS, baselinePrecision: 0.7 });
    expect(ok.baselineGap).toBeCloseTo(0.22, 10);
    expect(ok.verdict).toBe("pass");
  });

  it("uses only the latest gate decision per proposal and collapses duplicates", () => {
    const data = [
      row({ id: "x", decision: "SURFACE", gate_ts: NOW - 2 * DAY, label: "wanted" }),
      row({ id: "x", decision: "QUEUE", gate_ts: NOW - DAY }),
      row({ id: "y", decision: "SURFACE", gate_ts: NOW - DAY, label: "wanted" }),
      row({ id: "y", decision: "SURFACE", gate_ts: NOW - DAY, label: "wanted" }),
    ];
    expect(computeShadowMetrics(data, OPTS).surfaced).toBe(1);
  });

  it("pins window boundaries: excludes gate_ts == since, includes gate_ts == now", () => {
    const data = [
      row({ id: "edge-old", gate_ts: NOW - 14 * DAY, label: "wanted" }),
      row({ id: "edge-now", gate_ts: NOW, label: "wanted" }),
    ];
    expect(computeShadowMetrics(data, OPTS).surfaced).toBe(1);
  });

  it("keeps a failing system failing even when it also loses to the baseline", () => {
    const m = computeShadowMetrics(rows({ wanted: 15, not_wanted: 10 }), { ...OPTS, baselinePrecision: 0.7 });
    expect(m.verdict).toBe("fail");
    expect(m.breakerTripped).toBe(true);
  });

  it("excludes inferred wanted/not_wanted from precision", () => {
    const data = [
      ...rows({ wanted: 18, not_wanted: 2 }),
      ...Array.from({ length: 30 }, (_, i) => row({ id: `inf${i}`, label: "wanted", label_source: "inferred" })),
    ];
    const m = computeShadowMetrics(data, OPTS);
    expect(m.precision).toBeCloseTo(0.9, 10);
    expect(m.inferredDecided).toBe(30);
    expect(m.wanted + m.notWanted + m.alreadyDid + m.ignored + m.unlabeled + m.inferredDecided).toBe(m.surfaced);
  });

  it("defaults minLabels to 50", () => {
    const m = computeShadowMetrics(rows({ wanted: 30 }), { nowMs: NOW });
    expect(m.verdict).toBe("insufficient_data");
  });

  it("pins the Wilson lower bound for 18/20", () => {
    const m = computeShadowMetrics(rows({ wanted: 18, not_wanted: 2 }), OPTS);
    expect(m.wilsonLower!).toBeCloseTo(0.699, 2);
  });
});

describe("loadShadowRows + formatShadowReport (sqlite)", () => {
  it("loads latest gate decision joined with labels, read-only", () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec(`
      INSERT INTO proposals(proposal_id,created_seq,policy_type,tier,summary,action,action_hash,efe,risk_term,ambiguity_term,state,shadow,expires_at,updated_at)
        VALUES ('p1',1,'PRAGMATIC',1,'s','{}',x'01',1,0,0,'SURFACED',1,1,1);
      INSERT INTO gate_decisions(proposal_id,mode,decision,reason,ts) VALUES ('p1','MAINTENANCE','QUEUE','r',${NOW - 2 * DAY});
      INSERT INTO gate_decisions(proposal_id,mode,decision,reason,ts) VALUES ('p1','DEEP_FOCUS','SURFACE','r',${NOW - DAY});
      INSERT INTO shadow_labels(proposal_id,label,actual,latency_ms,ts) VALUES ('p1','wanted','{"source":"tap"}',10,${NOW});
    `);
    const loaded = loadShadowRows(raw, { restoreQueryOnly: false });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      proposal_id: "p1",
      decision: "SURFACE",
      mode: "DEEP_FOCUS",
      label: "wanted",
      label_source: "tap",
    });
    expect(() => raw.exec("DELETE FROM proposals")).toThrow();
    const m = computeShadowMetrics(loaded, OPTS);
    const text = formatShadowReport(m);
    expect(text).toContain("Precision@surface");
    expect(text).toContain("insufficient_data");
  });

  it("by default restores query_only = OFF on read-write connections", () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    const loaded = loadShadowRows(raw);
    expect(loaded).toHaveLength(0);
    // Writes should succeed because query_only was restored
    expect(() => raw.exec("INSERT INTO devices(device_id, name, platform, pubkey_spki, scopes, enrolled_at) VALUES ('d1', 'n', 'android', x'01', '[]', 1)")).not.toThrow();
  });

  it("rejects unknown label values instead of dropping them from the accounting", () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec("PRAGMA ignore_check_constraints = ON");
    raw.exec(`
      INSERT INTO proposals(proposal_id,created_seq,policy_type,tier,summary,action,action_hash,efe,risk_term,ambiguity_term,state,shadow,expires_at,updated_at)
        VALUES ('p1',1,'PRAGMATIC',1,'s','{}',x'01',1,0,0,'SURFACED',1,1,1);
      INSERT INTO gate_decisions(proposal_id,mode,decision,reason,ts) VALUES ('p1','MAINTENANCE','SURFACE','r',${NOW});
      INSERT INTO shadow_labels(proposal_id,label,actual,latency_ms,ts) VALUES ('p1','bogus',NULL,NULL,${NOW});
    `);
    expect(() => loadShadowRows(raw)).toThrow(/unknown label/);
  });
});

describe("computeSameHourYesterdayBaseline (sqlite)", () => {
  function createTestDb(): DatabaseSync {
    const raw = new DatabaseSync(":memory:");
    raw.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    raw.exec("PRAGMA foreign_keys = OFF");
    return raw;
  }

  it("scores baseline precision when yesterday has matching surfaced action", () => {
    const raw = createTestDb();
    raw.exec(`
      INSERT INTO proposals(proposal_id,created_seq,policy_type,tier,summary,action,action_hash,efe,risk_term,ambiguity_term,state,shadow,expires_at,updated_at)
        VALUES ('p0',1,'PRAGMATIC',1,'s','{"op":"review"}',x'01',1,0,0,'SURFACED',1,1,1);
      INSERT INTO gate_decisions(proposal_id,mode,decision,reason,ts) VALUES ('p0','MAINTENANCE','SURFACE','r',${NOW - DAY});

      INSERT INTO proposals(proposal_id,created_seq,policy_type,tier,summary,action,action_hash,efe,risk_term,ambiguity_term,state,shadow,expires_at,updated_at)
        VALUES ('p1',2,'PRAGMATIC',1,'s','{"op":"review"}',x'02',1,0,0,'SURFACED',1,1,1);
      INSERT INTO gate_decisions(proposal_id,mode,decision,reason,ts) VALUES ('p1','MAINTENANCE','SURFACE','r',${NOW});
      INSERT INTO shadow_labels(proposal_id,label,actual,latency_ms,ts) VALUES ('p1','wanted','{"source":"tap"}',10,${NOW});
    `);

    const baseline = computeSameHourYesterdayBaseline(raw, { nowMs: NOW, windowDays: 7, minEvaluations: 1 });
    expect(baseline.evaluations).toBe(1);
    expect(baseline.baselineWanted).toBe(1);
    expect(baseline.baselineNotWanted).toBe(0);
    expect(baseline.baselinePrecision).toBe(1.0);
  });

  it("penalizes baseline when yesterday action was different", () => {
    const raw = createTestDb();
    raw.exec(`
      INSERT INTO proposals(proposal_id,created_seq,policy_type,tier,summary,action,action_hash,efe,risk_term,ambiguity_term,state,shadow,expires_at,updated_at)
        VALUES ('p0',1,'PRAGMATIC',1,'s','{"op":"other"}',x'01',1,0,0,'SURFACED',1,1,1);
      INSERT INTO gate_decisions(proposal_id,mode,decision,reason,ts) VALUES ('p0','MAINTENANCE','SURFACE','r',${NOW - DAY});

      INSERT INTO proposals(proposal_id,created_seq,policy_type,tier,summary,action,action_hash,efe,risk_term,ambiguity_term,state,shadow,expires_at,updated_at)
        VALUES ('p1',2,'PRAGMATIC',1,'s','{"op":"review"}',x'02',1,0,0,'SURFACED',1,1,1);
      INSERT INTO gate_decisions(proposal_id,mode,decision,reason,ts) VALUES ('p1','MAINTENANCE','SURFACE','r',${NOW});
      INSERT INTO shadow_labels(proposal_id,label,actual,latency_ms,ts) VALUES ('p1','wanted','{"source":"tap"}',10,${NOW});
    `);

    const baseline = computeSameHourYesterdayBaseline(raw, { nowMs: NOW, windowDays: 7, minEvaluations: 1 });
    expect(baseline.evaluations).toBe(1);
    expect(baseline.baselineWanted).toBe(0);
    expect(baseline.baselineNotWanted).toBe(1);
    expect(baseline.baselinePrecision).toBe(0.0);
  });

  it("returns null baseline when no proposals surfaced at that hour yesterday", () => {
    const raw = createTestDb();
    raw.exec(`
      INSERT INTO proposals(proposal_id,created_seq,policy_type,tier,summary,action,action_hash,efe,risk_term,ambiguity_term,state,shadow,expires_at,updated_at)
        VALUES ('p1',2,'PRAGMATIC',1,'s','{"op":"review"}',x'02',1,0,0,'SURFACED',1,1,1);
      INSERT INTO gate_decisions(proposal_id,mode,decision,reason,ts) VALUES ('p1','MAINTENANCE','SURFACE','r',${NOW});
      INSERT INTO shadow_labels(proposal_id,label,actual,latency_ms,ts) VALUES ('p1','wanted','{"source":"tap"}',10,${NOW});
    `);

    const baseline = computeSameHourYesterdayBaseline(raw, { nowMs: NOW, windowDays: 7, minEvaluations: 1 });
    expect(baseline.evaluations).toBe(0);
    expect(baseline.baselinePrecision).toBeNull();
  });

  it("auto-resolves baseline in computeShadowMetrics when opts.db is provided", () => {
    const raw = createTestDb();
    for (let i = 0; i < 20; i++) {
      raw.exec(`
        INSERT INTO proposals(proposal_id,created_seq,policy_type,tier,summary,action,action_hash,efe,risk_term,ambiguity_term,state,shadow,expires_at,updated_at)
          VALUES ('y${i}',${100 + i},'PRAGMATIC',1,'s','{"op":"review"}',x'01',1,0,0,'SURFACED',1,1,1);
        INSERT INTO gate_decisions(proposal_id,mode,decision,reason,ts)
          VALUES ('y${i}','MAINTENANCE','SURFACE','r',${NOW - DAY + i * 10});
      `);
    }
    for (let i = 0; i < 20; i++) {
      raw.exec(`
        INSERT INTO proposals(proposal_id,created_seq,policy_type,tier,summary,action,action_hash,efe,risk_term,ambiguity_term,state,shadow,expires_at,updated_at)
          VALUES ('t${i}',${200 + i},'PRAGMATIC',1,'s','{"op":"review"}',x'02',1,0,0,'SURFACED',1,1,1);
        INSERT INTO gate_decisions(proposal_id,mode,decision,reason,ts)
          VALUES ('t${i}','MAINTENANCE','SURFACE','r',${NOW + i * 10});
        INSERT INTO shadow_labels(proposal_id,label,actual,latency_ms,ts)
          VALUES ('t${i}','wanted','{"source":"tap"}',10,${NOW + i * 10});
      `);
    }

    const rows = loadShadowRows(raw);
    const metrics = computeShadowMetrics(rows, { nowMs: NOW + 1000, minLabels: 20, db: raw });
    expect(metrics.baselinePrecision).toBe(1.0);
    expect(metrics.baselineEvaluations).toBe(20);
    expect(metrics.baselineGap).toBe(0.0);
    expect(metrics.verdict).toBe("heuristic_scorer");

    const report = formatShadowReport(metrics);
    expect(report).toContain("baseline 100.0%, n=20");
  });
});

describe("evaluateSystemSuggestionDecisions", () => {
  it("computes empirical acceptance rate, Wilson lower bound, and dwell times", () => {
    const records = [
      { decision: "ACCEPTED" as const, dwellMs: 1500, suggestionType: "open_url" },
      { decision: "ACCEPTED" as const, dwellMs: 500, suggestionType: "open_url" },
      { decision: "IGNORED" as const, dwellMs: 3000, suggestionType: "view_map" },
      { decision: "IGNORED" as const, dwellMs: 5000, suggestionType: "call_phone" },
    ];
    const res = evaluateSystemSuggestionDecisions(records);
    expect(res.sampleCount).toBe(4);
    expect(res.acceptedCount).toBe(2);
    expect(res.ignoredCount).toBe(2);
    expect(res.acceptanceRate).toBe(0.5);
    expect(res.wilsonLower).not.toBeNull();
    expect(res.wilsonLower).toBeLessThan(0.5);
    expect(res.meanAcceptedDwellMs).toBe(1000); // (1500 + 500) / 2
    expect(res.meanIgnoredDwellMs).toBe(4000); // (3000 + 5000) / 2
  });

  it("handles empty records gracefully", () => {
    const res = evaluateSystemSuggestionDecisions([]);
    expect(res.sampleCount).toBe(0);
    expect(res.acceptanceRate).toBeNull();
    expect(res.wilsonLower).toBeNull();
  });
});

