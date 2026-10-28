/**
 * One scheduler for every local model call that runs inside the daemon.
 *
 * The three llama.cpp servers (triage :8080, embeddings :8081, vision :8082) share one CPU, so running them
 * together makes the latency-sensitive one (triage) slow down whenever a bulk job (embedding backfill) is running.
 * The broker admits jobs one at a time by default and always starts the highest-priority waiting job next:
 * triage, then embed, then vision. Strict priority is deliberate: triage must never wait behind a backfill.
 * Jobs already running are never preempted.
 *
 * Scope: this covers calls made from the daemon process. The memory node (:39400) embeds in its own process and
 * is not routed through this broker.
 */

export type InferenceLane = "triage" | "embed" | "vision";

/** Lower number runs first. */
export const LANE_PRIORITY: Record<InferenceLane, number> = { triage: 0, embed: 1, vision: 2 };

export class BrokerOverflowError extends Error {
  constructor(lane: InferenceLane, depth: number) {
    super(`inference broker: ${lane} queue is full (${depth} waiting)`);
    this.name = "BrokerOverflowError";
  }
}

export class BrokerWaitTimeoutError extends Error {
  constructor(lane: InferenceLane, waitedMs: number) {
    super(`inference broker: ${lane} job waited ${waitedMs} ms without starting`);
    this.name = "BrokerWaitTimeoutError";
  }
}

export interface InferenceBrokerOptions {
  /** Jobs allowed to run at once. 1 on a CPU-only box. */
  concurrency?: number;
  /** Total model memory (MB) that running jobs may claim. Jobs that declare no memory claim 0. Default: unlimited. */
  memoryBudgetMb?: number;
  /** Maximum waiting jobs per lane before new ones are rejected. Default: unlimited. */
  maxQueuePerLane?: Partial<Record<InferenceLane, number>>;
  now?: () => number;
}

export interface RunOptions {
  /** Memory this job claims while running, in MB. Only matters when a memory budget is set. */
  memoryMb?: number;
  /** Reject instead of starting if the job has waited this long. */
  maxWaitMs?: number;
  /** Cancels the job while it is still queued. A running job must watch the signal itself. */
  signal?: AbortSignal;
}

export interface LaneStats {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  rejected: number;
  /** Time spent waiting in the queue, in ms, for completed and failed jobs (not rejected ones). */
  waitP50Ms: number | null;
  waitP95Ms: number | null;
}

interface Waiting {
  lane: InferenceLane;
  seq: number;
  enqueuedAt: number;
  memoryMb: number;
  start: () => void;
  reject: (err: Error) => void;
  cleanup: () => void;
}

const SAMPLE_CAP = 500;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

export class InferenceBroker {
  private readonly concurrency: number;
  private readonly memoryBudgetMb: number;
  private readonly maxQueue: Partial<Record<InferenceLane, number>>;
  private readonly now: () => number;
  private readonly waiting: Waiting[] = [];
  private runningCount = 0;
  private runningMemoryMb = 0;
  private seq = 0;
  private readonly counters: Record<InferenceLane, { running: number; completed: number; failed: number; rejected: number }> = {
    triage: { running: 0, completed: 0, failed: 0, rejected: 0 },
    embed: { running: 0, completed: 0, failed: 0, rejected: 0 },
    vision: { running: 0, completed: 0, failed: 0, rejected: 0 },
  };
  private readonly waits: Record<InferenceLane, number[]> = { triage: [], embed: [], vision: [] };

  constructor(opts: InferenceBrokerOptions = {}) {
    const c = opts.concurrency ?? 1;
    this.concurrency = Number.isInteger(c) && c >= 1 ? c : 1;
    this.memoryBudgetMb = opts.memoryBudgetMb !== undefined && opts.memoryBudgetMb > 0 ? opts.memoryBudgetMb : Number.POSITIVE_INFINITY;
    this.maxQueue = opts.maxQueuePerLane ?? {};
    this.now = opts.now ?? Date.now;
  }

  /** Run `job` when the broker admits it. Resolves or rejects with the job's own result. */
  run<T>(lane: InferenceLane, job: () => Promise<T>, opts: RunOptions = {}): Promise<T> {
    const memoryMb = Math.max(0, opts.memoryMb ?? 0);
    if (memoryMb > this.memoryBudgetMb) {
      this.counters[lane].rejected++;
      return Promise.reject(new Error(`inference broker: ${lane} job needs ${memoryMb} MB, budget is ${this.memoryBudgetMb} MB`));
    }
    if (opts.signal?.aborted) {
      this.counters[lane].rejected++;
      return Promise.reject(opts.signal.reason instanceof Error ? opts.signal.reason : new Error("aborted"));
    }
    const cap = this.maxQueue[lane];
    const depth = this.waiting.filter((w) => w.lane === lane).length;
    if (cap !== undefined && depth >= cap) {
      this.counters[lane].rejected++;
      return Promise.reject(new BrokerOverflowError(lane, depth));
    }

    return new Promise<T>((resolve, reject) => {
      const enqueuedAt = this.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
      };
      const entry: Waiting = {
        lane,
        seq: this.seq++,
        enqueuedAt,
        memoryMb,
        cleanup,
        reject: (err) => {
          this.counters[lane].rejected++;
          reject(err);
        },
        start: () => {
          cleanup();
          this.recordWait(lane, this.now() - enqueuedAt);
          this.runningCount++;
          this.runningMemoryMb += memoryMb;
          this.counters[lane].running++;
          let result: Promise<T>;
          try {
            result = Promise.resolve(job());
          } catch (err) {
            result = Promise.reject(err);
          }
          result.then(
            (value) => {
              this.counters[lane].completed++;
              resolve(value);
            },
            (err) => {
              this.counters[lane].failed++;
              reject(err);
            },
          ).finally(() => {
            this.runningCount--;
            this.runningMemoryMb -= memoryMb;
            this.counters[lane].running--;
            this.pump();
          });
        },
      };
      if (opts.maxWaitMs !== undefined && opts.maxWaitMs > 0) {
        timer = setTimeout(() => {
          if (this.remove(entry)) entry.reject(new BrokerWaitTimeoutError(lane, this.now() - enqueuedAt));
        }, opts.maxWaitMs);
      }
      if (opts.signal) {
        onAbort = () => {
          if (this.remove(entry)) {
            entry.cleanup();
            entry.reject(opts.signal?.reason instanceof Error ? opts.signal.reason : new Error("aborted"));
          }
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.waiting.push(entry);
      this.pump();
    });
  }

  /** Counters per lane plus queue-wait percentiles. */
  stats(): Record<InferenceLane, LaneStats> {
    const out = {} as Record<InferenceLane, LaneStats>;
    for (const lane of Object.keys(LANE_PRIORITY) as InferenceLane[]) {
      const sorted = [...this.waits[lane]].sort((a, b) => a - b);
      out[lane] = {
        queued: this.waiting.filter((w) => w.lane === lane).length,
        running: this.counters[lane].running,
        completed: this.counters[lane].completed,
        failed: this.counters[lane].failed,
        rejected: this.counters[lane].rejected,
        waitP50Ms: percentile(sorted, 0.5),
        waitP95Ms: percentile(sorted, 0.95),
      };
    }
    return out;
  }

  private recordWait(lane: InferenceLane, ms: number): void {
    const arr = this.waits[lane];
    arr.push(Math.max(0, ms));
    if (arr.length > SAMPLE_CAP) arr.shift();
  }

  private remove(entry: Waiting): boolean {
    const i = this.waiting.indexOf(entry);
    if (i < 0) return false;
    this.waiting.splice(i, 1);
    entry.cleanup();
    return true;
  }

  /** Start waiting jobs, best priority first (FIFO within a lane), while there is room. */
  private pump(): void {
    while (this.runningCount < this.concurrency && this.waiting.length > 0) {
      let best = -1;
      for (let i = 0; i < this.waiting.length; i++) {
        const w = this.waiting[i];
        if (this.runningMemoryMb + w.memoryMb > this.memoryBudgetMb) continue;
        if (best < 0) {
          best = i;
          continue;
        }
        const b = this.waiting[best];
        if (LANE_PRIORITY[w.lane] < LANE_PRIORITY[b.lane] || (w.lane === b.lane && w.seq < b.seq)) best = i;
      }
      if (best < 0) return; // everything waiting needs more memory than is free; a finishing job will re-pump
      const [next] = this.waiting.splice(best, 1);
      next.start();
    }
  }
}

function envPositiveInt(name: string): number | undefined {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Shared by everything in the daemon process. EXOCORTEX_INFERENCE_CONCURRENCY / _MEMORY_MB tune it. */
export const defaultInferenceBroker = new InferenceBroker({
  concurrency: envPositiveInt("EXOCORTEX_INFERENCE_CONCURRENCY") ?? 1,
  memoryBudgetMb: envPositiveInt("EXOCORTEX_INFERENCE_MEMORY_MB"),
});
