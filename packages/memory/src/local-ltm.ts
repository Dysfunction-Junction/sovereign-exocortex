import { readFile, appendFile, mkdir, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  return resolve(currentDir, "../data/memories.jsonl");
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

export class LocalLTM {
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? getDefaultLtmFile();
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
    return memory;
  }

  public async getAllMemories(): Promise<MemoryEntry[]> {
    if (!existsSync(this.filePath)) {
      return [];
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
    return results;
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
}

export const localLTM = new LocalLTM();
export const getAllMemories = () => localLTM.getAllMemories();
export const searchMemories = (query: string, limit = 5) => localLTM.searchMemories(query, limit);
export const addMemory = (entry: { title: string; body: string; source?: string; tags?: string[] }) => localLTM.addMemory(entry);
