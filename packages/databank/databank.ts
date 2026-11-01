/**
 * @file databank.ts
 * The databank: encrypted blob store + SQLite index (FTS5 + int8 vectors) + hash-chained
 * ingest log. See docs/DATABANK_ARCHITECTURE.md.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { BlobStore } from "./blobstore.js";
import { DatabankKeys } from "./crypto.js";
import { KINDS_SQL, SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";
import { chunkText, describeFile, extractText, isItemKind, kindOf, mimeOf, type ItemKind } from "./text.js";
import { VectorIndex, normalize, quantize, type VectorRow } from "./vectors.js";

export type { ItemKind } from "./text.js";

export interface Embedder {
  readonly model: string;
  embedQuery(text: string): Promise<number[] | null>;
  embedDocuments(texts: string[]): Promise<(number[] | null)[]>;
}

export interface DatabankOptions {
  /** Mounted vault root (contains `.vault-id` once provisioned). */
  root: string;
  keys: DatabankKeys;
  embedder?: Embedder | null;
  now?: () => number;
  /** Skip the `.vault-id` check (tests only). */
  skipVaultCheck?: boolean;
}

export interface TextInput {
  source: string;
  kind: ItemKind;
  title: string;
  text: string;
  path?: string;
  ts?: number;
  mime?: string;
  meta?: Record<string, unknown>;
  /** Keep the original text as an encrypted blob (default true). */
  storeBlob?: boolean;
}

export interface IngestResult {
  itemId: string;
  existed: boolean;
  chunks: number;
  vectors: number;
  blobId: string | null;
}

export interface SearchOptions {
  /** Retrieval partition, default Michael; legacy unowned records belong to Michael. */
  owner?: string;
  k?: number;
  kind?: ItemKind;
  source?: string;
  since?: number;
  until?: number;
  /** Cosine below this is ignored as a vector candidate. */
  minCosine?: number;
}

export interface SearchHit {
  itemId: string;
  score: number;
  kind: ItemKind;
  source: string;
  title: string;
  path: string;
  ts: number;
  blobId: string | null;
  snippet: string;
  via: "hybrid" | "fts" | "vector";
}

export interface ItemRow {
  item_id: string;
  source: string;
  kind: ItemKind;
  title: string;
  path: string;
  mime: string;
  size: number;
  ts: number;
  blob_id: string | null;
  meta: string;
  tier: string;
  ingested_at: number;
}

const VAULT_MARKER = ".vault-id";
const VECTOR_WEIGHT = 0.6;
const FTS_WEIGHT = 0.4;
const CANDIDATES = 50;
const GENESIS = "0".repeat(64);

type Row = Record<string, unknown>;

export class Databank {
  readonly blobs: BlobStore;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private vecCache: { model: string; count: number; index: VectorIndex } | null = null;

  private constructor(private readonly opts: DatabankOptions) {
    this.now = opts.now ?? Date.now;
    mkdirSync(join(opts.root, "index"), { recursive: true });
    this.db = new DatabaseSync(join(opts.root, "index", "databank.db"));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
    this.db.exec(SCHEMA_SQL);
    this.db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    this.migrate();
    this.blobs = new BlobStore(opts.root, opts.keys);
  }

  /** Opens (and initialises) a databank. Refuses an unprovisioned or unmounted vault. */
  static open(opts: DatabankOptions): Databank {
    if (!opts.skipVaultCheck && !existsSync(join(opts.root, VAULT_MARKER))) {
      throw new Error(`vault not mounted or not provisioned: missing ${join(opts.root, VAULT_MARKER)}`);
    }
    return new Databank(opts);
  }

  /** Writes the marker that makes `open` accept this directory (setup script does this on the real vault). */
  static provision(root: string, vaultId: string): void {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, VAULT_MARKER), vaultId + "\n", { flag: "wx", mode: 0o600 });
  }

  private migrate(): void {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    const currentVersion = row ? Number(row.value) : 1;
    if (currentVersion < 2) {
      this.db.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE IF NOT EXISTS items_v2 (
          item_id     TEXT PRIMARY KEY,
          source      TEXT NOT NULL,
          kind        TEXT NOT NULL CHECK (kind IN (${KINDS_SQL})),
          title       TEXT NOT NULL,
          path        TEXT NOT NULL DEFAULT '',
          mime        TEXT NOT NULL DEFAULT '',
          size        INTEGER NOT NULL DEFAULT 0,
          ts          INTEGER NOT NULL,
          blob_id     TEXT,
          meta        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta)),
          tier        TEXT NOT NULL DEFAULT 'archived' CHECK (tier IN ('hot','archived')),
          ingested_at INTEGER NOT NULL
        ) STRICT;
        INSERT OR IGNORE INTO items_v2 SELECT * FROM items;
        DROP TABLE items;
        ALTER TABLE items_v2 RENAME TO items;
        CREATE INDEX IF NOT EXISTS items_kind_ts ON items(kind, ts);
        CREATE INDEX IF NOT EXISTS items_source ON items(source);
        CREATE INDEX IF NOT EXISTS items_blob ON items(blob_id);
        INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '2');
        PRAGMA foreign_keys = ON;
      `);
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- ingest

  async ingestText(input: TextInput): Promise<IngestResult> {
    let blobId: string | null = null;
    if (input.storeBlob !== false) {
      blobId = (await this.blobs.put(Readable.from([Buffer.from(input.text, "utf8")]))).id;
    }
    return this.indexItem({
      source: input.source,
      kind: input.kind,
      title: input.title,
      path: input.path ?? "",
      mime: input.mime ?? "text/plain",
      size: Buffer.byteLength(input.text),
      ts: input.ts ?? this.now(),
      blobId,
      meta: input.meta ?? {},
      text: input.text,
    });
  }

  /** Ingests one file: encrypted blob + extracted text (documents) or a descriptive line (media). */
  async ingestFile(path: string, opts: { source: string; relPath?: string }): Promise<IngestResult> {
    const st = await stat(path);
    const rel = (opts.relPath ?? path).split(sep).join("/");
    const kind = kindOf(path);
    const put = await this.blobs.putFile(path);
    let text = await extractText(path, st.size);
    const description = describeFile(rel, kind, st.mtimeMs);
    text = text.trim().length > 0 ? `${description}\n\n${text}` : description;
    return this.indexItem({
      source: opts.source,
      kind,
      title: rel.split("/").pop() ?? rel,
      path: rel,
      mime: mimeOf(path),
      size: st.size,
      ts: Math.round(st.mtimeMs),
      blobId: put.id,
      meta: { mtimeMs: Math.round(st.mtimeMs) },
      text,
    });
  }

  /** Walks a directory (no symlinks), sequentially so a spinning disk is read in order. */
  async ingestDir(
    dir: string,
    opts: { source: string; skip?: (name: string) => boolean; onProgress?: (p: IngestProgress) => void },
  ): Promise<IngestSummary> {
    const summary: IngestSummary = { files: 0, newItems: 0, existing: 0, failed: [] };
    const skip = opts.skip ?? defaultSkip;
    const a = resolve(dir) + sep;
    const b = resolve(this.opts.root) + sep;
    if (a.startsWith(b) || b.startsWith(a)) {
      throw new Error("refusing to ingest a directory that contains or lies inside the vault");
    }
    const walk = async (d: string): Promise<void> => {
      const entries = await readdir(d, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (skip(e.name)) continue;
        const full = join(d, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.isFile()) {
          summary.files++;
          try {
            const r = await this.ingestFile(full, { source: opts.source, relPath: relative(dir, full) });
            if (r.existed) summary.existing++;
            else summary.newItems++;
          } catch (err) {
            summary.failed.push({ path: full, error: err instanceof Error ? err.message : String(err) });
          }
          opts.onProgress?.({ ...summary, current: full });
        }
      }
    };
    await walk(dir);
    return summary;
  }

  private async indexItem(it: {
    source: string;
    kind: ItemKind;
    title: string;
    path: string;
    mime: string;
    size: number;
    ts: number;
    blobId: string | null;
    meta: Record<string, unknown>;
    text: string;
  }): Promise<IngestResult> {
    if (!isItemKind(it.kind)) {
      throw new Error(`invalid item kind: ${it.kind}`);
    }
    const itemId = createHash("sha256")
      .update(`${it.source}\n${it.path || it.title}\n${it.blobId ?? createHash("sha256").update(it.text).digest("hex")}`)
      .digest("hex")
      .slice(0, 32);

    if (this.db.prepare("SELECT 1 FROM items WHERE item_id = ?").get(itemId)) {
      return { itemId, existed: true, chunks: 0, vectors: 0, blobId: it.blobId };
    }

    const chunks = chunkText(it.text);
    if (chunks.length === 0) chunks.push(it.title);
    const embedder = this.opts.embedder ?? null;
    const embedded = embedder ? await embedder.embedDocuments(chunks) : chunks.map(() => null);

    let vectors = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO items (item_id, source, kind, title, path, mime, size, ts, blob_id, meta, tier, ingested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'archived', ?)`,
        )
        .run(itemId, it.source, it.kind, it.title, it.path, it.mime, it.size, it.ts, it.blobId, JSON.stringify(it.meta), this.now());
      const insChunk = this.db.prepare("INSERT INTO chunks (item_id, ord, text) VALUES (?, ?, ?)");
      const insVec = this.db.prepare("INSERT INTO vectors (chunk_id, model, dim, scale, q8) VALUES (?, ?, ?, ?, ?)");
      for (let i = 0; i < chunks.length; i++) {
        const { lastInsertRowid } = insChunk.run(itemId, i, chunks[i]);
        const unit = embedded[i] ? normalize(embedded[i]!) : null;
        if (unit && embedder) {
          const { q8, scale } = quantize(unit);
          insVec.run(Number(lastInsertRowid), embedder.model, unit.length, scale, q8);
          vectors++;
        }
      }
      this.appendLog("ingest", itemId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { itemId, existed: false, chunks: chunks.length, vectors, blobId: it.blobId };
  }

  /** Embeds any chunk that has no vector yet (after an embedder outage or for old data). */
  async reindex(batch = 64): Promise<number> {
    const embedder = this.opts.embedder;
    if (!embedder) return 0;
    let done = 0;
    for (;;) {
      const rows = this.db
        .prepare(
          `SELECT c.chunk_id, c.text FROM chunks c LEFT JOIN vectors v ON v.chunk_id = c.chunk_id
            WHERE v.chunk_id IS NULL ORDER BY c.chunk_id LIMIT ?`,
        )
        .all(batch) as Row[];
      if (rows.length === 0) return done;
      const vecs = await embedder.embedDocuments(rows.map((r) => String(r.text)));
      let wrote = 0;
      const ins = this.db.prepare("INSERT OR IGNORE INTO vectors (chunk_id, model, dim, scale, q8) VALUES (?, ?, ?, ?, ?)");
      for (let i = 0; i < rows.length; i++) {
        const unit = vecs[i] ? normalize(vecs[i]!) : null;
        if (!unit) continue;
        const { q8, scale } = quantize(unit);
        ins.run(Number(rows[i].chunk_id), embedder.model, unit.length, scale, q8);
        wrote++;
      }
      if (wrote === 0) return done; // embedder is down; stop instead of spinning
      done += wrote;
    }
  }

  // ---------------------------------------------------------------- search

  async search(query: string, o: SearchOptions = {}): Promise<SearchHit[]> {
    if (o.owner !== undefined && (typeof o.owner !== 'string' || !o.owner.trim() || o.owner.length > 100)) {
      throw new Error('invalid owner');
    }
    o = { ...o, owner: o.owner?.trim().toLowerCase() ?? 'michael' };
    const k = Math.max(1, Math.min(o.k ?? 10, 100));
    const minCosine = o.minCosine ?? 0.3;
    const fts = this.ftsCandidates(query, o);
    let vec: Array<{ chunkId: number; cosine: number }> = [];
    const embedder = this.opts.embedder ?? null;
    if (embedder) {
      const q = await embedder.embedQuery(query);
      const unit = q ? normalize(q) : null;
      if (unit) {
        const index = this.vectorIndex(embedder.model);
        if (index && index.dim === unit.length) {
          vec = index.top(unit, CANDIDATES, this.allowedChunks(o)).filter((v) => v.cosine >= minCosine);
        }
      }
    }

    const ftsNorm = minMax(fts.map((f) => -f.bm25));
    const vecNorm = minMax(vec.map((v) => v.cosine));
    const scores = new Map<number, { fts: number; vec: number; hasFts: boolean; hasVec: boolean }>();
    fts.forEach((f, i) => scores.set(f.chunkId, { fts: ftsNorm[i], vec: 0, hasFts: true, hasVec: false }));
    vec.forEach((v, i) => {
      const s = scores.get(v.chunkId) ?? { fts: 0, vec: 0, hasFts: false, hasVec: false };
      s.vec = vecNorm[i];
      s.hasVec = true;
      scores.set(v.chunkId, s);
    });
    if (scores.size === 0) return [];

    const ids = [...scores.keys()];
    const { where, args } = this.filterSql(o);
    const rows = this.db
      .prepare(
        `SELECT c.chunk_id, c.text, i.* FROM chunks c JOIN items i ON i.item_id = c.item_id
          WHERE c.chunk_id IN (${ids.map(() => "?").join(",")}) ${where}`,
      )
      .all(...ids, ...args) as Row[];

    const best = new Map<string, SearchHit>();
    for (const r of rows) {
      const s = scores.get(Number(r.chunk_id))!;
      const score = vec.length > 0 ? VECTOR_WEIGHT * s.vec + FTS_WEIGHT * s.fts : s.fts;
      const itemId = String(r.item_id);
      const prev = best.get(itemId);
      if (prev && prev.score >= score) continue;
      best.set(itemId, {
        itemId,
        score,
        kind: r.kind as ItemKind,
        source: String(r.source),
        title: String(r.title),
        path: String(r.path),
        ts: Number(r.ts),
        blobId: (r.blob_id as string | null) ?? null,
        snippet: String(r.text).slice(0, 300),
        via: s.hasFts && s.hasVec ? "hybrid" : s.hasVec ? "vector" : "fts",
      });
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, k);
  }

  private ftsCandidates(query: string, o: SearchOptions): Array<{ chunkId: number; bm25: number }> {
    const tokens = (query.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 12);
    if (tokens.length === 0) return [];
    const match = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
    const { where, args } = this.filterSql(o);
    const rows = this.db
      .prepare(
        `SELECT c.chunk_id AS chunk_id, bm25(chunks_fts) AS b
           FROM chunks_fts JOIN chunks c ON c.chunk_id = chunks_fts.rowid
           JOIN items i ON i.item_id = c.item_id
          WHERE chunks_fts MATCH ? ${where}
          ORDER BY b LIMIT ${CANDIDATES}`,
      )
      .all(match, ...args) as Row[];
    return rows.map((r) => ({ chunkId: Number(r.chunk_id), bm25: Number(r.b) }));
  }

  private filterSql(o: SearchOptions): { where: string; args: Array<string | number> } {
    // Apply before both FTS ranking and vector top-k. Source/tier guards also cover
    // older Gwen records whose owner metadata has not yet been backfilled.
    const parts: string[] = [`(CASE WHEN json_valid(i.meta) THEN
      CASE WHEN i.source = 'gwen-messenger' OR i.tier = 'gwen-knowledge-base'
        OR json_extract(i.meta, '$.tier') = 'gwen-knowledge-base' THEN 'gwen'
        ELSE COALESCE(NULLIF(json_extract(i.meta, '$.owner'), ''), 'michael') END
      ELSE NULL END) = ?`];
    const args: Array<string | number> = [o.owner ?? 'michael'];
    if (o.kind) (parts.push("i.kind = ?"), args.push(o.kind));
    if (o.source) (parts.push("i.source = ?"), args.push(o.source));
    if (o.since !== undefined) (parts.push("i.ts >= ?"), args.push(o.since));
    if (o.until !== undefined) (parts.push("i.ts <= ?"), args.push(o.until));
    return { where: parts.length ? "AND " + parts.join(" AND ") : "", args };
  }

  /** Chunk IDs permitted by the owner partition and optional filters. */
  private allowedChunks(o: SearchOptions): Set<number> {
    const { where, args } = this.filterSql(o);
    const rows = this.db
      .prepare(`SELECT c.chunk_id FROM chunks c JOIN items i ON i.item_id = c.item_id WHERE 1=1 ${where}`)
      .all(...args) as Row[];
    return new Set(rows.map((r) => Number(r.chunk_id)));
  }

  private vectorIndex(model: string): VectorIndex | null {
    const count = Number((this.db.prepare("SELECT COUNT(*) AS n FROM vectors WHERE model = ?").get(model) as Row).n);
    if (count === 0) return null;
    if (this.vecCache && this.vecCache.model === model && this.vecCache.count === count) return this.vecCache.index;
    const dim = Number((this.db.prepare("SELECT dim FROM vectors WHERE model = ? LIMIT 1").get(model) as Row).dim);
    const rows = this.db
      .prepare("SELECT chunk_id, scale, q8 FROM vectors WHERE model = ? AND dim = ?")
      .all(model, dim) as unknown as VectorRow[];
    const index = new VectorIndex(dim, rows);
    this.vecCache = { model, count, index };
    return index;
  }

  // ---------------------------------------------------------------- reads / audit

  getItem(itemId: string): ItemRow | null {
    return (this.db.prepare("SELECT * FROM items WHERE item_id = ?").get(itemId) as unknown as ItemRow) ?? null;
  }

  stats(): { items: number; chunks: number; vectors: number; blobs: number; byKind: Record<string, number>; bySource: Record<string, number> } {
    const n = (sql: string): number => Number((this.db.prepare(sql).get() as Row).n);
    const byKind: Record<string, number> = {};
    for (const r of this.db.prepare("SELECT kind, COUNT(*) AS n FROM items GROUP BY kind").all() as Row[]) {
      byKind[String(r.kind)] = Number(r.n);
    }
    const bySource: Record<string, number> = {};
    for (const r of this.db.prepare("SELECT source, COUNT(*) AS n FROM items GROUP BY source").all() as Row[]) {
      bySource[String(r.source)] = Number(r.n);
    }
    return {
      items: n("SELECT COUNT(*) AS n FROM items"),
      chunks: n("SELECT COUNT(*) AS n FROM chunks"),
      vectors: n("SELECT COUNT(*) AS n FROM vectors"),
      blobs: n("SELECT COUNT(DISTINCT blob_id) AS n FROM items WHERE blob_id IS NOT NULL"),
      byKind,
      bySource,
    };
  }

  private appendLog(action: string, itemId: string): void {
    const last = this.db.prepare("SELECT hash FROM ingest_log ORDER BY seq DESC LIMIT 1").get() as Row | undefined;
    const prev = last ? String(last.hash) : GENESIS;
    const ts = this.now();
    const hash = logHash(prev, ts, action, itemId);
    this.db
      .prepare("INSERT INTO ingest_log (ts, action, item_id, prev_hash, hash) VALUES (?, ?, ?, ?, ?)")
      .run(ts, action, itemId, prev, hash);
  }

  /** Recomputes the whole ingest-log hash chain. */
  verifyLog(): { ok: boolean; entries: number; brokenAt?: number } {
    let prev = GENESIS;
    let entries = 0;
    for (const r of this.db.prepare("SELECT * FROM ingest_log ORDER BY seq").all() as Row[]) {
      entries++;
      if (String(r.prev_hash) !== prev || String(r.hash) !== logHash(prev, Number(r.ts), String(r.action), String(r.item_id))) {
        return { ok: false, entries, brokenAt: Number(r.seq) };
      }
      prev = String(r.hash);
    }
    return { ok: true, entries };
  }

  /** Decrypts and re-hashes up to `limit` distinct blobs (all when omitted). */
  async verifyBlobs(limit?: number): Promise<{ checked: number; bad: Array<{ id: string; error: string }> }> {
    const rows = this.db
      .prepare(`SELECT DISTINCT blob_id FROM items WHERE blob_id IS NOT NULL ${limit ? `LIMIT ${Math.floor(limit)}` : ""}`)
      .all() as Row[];
    const bad: Array<{ id: string; error: string }> = [];
    for (const r of rows) {
      const id = String(r.blob_id);
      const v = await this.blobs.verify(id);
      if (!v.ok) bad.push({ id, error: v.error ?? "unknown" });
    }
    return { checked: rows.length, bad };
  }

  /** Returns item rows matching a source (e.g. 'contacts') */
  getItemsBySource(source: string, limit = 50000): ItemRow[] {
    return this.db
      .prepare("SELECT * FROM items WHERE source = ? ORDER BY ingested_at ASC LIMIT ?")
      .all(source, limit) as unknown as ItemRow[];
  }
}

export interface IngestSummary {
  files: number;
  newItems: number;
  existing: number;
  failed: Array<{ path: string; error: string }>;
}
export type IngestProgress = IngestSummary & { current: string };

const SKIP_NAMES = new Set(["desktop.ini", "thumbs.db", ".ds_store", "$recycle.bin", "system volume information"]);
function defaultSkip(name: string): boolean {
  const n = name.toLowerCase();
  return SKIP_NAMES.has(n) || n.endsWith(".tmp") || n.endsWith(".part") || n.startsWith("ntuser.");
}

function logHash(prev: string, ts: number, action: string, itemId: string): string {
  return createHash("sha256").update(`${prev}|${ts}|${action}|${itemId}`).digest("hex");
}

/** Min-max to [0,1]; a lone value (or all-equal values) maps to 1. */
export function minMax(xs: number[]): number[] {
  let lo = Infinity, hi = -Infinity;
  for (const x of xs) {
    if (Number.isFinite(x)) {
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
  }
  if (lo === Infinity) return xs.map(() => 0); // no finite values
  const span = hi - lo;
  return xs.map((x) =>
    !Number.isFinite(x)
      ? 0
      : span === 0 || !Number.isFinite(span)
        ? 1
        : Math.min(1, Math.max(0, (x - lo) / span))
  );
}
