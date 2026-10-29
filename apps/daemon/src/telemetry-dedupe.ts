/**
 * @file telemetry-dedupe.ts
 * Drops telemetry the event log already holds.
 *
 * The phone re-pulls its last 30 days of SMS on some app starts and gives every queued event a fresh
 * random event_id, so the id-based duplicate check never fires and the same message lands in the
 * append-only log again (one run stored 96 messages three times). A telemetry event is identified by
 * what it says: device, message time and text. Only `system_telemetry` is deduped; touches, queries
 * and everything else keep their id-based handling.
 *
 * Dropped duplicates are not forgotten: `recordTelemetryDuplicates` tallies them in `telemetry_tally`, a
 * mutable side table outside the hash chain (merge, never delete). `events` itself is never updated.
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ExocortexDatabase } from "@exocortex/core/db";
import type { IngestReq } from "@exocortex/core";

const indexed = new WeakSet<object>();
const tallyReady = new WeakSet<object>();

/** Cap on `merged_event_ids`; `occurrence_count` stays authoritative past it. */
const MERGED_IDS_CAP = 100;

export interface PendingDuplicate {
  key: string;
  event_id: string;
  ts_device: number;
  text: string;
}

/** Identity of a telemetry observation: hex sha256(device_id|ts_device|telemetry). */
export function telemetryDedupeKey(deviceId: string, tsDevice: number, text: string): string {
  return createHash("sha256").update(`${deviceId}|${tsDevice}|${text}`).digest("hex");
}

const TALLY_DDL = `
CREATE TABLE IF NOT EXISTS telemetry_tally (
  dedupe_key        TEXT PRIMARY KEY,
  device_id         TEXT NOT NULL,
  canonical_seq     INTEGER NOT NULL REFERENCES events(seq),
  occurrence_count  INTEGER NOT NULL CHECK (occurrence_count >= 1),
  first_seen_server INTEGER NOT NULL,
  last_seen_server  INTEGER NOT NULL,
  merged_event_ids  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(merged_event_ids))
) STRICT;
CREATE TABLE IF NOT EXISTS telemetry_tally_members (
  seq        INTEGER PRIMARY KEY REFERENCES events(seq),
  dedupe_key TEXT NOT NULL REFERENCES telemetry_tally(dedupe_key)
) STRICT;
CREATE VIEW IF NOT EXISTS events_canonical AS
  SELECT e.* FROM events e
   WHERE NOT EXISTS (SELECT 1 FROM telemetry_tally_members m JOIN telemetry_tally t USING (dedupe_key)
                      WHERE m.seq = e.seq AND m.seq <> t.canonical_seq);
`;

/** Creates the tally tables and the `events_canonical` view if missing. Idempotent. */
export function ensureTelemetryTally(raw: DatabaseSync): void {
  raw.exec(TALLY_DDL);
}

function telemetryText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  return p.type === "system_telemetry" && typeof p.telemetry === "string" ? p.telemetry : null;
}

export function dropKnownTelemetry(
  db: ExocortexDatabase,
  req: IngestReq,
): { req: IngestReq; skipped: number; pending: PendingDuplicate[] } {
  if (!req.events.some((e) => e.kind === "telemetry")) return { req, skipped: 0, pending: [] };
  if (!indexed.has(db)) {
    // Keeps the lookup below an index seek rather than a scan once the log grows.
    db.raw.exec("CREATE INDEX IF NOT EXISTS events_telemetry_key ON events(device_id, ts_device) WHERE kind = 'telemetry'");
    indexed.add(db);
  }
  const lookup = db.raw.prepare(
    "SELECT seq FROM events WHERE device_id = ? AND kind = 'telemetry' AND ts_device = ? AND json_extract(payload, '$.telemetry') = ? LIMIT 1",
  );
  const seen = new Set<string>();
  const pending: PendingDuplicate[] = [];
  let skipped = 0;
  const events = req.events.filter((e) => {
    const text = e.kind === "telemetry" ? telemetryText(e.payload) : null;
    if (text === null) return true;
    const key = `${e.ts_device}|${text}`;
    if (seen.has(key) || lookup.get(req.device_id, e.ts_device, text)) {
      skipped++;
      pending.push({ key: telemetryDedupeKey(req.device_id, e.ts_device, text), event_id: e.event_id, ts_device: e.ts_device, text });
      return false;
    }
    seen.add(key);
    return true;
  });
  return skipped === 0 ? { req, skipped: 0, pending } : { req: { ...req, events }, skipped, pending };
}

/**
 * Tallies the duplicates `dropKnownTelemetry` skipped. Call it AFTER `db.ingestBatch`, so a canonical
 * that arrived in the same batch already has a seq. A tally row appears only once a duplicate does:
 * it starts at 2 (canonical plus this one), then increments. `first_seen_server` is the canonical's
 * ts_server and is never moved. Returns how many duplicates were tallied.
 */
export function recordTelemetryDuplicates(
  db: ExocortexDatabase,
  deviceId: string,
  pending: PendingDuplicate[],
  nowMs: number = Date.now(),
): number {
  if (pending.length === 0) return 0;
  if (!tallyReady.has(db)) {
    ensureTelemetryTally(db.raw);
    tallyReady.add(db);
  }
  const canon = db.raw.prepare(
    "SELECT seq, ts_server FROM events WHERE device_id = ? AND kind = 'telemetry' AND ts_device = ? AND json_extract(payload, '$.telemetry') = ? ORDER BY seq LIMIT 1",
  );
  const getRow = db.raw.prepare("SELECT occurrence_count, merged_event_ids FROM telemetry_tally WHERE dedupe_key = ?");
  const insert = db.raw.prepare(
    "INSERT INTO telemetry_tally (dedupe_key, device_id, canonical_seq, occurrence_count, first_seen_server, last_seen_server, merged_event_ids) VALUES (?, ?, ?, 2, ?, ?, ?)",
  );
  const bump = db.raw.prepare(
    "UPDATE telemetry_tally SET occurrence_count = occurrence_count + 1, last_seen_server = ?, merged_event_ids = ? WHERE dedupe_key = ?",
  );
  return db.withTransaction(() => {
    let tallied = 0;
    for (const p of pending) {
      const c = canon.get(deviceId, p.ts_device, p.text) as { seq: number; ts_server: number } | undefined;
      if (!c) continue; // canonical never made it into the log (ingest failed); nothing to tally against
      const row = getRow.get(p.key) as { occurrence_count: number; merged_event_ids: string } | undefined;
      if (!row) {
        insert.run(p.key, deviceId, c.seq, c.ts_server, nowMs, JSON.stringify([p.event_id]));
      } else {
        const ids = JSON.parse(row.merged_event_ids) as string[];
        if (ids.includes(p.event_id)) continue; // the phone retried the very same event; already counted
        if (ids.length < MERGED_IDS_CAP) ids.push(p.event_id);
        bump.run(nowMs, JSON.stringify(ids), p.key);
      }
      tallied++;
    }
    return tallied;
  });
}
