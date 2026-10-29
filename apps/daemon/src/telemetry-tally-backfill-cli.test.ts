import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ExocortexDatabase } from "@exocortex/core/db";
import type { EventIn } from "@exocortex/core";
import { backfillTelemetryTally } from "./telemetry-tally-backfill-cli.js";

const T0 = Date.UTC(2026, 9, 11, 15, 0, 0);
const DEVICE = "phone-1";

describe("backfillTelemetryTally", () => {
  let dir: string;
  let path: string;
  let n = 0;
  const tele = (ts: number, text: string): EventIn => ({
    event_id: `e${++n}`, schema_ver: 1, kind: "telemetry", ts_device: ts, payload: { type: "system_telemetry", telemetry: text },
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tally-backfill-"));
    path = join(dir, "t.db");
    n = 0;
    const db = new ExocortexDatabase({ path });
    db.registerDevice({
      device_id: DEVICE, name: "p", platform: "android", pubkey_spki: new Uint8Array([1]),
      key_attested: 0, scopes: [], enrolled_at: T0, revoked_at: null,
    });
    // Three copies of one SMS (pre-dedupe history), plus a unique one.
    for (const e of [tele(T0, "hi"), tele(T0, "hi"), tele(T0, "hi"), tele(T0 + 1, "solo")]) db.ingestBatch({ device_id: DEVICE, events: [e] });
    db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("dry-run reports the plan on a read-only handle and writes nothing", () => {
    const raw = new DatabaseSync(path, { readOnly: true });
    const r = backfillTelemetryTally(raw, false);
    assert.deepEqual([r.groups, r.duplicateRows, r.newGroups, r.newMembers, r.applied], [1, 2, 1, 2, false]);
    assert.equal((raw.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name LIKE 'telemetry_tally%'").get() as { c: number }).c, 0);
    raw.close();
  });

  it("apply gives 1 canonical, 2 members, view count 1, events untouched; re-run is idempotent", () => {
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA foreign_keys = ON;");
    const snap = () => JSON.stringify(raw.prepare("SELECT * FROM events ORDER BY seq").all());
    const before = snap();
    const r = backfillTelemetryTally(raw, true);
    assert.deepEqual([r.newGroups, r.newMembers], [1, 2]);
    assert.equal(snap(), before);
    const t = raw.prepare("SELECT * FROM telemetry_tally").all() as Array<Record<string, any>>;
    assert.equal(t.length, 1);
    assert.equal(t[0].occurrence_count, 3);
    assert.equal(t[0].canonical_seq, 1);
    assert.deepEqual(JSON.parse(t[0].merged_event_ids), ["e2", "e3"]);
    assert.equal((raw.prepare("SELECT COUNT(*) AS c FROM telemetry_tally_members").get() as { c: number }).c, 2);
    const view = raw.prepare("SELECT COUNT(*) AS c FROM events_canonical WHERE kind = 'telemetry' AND json_extract(payload, '$.telemetry') = 'hi'").get() as { c: number };
    assert.equal(view.c, 1);
    const again = backfillTelemetryTally(raw, true);
    assert.deepEqual([again.newGroups, again.newMembers], [1 - 1, 0]);
    assert.equal((raw.prepare("SELECT occurrence_count AS c FROM telemetry_tally").get() as { c: number }).c, 3);
    raw.close();
    const db = new ExocortexDatabase({ path });
    assert.equal(db.verifyEventChain().valid, true);
    db.close();
  });
});
