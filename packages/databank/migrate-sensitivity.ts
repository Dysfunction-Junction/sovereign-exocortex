/** Run with pnpm --filter @exocortex/databank exec tsx migrate-sensitivity.ts
 * --db <index.db> --evidence <receipt.json> [--apply]. No keys or plaintext output.
 * Default is a read-only version check; --apply performs the automatic-open migration. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { migrateSensitivity } from "./sensitivity-migration.js";

const { values } = parseArgs({ options: {
  db: { type: "string" }, evidence: { type: "string" }, apply: { type: "boolean", default: false },
} });
if (!values.db || !values.evidence) throw new Error("--db and --evidence are required");
const dbPath = resolve(values.db);
if (!existsSync(dbPath)) throw new Error("database does not exist");
const evidencePath = resolve(values.evidence);
// This report must never overwrite the database or its sidecars.
if ([dbPath, `${dbPath}-wal`, `${dbPath}-shm`].includes(evidencePath)) throw new Error("evidence path overlaps database");
const db = new DatabaseSync(dbPath, { readOnly: !values.apply });
try {
  const version = Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value);
  if (!values.apply) {
    console.log(JSON.stringify({ schemaVersion: version, apply: false, eligible: version === 2 }));
  } else {
    let receipt: unknown;
    if (version === 2) receipt = migrateSensitivity(db, `${dbPath}.pre-v3-${Date.now()}.db`);
    else if (version === 3) {
      const saved = db.prepare("SELECT value FROM meta WHERE key = 'sensitivity_migration_v3'").get();
      if (!saved) throw new Error("no v2-to-v3 migration receipt (database may have been created at v3)");
      receipt = JSON.parse(String(saved.value));
    } else throw new Error("expected schema v2 or an already migrated v3 database");
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log("Sensitivity migration complete; aggregate evidence exported.");
  }
} finally {
  db.close();
}
