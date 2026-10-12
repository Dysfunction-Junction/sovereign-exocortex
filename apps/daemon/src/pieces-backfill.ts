/**
 * @file pieces-backfill.ts
 * Replays a Pieces export into the event log as PAST events (kind "past", never live).
 *
 * One event per workstream summary: when it happened (range start, else record creation), its tags,
 * people and sources. Events use their own kind so the predictors and the world-model replay, which only
 * read live kinds, ignore them by default. Callers that want history must ask for kind "past" explicitly.
 *
 * Idempotent: event_id is pieces:<summary id>, so re-running inserts nothing new.
 * Source is the export folder on disk; nothing is sent anywhere.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExocortexDatabase } from "@exocortex/core/db";

export const PAST_KIND = "past";
export const BACKFILL_DEVICE_ID = "pieces-backfill";

type Json = Record<string, unknown>;

export interface BackfillResult {
  summaries: number;
  inserted: number;
  duplicate: number;
  skipped: number;
  withRealRange: number;
}

function readKind(exportDir: string, kind: string): Map<string, Json> {
  const byId = new Map<string, Json>();
  const dir = join(exportDir, "data", kind);
  if (!existsSync(dir)) return byId;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(dir, f), "utf8")) as Json;
      if (typeof rec.id === "string") byId.set(rec.id, rec);
    } catch {
      // A corrupt record is skipped; the summary just loses that link.
    }
  }
  return byId;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const isoField = (v: unknown): string | null => {
  const s = typeof v === "object" && v ? str((v as Json).value) : str(v);
  return s && Number.isFinite(Date.parse(s)) ? s : null;
};
const linked = (summary: Json, field: string): string[] => {
  const idx = (summary[field] as Json | undefined)?.indices;
  return idx && typeof idx === "object" ? Object.keys(idx as Json) : [];
};

function ensureDevice(db: ExocortexDatabase): void {
  if (db.getDevice(BACKFILL_DEVICE_ID)) return;
  db.registerDevice({
    device_id: BACKFILL_DEVICE_ID,
    name: "Pieces export backfill (past events only)",
    platform: "windows",
    pubkey_spki: new Uint8Array(0),
    key_attested: 0,
    scopes: ["past:write"],
    enrolled_at: Date.now(),
  });
}

export function backfillPieces(db: ExocortexDatabase, exportDir: string): BackfillResult {
  const summaries = readKind(exportDir, "summaries");
  const ranges = readKind(exportDir, "ranges");
  const tags = readKind(exportDir, "tags");
  const persons = readKind(exportDir, "persons");
  const sources = readKind(exportDir, "sources");

  const texts = (ids: string[], from: Map<string, Json>, ...fields: string[]): string[] => {
    const out: string[] = [];
    for (const id of ids) {
      const rec = from.get(id);
      const t = rec && fields.map((f) => str(rec[f])).find(Boolean);
      if (t) out.push(t);
    }
    return out.sort();
  };

  const prepared = [...summaries.values()].map((s) => {
    const rangeFrom = linked(s, "ranges")
      .map((id) => isoField((ranges.get(id)?.from as Json | undefined) ?? null))
      .filter((x): x is string => x !== null)
      .sort()[0] ?? null;
    const rangeTo = linked(s, "ranges")
      .map((id) => isoField((ranges.get(id)?.to as Json | undefined) ?? null))
      .filter((x): x is string => x !== null)
      .sort()
      .at(-1) ?? null;
    const created = isoField(s.created);
    const when = rangeFrom ?? created;
    return { s, rangeFrom, rangeTo, created, when };
  });

  const result: BackfillResult = { summaries: prepared.length, inserted: 0, duplicate: 0, skipped: 0, withRealRange: 0 };
  // Oldest first, so sequence order matches chronology.
  prepared.sort((a, b) => Date.parse(a.when ?? "") - Date.parse(b.when ?? ""));

  ensureDevice(db);
  for (const { s, rangeFrom, rangeTo, created, when } of prepared) {
    const id = str(s.id);
    if (!id || !when) {
      result.skipped++;
      continue;
    }
    if (rangeFrom) result.withRealRange++;
    const { status } = db.ingestEvent(BACKFILL_DEVICE_ID, {
      event_id: `pieces:${id}`,
      kind: PAST_KIND,
      schema_ver: 1,
      ts_device: Date.parse(when),
      payload: {
        origin: "pieces-backfill",
        past: true,
        type: "work_session",
        summary_id: id,
        name: str(s.name),
        range: [rangeFrom, rangeTo],
        created,
        time_basis: rangeFrom ? "range_start" : "record_created",
        tags: texts(linked(s, "tags"), tags, "text"),
        persons: texts(linked(s, "persons"), persons, "name", "text"),
        sources: texts(linked(s, "sources"), sources, "name", "title"),
      },
    });
    if (status === "inserted") result.inserted++;
    else result.duplicate++;
  }
  return result;
}
