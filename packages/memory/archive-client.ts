/**
 * @file archive-client.ts
 * Thin client for the databank (encrypted archive on Lubuntu). Used by memory.search to add archived
 * matches next to the hot LocalLTM ones.
 *
 * Fail-soft by contract: a locked vault, a stopped service, a bad token or a slow tailnet never throws
 * and never delays the local answer by more than `timeoutMs`; the caller gets `{ available: false }`.
 * Hits are data from an archive, so they are flagged `untrusted` like every other recalled memory.
 */

import { copyFile, readFile, rename, writeFile } from "node:fs/promises";

export interface ArchiveHit {
  itemId: string;
  score: number;
  kind: string;
  source: string;
  title: string;
  path: string;
  ts: number;
  snippet: string;
  untrusted: true;
}

export type ArchiveResult =
  | { available: true; hits: ArchiveHit[] }
  | { available: false; reason: "locked-or-unreachable" | "unauthorized" | "error" };

export type ArchiveHealthResult =
  | { available: true; items: number; chunks: number; blobs: number }
  | { available: false; reason: "locked-or-unreachable" | "unauthorized" | "error" };

export interface ArchiveIngestInput {
  source: string;
  kind: "memory" | "document" | "photo" | "video" | "audio" | "text" | "other";
  title: string;
  text: string;
  path?: string;
  ts?: number;
  meta?: Record<string, unknown>;
}

export type ArchiveIngestResult =
  | { ok: true; itemId: string; existed: boolean; chunks: number; vectors: number; blobId: string | null }
  | { ok: false; reason: "locked-or-unreachable" | "unauthorized" | "error" };

export interface RemoteArchiveResult {
  scanned: number;
  archived: number;
  alreadyArchived: number;
  kept: number;
  pruned: boolean;
  backup?: string;
  failed: number;
}

export interface ArchiveClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const MAX_SNIPPET = 300;

export class ArchiveClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ArchiveClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 4000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Client from DATABANK_URL + DATABANK_TOKEN, or null when the archive is not configured. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): ArchiveClient | null {
    const baseUrl = env.DATABANK_URL?.trim();
    const token = env.DATABANK_TOKEN?.trim();
    if (!baseUrl || !token) return null;
    try {
      new URL(baseUrl);
    } catch {
      return null;
    }
    return new ArchiveClient({ baseUrl, token });
  }

  async search(query: string, k = 5): Promise<ArchiveResult> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ q: query, k }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 401 || res.status === 403) return { available: false, reason: "unauthorized" };
      if (!res.ok) return { available: false, reason: "error" };
      const body = (await res.json()) as { hits?: unknown };
      if (!Array.isArray(body?.hits)) return { available: false, reason: "error" };
      const hits: ArchiveHit[] = [];
      for (const h of body.hits as Array<Record<string, unknown>>) {
        if (typeof h?.itemId !== "string" || typeof h.title !== "string") continue;
        hits.push({
          itemId: h.itemId,
          score: typeof h.score === "number" && Number.isFinite(h.score) ? Math.min(1, Math.max(0, Math.round(h.score * 100) / 100)) : 0,
          kind: String(h.kind ?? "other"),
          source: String(h.source ?? ""),
          title: h.title,
          path: String(h.path ?? ""),
          ts: typeof h.ts === "number" && Number.isFinite(h.ts) ? Math.max(0, h.ts) : 0,
          snippet: String(h.snippet ?? "").slice(0, MAX_SNIPPET),
          untrusted: true,
        });
      }
      return { available: true, hits };
    } catch {
      // Connection refused / timeout / TLS / DNS: the vault is locked, the box is off, or the tailnet is down.
      return { available: false, reason: "locked-or-unreachable" };
    }
  }

  async health(): Promise<ArchiveHealthResult> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/health`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 401 || res.status === 403) return { available: false, reason: "unauthorized" };
      if (!res.ok) return { available: false, reason: "error" };
      const body = (await res.json()) as { ok?: boolean; items?: number; chunks?: number; blobs?: number };
      if (body?.ok !== true || typeof body?.items !== "number") return { available: false, reason: "error" };
      return {
        available: true,
        items: body.items,
        chunks: typeof body.chunks === "number" ? body.chunks : 0,
        blobs: typeof body.blobs === "number" ? body.blobs : 0,
      };
    } catch {
      return { available: false, reason: "locked-or-unreachable" };
    }
  }

  async ingestText(input: ArchiveIngestInput): Promise<ArchiveIngestResult> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/ingest/text`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(this.timeoutMs * 2),
      });
      if (res.status === 401 || res.status === 403) return { ok: false, reason: "unauthorized" };
      if (!res.ok) return { ok: false, reason: "error" };
      const body = (await res.json()) as { itemId?: string; existed?: boolean; chunks?: number; vectors?: number; blobId?: string | null };
      if (typeof body?.itemId !== "string") return { ok: false, reason: "error" };
      return {
        ok: true,
        itemId: body.itemId,
        existed: Boolean(body.existed),
        chunks: typeof body.chunks === "number" ? body.chunks : 0,
        vectors: typeof body.vectors === "number" ? body.vectors : 0,
        blobId: typeof body.blobId === "string" ? body.blobId : null,
      };
    } catch {
      return { ok: false, reason: "locked-or-unreachable" };
    }
  }
}

export async function archiveLocalMemoriesToRemote(
  client: ArchiveClient,
  file: string,
  opts: { olderThanDays: number; prune?: boolean; now?: number },
): Promise<RemoteArchiveResult> {
  const now = opts.now ?? Date.now();
  const cutoff = now - opts.olderThanDays * 86_400_000;
  const raw = await readFile(file, "utf8");
  const lines = raw.split("\n");
  const keep: string[] = [];
  const res: RemoteArchiveResult = { scanned: 0, archived: 0, alreadyArchived: 0, kept: 0, pruned: false, failed: 0 };

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown> | null = null;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      keep.push(line);
      continue;
    }
    res.scanned++;
    // server.ts writes `loggedAt`; local-ltm writes `createdAt`. Accept both.
    const stamp = typeof entry.createdAt === "string" ? entry.createdAt : typeof entry.loggedAt === "string" ? entry.loggedAt : "";
    const created = stamp ? Date.parse(stamp) : NaN;
    if (typeof entry.body !== "string" || !Number.isFinite(created) || created > cutoff) {
      keep.push(line);
      continue;
    }
    const title = typeof entry.title === "string" ? entry.title : "memory";
    const r = await client.ingestText({
      source: typeof entry.source === "string" ? entry.source : "ltm",
      kind: "memory",
      title,
      text: `${title}\n\n${entry.body}`,
      path: `ltm/${stamp}`,
      ts: created,
      meta: { tags: Array.isArray(entry.tags) ? entry.tags : [] },
    });
    if (r.ok) {
      if (r.existed) res.alreadyArchived++;
      else res.archived++;
    } else {
      res.failed++;
      keep.push(line);
    }
  }
  res.kept = keep.length;

  if (opts.prune && res.failed === 0 && (res.archived > 0 || res.alreadyArchived > 0)) {
    const backup = `${file}.pre-prune-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(file, backup);
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, keep.length ? keep.join("\n") + "\n" : "");
    await rename(tmp, file);
    res.pruned = true;
    res.backup = backup;
  }
  return res;
}

