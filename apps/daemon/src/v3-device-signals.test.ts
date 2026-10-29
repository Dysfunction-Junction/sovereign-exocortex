import test from "node:test";
import assert from "node:assert/strict";
import { issueToken } from "./jwt.js";
import { setDatabase } from "./db-host.js";
import { ExocortexDatabase } from "@exocortex/core/db";
import { loadPredictionRows, type EventIn, type IngestReq } from "@exocortex/core";
import { PredictionHost } from "./prediction-host.js";
import { dropKnownTelemetry } from "./telemetry-dedupe.js";

const TEST_SECRET = "test-gateway-jwt-secret-secure-signals-123";
process.env.GATEWAY_JWT_SECRET = TEST_SECRET;
process.env.GATEWAY_ENROLL_TOKEN = "test-gateway-enroll-token-secure-signals-456";
process.env.DEVICE_REGISTRY_PATH = "none";
process.env.NODE_ENV = "test";

const { server, ingestConsumerForDatabase } = await import("./server.js");

const T0 = Date.UTC(2026, 9, 29, 15, 0, 0);
const DEVICE = "dev_signals";

function memoryDb(): ExocortexDatabase {
  const db = new ExocortexDatabase({ path: ":memory:" });
  db.registerDevice({
    device_id: DEVICE, name: DEVICE, platform: "android", pubkey_spki: new Uint8Array([1]),
    key_attested: 0, scopes: ["telemetry:write"], enrolled_at: T0, revoked_at: null,
  });
  return db;
}

type Draft = Omit<EventIn, "event_id" | "schema_ver">;
const arrival = (dt: number, to: string | null, extra: Record<string, unknown> = {}): Draft => ({
  kind: "telemetry",
  ts_device: T0 + dt,
  payload: to
    ? { type: "app_foreground", event: "APP_TRANSITION", to, category: "Audio", app_label: "App", from: "com.android.chrome", from_category: "Uncategorized", excluded: false, dwell_prev_ms: 41200, src: "usage_stats", ...extra }
    : { type: "app_foreground", event: "APP_TRANSITION", category: "excluded", excluded: true, dwell_prev_ms: 900, src: "usage_stats", ...extra },
});
const screen = (dt: number, name: string): Draft => ({ kind: "touch", ts_device: T0 + dt, payload: { type: "screen_view", screen: name } });
const windowEvent = (end: number): Draft => ({
  kind: "telemetry",
  ts_device: end,
  payload: { type: "sensor_window", window_start: end - 300_000, window_end: end, dur_ms: 300_000, sensors: { motion: { energy_rms: 0.4, energy_class: "light" }, light: { bucket: "dim" } } },
});
const capsEvent: Draft = {
  kind: "telemetry",
  ts_device: T0,
  payload: { type: "sensor_caps", sensors: { motion: { present: true, power_ma: 0.1, fifo_max: 600, wakeup: false, min_delay_us: 5000 } }, perm_activity_recognition: false, toggles: { motion: true } },
};
const consentEvent: Draft = { kind: "telemetry", ts_device: T0 + 1, payload: { type: "sensor_consent", key: "pressure", enabled: false } };

test("v3 ingest stores app_foreground, sensor_window, sensor_caps and sensor_consent verbatim and enforces the batch limit", async () => {
  const db = memoryDb();
  setDatabase(db);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${issueToken(DEVICE, TEST_SECRET)}` };
  const post = (events: unknown[]) => fetch(`${baseUrl}/v3/events`, { method: "POST", headers, body: JSON.stringify({ device_id: DEVICE, events }) });

  try {
    const drafts: Draft[] = [arrival(1000, "com.spotify.music"), arrival(2000, null), windowEvent(T0 + 300_000), capsEvent, consentEvent];
    const events = drafts.map((d, i) => ({ ...d, event_id: `sig-${i}`, schema_ver: 1 }));

    // dropKnownTelemetry only content-dedupes system_telemetry, so none of these are skipped.
    const before = dropKnownTelemetry(db, { device_id: DEVICE, events } as IngestReq);
    assert.equal(before.skipped, 0);
    assert.equal(before.req.events.length, events.length);

    const res = await post(events);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).result.insertedCount, events.length);
    await ingestConsumerForDatabase(db).idle();

    const got = await (await fetch(`${baseUrl}/v3/events?limit=100&sinceSeq=0`, { headers })).json();
    assert.equal(got.events.length, events.length);
    got.events.forEach((e: { payload: unknown; event_id: string }, i: number) => {
      assert.equal(e.event_id, events[i].event_id);
      assert.deepEqual(e.payload, events[i].payload);
    });
    assert.equal(dropKnownTelemetry(db, { device_id: DEVICE, events } as IngestReq).skipped, 0);

    // Re-sending the same events is idempotent: nothing is stored twice.
    const replay = await (await post(events)).json();
    assert.equal(replay.result.insertedCount, 0);
    assert.equal(replay.result.duplicateCount, events.length);

    // The /v3/events limit is 100 events per POST.
    const tooMany = Array.from({ length: 101 }, (_, i) => ({ ...windowEvent(T0 + (i + 10) * 300_000), event_id: `bulk-${i}`, schema_ver: 1 }));
    assert.equal((await post(tooMany)).status, 400);
    assert.equal((await post(tooMany.slice(0, 100))).status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setDatabase(null); // closes the db
  }
});

test("app-stream predictions carry stream app, stay apart from the screen ledger, and late arrivals predict nothing", () => {
  const db = memoryDb();
  let n = 0;
  const ingest = (drafts: Draft[]) => db.ingestBatch({ device_id: DEVICE, events: drafts.map((d) => ({ ...d, event_id: `e${++n}`, schema_ver: 1 as const })) });
  const host = () => new PredictionHost({ horizonMs: 600_000, tzOffsetMin: () => 0 });
  try {
    const h = host();
    // Screen guesses stay open while app arrivals come in.
    h.onEventsAppended(ingest([screen(0, "status"), screen(1000, "ask")]).events, db);
    h.onEventsAppended(ingest([windowEvent(T0 + 1500), arrival(2000, "com.a"), arrival(3000, "com.b"), arrival(4000, "com.a")]).events, db);
    let rows = loadPredictionRows(db.raw);
    const screenRows = rows.filter((r) => r.context.stream === "screen");
    const appRows = rows.filter((r) => r.context.stream === "app");
    assert.equal(screenRows.length + appRows.length, rows.length, "every new row names its stream");
    assert.ok(appRows.length >= 2);
    assert.equal(appRows[0].context.label_rule, "k5");
    assert.deepEqual(appRows[0].context.sensors, { window_end: T0 + 1500, motion_energy: "light", light: "dim" });
    assert.ok(appRows.every((r) => r.candidates.every((c) => c.value.startsWith("cat:") || c.value.startsWith("pkg:"))));
    const lastScreen = screenRows[screenRows.length - 1];
    assert.equal(lastScreen.outcome, null, "an app arrival must not resolve a screen guess");
    assert.ok(appRows.some((r) => r.outcome !== null), "app arrivals resolve app guesses");

    // A late arrival (older than the newest on-time one) updates nothing visible: no guess, no resolution.
    const before = loadPredictionRows(db.raw).length;
    const out = h.onEventsAppended(ingest([arrival(2500, "com.c")]).events, db);
    assert.deepEqual(out, { guesses: 0, resolved: 0 });
    assert.equal(loadPredictionRows(db.raw).length, before);
    // The skip is reported on the next logged app row.
    h.onEventsAppended(ingest([arrival(5000, "com.b")]).events, db);
    const next = loadPredictionRows(db.raw).filter((r) => r.context.stream === "app").pop()!;
    assert.equal((next.context.model as Record<string, unknown>).late_skipped, 1);
  } finally {
    db.close();
  }
});

test("pkg labels switch at the 5th arrival and a restarted host keeps the counts and the late rule", () => {
  const db = memoryDb();
  let n = 0;
  const ingest = (drafts: Draft[]) => db.ingestBatch({ device_id: DEVICE, events: drafts.map((d) => ({ ...d, event_id: `r${++n}`, schema_ver: 1 as const })) });
  const mk = () => new PredictionHost({ horizonMs: 600_000, tzOffsetMin: () => 0 });
  try {
    const first = mk();
    first.onEventsAppended(ingest([0, 1, 2, 3].map((i) => arrival(1000 * (i + 1), "com.spotify.music"))).events, db);
    // A new host (restart) sees the 5th arrival: counts come back from the log, so the label is pkg: already.
    const second = mk();
    second.onEventsAppended(ingest([arrival(5000, "com.spotify.music"), arrival(6000, "com.spotify.music")]).events, db);
    const rows = loadPredictionRows(db.raw).filter((r) => r.context.stream === "app");
    const tops = rows.map((r) => r.candidates[0].value);
    assert.ok(tops.slice(0, 3).every((v) => v === "cat:Audio"), `first arrivals use the category: ${tops.join(",")}`);
    assert.equal(rows.find((r) => r.made_at === T0 + 5000)!.context_key.startsWith("pkg:com.spotify.music|"), true);

    // The restarted host still knows 6000 is the newest on-time arrival.
    const out = second.onEventsAppended(ingest([arrival(5500, "com.late")]).events, db);
    assert.deepEqual(out, { guesses: 0, resolved: 0 });

    // Excluded apps are labelled cat:excluded and never reach the context.
    second.onEventsAppended(ingest([arrival(7000, null)]).events, db);
    const ex = loadPredictionRows(db.raw).find((r) => r.made_at === T0 + 7000)!;
    assert.equal(ex.context_key.startsWith("cat:excluded|"), true);
    assert.equal(ex.context.app?.package, undefined, "an excluded arrival never lands in app.package");
  } finally {
    db.close();
  }
});
