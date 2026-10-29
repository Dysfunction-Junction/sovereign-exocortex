import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExocortexDatabase } from "@exocortex/core/db";
import type { EventIn } from "@exocortex/core";
import { dropKnownTelemetry, recordTelemetryDuplicates, telemetryDedupeKey } from "./telemetry-dedupe.js";

const T0 = Date.UTC(2026, 9, 11, 15, 0, 0);
const DEVICE = "phone-1";

describe("dropKnownTelemetry", () => {
  let dir: string;
  let db: ExocortexDatabase;
  let n = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tele-dedupe-"));
    db = new ExocortexDatabase({ path: join(dir, "t.db") });
    db.registerDevice({
      device_id: DEVICE, name: "test phone", platform: "android", pubkey_spki: new Uint8Array([1]),
      key_attested: 0, scopes: [], enrolled_at: T0, revoked_at: null,
    });
    n = 0;
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const tele = (ts: number, text: string): EventIn => ({
    event_id: `e${++n}`, schema_ver: 1, kind: "telemetry", ts_device: ts,
    payload: { type: "system_telemetry", telemetry: text, app_label: "Messages" },
  });
  const touch = (ts: number): EventIn => ({
    event_id: `e${++n}`, schema_ver: 1, kind: "touch", ts_device: ts, payload: { type: "screen_view", screen: "status" },
  });
  const store = (events: EventIn[]) => {
    const { req, skipped } = dropKnownTelemetry(db, { device_id: DEVICE, events });
    if (req.events.length) db.ingestBatch(req);
    return skipped;
  };
  const count = () => (db.raw.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'telemetry'").get() as { c: number }).c;

  it("stores a message once even when it is re-sent with fresh event ids", () => {
    assert.equal(store([tele(T0, "SMS inbound Mom hi"), tele(T0 + 1, "SMS inbound Mom bye")]), 0);
    assert.equal(store([tele(T0, "SMS inbound Mom hi"), tele(T0 + 1, "SMS inbound Mom bye")]), 2);
    assert.equal(count(), 2);
  });

  it("keeps messages that differ in time or text, and only the new part of a mixed batch", () => {
    store([tele(T0, "SMS inbound Mom hi")]);
    const skipped = store([tele(T0, "SMS inbound Mom hi"), tele(T0, "SMS inbound Mom hello"), tele(T0 + 5, "SMS inbound Mom hi")]);
    assert.equal(skipped, 1);
    assert.equal(count(), 3);
  });

  it("drops repeats inside a single batch", () => {
    assert.equal(store([tele(T0, "same"), tele(T0, "same"), tele(T0, "same")]), 2);
    assert.equal(count(), 1);
  });

  it("leaves non-telemetry events and batches without telemetry untouched", () => {
    const batch = { device_id: DEVICE, events: [touch(T0), touch(T0)] };
    const r = dropKnownTelemetry(db, batch);
    assert.equal(r.skipped, 0);
    assert.equal(r.req, batch, "same request object when nothing is dropped");
    assert.equal(store([touch(T0 + 10)]), 0);
  });

  it("is scoped per device", () => {
    db.registerDevice({
      device_id: "phone-2", name: "second", platform: "android", pubkey_spki: new Uint8Array([2]),
      key_attested: 0, scopes: [], enrolled_at: T0, revoked_at: null,
    });
    store([tele(T0, "shared text")]);
    const other = dropKnownTelemetry(db, { device_id: "phone-2", events: [tele(T0, "shared text")] });
    assert.equal(other.skipped, 0);
  });
});

describe("recordTelemetryDuplicates", () => {
  let db: ExocortexDatabase;
  let n = 0;
  beforeEach(() => {
    db = new ExocortexDatabase({ path: ":memory:" });
    db.registerDevice({
      device_id: DEVICE, name: "test phone", platform: "android", pubkey_spki: new Uint8Array([1]),
      key_attested: 0, scopes: [], enrolled_at: T0, revoked_at: null,
    });
    n = 0;
  });
  afterEach(() => db.close());

  const tele = (ts: number, text: string): EventIn => ({
    event_id: `e${++n}`, schema_ver: 1, kind: "telemetry", ts_device: ts,
    payload: { type: "system_telemetry", telemetry: text },
  });
  // The exact sequence the server runs.
  const ingest = (events: EventIn[], now: number) => {
    const d = dropKnownTelemetry(db, { device_id: DEVICE, events });
    if (d.req.events.length) db.ingestBatch(d.req);
    recordTelemetryDuplicates(db, DEVICE, d.pending, now);
  };
  const tallyRows = () => db.raw.prepare("SELECT * FROM telemetry_tally").all() as Array<Record<string, any>>;
  const eventSnapshot = () => JSON.stringify(db.raw.prepare("SELECT * FROM events ORDER BY seq").all());

  it("tallies the same SMS sent three times: one event, count 3, two merged ids", () => {
    ingest([tele(T0, "hi")], T0 + 10);
    const before = eventSnapshot();
    ingest([tele(T0, "hi")], T0 + 20);
    ingest([tele(T0, "hi")], T0 + 30);
    assert.equal(eventSnapshot(), before, "original event rows untouched");
    const [row] = tallyRows();
    assert.equal(tallyRows().length, 1);
    assert.equal(row.occurrence_count, 3);
    assert.equal(row.last_seen_server, T0 + 30);
    assert.deepEqual(JSON.parse(row.merged_event_ids), ["e2", "e3"]);
    assert.equal(row.dedupe_key, telemetryDedupeKey(DEVICE, T0, "hi"));
    const ev = db.raw.prepare("SELECT seq, ts_server FROM events WHERE kind = 'telemetry'").all() as Array<{ seq: number; ts_server: number }>;
    assert.equal(ev.length, 1);
    assert.equal(row.canonical_seq, ev[0].seq);
    assert.equal(row.first_seen_server, ev[0].ts_server, "first_seen is the canonical's arrival, preserved");
    assert.equal(db.verifyEventChain().valid, true);
  });

  it("tallies in-batch repeats once the canonical has a seq, and leaves unique events untallied", () => {
    ingest([tele(T0, "a"), tele(T0, "a"), tele(T0, "a"), tele(T0 + 1, "b")], T0 + 5);
    const rows = tallyRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].occurrence_count, 3);
  });

  it("does not double count a retry of the same event id", () => {
    ingest([tele(T0, "x")], T0);
    const dup = tele(T0, "x");
    for (const t of [T0 + 1, T0 + 2]) {
      const d = dropKnownTelemetry(db, { device_id: DEVICE, events: [dup] });
      recordTelemetryDuplicates(db, DEVICE, d.pending, t);
    }
    assert.equal(tallyRows()[0].occurrence_count, 2);
  });

  it("caps merged_event_ids at 100 while the count stays authoritative", () => {
    ingest([tele(T0, "spam")], T0);
    for (let i = 0; i < 105; i++) ingest([tele(T0, "spam")], T0 + i);
    const [row] = tallyRows();
    assert.equal(row.occurrence_count, 106);
    assert.equal(JSON.parse(row.merged_event_ids).length, 100);
  });

  it("events_canonical hides tallied in-log duplicates but keeps the canonical", () => {
    // A duplicate already in the log (pre-dedupe history); a first real duplicate creates the schema.
    db.ingestBatch({ device_id: DEVICE, events: [tele(T0, "dup"), tele(T0, "dup"), tele(T0 + 1, "solo")] });
    ingest([tele(T0 + 9, "z")], T0);
    ingest([tele(T0 + 9, "z")], T0 + 1);
    const seqs = (db.raw.prepare("SELECT seq FROM events WHERE json_extract(payload, '$.telemetry') IN ('dup', 'solo') ORDER BY seq").all() as Array<{ seq: number }>).map((r) => r.seq);
    const key = telemetryDedupeKey(DEVICE, T0, "dup");
    db.raw.prepare("INSERT INTO telemetry_tally VALUES (?, ?, ?, 2, 1, 2, '[]')").run(key, DEVICE, seqs[0]);
    db.raw.prepare("INSERT INTO telemetry_tally_members VALUES (?, ?)").run(seqs[1], key);
    const visible = (db.raw.prepare("SELECT seq FROM events_canonical WHERE kind = 'telemetry'").all() as Array<{ seq: number }>).map((r) => r.seq);
    assert.ok(visible.includes(seqs[0]) && visible.includes(seqs[2]));
    assert.ok(!visible.includes(seqs[1]));
    assert.equal((db.raw.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'telemetry'").get() as { c: number }).c, 4);
  });
});
