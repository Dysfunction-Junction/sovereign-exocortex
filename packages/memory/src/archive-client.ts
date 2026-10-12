/**
 * @file archive-client.ts
 * Thin client for the databank (encrypted archive on Lubuntu). Used by memory.search to add archived
 * matches next to the hot LocalLTM ones.
 *
 * Fail-soft by contract: a locked vault, a stopped service, a bad token or a slow tailnet never throws
 * and never delays the local answer by more than `timeoutMs`; the caller gets `{ available: false }`.
 * Hits are data from an archive, so they are flagged `untrusted` like every other recalled memory.
 */

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
          score: typeof h.score === "number" ? Math.round(h.score * 100) / 100 : 0,
          kind: String(h.kind ?? "other"),
          source: String(h.source ?? ""),
          title: h.title,
          path: String(h.path ?? ""),
          ts: typeof h.ts === "number" ? h.ts : 0,
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
}
