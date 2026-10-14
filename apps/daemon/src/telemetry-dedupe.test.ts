import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExocortexDatabase } from "@exocortex/core/db";
import type { EventIn } from "@exocortex/core";
import { dropKnownTelemetry } from "./telemetry-dedupe.js";

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
