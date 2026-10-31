// Regenerates the SQLite schema sections of docs/SOVEREIGN_EXOCORTEX_SPEC.json from sqlite_master.
//
//   pnpm exec tsx scripts/dump-sqlite-schema.mts            # print JSON
//   pnpm exec tsx scripts/dump-sqlite-schema.mts --write    # rewrite the spec's schema sections
//   pnpm exec tsx scripts/dump-sqlite-schema.mts --ledger <path>
//
// The ledger is opened read-only (default %LOCALAPPDATA%\exocortex.db). The databank schema is
// built from packages/databank/schema.ts in a temp directory, because the vault is a separate service.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_SQL as DATABANK_SCHEMA_SQL } from "../packages/databank/schema.ts";

interface MasterRow { type: string; name: string; tbl_name: string; sql: string | null }
interface TableSchema { name: string; ddl: string; indexes: string[]; triggers: string[] }
interface SchemaDump { generated_by: string; source: string; sqlite_master_sha256: string; tables: TableSchema[]; views: string[] }

const SHADOW_SUFFIXES: Record<string, string[]> = {
  fts5: ["data", "idx", "content", "docsize", "config"],
  fts4: ["content", "segments", "segdir", "docsize", "stat"],
  fts3: ["content", "segments", "segdir"],
  rtree: ["node", "rowid", "parent"],
};
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = join(repoRoot, "docs", "SOVEREIGN_EXOCORTEX_SPEC.json");

function dumpSchema(db: DatabaseSync, source: string): SchemaDump {
  const rows = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
    .all() as unknown as MasterRow[];
  const shadowNames = new Set<string>();
  for (const r of rows) {
    const module = r.type === "table" ? /^CREATE VIRTUAL TABLE\s+\S+\s+USING\s+(\w+)/i.exec(r.sql!)?.[1] : undefined;
    for (const suffix of SHADOW_SUFFIXES[module?.toLowerCase() ?? ""] ?? []) shadowNames.add(`${r.name}_${suffix}`);
  }
  const kept = rows.filter((r) => !shadowNames.has(r.tbl_name) && !r.name.startsWith("sqlite_"));
  const tables: TableSchema[] = kept
    .filter((r) => r.type === "table")
    .map((r) => ({
      name: r.name,
      ddl: r.sql!,
      indexes: kept.filter((i) => i.type === "index" && i.tbl_name === r.name).map((i) => i.sql!),
      triggers: kept.filter((t) => t.type === "trigger" && t.tbl_name === r.name).map((t) => t.sql!),
    }));
  const views = kept.filter((r) => r.type === "view").map((r) => r.sql!);
  const canonical = kept.map((r) => `${r.type}\t${r.name}\t${r.sql}`).join("\n");
  return {
    generated_by: "scripts/dump-sqlite-schema.mts",
    source,
    sqlite_master_sha256: createHash("sha256").update(canonical).digest("hex"),
    tables,
    views,
  };
}

function ledgerSchema(path: string, label: string): SchemaDump {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON");
    return dumpSchema(db, label);
  } finally {
    db.close();
  }
}

function databankSchema(): SchemaDump {
  const dir = mkdtempSync(join(tmpdir(), "databank-schema-"));
  const db = new DatabaseSync(join(dir, "databank.db"));
  try {
    db.exec(DATABANK_SCHEMA_SQL);
    return dumpSchema(db, "packages/databank/schema.ts (scratch database)");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function resolveLedger(args: string[]): { path: string; label: string } {
  const i = args.indexOf("--ledger");
  if (i >= 0) {
    const path = args[i + 1];
    if (!path || path.startsWith("--")) throw new Error("--ledger needs a path");
    return { path, label: `${path} (read-only)` };
  }
  if (!process.env.LOCALAPPDATA) throw new Error("LOCALAPPDATA is unset; pass --ledger <path>");
  return { path: join(process.env.LOCALAPPDATA, "exocortex.db"), label: "%LOCALAPPDATA%\\exocortex.db (read-only)" };
}

const args = process.argv.slice(2);
const ledger = resolveLedger(args);
const result = { sqlite_v3_core: ledgerSchema(ledger.path, ledger.label), sqlite_databank: databankSchema() };

if (args.includes("--write")) {
  const raw = readFileSync(specPath, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const spec = JSON.parse(raw);
  spec.schemas ??= {};
  spec.schemas.sqlite_v3_core = result.sqlite_v3_core;
  spec.schemas.sqlite_databank = result.sqlite_databank;
  const tmp = `${specPath}.tmp`;
  writeFileSync(tmp, (JSON.stringify(spec, null, 2) + "\n").replace(/\n/g, eol));
  renameSync(tmp, specPath);
  console.log(`wrote ${specPath}: core ${result.sqlite_v3_core.tables.length} tables, databank ${result.sqlite_databank.tables.length} tables`);
} else {
  console.log(JSON.stringify(result, null, 2));
}
