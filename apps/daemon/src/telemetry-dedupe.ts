/**
 * @file telemetry-dedupe.ts
 * Drops telemetry the event log already holds.
 *
 * The phone re-pulls its last 30 days of SMS on some app starts and gives every queued event a fresh
 * random event_id, so the id-based duplicate check never fires and the same message lands in the
 * append-only log again (one run stored 96 messages three times). A telemetry event is identified by
 * what it says: device, message time and text. Only `system_telemetry` is deduped; touches, queries
 * and everything else keep their id-based handling.
 */

import type { ExocortexDatabase } from "@exocortex/core/db";
import type { IngestReq } from "@exocortex/core";

const indexed = new WeakSet<object>();

function telemetryText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  return p.type === "system_telemetry" && typeof p.telemetry === "string" ? p.telemetry : null;
}

export function dropKnownTelemetry(db: ExocortexDatabase, req: IngestReq): { req: IngestReq; skipped: number } {
  if (!req.events.some((e) => e.kind === "telemetry")) return { req, skipped: 0 };
  if (!indexed.has(db)) {
    // Keeps the lookup below an index seek rather than a scan once the log grows.
    db.raw.exec("CREATE INDEX IF NOT EXISTS events_telemetry_key ON events(device_id, ts_device) WHERE kind = 'telemetry'");
    indexed.add(db);
  }
  const lookup = db.raw.prepare(
    "SELECT 1 FROM events WHERE device_id = ? AND kind = 'telemetry' AND ts_device = ? AND json_extract(payload, '$.telemetry') = ? LIMIT 1",
  );
  const seen = new Set<string>();
  let skipped = 0;
  const events = req.events.filter((e) => {
    const text = e.kind === "telemetry" ? telemetryText(e.payload) : null;
    if (text === null) return true;
    const key = `${e.ts_device}|${text}`;
    if (seen.has(key) || lookup.get(req.device_id, e.ts_device, text)) {
      skipped++;
      return false;
    }
    seen.add(key);
    return true;
  });
  return skipped === 0 ? { req, skipped: 0 } : { req: { ...req, events }, skipped };
}
