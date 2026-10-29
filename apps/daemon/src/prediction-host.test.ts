import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExocortexDatabase } from "@exocortex/core/db";
import { loadPredictionRows, computePredictionReport, loadProbEngineCheckpoint, type EventIn } from "@exocortex/core";
import { PredictionHost } from "./prediction-host.js";

const T0 = Date.UTC(2026, 9, 10, 15, 0, 0);
const DEVICE = "phone-1";

describe("PredictionHost", () => {
  let dir: string;
  let db: ExocortexDatabase;
  let n = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pred-host-"));
    db = new ExocortexDatabase({ path: join(dir, "t.db") });
    db.registerDevice({
      device_id: DEVICE,
      name: "test phone",
      platform: "android",
      pubkey_spki: new Uint8Array([1]),
      key_attested: 0,
      scopes: [],
      enrolled_at: T0,
      revoked_at: null,
    });
    n = 0;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const host = (): PredictionHost => new PredictionHost({ horizonMs: 60_000, tzOffsetMin: () => 0 });

  function ingest(events: Array<Omit<EventIn, "event_id" | "schema_ver">>) {
    return db.ingestBatch({ device_id: DEVICE, events: events.map((e) => ({ ...e, event_id: `e${++n}`, schema_ver: 1 as const })) });
  }
  const view = (screen: string, dt: number): Omit<EventIn, "event_id" | "schema_ver"> => ({
    kind: "touch",
    ts_device: T0 + dt,
    payload: { type: "screen_view", screen },
  });

  it("logs a guess per screen view, resolves it on the next one, and keeps misses with the real action", () => {
    const h = host();
    const r1 = ingest([view("status", 0), view("ask", 1000), view("status", 2000), view("ask", 3000), view("setup", 4000)]);
    const out = h.onEventsAppended(r1.events, db);
    assert.ok(out.guesses >= 3);

    const rows = loadPredictionRows(db.raw);
    const resolved = rows.filter((r) => r.outcome !== null);
    assert.ok(resolved.length >= 2);
    const misses = rows.filter((r) => r.outcome === "MISS");
    assert.ok(misses.length >= 1, "expected misses");
    for (const m of misses) assert.ok(m.actual && m.actual !== m.candidates[0].value, "a miss keeps the real, different action");
    const miss = misses.find((r) => r.actual === "setup");
    assert.ok(miss, "the screen the model never expected is recorded");
    assert.equal(miss.hit_rank, null);
    assert.ok(miss.actual_context?.time, "the situation at the real action is stored");
    assert.ok(miss.latency_ms !== null && miss.latency_ms >= 0);
    for (const r of rows) assert.ok(Math.abs(r.candidates.reduce((s, c) => s + c.prob, 0)) <= 1 + 1e-9);
  });

  it("stores the full context, names what was missing, and never invents a signal", () => {
    const h = host();
    const r = ingest([
      { kind: "telemetry", ts_device: T0, payload: { package: "com.x", app_label: "X", battery_pct: 64, charging: false, network: "wifi" } },
      view("status", 100),
      view("ask", 200),
      view("status", 300),
    ]);
    h.onEventsAppended(r.events, db);
    const last = loadPredictionRows(db.raw).at(-1)!;
    assert.equal(last.context.device?.battery_pct, 64);
    assert.equal(last.context.device?.network, "wifi");
    assert.equal(last.context.app?.package, "com.x");
    assert.equal(last.context.time?.daypart, "afternoon");
    assert.ok(last.context.missing?.includes("ambient.temp_c"));
    assert.ok(last.context.missing?.includes("location"));
    assert.equal(last.context.ambient, undefined);
    assert.equal(last.context.location, undefined);
    const model = last.context.model as { examples_seen: number; active_experts: string[] };
    assert.ok(model.active_experts.includes("bigram"));
    assert.ok(model.active_experts.includes("cur+battery"));
  });

  it("ignores events that are not screen views and does not process a batch twice", () => {
    const h = host();
    const r = ingest([{ kind: "touch", ts_device: T0, payload: { type: "tap", screen: "status" } }, view("status", 10), view("ask", 20)]);
    h.onEventsAppended(r.events, db);
    const before = loadPredictionRows(db.raw).length;
    h.onEventsAppended(r.events, db);
    assert.equal(loadPredictionRows(db.raw).length, before);
  });

  it("rebuilds its model from the log after a restart and carries on without gaps or repeats", () => {
    const a = host();
    a.onEventsAppended(ingest([view("status", 0), view("ask", 1000), view("status", 2000), view("ask", 3000)]).events, db);
    const afterFirst = loadPredictionRows(db.raw);

    const b = host(); // fresh process
    const more = ingest([view("status", 4000), view("ask", 5000)]);
    b.onEventsAppended(more.events, db);
    const rows = loadPredictionRows(db.raw);
    assert.equal(rows.length, afterFirst.length + 2);
    assert.equal(new Set(rows.map((r) => r.prediction_id)).size, rows.length);
    // The open guess made before the restart was resolved by the first view after it.
    const crossing = rows.find((r) => r.made_seq === afterFirst.at(-1)!.made_seq)!;
    assert.equal(crossing.outcome !== null, true);
    assert.equal(crossing.actual, "status");
    // The restarted model has seen the earlier history, so it is not starting cold.
    const model = rows.at(-1)!.context.model as { examples_seen: number };
    assert.ok(model.examples_seen >= 4);
  });

  it("expires a guess whose next action arrives after the horizon, but still records what happened", () => {
    const h = host();
    h.onEventsAppended(ingest([view("status", 0), view("ask", 1000), view("status", 2000)]).events, db);
    h.onEventsAppended(ingest([view("ask", 2000 + 61_000)]).events, db);
    const late = loadPredictionRows(db.raw).find((r) => r.latency_ms !== null && r.latency_ms > 60_000)!;
    assert.equal(late.outcome, "EXPIRED");
    assert.equal(late.actual, "ask");
  });

  it("produces a report once enough guesses have resolved", () => {
    const h = host();
    const evs = [];
    for (let i = 0; i < 30; i++) evs.push(view(i % 2 === 0 ? "status" : "ask", i * 1000));
    h.onEventsAppended(ingest(evs).events, db);
    const report = computePredictionReport(loadPredictionRows(db.raw));
    assert.ok(report.scored >= 25);
    assert.ok(report.top1! > 0.7, `alternating screens should be learned, got ${report.top1}`);
    assert.ok(report.guide.length > 0);
  });
  it("serializes engine state to checkpoint every N observations and hydrates O(1)", () => {
    // Test with checkpointInterval: 3
    const h1 = new PredictionHost({ horizonMs: 60_000, tzOffsetMin: () => 0, checkpointInterval: 3 });
    const evs = ingest([
      view("status", 0),
      view("ask", 1000),   // obs 1
      view("status", 2000),// obs 2
      view("ask", 3000),   // obs 3 -> triggers checkpoint!
    ]);
    h1.onEventsAppended(evs.events, db);

    const chk = loadProbEngineCheckpoint(db, DEVICE);
    assert.ok(chk, "checkpoint should exist in prob_engine_checkpoints");
    assert.equal(chk.device_id, DEVICE);
    assert.ok(chk.last_seq >= evs.events[3].seq);
    assert.equal(chk.last_screen, "ask");
    assert.ok(chk.engine_json.includes('"seen":3'));

    // Fresh instance hydrates from checkpoint in O(1)
    const h2 = new PredictionHost({ horizonMs: 60_000, tzOffsetMin: () => 0, checkpointInterval: 3 });
    const nextEvs = ingest([
      view("status", 4000), // obs 4
    ]);
    h2.onEventsAppended(nextEvs.events, db);

    const rows = loadPredictionRows(db.raw);
    const lastRow = rows.at(-1)!;
    const model = lastRow.context.model as { examples_seen: number };
    assert.ok(model.examples_seen >= 4, "hydrated model retains checkpointed seen count");
  });

  it("integrates triage category into ContextTracker and activates cur+triage expert", () => {
    const h = host();
    h.updateTriage(DEVICE, "urgent");

    const r = ingest([view("status", 0), view("ask", 1000)]);
    h.onEventsAppended(r.events, db);

    const rows = loadPredictionRows(db.raw);
    const last = rows.at(-1)!;
    assert.equal(last.context.triage, "urgent");
    const model = last.context.model as { active_experts: string[] };
    assert.ok(model.active_experts.includes("cur+triage"), "cur+triage expert must be active");
  });

  it("ingests passiveCapture telemetry events, maps packages via playCategories, and applies dwell debounce", () => {
    const h = new PredictionHost({
      horizonMs: 60_000,
      tzOffsetMin: () => 0,
      dwellDebounceMs: 1000,
    });

    const passive = (pkg: string, dt: number, dwellMs?: number): Omit<EventIn, "event_id" | "schema_ver"> => ({
      kind: "telemetry",
      ts_device: T0 + dt,
      payload: {
        type: "system_telemetry",
        telemetry: `Package: ${pkg}\n\nText content`,
        package: pkg,
        ...(dwellMs !== undefined ? { dwell_ms: dwellMs } : {}),
      },
    });

    // co.mangotechnologies.clickup -> "Productivity"
    // com.instagram.barcelona -> "Social"
    // Rapid bounce: com.sand.airsos at dt=1200 (only 200ms after dt=1000) should be debounced
    const batch = ingest([
      view("status", 0),
      passive("co.mangotechnologies.clickup", 1000),   // Action: Productivity
      passive("com.instagram.barcelona", 3000),        // Action: Social (dt=2000ms >= 1000ms)
      passive("com.sand.airsos", 3200),                // Debounced! (dt=200ms < 1000ms)
      passive("co.mangotechnologies.clickup", 5000),   // Action: Productivity (dt=2000ms >= 1000ms)
    ]);

    const res = h.onEventsAppended(batch.events, db);
    assert.ok(res.guesses >= 2);

    const rows = loadPredictionRows(db.raw);
    // Categories should be recorded as context_key and actuals
    assert.ok(rows.some((r) => r.context_key.startsWith("Productivity|")));
    assert.ok(rows.some((r) => r.actual === "Social"));
  });

  it("logs pre-registered baselines on every prediction; cold start is flagged, then clears", () => {
    const h = host();
    const evs = [];
    for (let i = 0; i < 14; i++) evs.push(view(i % 3 === 0 ? "ask" : "status", i * 1000));
    h.onEventsAppended(ingest(evs).events, db);
    const rows = loadPredictionRows(db.raw);
    assert.ok(rows.length >= 12);
    type B = { avg_usage: { n: number; cell: string; cold_start: boolean; cands: unknown[] }; persistence: { repeat_rate: number } };
    for (const r of rows) assert.ok((r.context as { baselines?: B }).baselines, "baselines present");
    const bl = rows.map((r) => (r.context as { baselines: B }).baselines);
    assert.equal(bl[0].avg_usage.cold_start, true);
    assert.ok(bl[0].avg_usage.n < 10);
    assert.equal(bl.at(-1)!.avg_usage.cold_start, false);
    assert.equal(bl.at(-1)!.avg_usage.cell, "overall");
    assert.ok(bl.at(-1)!.persistence.repeat_rate > 0 && bl.at(-1)!.persistence.repeat_rate < 1);
  });

  it("baseline for guess k has seen only actions up to k (not the next one)", () => {
    const h = host();
    const evs = [];
    for (let i = 0; i < 12; i++) evs.push(view("status", i * 1000));
    evs.push(view("ask", 12_000));
    h.onEventsAppended(ingest(evs).events, db);
    const rows = loadPredictionRows(db.raw);
    const before = rows.find((r) => r.made_seq === rows.at(-2)!.made_seq)!;
    const b = (before.context as { baselines: { avg_usage: { cands: Array<{ value: string }>; n: number } } }).baselines.avg_usage;
    assert.equal(before.actual, "ask");
    assert.equal(b.n, 12);
    assert.ok(!b.cands.some((c) => c.value === "ask"), "the not-yet-seen answer is not in the baseline");
  });

  it("rebuilds the baseline on restart so it matches an uninterrupted host", () => {
    const first = [];
    for (let i = 0; i < 12; i++) first.push(view(i % 2 ? "ask" : "status", i * 1000));
    const a = host();
    a.onEventsAppended(ingest(first).events, db);
    const b = host(); // fresh process
    b.onEventsAppended(ingest([view("status", 12_000)]).events, db);
    const last = loadPredictionRows(db.raw).at(-1)!;
    const avg = (last.context as { baselines: { avg_usage: { n: number; cold_start: boolean; cands: Array<{ value: string; prob: number }> } } }).baselines.avg_usage;
    assert.equal(avg.n, 13);
    assert.equal(avg.cold_start, false);
    // 7 status + 6 ask, alpha 0.5, 2 seen + OTHER
    assert.ok(Math.abs(avg.cands.find((c) => c.value === "status")!.prob - 7.5 / 14.5) < 1e-9);
  });

  it("re-exports actionOf and passiveCapturePackage with playCategories injected", async () => {
    const mod = await import("./prediction-host.js");
    const ev = { seq: 1, device_id: DEVICE, kind: "telemetry", ts_device: T0, payload: JSON.stringify({ type: "passive_capture", package: "com.instagram.barcelona" }) };
    assert.equal(mod.passiveCapturePackage(ev), "com.instagram.barcelona");
    assert.equal(mod.actionOf(ev), "Social");
  });
});