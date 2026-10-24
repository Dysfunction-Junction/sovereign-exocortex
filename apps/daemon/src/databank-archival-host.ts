/**
 * @file databank-archival-host.ts
 * Autonomic Nightly Databank Archival Daemon Task for Sovereign Exocortex.
 *
 * Safely and autonomously bridges local hot LTM memories into the encrypted
 * Databank remote vault on Lubuntu (e.g. https://<databank-host>:8443).
 *
 * Fail-soft by contract:
 * - Always probes ArchiveClient.health() first.
 * - If the remote vault is locked, unreachable, or timed out, logs diagnostic
 *   telemetry and skips without throwing or crashing exocortexd.
 * - Prunes locally archived memories with atomic backup (.pre-prune timestamped copy)
 *   when remote archiving succeeds.
 * - Appends a structured `DATABANK_ARCHIVAL_COMPLETED` audit event to the ledger.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExocortexDatabase } from "@exocortex/core/db";
import {
  ArchiveClient,
  archiveLocalMemoriesToRemote,
  type ArchiveHealthResult,
  type RemoteArchiveResult,
} from "@exocortex/memory/archive-client";
import { DEFAULT_MEMORY_LOG } from "@exocortex/memory/memories";
import { HOST_DEVICE_ID } from "./shadow-recorder.js";
import { hasDatabase, getDatabase } from "./db-host.js";

export const DEFAULT_ARCHIVE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const DEFAULT_OLDER_THAN_DAYS = 90; // 90 days retention for hot local memories

export interface DatabankArchivalOptions {
  enabled?: boolean;
  intervalMs?: number;
  olderThanDays?: number;
  prune?: boolean;
  memoryFilePath?: string;
  client?: ArchiveClient | null;
  getDb?: () => ExocortexDatabase | null;
  now?: () => number;
}

export type DatabankRunResult =
  | (RemoteArchiveResult & { ok: true })
  | { ok: false; reason: string };

export interface DatabankArchivalStatus {
  configured: boolean;
  available: boolean;
  reason?: string;
  items?: number;
  chunks?: number;
  blobs?: number;
  lastRunAt: number | null;
  lastResult: DatabankRunResult | null;
  nextScheduledRunAt: number | null;
  running: boolean;
  hasLocalMemories: boolean;
}

export class DatabankArchivalHost {
  private static readonly HEALTH_CACHE_TTL_MS = 15_000; // 15s health probe cache
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly olderThanDays: number;
  private readonly prune: boolean;
  private customMemoryFilePath?: string;
  private customClient?: ArchiveClient | null;
  private readonly getDb: () => ExocortexDatabase | null;
  private readonly now: () => number;

  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running = false;
  private lastRunAt: number | null = null;
  private lastResult: DatabankRunResult | null = null;
  private nextScheduledRunAt: number | null = null;
  private cachedHealth: { result: ArchiveHealthResult; ts: number } | null = null;

  constructor(options: DatabankArchivalOptions = {}) {
    this.enabled = options.enabled ?? (process.env.EXOCORTEX_ARCHIVAL_ENABLED !== "0");
    this.intervalMs = Math.max(10_000, options.intervalMs ?? DEFAULT_ARCHIVE_INTERVAL_MS);
    this.olderThanDays = Math.max(7, options.olderThanDays ?? DEFAULT_OLDER_THAN_DAYS);
    // Pruning is refused by the archive functions until writers are coordinated, so archive-only is the default.
    this.prune = options.prune ?? false;
    this.customMemoryFilePath = options.memoryFilePath;
    this.customClient = options.client;
    this.getDb = options.getDb ?? (() => (hasDatabase() ? getDatabase() : null));
    this.now = options.now ?? Date.now;
  }

  public resolveMemoryFilePath(): string {
    if (this.customMemoryFilePath) return this.customMemoryFilePath;
    if (process.env.EXOCORTEX_MEMORIES_FILE) {
      return resolve(process.env.EXOCORTEX_MEMORIES_FILE);
    }
    const cwdPath = resolve(process.cwd(), DEFAULT_MEMORY_LOG);
    if (existsSync(cwdPath)) return cwdPath;

    const parentPath = resolve(process.cwd(), "../../", DEFAULT_MEMORY_LOG);
    if (existsSync(parentPath)) return parentPath;

    const userProfile = process.env.USERPROFILE || process.env.HOME;
    if (userProfile) {
      const homePath = resolve(userProfile, ".exocortex", "memories.jsonl");
      if (existsSync(homePath)) return homePath;
    }

    return cwdPath;
  }

  private getClient(): ArchiveClient | null {
    if (this.customClient !== undefined) return this.customClient;
    return ArchiveClient.fromEnv();
  }

  public setClientForTest(client: ArchiveClient | null): void {
    this.customClient = client;
    this.cachedHealth = null;
  }

  public setMemoryFilePathForTest(path: string): void {
    this.customMemoryFilePath = path;
  }

  public async getStatus(): Promise<DatabankArchivalStatus> {
    const client = this.getClient();
    const memoryFilePath = this.resolveMemoryFilePath();
    const hasLocalMemories = existsSync(memoryFilePath);

    if (!client) {
      return {
        configured: false,
        available: false,
        reason: "not_configured",
        lastRunAt: this.lastRunAt,
        lastResult: this.lastResult,
        nextScheduledRunAt: this.nextScheduledRunAt,
        running: this.running,
        hasLocalMemories,
      };
    }

    const now = this.now();
    let health: ArchiveHealthResult;
    if (this.cachedHealth && now - this.cachedHealth.ts < DatabankArchivalHost.HEALTH_CACHE_TTL_MS) {
      health = this.cachedHealth.result;
    } else {
      health = await client.health();
      this.cachedHealth = { result: health, ts: now };
    }

    if (!health.available) {
      return {
        configured: true,
        available: false,
        reason: health.reason,
        lastRunAt: this.lastRunAt,
        lastResult: this.lastResult,
        nextScheduledRunAt: this.nextScheduledRunAt,
        running: this.running,
        hasLocalMemories,
      };
    }

    return {
      configured: true,
      available: true,
      items: health.items,
      chunks: health.chunks,
      blobs: health.blobs,
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult,
      nextScheduledRunAt: this.nextScheduledRunAt,
      running: this.running,
      hasLocalMemories,
    };
  }

  public async runArchival(options: { olderThanDays?: number; prune?: boolean; force?: boolean } = {}): Promise<DatabankRunResult> {
    if (this.running) {
      return { ok: false, reason: "already_running" };
    }

    const client = this.getClient();
    if (!client) {
      const res: DatabankRunResult = { ok: false, reason: "not_configured" };
      this.lastResult = res;
      return res;
    }

    this.running = true;
    const now = this.now();
    this.lastRunAt = now;

    try {
      // 1. Check vault health first. If unreachable or locked, fail soft without crashing.
      const health = await client.health();
      if (!health.available) {
        console.warn(`[databank-archival] skipped: vault unavailable (${health.reason})`);
        const res: DatabankRunResult = { ok: false, reason: health.reason };
        this.lastResult = res;
        return res;
      }

      // 2. Locate memory log
      const file = this.resolveMemoryFilePath();
      if (!existsSync(file)) {
        const res: DatabankRunResult = {
          ok: true,
          scanned: 0,
          archived: 0,
          alreadyArchived: 0,
          kept: 0,
          pruned: false,
          failed: 0,
        };
        this.lastResult = res;
        return res;
      }

      // 3. Execute remote archival pass (enforce minimum 7-day retention floor)
      const days = Math.max(7, options.olderThanDays ?? this.olderThanDays);
      const prune = options.prune ?? this.prune;

      const remoteResult = await archiveLocalMemoriesToRemote(client, file, {
        olderThanDays: days,
        prune,
        now,
      });

      const res: DatabankRunResult = {
        ok: true,
        ...remoteResult,
      };
      this.lastResult = res;

      // 4. Emit audit event to SQLite if database is active
      const db = this.getDb();
      if (db) {
        try {
          // Ensure host device is registered before appending
          if (!db.getDevice(HOST_DEVICE_ID)) {
            try {
              db.registerDevice({
                device_id: HOST_DEVICE_ID,
                name: "exocortexd host",
                platform: process.platform === "win32" ? "windows" : "linux",
                pubkey_spki: new Uint8Array([0]),
                key_attested: 0,
                scopes: ["host:proposal", "telemetry:write"],
                enrolled_at: now,
                revoked_at: null,
              });
            } catch {}
          }

          const eventId = `databank:archival:${now}:${Math.random().toString(36).slice(2, 8)}`;
          db.ingestEvent(HOST_DEVICE_ID, {
            event_id: eventId,
            kind: "maintenance",
            ts_device: now,
            schema_ver: 1,
            payload: {
              action: "DATABANK_ARCHIVAL_COMPLETED",
              scanned: res.scanned,
              archived: res.archived,
              alreadyArchived: res.alreadyArchived,
              kept: res.kept,
              pruned: res.pruned,
              backup: res.backup,
              failed: res.failed,
            },
          });
        } catch (evErr) {
          console.warn("[databank-archival] could not append audit event:", evErr instanceof Error ? evErr.message : evErr);
        }
      }

      console.log(
        `[databank-archival] pass completed: ${res.archived} archived, ${res.alreadyArchived} existing, ${res.kept} kept, pruned=${res.pruned}`
      );
      return res;
    } catch (err) {
      console.error("[databank-archival] error during archival run:", err instanceof Error ? err.message : err);
      const res: DatabankRunResult = {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
      this.lastResult = res;
      return res;
    } finally {
      this.running = false;
      if (this.timer && !this.stopped) {
        this.nextScheduledRunAt = this.now() + this.intervalMs;
      }
    }
  }

  public start(): void {
    if (this.timer || !this.enabled) return;
    this.stopped = false;
    this.nextScheduledRunAt = this.now() + this.intervalMs;

    this.timer = setInterval(() => {
      void this.runArchival();
    }, this.intervalMs);
    this.timer.unref();
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.nextScheduledRunAt = null;
  }
}

export const defaultDatabankArchivalHost = new DatabankArchivalHost();
