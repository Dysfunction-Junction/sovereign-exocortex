import type { EventRecord } from "@exocortex/core";
import type { ExocortexDatabase } from "@exocortex/core/db";

export interface IngestHook {
  name: string;
  apply(events: EventRecord[], db: ExocortexDatabase): void | Promise<void>;
}

export interface IngestConsumerOptions {
  db: ExocortexDatabase;
  hooks: IngestHook[];
  batchSize?: number;
  pollMs?: number;
  onError?: (hook: string, error: unknown) => void;
}

/** Durable, per-hook event cursor. A failed hook keeps its cursor and is retried later. */
export class IngestConsumer {
  private readonly db: ExocortexDatabase;
  private readonly hooks: IngestHook[];
  private readonly batchSize: number;
  private readonly pollMs: number;
  private readonly onError: (hook: string, error: unknown) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;

  constructor(options: IngestConsumerOptions) {
    this.db = options.db;
    this.hooks = [...options.hooks];
    this.batchSize = options.batchSize ?? 100;
    this.pollMs = options.pollMs ?? 1000;
    this.onError = options.onError ?? ((hook, error) => console.error(`[ingest-consumer:${hook}]`, error));
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1) throw new TypeError("batchSize must be positive");
    if (!Number.isSafeInteger(this.pollMs) || this.pollMs < 1) throw new TypeError("pollMs must be positive");
    const names = this.hooks.map((hook) => hook.name);
    if (names.some((name) => !name) || new Set(names).size !== names.length) throw new TypeError("consumer hook names must be unique");
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.wake(), this.pollMs);
    this.timer.unref?.();
    this.wake();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Schedules work on a later turn so an HTTP handler can send its response first. */
  wake(): void {
    if (this.running) return;
    let task: Promise<void>;
    task = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.drain())
      .finally(() => { if (this.running === task) this.running = null; });
    this.running = task;
  }

  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  async drain(): Promise<void> {
    await Promise.all(this.hooks.map((hook) => this.drainHook(hook)));
  }

  private async drainHook(hook: IngestHook): Promise<void> {
    while (true) {
      const cursor = this.db.getConsumerCursor(hook.name);
      const events = this.db.listEvents({ sinceSeq: cursor, limit: this.batchSize });
      if (events.length === 0) break;
      try {
        await hook.apply(events, this.db);
        this.db.setConsumerCursor(hook.name, events[events.length - 1].seq);
      } catch (error) {
        this.onError(hook.name, error);
        break;
      }
    }
  }
}
