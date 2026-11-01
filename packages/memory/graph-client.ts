/**
 * @file graph-client.ts
 * Local, fail-soft client for the exported Pieces knowledge graph (PLAN_WORLD_MODEL_STORE_2026-10-31 §8).
 *
 * Replaces the retired Neo4j Aura HTTP Query API client with zero network egress. Reads `PiecesRecord` /
 * `Doc` nodes locally from `exocortex.db`'s append-only `artifacts` table (`PIECES_GRAPH_MEDIA_TYPE`,
 * ordered by the latest host `curation_import` event) or a local JSON export file, preserving the
 * `GraphResult` contract (`available`, `hits`, `untrusted: true`).
 *
 * Integrity note: unpinned SHA-256 verification checks `sha256(bytes) === key` (corruption detection,
 * not cryptographic authorship). Supply `expectedSha256` / `PIECES_GRAPH_SHA256` to pin a specific export;
 * all recalled graph hits remain flagged `untrusted: true`.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const PIECES_GRAPH_MEDIA_TYPE = "application/vnd.exocortex.pieces-graph+json";
export const MAX_PIECES_GRAPH_BYTES = 20 * 1024 * 1024;

const POSITIVE_CACHE_TTL_MS = 30_000;
const NEGATIVE_CACHE_TTL_MS = 5_000;
const HOST_DEVICE_ID = "host:exocortexd";
const MAX_SNIPPET = 300;

export interface GraphHit {
  kind: string;
  title: string;
  snippet: string;
  path: string;
  /** Number of edges touching the node: a cheap relevance hint (well-connected records matter more). */
  links: number;
  untrusted: true;
}

export type GraphResult =
  | { available: true; hits: GraphHit[] }
  | { available: false; reason: "unreachable" | "unauthorized" | "error" };

export interface PiecesGraphRecord {
  id: string;
  kind: string;
  name: string;
  ref: string;
  path: string;
  created: string;
  links: number;
}

export interface PiecesGraphEdge {
  type: string;
  source_id: string;
  target_id: string;
}

export interface PiecesGraphArtifact {
  version: 1;
  nodes: PiecesGraphRecord[];
  relationships: PiecesGraphEdge[];
}

export interface GraphClientOptions {
  /** Pre-loaded records (primarily for deterministic unit tests). */
  records?: readonly PiecesGraphRecord[];
  /** Path to a local JSON export containing `{ nodes: PiecesGraphRecord[] }` or `PiecesGraphRecord[]`. */
  exportPath?: string;
  /** Path to `exocortex.db` holding the `PIECES_GRAPH_MEDIA_TYPE` row in `artifacts`. */
  sqliteDbPath?: string;
  /** Optional 64-hex SHA-256 pin verified against the file or SQLite artifact bytes. */
  expectedSha256?: string;
  /** Optional clock override for deterministic TTL cache tests. */
  nowMs?: () => number;
}

interface IndexedRecord {
  record: PiecesGraphRecord;
  nameLc: string;
  refLc: string;
}

function indexRecords(records: readonly PiecesGraphRecord[]): IndexedRecord[] {
  return records.map((record) => ({
    record,
    nameLc: record.name.toLowerCase(),
    refLc: record.ref.toLowerCase(),
  }));
}

function parseRecordsPayload(parsed: unknown): PiecesGraphRecord[] | null {
  const rawNodes = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { nodes?: unknown }).nodes)
    ? (parsed as { nodes: unknown[] }).nodes
    : null;
  if (!rawNodes) return null;

  const out: PiecesGraphRecord[] = [];
  for (const item of rawNodes) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name : "";
    const ref = typeof rec.ref === "string" ? rec.ref : "";
    const path = typeof rec.path === "string" ? rec.path : "";
    const id = typeof rec.id === "string" && rec.id ? rec.id : path || name;
    if (!name && !ref) continue;
    out.push({
      id,
      kind: typeof rec.kind === "string" && rec.kind ? rec.kind : "Other",
      name,
      ref,
      path,
      created: typeof rec.created === "string" ? rec.created : "",
      links: typeof rec.links === "number" && Number.isFinite(rec.links) ? rec.links : 0,
    });
  }
  if (rawNodes.length > 0 && out.length === 0) {
    return null;
  }
  return out;
}

function openReadOnlySqlite(dbPath: string): DatabaseSync {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    db = new DatabaseSync(dbPath);
  }
  db.exec("PRAGMA busy_timeout = 250; PRAGMA query_only = ON;");
  return db;
}

function resolveTargetShaInDb(db: DatabaseSync, expectedSha?: string): string | null {
  if (expectedSha) return expectedSha;
  try {
    const evRow = db
      .prepare(
        `SELECT lower(json_extract(payload, '$.artifact_sha256')) AS sha
         FROM events
         WHERE kind = 'curation_import'
           AND device_id = ?
           AND json_valid(payload)
           AND json_extract(payload, '$.media_type') = ?
         ORDER BY seq DESC
         LIMIT 1`,
      )
      .get(HOST_DEVICE_ID, PIECES_GRAPH_MEDIA_TYPE) as { sha?: unknown } | undefined;
    if (typeof evRow?.sha === "string" && /^[0-9a-f]{64}$/.test(evRow.sha)) {
      return evRow.sha;
    }
  } catch (err) {
    if (!(err instanceof Error && /no such table/i.test(err.message))) {
      throw err;
    }
  }

  const artRow = db
    .prepare("SELECT lower(hex(sha256)) AS sha FROM artifacts WHERE media_type = ? ORDER BY rowid DESC LIMIT 1")
    .get(PIECES_GRAPH_MEDIA_TYPE) as { sha?: unknown } | undefined;
  return typeof artRow?.sha === "string" && /^[0-9a-f]{64}$/.test(artRow.sha) ? artRow.sha : null;
}

export class GraphClient {
  private readonly opts: GraphClientOptions;
  private readonly nowMs: () => number;
  private readonly staticIndexed: readonly IndexedRecord[] | null;

  private cachedIndexed: readonly IndexedRecord[] | null = null;
  private cachedVersionKey: string | null = null;
  private cacheExpiresAt = 0;
  private negativeReason: "unreachable" | "error" | null = null;
  private negativeExpiresAt = 0;

  constructor(opts: GraphClientOptions) {
    this.opts = opts;
    this.nowMs = opts.nowMs ?? Date.now;
    this.staticIndexed = opts.records ? indexRecords(opts.records) : null;
  }

  /**
   * Local client from `PIECES_GRAPH_EXPORT_PATH`, `PIECES_GRAPH_DB_PATH`, or `EXOCORTEX_DB_PATH`
   * (with optional `PIECES_GRAPH_SHA256` pin), or `null` when unconfigured.
   * Performs zero startup I/O so artifacts imported after gateway boot become visible automatically,
   * and ignores legacy `NEO4J_*` variables completely.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): GraphClient | null {
    const expectedSha256 = env.PIECES_GRAPH_SHA256?.trim() || undefined;
    const exportPath = env.PIECES_GRAPH_EXPORT_PATH?.trim();
    if (exportPath) {
      return new GraphClient({ exportPath, expectedSha256 });
    }
    const dbPath = env.PIECES_GRAPH_DB_PATH?.trim() || env.EXOCORTEX_DB_PATH?.trim();
    if (dbPath) {
      return new GraphClient({ sqliteDbPath: dbPath, expectedSha256 });
    }
    return null;
  }

  private setNegative(now: number, reason: "unreachable" | "error"): { ok: false; reason: "unreachable" | "error" } {
    this.cachedIndexed = null;
    this.cachedVersionKey = null;
    this.negativeReason = reason;
    this.negativeExpiresAt = now + NEGATIVE_CACHE_TTL_MS;
    return { ok: false, reason };
  }

  private loadRecords():
    | { ok: true; indexed: readonly IndexedRecord[] }
    | { ok: false; reason: "unreachable" | "error" } {
    if (this.staticIndexed) {
      return { ok: true, indexed: this.staticIndexed };
    }

    const now = this.nowMs();
    if (this.cachedIndexed && now < this.cacheExpiresAt) {
      return { ok: true, indexed: this.cachedIndexed };
    }
    if (this.negativeReason && now < this.negativeExpiresAt) {
      return { ok: false, reason: this.negativeReason };
    }

    const expectedSha = this.opts.expectedSha256?.toLowerCase();
    if (expectedSha && !/^[0-9a-f]{64}$/.test(expectedSha)) {
      return this.setNegative(now, "error");
    }

    if (this.opts.exportPath) {
      if (!existsSync(this.opts.exportPath)) {
        return this.setNegative(now, "unreachable");
      }
      try {
        const st = statSync(this.opts.exportPath);
        if (!st.isFile() || st.size > MAX_PIECES_GRAPH_BYTES) {
          return this.setNegative(now, "error");
        }
        const versionKey = `file:${st.mtimeMs}:${st.size}:${expectedSha ?? ""}`;
        if (this.cachedIndexed && this.cachedVersionKey === versionKey) {
          this.cacheExpiresAt = now + POSITIVE_CACHE_TTL_MS;
          return { ok: true, indexed: this.cachedIndexed };
        }
        const bytes = readFileSync(this.opts.exportPath);
        if (bytes.byteLength > MAX_PIECES_GRAPH_BYTES) {
          return this.setNegative(now, "error");
        }
        if (expectedSha) {
          const actual = createHash("sha256").update(bytes).digest("hex");
          if (actual !== expectedSha) return this.setNegative(now, "error");
        }
        const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
        const records = parseRecordsPayload(parsed);
        if (!records) return this.setNegative(now, "error");
        const indexed = indexRecords(records);
        this.cachedIndexed = indexed;
        this.cachedVersionKey = versionKey;
        this.cacheExpiresAt = now + POSITIVE_CACHE_TTL_MS;
        this.negativeReason = null;
        return { ok: true, indexed };
      } catch {
        return this.setNegative(now, "error");
      }
    }

    if (this.opts.sqliteDbPath) {
      if (!existsSync(this.opts.sqliteDbPath)) {
        return this.setNegative(now, "unreachable");
      }
      let db: DatabaseSync | null = null;
      try {
        db = openReadOnlySqlite(this.opts.sqliteDbPath);
        const targetSha = resolveTargetShaInDb(db, expectedSha);
        if (!targetSha) {
          return this.setNegative(now, "unreachable");
        }
        const versionKey = `sqlite:${targetSha}`;
        if (this.cachedIndexed && this.cachedVersionKey === versionKey) {
          this.cacheExpiresAt = now + POSITIVE_CACHE_TTL_MS;
          return { ok: true, indexed: this.cachedIndexed };
        }
        const row = db
          .prepare("SELECT sha256, bytes FROM artifacts WHERE sha256 = ? AND media_type = ?")
          .get(Buffer.from(targetSha, "hex"), PIECES_GRAPH_MEDIA_TYPE) as
          | { sha256: Uint8Array; bytes: Uint8Array }
          | undefined;
        if (!row) {
          return this.setNegative(now, "unreachable");
        }
        const bytes = Buffer.from(row.bytes);
        if (bytes.byteLength > MAX_PIECES_GRAPH_BYTES) {
          return this.setNegative(now, "error");
        }
        const keyHex = Buffer.from(row.sha256).toString("hex");
        const actualHex = createHash("sha256").update(bytes).digest("hex");
        if (actualHex !== keyHex || actualHex !== targetSha) {
          return this.setNegative(now, "error");
        }
        const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
        const records = parseRecordsPayload(parsed);
        if (!records) return this.setNegative(now, "error");
        const indexed = indexRecords(records);
        this.cachedIndexed = indexed;
        this.cachedVersionKey = versionKey;
        this.cacheExpiresAt = now + POSITIVE_CACHE_TTL_MS;
        this.negativeReason = null;
        return { ok: true, indexed };
      } catch {
        return this.setNegative(now, "error");
      } finally {
        try {
          db?.close();
        } catch {
          // ignore close errors on read-only connection
        }
      }
    }

    return this.setNegative(now, "unreachable");
  }

  async search(query: string, k = 5): Promise<GraphResult> {
    const loaded = this.loadRecords();
    if (!loaded.ok) {
      return { available: false, reason: loaded.reason };
    }

    const needle = query.toLowerCase();
    const limit = Number.isFinite(k) ? Math.max(0, Math.floor(k)) : 5;
    if (limit === 0) {
      return { available: true, hits: [] };
    }

    const matched: PiecesGraphRecord[] = [];
    for (const entry of loaded.indexed) {
      if (entry.nameLc.includes(needle) || entry.refLc.includes(needle)) {
        matched.push(entry.record);
      }
    }

    matched.sort((a, b) => {
      if (b.links !== a.links) return b.links - a.links;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const hits: GraphHit[] = matched.slice(0, limit).map((r) => ({
      kind: String(r.kind || "Other"),
      title: String(r.name || r.ref).slice(0, MAX_SNIPPET),
      snippet: String(r.ref ?? "").slice(0, MAX_SNIPPET),
      path: String(r.path ?? ""),
      links: typeof r.links === "number" && Number.isFinite(r.links) ? r.links : 0,
      untrusted: true,
    }));

    return { available: true, hits };
  }
}
