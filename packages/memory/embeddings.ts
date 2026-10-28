import { createHash } from "node:crypto";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

// Local semantic embeddings (nomic-embed-text). Default backend is a llama.cpp
// `llama-server --embeddings` instance on 127.0.0.1:8081; set
// EXOCORTEX_EMBED_BACKEND=ollama to use Ollama's /api/embed instead. Mirrors the
// mobile textEmbedder contract: every failure path (server down, model missing,
// bad response, timeout) collapses to `null`, and callers fall back to plain
// token-overlap search. Embedding never blocks or breaks memory reads.

export const DEFAULT_EMBED_MODEL = "nomic-embed-text";
export const DEFAULT_LLAMA_EMBED_URL = "http://127.0.0.1:8081";
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

export type EmbedBackend = "llamacpp" | "ollama";

// nomic-embed-text is trained with task prefixes; omitting them noticeably
// degrades retrieval quality.
const DOC_PREFIX = "search_document: ";
const QUERY_PREFIX = "search_query: ";

// nomic's context here is 2048 tokens; ~6000 chars stays safely under it.
const MAX_EMBED_CHARS = 6000;
const BATCH_SIZE = 32;

export interface EmbedderOptions {
  backend?: EmbedBackend;
  baseUrl?: string;
  model?: string;
  queryTimeoutMs?: number;
  batchTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function resolveBackend(explicit?: EmbedBackend): EmbedBackend {
  if (explicit) return explicit;
  return (process.env.EXOCORTEX_EMBED_BACKEND ?? "").trim().toLowerCase() === "ollama" ? "ollama" : "llamacpp";
}

export class LocalEmbedder {
  public readonly model: string;
  public readonly backend: EmbedBackend;
  private readonly baseUrl: string;
  private readonly queryTimeoutMs: number;
  private readonly batchTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: EmbedderOptions = {}) {
    this.backend = resolveBackend(options.backend);
    const envUrl = this.backend === "ollama" ? process.env.OLLAMA_URL : process.env.EXOCORTEX_EMBED_URL;
    const fallback = this.backend === "ollama" ? DEFAULT_OLLAMA_URL : DEFAULT_LLAMA_EMBED_URL;
    this.baseUrl = (options.baseUrl ?? envUrl ?? fallback).replace(/\/+$/, "");
    this.model = options.model ?? process.env.EXOCORTEX_EMBED_MODEL ?? DEFAULT_EMBED_MODEL;
    this.queryTimeoutMs = options.queryTimeoutMs ?? 5_000;
    this.batchTimeoutMs = options.batchTimeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async embedQuery(text: string): Promise<number[] | null> {
    const out = await this.request([QUERY_PREFIX + clip(text)], this.queryTimeoutMs);
    return out ? out[0] : null;
  }

  public async embedDocuments(texts: string[]): Promise<(number[] | null)[]> {
    const results: (number[] | null)[] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const chunk = texts.slice(i, i + BATCH_SIZE).map((t) => DOC_PREFIX + clip(t));
      const out = await this.request(chunk, this.batchTimeoutMs);
      for (let j = 0; j < chunk.length; j++) results.push(out ? out[j] : null);
    }
    return results;
  }

  private async request(input: string[], timeoutMs: number): Promise<number[][] | null> {
    try {
      const ollama = this.backend === "ollama";
      const res = await this.fetchImpl(`${this.baseUrl}${ollama ? "/api/embed" : "/v1/embeddings"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ollama ? { model: this.model, input, truncate: true } : { model: this.model, input }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const vecs = ollama ? ollamaVectors(await res.json()) : openAiVectors(await res.json());
      if (!vecs || vecs.length !== input.length) return null;
      for (const v of vecs) {
        if (!Array.isArray(v) || v.length === 0 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) {
          return null;
        }
      }
      return vecs as number[][];
    } catch {
      return null;
    }
  }
}

/** Kept for existing imports; the embedder now defaults to llama.cpp. */
export const OllamaEmbedder = LocalEmbedder;
export type OllamaEmbedder = LocalEmbedder;

function ollamaVectors(data: unknown): unknown[] | null {
  const vecs = (data as { embeddings?: unknown } | null)?.embeddings;
  return Array.isArray(vecs) ? vecs : null;
}

// OpenAI-compatible shape served by llama-server: { data: [{ index, embedding }] }.
function openAiVectors(data: unknown): unknown[] | null {
  const rows = (data as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return null;
  const out: unknown[] = new Array(rows.length);
  for (const row of rows) {
    const index = (row as { index?: unknown })?.index;
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= rows.length || out[index as number] !== undefined) {
      return null;
    }
    out[index as number] = (row as { embedding?: unknown }).embedding;
  }
  return out;
}

function clip(text: string): string {
  return text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Sidecar vector cache keyed by sha256(model + text), so the source memory
// file's format is untouched and edited entries simply miss and re-embed.
// Append-only JSONL; later lines win. Delete the file to rebuild.
export class VectorCache {
  private map: Map<string, number[]> | null = null;

  constructor(private readonly path: string, private readonly model: string) {}

  public keyFor(text: string): string {
    return createHash("sha256").update(`${this.model}\n${text}`).digest("hex").slice(0, 32);
  }

  public async load(): Promise<Map<string, number[]>> {
    if (this.map) return this.map;
    const map = new Map<string, number[]>();
    if (existsSync(this.path)) {
      const raw = await readFile(this.path, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (typeof row?.k === "string" && Array.isArray(row.v) && row.v.length > 0) {
            map.set(row.k, row.v as number[]);
          }
        } catch {
          // Skip malformed lines
        }
      }
    }
    this.map = map;
    return map;
  }

  public async put(entries: Array<{ k: string; v: number[] }>): Promise<void> {
    if (entries.length === 0) return;
    const map = await this.load();
    for (const e of entries) map.set(e.k, e.v);
    await mkdir(dirname(this.path), { recursive: true });
    const lines = entries.map((e) => JSON.stringify({ k: e.k, v: e.v.map((n) => Math.round(n * 1e5) / 1e5) }));
    await appendFile(this.path, lines.join("\n") + "\n", "utf8");
  }
}
