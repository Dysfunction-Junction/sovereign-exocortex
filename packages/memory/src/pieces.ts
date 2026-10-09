/**
 * PiecesOS Local Client
 *
 * Connects to the local PiecesOS instance (default http://127.0.0.1:39300).
 * Handles:
 * - Readiness polling (os_server takes 20-30s to bind :39300 after launch with no readiness signal).
 * - Health verification (/.well-known/health and /.well-known/version).
 * - Context retrieval across Workstream Events, Assets, and Workstream Summaries with relevance filtering.
 * - Explicit tracking of per-source retrieval success vs. failure (degraded vs. empty search).
 */

export const DEFAULT_PIECES_BASE_URL = "http://127.0.0.1:39300";
export const DEFAULT_TIMEOUT_MS = 5000;
export const MAX_ASSET_SNIPPETS = 5;
export const MAX_EVENT_SNIPPETS = 7;
export const MAX_SUMMARY_SNIPPETS = 4;
export const MAX_SNIPPET_CHARS = 500;

export interface PiecesClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface HealthCheckResult {
  ok: boolean;
  status: "up" | "down";
  version?: string;
  raw?: string;
  error?: string;
}

export interface ContextSnippet {
  source: "asset" | "workstream_event" | "summary";
  title: string;
  content: string;
  timestamp?: string;
  sortKey?: string;
  id?: string;
  relevanceScore?: number;
}

export interface SourceRetrievalResult {
  status: "ok" | "degraded" | "failed" | "skipped";
  snippets: ContextSnippet[];
  error?: string;
}

export interface ContextResult {
  snippets: ContextSnippet[];
  piecesAvailable: boolean;
  retrievalStatus: "ok" | "degraded" | "failed" | "offline";
  totalFound: number;
  sourcesStatus: {
    assets: { status: "ok" | "degraded" | "failed" | "skipped"; count: number; error?: string };
    events: { status: "ok" | "degraded" | "failed" | "skipped"; count: number; error?: string };
    summaries: { status: "ok" | "degraded" | "failed" | "skipped"; count: number; error?: string };
  };
  formattedNotes: string;
  errors?: string[];
}

interface WorkstreamEvent {
  id?: string;
  readable?: string;
  updated?: { value?: string };
  created?: { value?: string };
}

export const STOPWORDS = new Set([
  "the", "and", "for", "what", "did", "you", "are", "was", "with", "that", "this",
  "have", "from", "about", "how", "why", "when", "where", "which", "who", "does",
  "can", "not", "but", "all", "any", "some", "our", "your", "they", "them", "then"
]);

/** Words that mean "show me recent activity" rather than a topical search. */
const RECENT_ACTIVITY_WORDS = new Set([
  "been", "working", "recently", "recent", "lately", "today", "yesterday",
  "work", "doing", "done", "last", "week", "stuff", "latest", "current", "now",
]);

export function assertLocalPiecesRoute(path: string): void {
  const pathname = path.split("?")[0] ?? path;
  if (pathname === "/qgpt" || pathname.startsWith("/qgpt/")) {
    throw new Error("Refusing Pieces /qgpt route. Use local asset and workstream routes.");
  }
}

export function isRecencyQuery(keywords: string[]): boolean {
  return keywords.length === 0 || keywords.every((word) => RECENT_ACTIVITY_WORDS.has(word));
}

function readSummaryText(item: any): string {
  if (!item || typeof item !== "object") return "";
  const direct = [item.text, item.summary?.text, item.annotation?.text];
  for (const value of direct) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }

  const buckets = [item.annotations?.iterable, item.summary?.annotations?.iterable];
  let fallback = "";
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    for (const ann of bucket) {
      const node = ann?.annotation ?? ann;
      if (typeof node?.text !== "string" || node.text.trim().length === 0) continue;
      if (node.type === "SUMMARY") return node.text;
      if (!fallback) fallback = node.text;
    }
  }
  return fallback;
}

function readIterable(body: unknown): any[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, any>;
  if (Array.isArray(record.iterable)) return record.iterable;
  const nested =
    record.workstreamEvents ??
    record.workstream_events ??
    record.workstreamSummaries ??
    record.workstream_summaries;
  if (nested && typeof nested === "object" && Array.isArray(nested.iterable)) {
    return nested.iterable;
  }
  return [];
}

export function combineSignals(signals: (AbortSignal | null | undefined)[]): AbortSignal {
  const activeSignals = signals.filter((s): s is AbortSignal => Boolean(s));
  if (activeSignals.length === 0) return new AbortController().signal;
  if (activeSignals.length === 1) return activeSignals[0];
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(activeSignals);
  }
  const controller = new AbortController();
  for (const sig of activeSignals) {
    if (sig.aborted) {
      controller.abort(sig.reason);
      return controller.signal;
    }
    sig.addEventListener("abort", () => controller.abort(sig.reason), { once: true });
  }
  return controller.signal;
}

/**
 * Extracts a bounded window around matching query keywords so that evidence
 * occurring later in a document (e.g. beyond character 500) is retained for the model.
 */
export function extractExcerpt(content: string, keywords: string[], maxChars = MAX_SNIPPET_CHARS): string {
  if (!content) return "";
  if (content.length <= maxChars) return content;

  const lower = content.toLowerCase();
  let earliestIndex = -1;
  for (const kw of keywords) {
    if (!kw) continue;
    const idx = lower.indexOf(kw);
    if (idx !== -1 && (earliestIndex === -1 || idx < earliestIndex)) {
      earliestIndex = idx;
    }
  }

  if (earliestIndex === -1) {
    return content.slice(0, maxChars) + "...";
  }

  let start = Math.max(0, earliestIndex - 60);
  let end = Math.min(content.length, start + maxChars);
  if (end - start < maxChars) {
    start = Math.max(0, end - maxChars);
  }

  const prefix = start > 0 ? "..." : "";
  const suffix = end < content.length ? "..." : "";
  return prefix + content.slice(start, end).trim() + suffix;
}

export class PiecesClient {
  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;
  private readonly fetch: typeof fetch;
  private cachedApplication: Record<string, unknown> | null = null;

  constructor(options: PiecesClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.PIECES_BASE_URL ?? DEFAULT_PIECES_BASE_URL).replace(/\/$/, "");
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetch = options.fetchFn ?? globalThis.fetch;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private async request(path: string, init?: RequestInit, timeoutMs = this.defaultTimeoutMs): Promise<Response> {
    assertLocalPiecesRoute(path);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = combineSignals([init?.signal, timeoutSignal]);

    return this.fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal,
    });
  }

  /**
   * Health check against /.well-known/health and /.well-known/version.
   */
  async checkHealth(timeoutMs = 2000, signal?: AbortSignal): Promise<HealthCheckResult> {
    try {
      const res = await this.request("/.well-known/health", { signal }, timeoutMs);
      const text = await res.text();
      const isOk = res.ok && text.startsWith("ok:");

      let version: string | undefined;
      if (isOk) {
        try {
          const verRes = await this.request("/.well-known/version", { signal }, 2000);
          if (verRes.ok) {
            version = (await verRes.text()).trim();
          }
        } catch {
          // Version is secondary, keep health ok
        }
      }

      return {
        ok: isOk,
        status: isOk ? "up" : "down",
        version,
        raw: text,
      };
    } catch (err) {
      return {
        ok: false,
        status: "down",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Polls PiecesOS until it binds :39300 and responds healthy.
   * Useful on cold startup since os_server.exe takes 20-30s to bind.
   */
  async pollReadiness(options: { maxAttempts?: number; intervalMs?: number; timeoutPerAttemptMs?: number } = {}): Promise<boolean> {
    const maxAttempts = options.maxAttempts ?? 30;
    const intervalMs = options.intervalMs ?? 1000;
    const timeoutPerAttemptMs = options.timeoutPerAttemptMs ?? 1500;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const health = await this.checkHealth(timeoutPerAttemptMs);
      if (health.ok) {
        return true;
      }
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
    return false;
  }

  /**
   * Extract keywords from query for text search scoring.
   * Filters English stopwords, preserves Unicode characters (e.g. accented letters),
   * and extracts CJK character bigrams for Chinese, Japanese, and Korean scripts.
   */
  public extractKeywords(query: string): string[] {
    const normalized = query.toLowerCase();

    // Replace CJK character sequences with whitespace so adjacent Latin/accented words are cleanly separated
    const nonCjk = normalized.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu, " ");
    const words = nonCjk
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

    const cjkMatches = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? [];
    const cjkTokens: string[] = [];
    for (const seq of cjkMatches) {
      if (seq.length >= 2) {
        for (let i = 0; i < seq.length - 1; i++) cjkTokens.push(seq.slice(i, i + 2));
      } else if (seq.length === 1) {
        cjkTokens.push(seq);
      }
    }
    return [...new Set([...words, ...cjkTokens])];
  }

  public scoreText(text: string, keywords: string[]): number {
    const lower = text.toLowerCase();
    return keywords.reduce((score, kw) => (lower.includes(kw) ? score + 1 : score), 0);
  }

  /**
   * Search assets using GET /assets/search?query= and hydrate snippets.
   * Preserves errors rather than silently returning empty array.
   */
  async searchAssets(query: string, limit = MAX_ASSET_SNIPPETS, options: { signal?: AbortSignal } = {}): Promise<SourceRetrievalResult> {
    if (options.signal?.aborted) {
      return { status: "failed", snippets: [], error: "Asset search aborted by caller" };
    }

    try {
      // transferables=false keeps the search index response small. The default
      // (true) embeds file bytes and stalls on a real PiecesOS library.
      const res = await this.request(
        `/assets/search?query=${encodeURIComponent(query)}&transferables=false`,
        { signal: options.signal },
        8000
      );
      if (!res.ok) {
        return {
          status: "failed",
          snippets: [],
          error: `Asset search failed: HTTP ${res.status}`,
        };
      }

      const body = (await res.json()) as any;
      const iterable = Array.isArray(body?.iterable) ? body.iterable : [];
      if (iterable.length === 0) {
        return { status: "ok", snippets: [] };
      }

      const candidates = iterable.slice(0, limit);
      const snippets: ContextSnippet[] = [];
      const keywords = this.extractKeywords(query);
      let hydrationFailures = 0;
      const hydrationErrors: string[] = [];

      for (const item of candidates) {
        if (options.signal?.aborted) {
          hydrationFailures++;
          hydrationErrors.push("Hydration aborted by caller");
          break;
        }

        const asset = item.asset ?? item;
        const id = asset.id ?? asset.identifier ?? item.id ?? item.identifier;
        const name = asset.name ?? "(untitled snippet)";
        const timestamp = asset.updated?.readable ?? asset.updated?.value ?? asset.created?.readable ?? asset.created?.value;
        const sortKey = asset.updated?.value ?? asset.created?.value ?? "";

        let rawContent = "";
        let hydratedSuccessfully = false;

        if (id) {
          try {
            const detailRes = await this.request(`/asset/${encodeURIComponent(id)}`, { signal: options.signal }, 4000);
            if (detailRes.ok) {
              const detail = (await detailRes.json()) as any;
              if (detail.formats?.iterable) {
                for (const fmt of detail.formats.iterable) {
                  if (typeof fmt?.fragment?.string?.raw === "string") {
                    rawContent = fmt.fragment.string.raw;
                    hydratedSuccessfully = true;
                    break;
                  }
                }
              }
              if (!hydratedSuccessfully) {
                hydratedSuccessfully = true;
              }
            } else {
              hydrationFailures++;
              hydrationErrors.push(`Asset ${id} detail HTTP ${detailRes.status}`);
            }
          } catch (hErr) {
            hydrationFailures++;
            hydrationErrors.push(`Asset ${id} detail error: ${hErr instanceof Error ? hErr.message : String(hErr)}`);
          }
        }

        // Only include in context snippets if usable content was retrieved
        if (hydratedSuccessfully && typeof rawContent === "string" && rawContent.trim().length > 0) {
          const excerpt = extractExcerpt(rawContent, keywords, MAX_SNIPPET_CHARS);
          const score = this.scoreText(name + " " + excerpt, keywords);
          snippets.push({
            source: "asset",
            title: `Asset: ${name}`,
            content: excerpt,
            timestamp,
            sortKey,
            id,
            relevanceScore: score,
          });
        }
      }

      if (candidates.length > 0 && hydrationFailures === candidates.length) {
        return {
          status: "failed",
          snippets: [],
          error: `All ${candidates.length} asset detail hydrations failed: ${hydrationErrors[0]}`,
        };
      }

      const status: "ok" | "degraded" = hydrationFailures > 0 ? "degraded" : "ok";
      return {
        status,
        snippets,
        error: hydrationErrors.length > 0 ? hydrationErrors.join("; ") : undefined,
      };
    } catch (err) {
      return {
        status: "failed",
        snippets: [],
        error: `Asset search exception: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Fetch a bounded recent window of workstream events, then score them.
   * Never calls GET /workstream_events: that snapshot serializes the whole
   * long-term memory database and stalls PiecesOS.
   */
  async fetchRelevantWorkstreamEvents(query: string, limit = MAX_EVENT_SNIPPETS, options: { signal?: AbortSignal } = {}): Promise<SourceRetrievalResult> {
    if (options.signal?.aborted) {
      return { status: "failed", snippets: [], error: "Workstream events aborted by caller" };
    }

    try {
      const windowSize = 12;
      const idRes = await this.request(
        `/workstream_events/identifiers?limit=${windowSize}`,
        { signal: options.signal },
        8000
      );
      if (!idRes.ok) {
        return {
          status: "failed",
          snippets: [],
          error: `Workstream events failed: HTTP ${idRes.status}`,
        };
      }

      let iterable: WorkstreamEvent[] = readIterable(await idRes.json());
      const alreadyHasText = iterable.some((event) => typeof event.readable === "string" && event.readable.trim().length > 0);

      if (!alreadyHasText) {
        const ids = iterable
          .map((event) => event.id)
          .filter((id): id is string => typeof id === "string" && id.length > 0)
          .slice(0, windowSize);

        if (ids.length === 0) {
          return { status: "ok", snippets: [] };
        }

        const batchRes = await this.request(
          "/workstream_events/batch/fetch?transferables=false",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workstreamEvents: { iterable: ids.map((id) => ({ id })) } }),
            signal: options.signal,
          },
          8000
        );
        if (!batchRes.ok) {
          return {
            status: "failed",
            snippets: [],
            error: `Workstream event batch failed: HTTP ${batchRes.status}`,
          };
        }
        iterable = readIterable(await batchRes.json());
      }

      const keywords = this.extractKeywords(query);
      const recencyQuery = isRecencyQuery(keywords);
      const scored = iterable
        .map((event) => {
          const readable = typeof event.readable === "string" && event.readable.trim().length > 0
            ? event.readable
            : "(unspecified event)";
          const excerpt = extractExcerpt(readable, keywords, MAX_SNIPPET_CHARS);
          const score = keywords.length === 0 ? 0 : this.scoreText(excerpt, keywords);
          return { event, excerpt, score };
        })
        .filter(({ event, score }) => {
          const hasText = typeof event.readable === "string" && event.readable.trim().length > 0;
          if (!hasText) return false;
          return score > 0 || recencyQuery;
        });

      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const aTime = a.event.updated?.value ?? a.event.created?.value ?? "";
        const bTime = b.event.updated?.value ?? b.event.created?.value ?? "";
        return bTime.localeCompare(aTime);
      });

      const snippets: ContextSnippet[] = scored.slice(0, limit).map(({ event, excerpt, score }) => {
        const time = event.updated?.value ?? event.created?.value;
        return {
          source: "workstream_event",
          title: "Workstream Event",
          content: excerpt,
          timestamp: time,
          sortKey: time,
          id: event.id,
          relevanceScore: score,
        };
      });

      return {
        status: "ok",
        snippets,
      };
    } catch (err) {
      return {
        status: "failed",
        snippets: [],
        error: `Workstream events exception: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Search workstream summaries through the indexed search endpoint.
   * GET /workstream_summaries snapshots every summary and stalls a real library.
   */
  async fetchWorkstreamSummaries(query: string, limit = MAX_SUMMARY_SNIPPETS, options: { signal?: AbortSignal } = {}): Promise<SourceRetrievalResult> {
    if (options.signal?.aborted) {
      return { status: "failed", snippets: [], error: "Workstream summaries aborted by caller" };
    }

    try {
      const keywords = this.extractKeywords(query);
      const searchBody = {
        engines: {
          type: "OR",
          iterable: [
            {
              query,
              full_text: { exact: false },
            },
          ],
        },
      };
      const res = await this.request(
        "/workstream_summaries/search?transferables=true",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(searchBody),
          signal: options.signal,
        },
        8000
      );
      if (!res.ok) {
        return {
          status: "failed",
          snippets: [],
          error: `Workstream summaries failed: HTTP ${res.status}`,
        };
      }

      const items: any[] = readIterable(await res.json());
      if (items.length === 0) {
        return { status: "ok", snippets: [] };
      }

      const recencyQuery = isRecencyQuery(keywords);
      const candidates: Array<{ id: string; name: string; created: string; createdSort: string; titleScore: number; inlineText: string; similarity: number }> = items.map((item) => {
        const summary = item.summary ?? item;
        const name = typeof summary.name === "string"
          ? summary.name
          : typeof item.name === "string"
            ? item.name
            : "Workstream Summary";
        const inlineText = readSummaryText(item);
        const titleScore = keywords.length === 0 ? 0 : this.scoreText(`${name} ${inlineText}`, keywords);
        return {
          id: item.identifier ?? item.id ?? summary.id ?? summary.identifier ?? "",
          name,
          created: summary.created?.readable ?? summary.created?.value ?? item.created?.readable ?? "",
          createdSort: summary.created?.value ?? summary.updated?.value ?? item.created?.value ?? item.created?.readable ?? "",
          titleScore,
          inlineText,
          similarity: typeof item.similarity === "number" ? item.similarity : 0,
        };
      });

      candidates.sort((a, b) => {
        if (b.similarity !== a.similarity) return b.similarity - a.similarity;
        if (b.titleScore !== a.titleScore) return b.titleScore - a.titleScore;
        return b.createdSort.localeCompare(a.createdSort);
      });
      const topCandidates = candidates
        .filter((item) => recencyQuery || item.titleScore > 0 || item.inlineText.length === 0)
        .slice(0, 10);

      if (topCandidates.length === 0) {
        return { status: "ok", snippets: [] };
      }

      let hydrationFailures = 0;
      const hydrationErrors: string[] = [];

      const toSnippet = (
        item: (typeof topCandidates)[number],
        text: string,
        score: number
      ): ContextSnippet => ({
        source: "summary",
        title: `Summary: ${item.name}`,
        content: extractExcerpt(text, keywords, MAX_SNIPPET_CHARS),
        timestamp: item.created,
        sortKey: item.createdSort,
        id: item.id,
        relevanceScore: score,
      });

      // Parallelize hydration using Promise.all across top candidates
      const hydrationPromises = topCandidates.map(async (item): Promise<ContextSnippet | null> => {
        if (item.inlineText.trim().length > 0) {
          const keywordScore = keywords.length === 0 ? 0 : this.scoreText(item.name + " " + item.inlineText, keywords);
          const score = Math.max(keywordScore, item.titleScore);
          if (score > 0 || recencyQuery) {
            return toSnippet(item, item.inlineText, score);
          }
          return null;
        }

        if (options.signal?.aborted) {
          hydrationFailures++;
          return null;
        }

        try {
          const detailRes = await this.request(`/workstream_summary/${encodeURIComponent(item.id)}`, { signal: options.signal }, 3000);
          if (!detailRes.ok) {
            hydrationFailures++;
            hydrationErrors.push(`Summary ${item.id} detail HTTP ${detailRes.status}`);
            return null;
          }
          const detail = (await detailRes.json()) as any;
          const inline = readSummaryText(detail);
          const annotationIds: string[] = Object.keys(detail?.annotations?.indices ?? {});

          let summaryText: string | null = inline.length > 0 ? inline : null;
          for (const annId of annotationIds.slice(0, 3)) {
            if (options.signal?.aborted) break;
            const annRes = await this.request(`/annotation/${encodeURIComponent(annId)}`, { signal: options.signal }, 2000);
            if (annRes.ok) {
              const ann = (await annRes.json()) as any;
              if (ann?.type === "SUMMARY" && typeof ann?.text === "string") {
                summaryText = ann.text;
                break;
              } else if (ann?.type === "DESCRIPTION" && typeof ann?.text === "string" && !summaryText) {
                summaryText = ann.text;
              }
            } else {
              hydrationErrors.push(`Annotation ${annId} HTTP ${annRes.status}`);
            }
          }

          if (summaryText) {
            const keywordScore = keywords.length === 0 ? 0 : this.scoreText(item.name + " " + summaryText, keywords);
            const score = Math.max(keywordScore, item.titleScore);
            if (score > 0 || recencyQuery) {
              return toSnippet(item, summaryText, score);
            }
          }
        } catch (hErr) {
          hydrationFailures++;
          hydrationErrors.push(`Summary ${item.id} exception: ${hErr instanceof Error ? hErr.message : String(hErr)}`);
        }
        return null;
      });

      const hydratedRaw = await Promise.all(hydrationPromises);
      const hydrated = hydratedRaw.filter((s): s is ContextSnippet => s !== null);

      if (topCandidates.length > 0 && hydrationFailures === topCandidates.length) {
        return {
          status: "failed",
          snippets: [],
          error: `All ${topCandidates.length} summary hydrations failed: ${hydrationErrors[0] ?? "unknown error"}`,
        };
      }

      // Sort by relevance score, then chronological ISO timestamp
      hydrated.sort((a, b) => {
        const scoreDiff = (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0);
        if (scoreDiff !== 0) return scoreDiff;
        return (b.sortKey ?? "").localeCompare(a.sortKey ?? "");
      });

      const status: "ok" | "degraded" = hydrationFailures > 0 ? "degraded" : "ok";
      return {
        status,
        snippets: hydrated.slice(0, limit),
        error: hydrationErrors.length > 0 ? hydrationErrors.join("; ") : undefined,
      };
    } catch (err) {
      return {
        status: "failed",
        snippets: [],
        error: `Workstream summaries exception: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Save a text memory through the local asset route.
   * POST /assets/create uses an application already registered in PiecesOS.
   */
  async createAsset(input: { name: string; content: string }, options: { signal?: AbortSignal } = {}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const first = await this.createAssetOnce(input, options);
    if (first.ok || !/timeout|aborted/i.test(first.error)) return first;
    return this.createAssetOnce(input, options);
  }

  private async createAssetOnce(input: { name: string; content: string }, options: { signal?: AbortSignal } = {}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    try {
      const application = await this.registeredApplication(options.signal);
      if (!application) {
        return { ok: false, error: "No registered local Pieces application was found." };
      }

      const res = await this.request(
        "/assets/create?transferables=false",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "SEEDED_ASSET",
            asset: {
              application,
              metadata: { name: input.name, mechanism: "MANUAL" },
              format: {
                fragment: {
                  string: { raw: input.content },
                },
              },
            },
          }),
          signal: options.signal,
        },
        45000
      );

      const raw = await res.text();
      if (!res.ok) {
        return { ok: false, error: `Asset create failed: HTTP ${res.status}` };
      }

      let id = "";
      try {
        const parsed = JSON.parse(raw) as { id?: unknown };
        if (typeof parsed.id === "string") id = parsed.id;
      } catch {
        id = "";
      }
      if (!id) return { ok: false, error: "Asset create returned no id." };
      return { ok: true, id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async registeredApplication(signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    if (this.cachedApplication) return this.cachedApplication;
    const res = await this.request("/applications", { signal }, 15000);
    if (!res.ok) return null;
    const payload = await res.json() as { iterable?: unknown };
    if (!Array.isArray(payload.iterable)) return null;

    const apps = payload.iterable.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
    const preferred = apps.find((app) => app.name === "PIECES_FOR_DEVELOPERS_CLI") ?? apps[0];
    if (!preferred) return null;
    if (typeof preferred.id !== "string" || typeof preferred.name !== "string") return null;
    this.cachedApplication = {
      id: preferred.id,
      name: preferred.name,
      platform: preferred.platform,
      version: preferred.version,
      onboarded: preferred.onboarded,
      privacy: preferred.privacy,
    };
    return this.cachedApplication;
  }

  /**
   * Gather combined context across assets, workstream events, and summaries.
   * Accurately tracks per-source retrieval status and distinguishes failed searches
   * from successful empty searches.
   */
  async gatherContext(query: string, options: { signal?: AbortSignal; deepSearch?: boolean } = {}): Promise<ContextResult> {
    const health = await this.checkHealth(1500, options.signal);
    if (!health.ok) {
      return {
        snippets: [],
        piecesAvailable: false,
        retrievalStatus: "offline",
        totalFound: 0,
        sourcesStatus: {
          assets: { status: "skipped", count: 0, error: "PiecesOS offline" },
          events: { status: "skipped", count: 0, error: "PiecesOS offline" },
          summaries: { status: "skipped", count: 0, error: "PiecesOS offline" },
        },
        formattedNotes: "PiecesOS is currently offline or unreachable. No local memory context was retrieved.",
        errors: [health.error ?? `PiecesOS unreachable on ${this.baseUrl}`],
      };
    }

    // Full-library asset and summary search stalls PiecesOS 12.6.2 on a real
    // long-term memory database (the request keeps running after the client
    // gives up and can crash os_server). Recent workstream events are bounded
    // and are the default context. Set deepSearch to also query assets/summaries.
    const deepSearch = options.deepSearch === true;
    const skipped: SourceRetrievalResult = { status: "skipped", snippets: [] };
    const [assetsResult, eventsResult, summariesResult] = await Promise.all([
      deepSearch ? this.searchAssets(query, MAX_ASSET_SNIPPETS, options) : Promise.resolve(skipped),
      this.fetchRelevantWorkstreamEvents(query, MAX_EVENT_SNIPPETS, options),
      deepSearch ? this.fetchWorkstreamSummaries(query, MAX_SUMMARY_SNIPPETS, options) : Promise.resolve(skipped),
    ]);

    const errors: string[] = [];
    if (assetsResult.error) errors.push(assetsResult.error);
    if (eventsResult.error) errors.push(eventsResult.error);
    if (summariesResult.error) errors.push(summariesResult.error);

    const allSnippets = [
      ...assetsResult.snippets,
      ...eventsResult.snippets,
      ...summariesResult.snippets,
    ];

    const sourceStatuses = [assetsResult.status, eventsResult.status, summariesResult.status];
    const attempted = sourceStatuses.filter((status) => status !== "skipped");
    let retrievalStatus: "ok" | "degraded" | "failed" = "ok";
    if (attempted.length > 0 && attempted.every((status) => status === "failed")) {
      retrievalStatus = "failed";
    } else if (attempted.some((status) => status === "failed" || status === "degraded")) {
      retrievalStatus = "degraded";
    }

    let formattedNotes: string;
    if (retrievalStatus === "failed") {
      formattedNotes = "PiecesOS is running, but memory retrieval queries encountered errors:\n" + errors.join("\n");
    } else if (allSnippets.length === 0) {
      formattedNotes = retrievalStatus === "degraded"
        ? "No matching records found, though some PiecesOS retrieval queries were degraded:\n" + errors.join("\n")
        : "No matching notes or workstream events found in PiecesOS memory for this query.";
    } else {
      formattedNotes = allSnippets
        .map((s, index) => {
          const dateStr = s.timestamp ? ` (${s.timestamp})` : "";
          return `[${index + 1}] ${s.title}${dateStr}:\n${s.content}`;
        })
        .join("\n\n");
    }

    return {
      snippets: allSnippets,
      piecesAvailable: true,
      retrievalStatus,
      totalFound: allSnippets.length,
      sourcesStatus: {
        assets: {
          status: assetsResult.status,
          count: assetsResult.snippets.length,
          error: assetsResult.error,
        },
        events: {
          status: eventsResult.status,
          count: eventsResult.snippets.length,
          error: eventsResult.error,
        },
        summaries: {
          status: summariesResult.status,
          count: summariesResult.snippets.length,
          error: summariesResult.error,
        },
      },
      formattedNotes,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}
