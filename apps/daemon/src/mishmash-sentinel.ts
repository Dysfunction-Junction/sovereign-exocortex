import { startMishmash, stopMishmash, type MishmashHandle } from "./mishmash-launch.js";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export interface NodeHealthStatus {
  id: string;
  port: number;
  healthy: boolean;
  statusText: string;
}

export function checkNodeHealth(port: number, timeoutMs = 5000, headers?: Record<string, string>): Promise<{ healthy: boolean; statusText: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { healthy: boolean; statusText: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/health",
        method: "GET",
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        res.resume(); // Discard body without unbounded accumulation
        const statusCode = res.statusCode ?? 500;
        const ok = statusCode >= 200 && statusCode < 300;
        finish({ healthy: ok, statusText: `HTTP ${statusCode}` });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      finish({ healthy: false, statusText: "Timeout" });
    });

    req.on("error", (err) => {
      finish({ healthy: false, statusText: err.message });
    });

    req.end();
  });
}

export async function checkAllNodesHealth(upstreams: Record<string, string>): Promise<NodeHealthStatus[]> {
  const entries = Object.entries(upstreams);
  return Promise.all(
    entries.map(async ([id, urlStr]) => {
      try {
        const url = new URL(urlStr);
        const port = Number(url.port);
        if (port > 0 && port < 65536) {
          // pieces-for-all gives loopback callers no token exemption, so probe it authenticated.
          const token = (process.env.GATEWAY_TOKEN ?? process.env.PIECES_GATEWAY_TOKEN ?? "").trim();
          const headers = id === "pieces-for-all" && token ? { Authorization: `Bearer ${token}` } : undefined;
          const { healthy, statusText } = await checkNodeHealth(port, 5000, headers);
          return { id, port, healthy, statusText };
        }
        return { id, port: 0, healthy: false, statusText: "No explicit port" };
      } catch {
        return { id, port: 0, healthy: false, statusText: "Invalid URL" };
      }
    })
  );
}

export interface SentinelController {
  handle: MishmashHandle;
  stop: () => Promise<void>;
  checkHealth: () => Promise<NodeHealthStatus[]>;
  restartNode: (id: string) => Promise<void>;
}

export async function startSentinel(options?: {
  reposRoot?: string;
  ports?: Record<string, number>;
}): Promise<SentinelController> {
  const handle = await startMishmash(options);
  let stopped = false;
  const attempts = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const restartInProgress = new Set<string>();
  const restartPromises = new Map<string, Promise<void>>();
  const watchChildExit = (id: string, index: number) => {
    const child = handle.children[index];
    if (!child) return;
    const onExit = () => {
      if (!restartInProgress.has(id)) scheduleRestart(id);
    };
    if (child.exitCode !== null || child.signalCode !== null) onExit();
    else {
      child.once("exit", onExit);
      child.once("error", onExit);
    }
  };
  const scheduleRestart = (id: string) => {
    if (stopped || timers.has(id)) return;
    const count = attempts.get(id) ?? 0;
    if (count >= 5) {
      console.error(`[Sentinel] ${id} restart limit reached; leaving other nodes running`);
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** count);
    const timer = setTimeout(() => {
      timers.delete(id);
      attempts.set(id, count + 1);
      void restartNode(id).catch((err) => {
        console.error(`[Sentinel] ${id} restart failed:`, err);
        scheduleRestart(id);
      });
    }, delay);
    timer.unref();
    timers.set(id, timer);
  };
  Object.keys(handle.upstreams).forEach((id, index) => {
    watchChildExit(id, index);
  });
  const restartNode = async (id: string) => {
    if (!handle.restartNode) throw new Error("node restart is unavailable");
    const active = restartPromises.get(id);
    if (active) return active;
    restartInProgress.add(id);
    const operation = handle.restartNode(id).finally(() => {
      restartPromises.delete(id);
      restartInProgress.delete(id);
      const index = Object.keys(handle.upstreams).indexOf(id);
      const child = handle.children[index];
      if (child && (child.exitCode !== null || child.signalCode !== null)) scheduleRestart(id);
    });
    restartPromises.set(id, operation);
    try {
      await operation;
      const index = Object.keys(handle.upstreams).indexOf(id);
      watchChildExit(id, index);
    } catch (err) {
      throw err;
    }
  };

  return {
    handle,
    checkHealth: async () => {
      const statuses = await checkAllNodesHealth(handle.upstreams);
      for (const status of statuses) if (status.healthy) attempts.delete(status.id);
      return statuses;
    },
    restartNode,
    stop: async () => {
      stopped = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await Promise.allSettled(restartPromises.values());
      await stopMishmash(handle);
    },
  };
}

const isDirectRun = Boolean(
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
);

if (isDirectRun) {
  console.log("Starting Mishmash Ambient Sentinel daemon...");
  startSentinel()
    .then(({ handle, checkHealth, stop, restartNode }) => {
      console.log("Mishmash Ambient Sentinel active on 127.0.0.1 across nodes:");
      for (const [id, upstream] of Object.entries(handle.upstreams)) {
        console.log(`  [${id}] -> ${upstream}`);
      }

      const consecutiveFailures = new Map<string, number>();
      let isShuttingDown = false;

      const shutdown = async (code = 0) => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        clearInterval(interval);
        console.log("Shutting down Sentinel daemon...");
        try {
          await stop();
        } catch (err) {
          console.error("Error during Sentinel shutdown:", err);
        } finally {
          process.exit(code);
        }
      };

      const interval = setInterval(async () => {
        try {
          const healths = await checkHealth();
          const unhealthy = healths.filter((h) => !h.healthy);
          const healthyCount = healths.length - unhealthy.length;
          console.log(
            `[Sentinel Heartbeat] ${new Date().toISOString()} - ${healthyCount}/${healths.length} nodes healthy`
          );

          for (const node of healths) {
            if (node.healthy) {
              consecutiveFailures.delete(node.id);
              continue;
            }
            const failures = (consecutiveFailures.get(node.id) ?? 0) + 1;
            consecutiveFailures.set(node.id, failures);
            console.warn(`[Sentinel Warning] ${node.id} unhealthy (${failures}/3): ${node.statusText}`);
            if (failures >= 3) {
              consecutiveFailures.set(node.id, 0);
              void restartNode(node.id).catch((err) => console.error(`[Sentinel] ${node.id} restart failed:`, err));
            }
          }
        } catch (sweepErr) {
          console.error("[Sentinel Sweep Error]", sweepErr);
        }
      }, 30_000);

      process.on("SIGINT", () => void shutdown(0));
      process.on("SIGTERM", () => void shutdown(0));
      process.on("SIGBREAK", () => void shutdown(0));
    })
    .catch((err) => {
      console.error("[Sentinel Fatal Start Error]", err);
      process.exit(1);
    });
}
