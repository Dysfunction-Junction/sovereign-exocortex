import { readFile, appendFile, mkdir, open, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalEmbedder, VectorCache, cosine } from "./embeddings.js";

export interface MemoryEntry {
  title: string;
  body: string;
  createdAt: string;
  source?: string;
  tags?: string[];
}

export interface MemorySearchResult extends MemoryEntry {
  score: number;
  untrusted: boolean;
}

function getDefaultLtmFile(): string {
  if (process.env.LOCAL_LTM_FILE && process.env.LOCAL_LTM_FILE.trim().length > 0) {
    return process.env.LOCAL_LTM_FILE.trim();
  }
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return resolve(currentDir, "./data/memories.jsonl");
}

function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  return new Set(words);
}

function computeSimilarity(queryTokens: Set<string>, docTokens: Set<string>): number {
  if (queryTokens.size === 0 || docTokens.size === 0) return 0;
  let matches = 0;
  for (const token of queryTokens) {
    if (docTokens.has(token)) matches += 1;
  }
  return matches / Math.sqrt(queryTokens.size * docTokens.size);
}

// Semantic weight in the hybrid score. Calibrated against nomic-embed-text:
// related pairs score ~0.54-0.66 cosine but unrelated ones reach ~0.59, so
// similarity ranks results rather than gating them; the floor only drops
// clearly unrelated text that also has zero keyword overlap.
const SEMANTIC_WEIGHT = 0.7;
const raw = process.env.EXOCORTEX_EMBED_MIN_COSINE?.trim();
const parsed = raw ? Number(raw) : NaN;
const MIN_COSINE = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1.0 ? parsed : 0.5;

export interface LocalLTMOptions {
  /** Optional semantic embedder. Omit (or null) for pure token-overlap search. */
  embedder?: LocalEmbedder | null;
  /**
   * Resolved on first use instead of at construction, so settings loaded from a .env file after
   * this module is imported (EXOCORTEX_EMBEDDINGS, EXOCORTEX_EMBED_URL, ...) still take effect.
   * Ignored when `embedder` is given.
   */
  embedderFactory?: () => LocalEmbedder | null;
}

export class LocalLTM {
  private explicitPath: string | undefined;
  private resolvedPath: string | undefined;
  private options: LocalLTMOptions;
  private resolvedEmbed: { embedder: LocalEmbedder | null; vectors: VectorCache | null } | undefined;
  private cachedMemories: { mtimeMs: number; size: number; entries: MemoryEntry[] } | null = null;

  constructor(filePath?: string, options: LocalLTMOptions = {}) {
    this.explicitPath = filePath;
    this.options = options;
  }

  /** Memory file; the env-derived default is read on first use, not at import. */
  private get filePath(): string {
    this.resolvedPath ??= this.explicitPath ?? getDefaultLtmFile();
    return this.resolvedPath;
  }

  private get embed(): { embedder: LocalEmbedder | null; vectors: VectorCache | null } {
    if (!this.resolvedEmbed) {
      const embedder = this.options.embedder ?? this.options.embedderFactory?.() ?? null;
      this.resolvedEmbed = {
        embedder,
        vectors: embedder ? new VectorCache(`${this.filePath}.vec.jsonl`, embedder.model) : null,
      };
    }
    return this.resolvedEmbed;
  }

  public async addMemory(entry: {
    title: string;
    body: string;
    source?: string;
    tags?: string[];
  }): Promise<MemoryEntry> {
    if (!entry.title || !entry.title.trim()) {
      throw new Error("title is required");
    }

    const rawTags = Array.isArray(entry.tags)
      ? entry.tags
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.trim().slice(0, 64))
          .filter((t) => t.length > 0)
          .slice(0, 16)
      : undefined;

    const memory: MemoryEntry = {
      title: entry.title.trim().slice(0, 512),
      body: entry.body.trim().slice(0, 65536),
      createdAt: new Date().toISOString(),
      source: entry.source ? entry.source.trim().slice(0, 128) : "unknown",
      ...(rawTags && rawTags.length > 0 ? { tags: rawTags } : {}),
    };
    await mkdir(dirname(this.filePath), { recursive: true });

    const fh = await open(this.filePath, "a+");
    try {
      const { size } = await fh.stat();
      let prefix = "";
      if (size > 0) {
        const b = Buffer.alloc(1);
        await fh.read(b, 0, 1, size - 1);
        if (b[0] !== 0x0a) {
          prefix = "\n";
        }
      }
      await fh.appendFile(prefix + JSON.stringify(memory) + "\n", "utf8");
    } finally {
      await fh.close();
    }
    this.cachedMemories = null;
    return memory;
  }

  public async getAllMemories(): Promise<MemoryEntry[]> {
    if (!existsSync(this.filePath)) {
      this.cachedMemories = null;
      return [];
    }

    try {
      const fileStat = await stat(this.filePath);
      if (
        this.cachedMemories &&
        this.cachedMemories.mtimeMs === fileStat.mtimeMs &&
        this.cachedMemories.size === fileStat.size
      ) {
        return this.cachedMemories.entries;
      }

      const raw = await readFile(this.filePath, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      const results: MemoryEntry[] = [];
      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          if (
            item &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            typeof item.title === "string" &&
            item.title.trim().length > 0 &&
            typeof item.body === "string"
          ) {
            const tags = Array.isArray(item.tags)
              ? (item.tags as unknown[])
                  .filter((t: unknown): t is string => typeof t === "string")
                  .map((t: string) => t.trim().slice(0, 64))
                  .filter((t: string) => t.length > 0)
                  .slice(0, 16)
              : undefined;
            const createdAtStr = typeof item.createdAt === "string" ? item.createdAt : "";
            const ts = Date.parse(createdAtStr);
            const clampedTs = Number.isNaN(ts) ? 0 : Math.min(ts, Date.now());
            const normalizedCreatedAt = new Date(clampedTs).toISOString();
            const cleanEntry: MemoryEntry = {
              title: item.title.trim().slice(0, 512),
              body: item.body.trim().slice(0, 65536),
              createdAt: normalizedCreatedAt,
              source: typeof item.source === "string" && item.source.trim() ? item.source.trim().slice(0, 128) : "unknown",
              ...(tags && tags.length > 0 ? { tags } : {}),
            };
            results.push(cleanEntry);
          }
        } catch {
          // Skip malformed lines
        }
      }

      this.cachedMemories = {
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
        entries: results,
      };

      return results;
    } catch {
      return [];
    }
  }

  public async searchMemories(query: string, limit = 5): Promise<MemorySearchResult[]> {
    const queryTokens = tokenize(query);
    if (queryTokens.size === 0) return [];

    const memories = await this.getAllMemories();
    const scored: Array<MemorySearchResult & { _rawScore: number }> = [];

    for (const mem of memories) {
      const docTokens = tokenize(`${mem.title} ${mem.body} ${(mem.tags || []).join(" ")}`);
      const rawScore = computeSimilarity(queryTokens, docTokens);
      if (rawScore > 0) {
        scored.push({
          ...mem,
          score: Math.round(rawScore * 100) / 100,
          untrusted: true,
          _rawScore: rawScore,
        });
      }
    }

    scored.sort((a, b) => {
      if (b._rawScore !== a._rawScore) return b._rawScore - a._rawScore;
      return b.createdAt.localeCompare(a.createdAt);
    });

    return scored.slice(0, Math.min(Math.max(limit, 1), 50)).map(({ _rawScore, ...rest }) => rest);
  }

  /**
   * Semantic + keyword search. Falls back to plain token-overlap search whenever
   * no embedder is configured or Ollama can't embed the query, so callers never
   * need to handle embedding failure.
   */
  public async searchMemoriesHybrid(query: string, limit = 5): Promise<MemorySearchResult[]> {
    const { embedder, vectors } = this.embed;
    if (!embedder || !vectors) return this.searchMemories(query, limit);
    if (query.trim().length === 0) return [];

    const queryVec = await embedder.embedQuery(query);
    if (!queryVec) return this.searchMemories(query, limit);

    const memories = await this.getAllMemories();
    if (memories.length === 0) return [];

    const cache = await vectors.load();
    const texts = memories.map((m) => `${m.title}\n${m.body}\n${(m.tags || []).join(" ")}`);
    const keys = texts.map((t) => vectors.keyFor(t));

    const missing: number[] = [];
    keys.forEach((k, i) => {
      if (!cache.has(k)) missing.push(i);
    });
    if (missing.length > 0) {
      const fresh = await embedder.embedDocuments(missing.map((i) => texts[i]));
      const toStore: Array<{ k: string; v: number[] }> = [];
      fresh.forEach((v, n) => {
        if (v) toStore.push({ k: keys[missing[n]], v });
      });
      await vectors.put(toStore);
    }

    const queryTokens = tokenize(query);
    const scored: Array<MemorySearchResult & { _raw: number }> = [];
    memories.forEach((mem, i) => {
      const vec = cache.get(keys[i]);
      const cos = vec ? Math.max(0, cosine(queryVec, vec)) : 0;
      const lex = computeSimilarity(queryTokens, tokenize(texts[i].replace(/\n/g, " ")));
      if (lex === 0 && cos < MIN_COSINE) return;
      const raw = vec ? SEMANTIC_WEIGHT * cos + (1 - SEMANTIC_WEIGHT) * lex : lex;
      scored.push({ ...mem, score: Math.round(raw * 100) / 100, untrusted: true, _raw: raw });
    });

    scored.sort((a, b) => (b._raw !== a._raw ? b._raw - a._raw : b.createdAt.localeCompare(a.createdAt)));
    return scored.slice(0, Math.min(Math.max(limit, 1), 50)).map(({ _raw, ...rest }) => rest);
  }
}

export const localLTM = new LocalLTM(undefined, {
  embedderFactory: () => ((process.env.EXOCORTEX_EMBEDDINGS ?? "1") !== "0" ? new LocalEmbedder() : null),
});
export const getAllMemories = () => localLTM.getAllMemories();
export const searchMemories = (query: string, limit = 5) => localLTM.searchMemories(query, limit);
export const searchMemoriesHybrid = (query: string, limit = 5) => localLTM.searchMemoriesHybrid(query, limit);
export const addMemory = (entry: { title: string; body: string; source?: string; tags?: string[] }) => localLTM.addMemory(entry);
