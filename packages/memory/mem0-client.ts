/**
 * @file mem0-client.ts
 * Fail-soft recall from Mem0 (distilled one-fact memories written by agents) for memory.search.
 *
 * Runs the user's existing Mem0 CLI (`node mem0.js search <q>`) as a child process, so this repo never holds the
 * Mem0 API key: the CLI owns its own credentials. The query is passed as a single argv entry with no shell.
 *
 * Fail-soft by contract: a missing CLI, no network, a bad key or a slow call never throws and never delays the
 * local answer by more than `timeoutMs`. Hits are recalled data, so they are flagged `untrusted`.
 */

import { execFile } from "node:child_process";
import { dirname } from "node:path";

export interface Mem0Hit {
  id: string;
  memory: string;
  score: number;
  categories: string[];
  createdAt: string;
  untrusted: true;
}

export type Mem0Result =
  | { available: true; hits: Mem0Hit[] }
  | { available: false; reason: "unreachable" | "error" };

/** Runs the CLI and resolves with its stdout. Injectable for tests. */
export type Mem0Runner = (script: string, query: string, timeoutMs: number) => Promise<string>;

const MAX_MEMORY = 400;

const defaultRunner: Mem0Runner = (script, query, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [script, "search", query],
      { cwd: dirname(script), timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });

export class Mem0Client {
  constructor(
    private readonly script: string,
    private readonly timeoutMs = 8000,
    private readonly run: Mem0Runner = defaultRunner,
  ) {}

  /** Client from MEM0_CLI (path to the Mem0 CLI's mem0.js), or null when not configured. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): Mem0Client | null {
    const script = env.MEM0_CLI?.trim();
    return script ? new Mem0Client(script) : null;
  }

  async search(query: string, k = 5): Promise<Mem0Result> {
    let out: string;
    try {
      out = await this.run(this.script, query, this.timeoutMs);
    } catch {
      return { available: false, reason: "unreachable" };
    }
    try {
      // The CLI prints a label line, then JSON: {"results":[...]}.
      const start = out.indexOf("{");
      const body = JSON.parse(out.slice(start)) as { results?: unknown };
      if (start < 0 || !Array.isArray(body.results)) return { available: false, reason: "error" };
      const hits: Mem0Hit[] = [];
      for (const r of body.results as Array<Record<string, unknown>>) {
        if (typeof r?.id !== "string" || typeof r.memory !== "string") continue;
        hits.push({
          id: r.id,
          memory: r.memory.slice(0, MAX_MEMORY),
          score: typeof r.score === "number" ? Math.round(r.score * 100) / 100 : 0,
          categories: Array.isArray(r.categories) ? r.categories.filter((c): c is string => typeof c === "string") : [],
          createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
          untrusted: true,
        });
        if (hits.length >= k) break;
      }
      return { available: true, hits };
    } catch {
      return { available: false, reason: "error" };
    }
  }
}
