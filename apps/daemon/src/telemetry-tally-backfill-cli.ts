/**
 * Telemetry tally backfill CLI.
 *
 *   npm run ... -- [--db <path>] [--apply]
 *
 * Finds telemetry duplicates already stored in the append-only log (same device, ts_device, text) and
 * records them in the `telemetry_tally` side table: canonical = lowest seq, the rest become members that
 * the `events_canonical` view hides. `events` is never modified. Dry-run by default (read-only handle,
 * writes nothing); writing needs BOTH --apply and an explicit --db path. Safe to re-run.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ensureTelemetryTally, telemetryDedupeKey } from "./telemetry-dedupe.js";

const MERGED_IDS_CAP = 100;

export interface BackfillResult {
  groups: number;
  duplicateRows: number;
  /** Groups with no tally row yet. */
  newGroups: number;
  /** Duplicate rows not yet recorded as members (what --apply would add). */
  newMembers: number;
  applied: boolean;
}

interface Group {
  device_id: string;
  ts_device: number;
  text: string;
}

function tallyTablesExist(raw: DatabaseSync): boolean {
  const n = raw.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name IN ('telemetry_tally', 'telemetry_tally_members')").get() as { c: number };
  return n.c === 2;
}

/** With apply=false the handle is only read (works on a read-only connection). */
export function backfillTelemetryTally(raw: DatabaseSync, apply: boolean): BackfillResult {
  const hasTally = tallyTablesExist(raw);
  if (apply) ensureTelemetryTally(raw);
  const groups = raw.prepare(
    `SELECT device_id, ts_device, json_extract(payload, '$.telemetry') AS text FROM events
      WHERE kind = 'telemetry' AND json_extract(payload, '$.telemetry') IS NOT NULL
      GROUP BY device_id, ts_device, json_extract(payload, '$.telemetry') HAVING COUNT(*) > 1`,
  ).all() as unknown as Group[];
  const rowsOf = raw.prepare(
    "SELECT seq, event_id, ts_server FROM events WHERE device_id = ? AND kind = 'telemetry' AND ts_device = ? AND json_extract(payload, '$.telemetry') = ? ORDER BY seq",
  );
  const result: BackfillResult = { groups: groups.length, duplicateRows: 0, newGroups: 0, newMembers: 0, applied: apply };
  const tally = hasTally ? raw.prepare("SELECT occurrence_count, first_seen_server, last_seen_server, merged_event_ids FROM telemetry_tally WHERE dedupe_key = ?") : null;
  const isMember = hasTally ? raw.prepare("SELECT 1 FROM telemetry_tally_members WHERE seq = ?") : null;

  const run = () => {
    for (const g of groups) {
      const key = telemetryDedupeKey(g.device_id, g.ts_device, g.text);
      const rows = rowsOf.all(g.device_id, g.ts_device, g.text) as Array<{ seq: number; event_id: string; ts_server: number }>;
      const [canon, ...dups] = rows;
      result.duplicateRows += dups.length;
      const existing = tally?.get(key) as
        | { occurrence_count: number; first_seen_server: number; last_seen_server: number; merged_event_ids: string }
        | undefined;
      if (!existing) result.newGroups++;
      const fresh = dups.filter((d) => !isMember?.get(d.seq));
      result.newMembers += fresh.length;
      if (!apply || fresh.length === 0) continue;

      const ids: string[] = existing ? JSON.parse(existing.merged_event_ids) : [];
      for (const d of fresh) if (ids.length < MERGED_IDS_CAP) ids.push(d.event_id);
      const last = Math.max(...fresh.map((d) => d.ts_server), existing?.last_seen_server ?? 0);
      if (!existing) {
        raw.prepare(
          "INSERT INTO telemetry_tally (dedupe_key, device_id, canonical_seq, occurrence_count, first_seen_server, last_seen_server, merged_event_ids) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(key, g.device_id, canon.seq, rows.length, canon.ts_server, last, JSON.stringify(ids));
      } else {
        raw.prepare("UPDATE telemetry_tally SET occurrence_count = occurrence_count + ?, last_seen_server = ?, merged_event_ids = ? WHERE dedupe_key = ?")
          .run(fresh.length, last, JSON.stringify(ids), key);
      }
      const addMember = raw.prepare("INSERT OR IGNORE INTO telemetry_tally_members (seq, dedupe_key) VALUES (?, ?)");
      for (const d of fresh) addMember.run(d.seq, key);
    }
  };
  if (apply) {
    raw.exec("BEGIN IMMEDIATE");
    try {
      run();
      raw.exec("COMMIT");
    } catch (err) {
      raw.exec("ROLLBACK");
      throw err;
    }
  } else {
    run();
  }
  return result;
}

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const i = args.indexOf("--db");
  const dbPath = i >= 0 ? args[i + 1] : undefined;
  if (apply && !dbPath) {
    console.error("--apply requires an explicit --db <path>");
    process.exit(1);
  }
  const path = dbPath ?? process.env.EXOCORTEX_DB_PATH ?? `${process.env.LOCALAPPDATA ?? "."}\exocortex.db`;
  if (!existsSync(path)) {
    console.error(`no database at ${path}`);
    process.exit(1);
  }
  const raw = new DatabaseSync(path, { readOnly: !apply });
  raw.exec("PRAGMA busy_timeout = 5000;");
  if (apply) raw.exec("PRAGMA foreign_keys = ON;");
  try {
    const r = backfillTelemetryTally(raw, apply);
    console.log(
      `${apply ? "applied" : "dry-run"} on ${path}: ${r.groups} duplicated groups, ${r.duplicateRows} duplicate rows; ` +
        `${apply ? "recorded" : "would record"} ${r.newMembers} new members across ${r.newGroups} new groups`,
    );
    if (!apply) console.log("nothing written; pass --apply with --db <path> to write");
  } finally {
    raw.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
