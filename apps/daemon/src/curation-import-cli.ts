/**
 * @file curation-import-cli.ts
 * Admin command to import curated world-model and Pieces memory-graph artifacts into the SQLite
 * ledger via `artifacts` + `curation_import` events (PLAN_WORLD_MODEL_STORE_2026-10-31 §4.2, §7, §8).
 *
 * Defaults to dry-run (`--apply` required to write to the ledger).
 * Usage:
 *   pnpm --filter @exocortex/daemon curation-import <neo4j-export.json> [--db <path>] [--apply]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { canonicalJsonStringify, HOST_DEVICE_ID } from "@exocortex/core";
import { ExocortexDatabase } from "@exocortex/core/db";
import {
  buildFileTreeArtifact,
  buildPiecesGraphArtifact,
  buildRuleLinksArtifacts,
  buildVocabularyArtifact,
  FILE_TREE_MEDIA_TYPE,
  MAX_PIECES_GRAPH_BYTES,
  PIECES_GRAPH_MEDIA_TYPE,
  RULE_LINKS_MEDIA_TYPE,
  VOCABULARY_MEDIA_TYPE,
  type RawNeo4jExport,
} from "@exocortex/world-model";
import { getDefaultDbPath } from "./db-host.js";
import { ShadowRecorder } from "./shadow-recorder.js";

export type CurationArtifactName =
  | "vocabulary"
  | "entity-rule"
  | "path-rule"
  | "file-tree"
  | "pieces-graph";

export interface CurationArtifactSummary {
  name: CurationArtifactName;
  eventId: string;
  mediaType: string;
  ruleSource?: "entity-rule" | "path-rule";
  sha256: string;
  bytes: number;
  count: number;
  relationshipCount?: number;
  artifactPresent: boolean;
  eventPresent: boolean;
}

export interface CurationImportResult {
  dryRun: boolean;
  artifacts: CurationArtifactSummary[];
  acceptedEvents: number;
  duplicateEvents: number;
  note: string;
}

export function computeCanonicalArtifactHash(value: unknown): { sha256: string; size: number } {
  const bytes = Buffer.from(canonicalJsonStringify(value), "utf8");
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}

function isMissingTableError(err: unknown): boolean {
  return err instanceof Error && /no such table/i.test(err.message);
}

function checkExistingInRawDb(
  rawDb: DatabaseSync,
  sha256Hex: string,
  eventId: string,
): { artifactPresent: boolean; eventPresent: boolean } {
  let artifactPresent = false;
  let eventPresent = false;
  try {
    const aRow = rawDb
      .prepare("SELECT 1 AS ok FROM artifacts WHERE sha256 = ?")
      .get(Buffer.from(sha256Hex, "hex")) as { ok?: number } | undefined;
    artifactPresent = aRow?.ok === 1;
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
  }
  try {
    const eRow = rawDb
      .prepare("SELECT 1 AS ok FROM events WHERE event_id = ?")
      .get(eventId) as { ok?: number } | undefined;
    eventPresent = eRow?.ok === 1;
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
  }
  return { artifactPresent, eventPresent };
}

interface ArtifactSpec {
  name: CurationArtifactName;
  mediaType: string;
  ruleSource?: "entity-rule" | "path-rule";
  count: number;
  relationshipCount?: number;
  maxBytes?: number;
  value: unknown;
  prefix: string;
}

export function importCurationArtifacts(
  rawExport: RawNeo4jExport,
  options: {
    db?: ExocortexDatabase;
    dbPath?: string;
    apply?: boolean;
    tsDeviceMs?: number;
    maxPiecesGraphBytes?: number;
  } = {},
): CurationImportResult {
  const apply = options.apply === true;
  const baseTs = options.tsDeviceMs ?? Date.now();
  const maxPgBytes = options.maxPiecesGraphBytes ?? MAX_PIECES_GRAPH_BYTES;

  const vocab = buildVocabularyArtifact(rawExport);
  const { entityRules, pathRules } = buildRuleLinksArtifacts(rawExport);
  const fileTree = buildFileTreeArtifact(rawExport);
  const piecesGraph = buildPiecesGraphArtifact(rawExport);

  const specs: ArtifactSpec[] = [
    {
      name: "vocabulary",
      mediaType: VOCABULARY_MEDIA_TYPE,
      count: vocab.topics.length,
      value: vocab,
      prefix: "curation_import_vocab_",
    },
    {
      name: "entity-rule",
      mediaType: RULE_LINKS_MEDIA_TYPE,
      ruleSource: "entity-rule",
      count: entityRules.links.length,
      value: entityRules,
      prefix: "curation_import_entity_rule_",
    },
    {
      name: "path-rule",
      mediaType: RULE_LINKS_MEDIA_TYPE,
      ruleSource: "path-rule",
      count: pathRules.links.length,
      value: pathRules,
      prefix: "curation_import_path_rule_",
    },
    {
      name: "file-tree",
      mediaType: FILE_TREE_MEDIA_TYPE,
      count: fileTree.nodes.length,
      value: fileTree,
      prefix: "curation_import_file_tree_",
    },
  ];

  if (piecesGraph.nodes.length > 0) {
    specs.push({
      name: "pieces-graph",
      mediaType: PIECES_GRAPH_MEDIA_TYPE,
      count: piecesGraph.nodes.length,
      relationshipCount: piecesGraph.relationships.length,
      maxBytes: maxPgBytes,
      value: piecesGraph,
      prefix: "curation_import_pieces_graph_",
    });
  }

  const zeroPiecesWarning =
    piecesGraph.nodes.length === 0
      ? " Warning: export contained 0 PiecesRecord/Doc nodes; pieces-graph was not imported."
      : "";

  if (!apply) {
    let roDb: DatabaseSync | null = null;
    try {
      if (!options.db && options.dbPath && existsSync(options.dbPath)) {
        try {
          roDb = new DatabaseSync(options.dbPath, { readOnly: true });
        } catch {
          roDb = new DatabaseSync(options.dbPath);
        }
        roDb.exec("PRAGMA busy_timeout = 5000; PRAGMA query_only = ON;");
      }
      const rawReader = options.db?.raw ?? roDb;
      const summaries: CurationArtifactSummary[] = specs.map((spec) => {
        const { sha256, size } = computeCanonicalArtifactHash(spec.value);
        if (spec.maxBytes !== undefined && size > spec.maxBytes) {
          throw new Error(
            `${spec.name} artifact (${size} bytes) exceeds cap (${spec.maxBytes} bytes); store in databank instead (§8.2)`,
          );
        }
        const eventId = `${spec.prefix}${sha256.slice(0, 16)}`;
        const existing = rawReader
          ? checkExistingInRawDb(rawReader, sha256, eventId)
          : { artifactPresent: false, eventPresent: false };
        return {
          name: spec.name,
          eventId,
          mediaType: spec.mediaType,
          ...(spec.ruleSource ? { ruleSource: spec.ruleSource } : {}),
          sha256,
          bytes: size,
          count: spec.count,
          ...(spec.relationshipCount !== undefined ? { relationshipCount: spec.relationshipCount } : {}),
          artifactPresent: existing.artifactPresent,
          eventPresent: existing.eventPresent,
        };
      });
      return {
        dryRun: true,
        artifacts: summaries,
        acceptedEvents: 0,
        duplicateEvents: 0,
        note: `Dry run only; pass --apply to store artifacts and append curation_import events.${zeroPiecesWarning}`,
      };
    } finally {
      roDb?.close();
    }
  }

  const ownsDb = !options.db;
  const db = options.db ?? new ExocortexDatabase({ path: options.dbPath ?? getDefaultDbPath() });
  try {
    // Reuse the daemon's own host-device bootstrap so device row shape/scopes never diverge.
    new ShadowRecorder(db).ensureHostDevice();

    const summaries: CurationArtifactSummary[] = [];
    const eventsToIngest: Array<{
      event_id: string;
      kind: "curation_import";
      schema_ver: 1;
      ts_device: number;
      payload: Record<string, unknown>;
    }> = [];

    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      const prelimHash = computeCanonicalArtifactHash(spec.value);
      if (spec.maxBytes !== undefined && prelimHash.size > spec.maxBytes) {
        throw new Error(
          `${spec.name} artifact (${prelimHash.size} bytes) exceeds cap (${spec.maxBytes} bytes); store in databank instead (§8.2)`,
        );
      }
      const eventId = `${spec.prefix}${prelimHash.sha256.slice(0, 16)}`;
      const before = checkExistingInRawDb(db.raw, prelimHash.sha256, eventId);

      // Invariant (P1-G5): always store the artifact BEFORE appending the curation_import event.
      const stored = db.putArtifact(spec.mediaType, spec.value);
      if (stored.sha256 !== prelimHash.sha256) {
        throw new Error(
          `canonical artifact hash mismatch for ${spec.name}: expected ${prelimHash.sha256}, stored ${stored.sha256}`,
        );
      }

      summaries.push({
        name: spec.name,
        eventId,
        mediaType: spec.mediaType,
        ...(spec.ruleSource ? { ruleSource: spec.ruleSource } : {}),
        sha256: stored.sha256,
        bytes: stored.size,
        count: spec.count,
        ...(spec.relationshipCount !== undefined ? { relationshipCount: spec.relationshipCount } : {}),
        artifactPresent: before.artifactPresent,
        eventPresent: before.eventPresent,
      });

      eventsToIngest.push({
        event_id: eventId,
        kind: "curation_import",
        schema_ver: 1,
        ts_device: baseTs + i,
        payload: {
          artifact_sha256: stored.sha256,
          media_type: spec.mediaType,
          ...(spec.ruleSource ? { rule_source: spec.ruleSource } : {}),
          count: spec.count,
        },
      });
    }

    const batchRes = db.ingestBatch({
      device_id: HOST_DEVICE_ID,
      events: eventsToIngest,
    });

    const check = db.verifyCurationArtifacts();
    if (!check.ok) {
      throw new Error(
        `curation events were committed, but post-import artifact verification failed: missing=${check.missing.join(",")}, altered=${check.altered.join(",")}`,
      );
    }

    return {
      dryRun: false,
      artifacts: summaries,
      acceptedEvents: batchRes.insertedCount,
      duplicateEvents: batchRes.duplicateCount,
      note: `Events appended to ledger; running exocortexd picks them up within 1s via IngestConsumer poll, or on next boot.${zeroPiecesWarning}`,
    };
  } finally {
    if (ownsDb) db.close();
  }
}

export function parseCurationImportArgs(argv: string[]): {
  exportPath: string;
  dbPath: string;
  apply: boolean;
} {
  let exportPath = "";
  let dbPath = getDefaultDbPath();
  let sawApply = false;
  let sawDryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") {
      sawApply = true;
    } else if (arg === "--dry-run") {
      sawDryRun = true;
    } else if (arg === "--db") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        throw new Error("--db requires a file path");
      }
      dbPath = resolve(next);
    } else if (!arg.startsWith("-")) {
      if (exportPath) {
        throw new Error(`unexpected extra positional argument: ${arg}`);
      }
      exportPath = resolve(arg);
    } else {
      throw new Error(`unknown flag: ${arg}`);
    }
  }

  if (sawApply && sawDryRun) {
    throw new Error("cannot combine --apply and --dry-run");
  }
  if (!exportPath) {
    throw new Error(
      "Usage: pnpm --filter @exocortex/daemon curation-import <neo4j-export.json> [--db <path>] [--apply]",
    );
  }
  return { exportPath, dbPath, apply: sawApply };
}

function isExecutedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(entry) === resolve(fileURLToPath(import.meta.url));
  }
}

function main(): void {
  try {
    const { exportPath, dbPath, apply } = parseCurationImportArgs(process.argv.slice(2));
    const raw = JSON.parse(readFileSync(exportPath, "utf8")) as RawNeo4jExport;
    const result = importCurationArtifacts(raw, { dbPath, apply });
    process.stdout.write(JSON.stringify({ dbPath, exportPath, ...result }, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`[curation-import] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

if (isExecutedDirectly()) {
  main();
}
