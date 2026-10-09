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

export function checkNodeHealth(port: number, timeoutMs = 2000): Promise<{ healthy: boolean; statusText: string }> {
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
          const { healthy, statusText } = await checkNodeHealth(port);
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
}

export async function startSentinel(options?: {
  reposRoot?: string;
  ports?: Record<string, number>;
}): Promise<SentinelController> {
  const handle = await startMishmash(options);

  return {
    handle,
    checkHealth: () => checkAllNodesHealth(handle.upstreams),
    stop: () => stopMishmash(handle),
  };
}

const isDirectRun = Boolean(
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
);

if (isDirectRun) {
  console.log("Starting Mishmash Ambient Sentinel daemon...");
  startSentinel()
    .then(({ handle, checkHealth, stop }) => {
      console.log("Mishmash Ambient Sentinel active on 127.0.0.1 across nodes:");
      for (const [id, upstream] of Object.entries(handle.upstreams)) {
        console.log(`  [${id}] -> ${upstream}`);
      }

      let consecutiveFailures = 0;
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

          if (unhealthy.length > 0) {
            consecutiveFailures += 1;
            console.warn(
              `[Sentinel Warning] ${unhealthy.length} unhealthy nodes (sweep failure ${consecutiveFailures}/3):`,
              unhealthy.map((u) => `${u.id}:${u.statusText}`).join(", ")
            );
            if (consecutiveFailures >= 3) {
              console.error("[Sentinel Fatal] 3 consecutive failed sweeps. Triggering supervisor exit for auto-restart.");
              void shutdown(1);
            }
          } else {
            consecutiveFailures = 0;
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
