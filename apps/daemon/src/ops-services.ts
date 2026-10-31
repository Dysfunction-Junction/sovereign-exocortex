/**
 * @file ops-services.ts
 * Workstation Node service registry, health inspection, and restart management.
 * Strictly manages exactly four services: daemon, proxy, piecesos, worldmodel.
 */

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { ExocortexDatabase } from "@exocortex/core/db";
import { getDatabase, hasDatabase, setDatabase } from "./db-host.js";
import { defaultWorldModelHost } from "./world-model-host.js";
import { HOST_DEVICE_ID, ShadowRecorder } from "./shadow-recorder.js";

export type ServiceId = "daemon" | "proxy" | "piecesos" | "worldmodel";
export type ServiceStatus = "healthy" | "unhealthy" | "unknown";

export interface ServiceRestartInfo {
  available: boolean;
  in_progress: boolean;
  last_at: number | null;
  last_result: "ok" | "failed" | null;
}

export interface ServiceInfo {
  id: ServiceId;
  label: string;
  status: ServiceStatus;
  detail: string;
  latency_ms: number | null;
  checked_at: number;
  port?: number;
  pid?: number;
  uptime_s?: number;
  restart: ServiceRestartInfo;
}

export interface ServiceRegistryEntry {
  id: ServiceId;
  label: string;
  port?: number;
}

export const SERVICE_REGISTRY: Record<ServiceId, ServiceRegistryEntry> = {
  daemon: { id: "daemon", label: "Daemon API", port: 8788 },
  proxy: { id: "proxy", label: "Proxy Bus", port: 8787 },
  piecesos: { id: "piecesos", label: "PiecesOS Engine", port: 39300 },
  worldmodel: { id: "worldmodel", label: "World Model Store" },
};

export const RESTART_COOLDOWN_MS = 30_000;

export function isValidServiceId(id: unknown): id is ServiceId {
  if (typeof id !== "string") return false;
  return Object.prototype.hasOwnProperty.call(SERVICE_REGISTRY, id);
}

// In-memory restart tracking per service
interface ServiceState {
  in_progress: boolean;
  last_at: number | null;
  last_result: "ok" | "failed" | null;
}

const serviceStates: Record<ServiceId, ServiceState> = {
  daemon: { in_progress: false, last_at: null, last_result: null },
  proxy: { in_progress: false, last_at: null, last_result: null },
  piecesos: { in_progress: false, last_at: null, last_result: null },
  worldmodel: { in_progress: false, last_at: null, last_result: null },
};

// World Model in-flight restart synchronization
let worldModelRestartPromise: Promise<void> | null = null;
let resolveWorldModelRestart: (() => void) | null = null;

export type IngestConsumerGetter = (db: ExocortexDatabase) => {
  stop: () => void;
  idle: () => Promise<void>;
  start: () => void;
};

let ingestConsumerGetter: IngestConsumerGetter | null = null;

export function setOpsIngestConsumer(fn: IngestConsumerGetter | null): void {
  ingestConsumerGetter = fn;
}

export function isWorldModelRestarting(): boolean {
  return serviceStates.worldmodel.in_progress;
}

export async function waitForWorldModelReady(timeoutMs = 5000): Promise<void> {
  if (!worldModelRestartPromise) return;
  const timeout = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error("Timeout waiting for world model database restart")), timeoutMs)
  );
  await Promise.race([worldModelRestartPromise, timeout]);
}

// Injectable dependencies for unit tests
export interface OpsDependencies {
  fetch?: typeof globalThis.fetch;
  isTaskInstalled?: (serviceId: ServiceId) => Promise<boolean> | boolean;
  spawnRunner?: (command: string, args: string[]) => Promise<{ exitCode: number | null }>;
  now?: () => number;
  getDb?: () => ExocortexDatabase;
}

// Task presence cache
const taskInstalledCache = new Map<ServiceId, { installed: boolean; cachedAt: number }>();

async function defaultIsTaskInstalled(serviceId: ServiceId): Promise<boolean> {
  if (serviceId === "worldmodel") return true;
  if (process.platform !== "win32") return false;

  const cached = taskInstalledCache.get(serviceId);
  const now = Date.now();
  if (cached && now - cached.cachedAt < 30_000) {
    return cached.installed;
  }

  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn("schtasks", ["/query", "/tn", `ExocortexRestart-${serviceId}`], {
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.on("close", (code) => {
        const installed = code === 0;
        taskInstalledCache.set(serviceId, { installed, cachedAt: now });
        resolve(installed);
      });
      child.on("error", () => {
        taskInstalledCache.set(serviceId, { installed: false, cachedAt: now });
        resolve(false);
      });
    } catch {
      taskInstalledCache.set(serviceId, { installed: false, cachedAt: now });
      resolve(false);
    }
  });
}

function defaultSpawnRunner(command: string, args: string[]): Promise<{ exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      child.on("error", (err) => reject(err));
      // Once spawned successfully, report exit code 0
      setImmediate(() => resolve({ exitCode: 0 }));
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Record an audit event for restart operations.
 * Strips any paths, secrets, or unbounded input.
 */
export function recordRestartAudit(
  db: ExocortexDatabase,
  info: {
    id: ServiceId;
    deviceId: string;
    action: "accepted" | "rejected" | "started" | "ok" | "failed";
    reason?: string;
  },
  nowFn: () => number = Date.now
): boolean {
  try {
    new ShadowRecorder(db, { shadow: true }).ensureHostDevice();
    const ts = nowFn();
    const { status } = db.ingestEvent(HOST_DEVICE_ID, {
      event_id: `service-restart-audit:${ts}:${randomUUID()}`,
      kind: "service_restart_audit",
      ts_device: ts,
      schema_ver: 1,
      payload: {
        service_id: info.id,
        requested_by: info.deviceId,
        action: info.action,
        ...(info.reason ? { reason: info.reason } : {}),
        ts,
      },
    });
    return status === "inserted";
  } catch (err) {
    if (err instanceof Error && err.message.includes("database is not open")) {
      return false;
    }
    console.error("[ops-services] failed to record restart audit event:", err instanceof Error ? err.message : err);
    return false;
  }
}

// 2-second caching layer for health checks
let cachedHealthList: ServiceInfo[] | null = null;
let lastCacheTimestamp = 0;

export function clearOpsServicesCache(): void {
  cachedHealthList = null;
  lastCacheTimestamp = 0;
}

export function resetOpsServicesState(): void {
  clearOpsServicesCache();
  for (const key of Object.keys(serviceStates) as ServiceId[]) {
    serviceStates[key] = { in_progress: false, last_at: null, last_result: null };
  }
  taskInstalledCache.clear();
}

/**
 * Check health of a single service.
 */
export async function checkServiceHealth(
  id: ServiceId,
  deps: OpsDependencies = {}
): Promise<ServiceInfo> {
  const now = deps.now ?? Date.now;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const isTaskInstalled = deps.isTaskInstalled ?? defaultIsTaskInstalled;
  const getDb = deps.getDb ?? getDatabase;

  const checkedAt = now();
  const entry = SERVICE_REGISTRY[id];
  const state = serviceStates[id];
  const available = await isTaskInstalled(id);

  const baseResult: ServiceInfo = {
    id,
    label: entry.label,
    port: entry.port,
    status: "unknown",
    detail: "",
    latency_ms: null,
    checked_at: checkedAt,
    restart: {
      available,
      in_progress: state.in_progress,
      last_at: state.last_at,
      last_result: state.last_result,
    },
  };

  if (id === "daemon") {
    const uptime = Math.floor(process.uptime());
    return {
      ...baseResult,
      status: "healthy",
      detail: `serving (pid ${process.pid}, uptime ${uptime}s)`,
      latency_ms: 0,
      pid: process.pid,
      uptime_s: uptime,
    };
  }

  if (id === "proxy") {
    const t0 = now();
    try {
      const res = await fetchFn("http://127.0.0.1:8787/mobile/health", {
        signal: AbortSignal.timeout(2000),
      });
      const latency = Math.max(0, now() - t0);
      if (res.ok) {
        return {
          ...baseResult,
          status: "healthy",
          detail: "HTTP 200 ok (/mobile/health)",
          latency_ms: latency,
        };
      }
      return {
        ...baseResult,
        status: "unhealthy",
        detail: `HTTP ${res.status}`,
        latency_ms: null,
      };
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : "FetchError";
      return {
        ...baseResult,
        status: "unhealthy",
        detail: errorClass === "TimeoutError" ? "TimeoutError (2s)" : errorClass,
        latency_ms: null,
      };
    }
  }

  if (id === "piecesos") {
    const t0 = now();
    try {
      const res = await fetchFn("http://127.0.0.1:39300/.well-known/health", {
        signal: AbortSignal.timeout(2000),
      });
      const latency = Math.max(0, now() - t0);
      if (res.ok) {
        return {
          ...baseResult,
          status: "healthy",
          detail: "HTTP 200 ok (.well-known/health)",
          latency_ms: latency,
        };
      }
      return {
        ...baseResult,
        status: "unhealthy",
        detail: `HTTP ${res.status}`,
        latency_ms: null,
      };
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : "FetchError";
      return {
        ...baseResult,
        status: "unhealthy",
        detail: errorClass === "TimeoutError" ? "TimeoutError (2s)" : errorClass,
        latency_ms: null,
      };
    }
  }

  if (id === "worldmodel") {
    const t0 = now();
    try {
      const db = getDb();
      const rows = db.raw.prepare("PRAGMA quick_check(1);").all() as Array<Record<string, unknown>>;
      const isOk = rows.length > 0 && Object.values(rows[0])[0] === "ok";
      if (!isOk) {
        return {
          ...baseResult,
          status: "unhealthy",
          detail: "quick_check failed",
          latency_ms: null,
        };
      }

      const loc = db.raw.location();
      let walInfo = "in-memory";
      if (loc && loc !== ":memory:") {
        const walPath = `${loc}-wal`;
        if (existsSync(walPath)) {
          const sz = statSync(walPath).size;
          walInfo = `wal ${(sz / 1024).toFixed(0)} KB`;
          if (sz > 500 * 1024 * 1024) {
            return {
              ...baseResult,
              status: "unhealthy",
              detail: `WAL size exceeds limit (${(sz / 1024 / 1024).toFixed(1)} MB)`,
              latency_ms: null,
            };
          }
        } else {
          walInfo = "wal 0 KB";
        }
      }

      let ageInfo = "";
      try {
        const row = db.raw.prepare("SELECT MAX(ts_device) as last_ts FROM events;").get() as
          | { last_ts: number | null }
          | undefined;
        if (row?.last_ts) {
          const ageS = Math.max(0, Math.floor((now() - row.last_ts) / 1000));
          ageInfo = `, last event ${ageS}s ago`;
        }
      } catch {
        // Events table empty or not yet seeded
      }

      const latency = Math.max(0, now() - t0);
      return {
        ...baseResult,
        status: "healthy",
        detail: `quick_check ok, ${walInfo}${ageInfo}`,
        latency_ms: latency,
      };
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : "DatabaseError";
      return {
        ...baseResult,
        status: "unhealthy",
        detail: errorClass,
        latency_ms: null,
      };
    }
  }

  return baseResult;
}

/**
 * List all four services with current health status.
 * Results cached for 2 seconds to prevent polling stampedes.
 */
export async function getServicesStatus(
  deps: OpsDependencies = {}
): Promise<ServiceInfo[]> {
  const now = deps.now ?? Date.now;
  const currentTime = now();

  if (cachedHealthList && currentTime - lastCacheTimestamp < 2000) {
    return cachedHealthList;
  }

  const ids: ServiceId[] = ["daemon", "proxy", "piecesos", "worldmodel"];
  const results = await Promise.all(ids.map((id) => checkServiceHealth(id, deps)));

  cachedHealthList = results;
  lastCacheTimestamp = currentTime;
  return results;
}

export type RestartResult =
  | { status: 202; data: { accepted: true; id: ServiceId } }
  | { status: 404; error: string }
  | { status: 409; error: string }
  | { status: 429; error: string };

/**
 * Request restart for a workstation service.
 */
export async function requestServiceRestart(
  id: unknown,
  deviceId: string,
  deps: OpsDependencies = {}
): Promise<RestartResult> {
  const now = deps.now ?? Date.now;
  const getDb = deps.getDb ?? getDatabase;
  const runner = deps.spawnRunner ?? defaultSpawnRunner;

  if (!isValidServiceId(id)) {
    try {
      recordRestartAudit(getDb(), { id: "daemon", deviceId, action: "rejected", reason: "unknown_service_id" }, now);
    } catch {
      // Ignore audit failure on rejected unknown id
    }
    return { status: 404, error: "unknown service" };
  }

  const serviceId = id as ServiceId;
  const state = serviceStates[serviceId];
  const currentTime = now();

  // Single-flight check
  if (state.in_progress) {
    try {
      recordRestartAudit(getDb(), { id: serviceId, deviceId, action: "rejected", reason: "in_progress" }, now);
    } catch {
      // Ignore
    }
    return { status: 409, error: `Restart already in progress for ${serviceId}` };
  }

  // Cooldown check (30s)
  if (state.last_at !== null && currentTime - state.last_at < RESTART_COOLDOWN_MS) {
    try {
      recordRestartAudit(getDb(), { id: serviceId, deviceId, action: "rejected", reason: "cooldown_active" }, now);
    } catch {
      // Ignore
    }
    return { status: 429, error: `Restart cooldown active for ${serviceId}, wait before retrying` };
  }

  // Mark in-progress and record start
  state.in_progress = true;
  state.last_at = currentTime;
  clearOpsServicesCache();

  try {
    recordRestartAudit(getDb(), { id: serviceId, deviceId, action: "accepted" }, now);
  } catch {
    // Ignore audit log error
  }

  // Trigger restart in background (detached)
  if (serviceId === "worldmodel") {
    worldModelRestartPromise = new Promise<void>((resolve) => {
      resolveWorldModelRestart = resolve;
    });

    setImmediate(async () => {
      try {
        const db = getDb();
        if (ingestConsumerGetter) {
          const consumer = ingestConsumerGetter(db);
          consumer.stop();
          await consumer.idle();
        }

        // Checkpoint WAL
        db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE);");

        const loc = db.raw.location();
        let newDb: ExocortexDatabase;
        if (!loc || loc === ":memory:") {
          const serialized = db.raw.serialize();
          setDatabase(null); // Closes old db
          newDb = new ExocortexDatabase({ path: ":memory:" });
          newDb.raw.deserialize(serialized);
          setDatabase(newDb);
        } else {
          setDatabase(null); // Closes old db
          newDb = new ExocortexDatabase({ path: loc });
          setDatabase(newDb);
        }

        // Restart ingest consumer and world model host
        if (ingestConsumerGetter) {
          ingestConsumerGetter(newDb).start();
        }
        defaultWorldModelHost.rehydrate(newDb);
        defaultWorldModelHost.normalizeCategories();

        // Re-run quick_check
        const rows = newDb.raw.prepare("PRAGMA quick_check(1);").all() as Array<Record<string, unknown>>;
        const isOk = rows.length > 0 && Object.values(rows[0])[0] === "ok";
        state.last_result = isOk ? "ok" : "failed";
      } catch (err) {
        console.error("[ops-services] worldmodel restart failed:", err);
        state.last_result = "failed";
      } finally {
        state.in_progress = false;
        clearOpsServicesCache();
        if (resolveWorldModelRestart) {
          resolveWorldModelRestart();
          resolveWorldModelRestart = null;
        }
        worldModelRestartPromise = null;
        try {
          recordRestartAudit(getDb(), { id: "worldmodel", deviceId, action: state.last_result ?? "failed" }, now);
        } catch {
          // Ignore
        }
      }
    });
  } else {
    // daemon, proxy, piecesos: invoke fixed scheduled task
    const taskName = `ExocortexRestart-${serviceId}`;
    setImmediate(async () => {
      try {
        await runner("schtasks", ["/run", "/tn", taskName]);

        if (serviceId === "proxy" || serviceId === "piecesos") {
          // Poll health until restored or timeout
          const maxWaitMs = serviceId === "piecesos" ? 120_000 : 30_000;
          const pollIntervalMs = 1000;
          const startTime = Date.now();
          let recovered = false;

          while (Date.now() - startTime < maxWaitMs) {
            await new Promise((r) => setTimeout(r, pollIntervalMs));
            const check = await checkServiceHealth(serviceId, deps);
            if (check.status === "healthy") {
              recovered = true;
              break;
            }
          }
          state.last_result = recovered ? "ok" : "failed";
          state.in_progress = false;
          clearOpsServicesCache();
          try {
            recordRestartAudit(getDb(), { id: serviceId, deviceId, action: state.last_result }, now);
          } catch {
            // Ignore
          }
        } else {
          state.last_result = "ok";
          state.in_progress = false;
          clearOpsServicesCache();
          try {
            recordRestartAudit(getDb(), { id: serviceId, deviceId, action: "ok" }, now);
          } catch {
            // Ignore
          }
        }
      } catch (err) {
        console.error(`[ops-services] ${serviceId} task launch failed:`, err);
        state.last_result = "failed";
        state.in_progress = false;
        clearOpsServicesCache();
        try {
          recordRestartAudit(getDb(), { id: serviceId, deviceId, action: "failed", reason: "spawn_error" }, now);
        } catch {
          // Ignore
        }
      }
    });
  }

  // Returns 202 Accepted immediately
  return { status: 202, data: { accepted: true, id: serviceId } };
}
