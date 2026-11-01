import { DatabaseSync } from "node:sqlite";
import { classifySensitivity, SENSITIVITY_SQL } from "./sensitivity.js";

function counts(db: DatabaseSync): Record<string, number> {
  return Object.fromEntries(["items", "chunks", "vectors", "ingest_log"].map(table =>
    [table, Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)]));
}

/** Phase 2 scaffolding: VACUUM INTO, busy timeout, atomic write, aggregate evidence. */
export function migrateSensitivity(db: DatabaseSync, backupPath: string) {
  db.exec("PRAGMA busy_timeout = 30000");
  db.prepare("VACUUM INTO ?").run(backupPath);
  db.exec("BEGIN IMMEDIATE");
  try {
    const before = counts(db);
    db.exec(`ALTER TABLE items ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'personal' CHECK (sensitivity IN (${SENSITIVITY_SQL}))`);
    const byRule: Record<string, number> = {};
    const bySensitivity: Record<string, number> = {};
    const update = db.prepare("UPDATE items SET sensitivity = ? WHERE item_id = ?");
    const rows = db.prepare("SELECT item_id, source, title, path FROM items").all() as unknown as Array<{
      item_id: string; source: string; title: string; path: string;
    }>;
    for (const row of rows) {
      const { sensitivity, rule } = classifySensitivity(row);
      update.run(sensitivity, row.item_id);
      byRule[rule] = (byRule[rule] ?? 0) + 1;
      bySensitivity[sensitivity] = (bySensitivity[sensitivity] ?? 0) + 1;
    }
    const after = counts(db);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("sensitivity migration changed row counts");
    const evidence = {
      from: 2, to: 3, classifier: "rule-only-names-source-path", timestamp: new Date().toISOString(),
      before, after, byRule, bySensitivity,
      classifiedByRule: before.items - (byRule.default ?? 0), leftAtDefault: byRule.default ?? 0,
      backupCreated: true,
    };
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('sensitivity_migration_v3', ?)").run(JSON.stringify(evidence));
    db.exec("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '3')");
    db.exec("COMMIT");
    return evidence;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
