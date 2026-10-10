import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExocortexDatabase } from "@exocortex/core/db";
import { loadPredictionRows, computePredictionReport, type EventIn } from "@exocortex/core";
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
});
