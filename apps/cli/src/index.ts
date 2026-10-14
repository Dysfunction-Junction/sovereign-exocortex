#!/usr/bin/env node
import { execFileSync, execSync } from "node:child_process";
import { getAllMemories, searchMemories } from "@exocortex/memory";

const args = process.argv.slice(2);
const command = args[0] || "help";
const daemonUrl = (process.env.EXOCORTEX_DAEMON_URL ?? "http://127.0.0.1:8788").replace(/\/$/, "");

async function daemonGet<T>(path: string, authenticated = true): Promise<T> {
  const token = process.env.EXOCORTEX_ADMIN_TOKEN;
  if (authenticated && !token) throw new Error("EXOCORTEX_ADMIN_TOKEN is not set");
  const response = await fetch(new URL(path, `${daemonUrl}/`), {
    headers: authenticated ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function daemonHealth(): Promise<boolean> {
  try {
    const result = await daemonGet<{ ok?: boolean }>("/mobile/health", false);
    return result.ok === true;
  } catch {
    return false;
  }
}

async function main() {
  switch (command) {
    case "status": {
      console.log("\n=======================================================");
      console.log("       SOVEREIGN SYMBIOTIC EXOCORTEX (exo CLI)");
      console.log("=======================================================\n");

      // Local memory is independent of daemon health.
      try {
        const memories = await getAllMemories();
        console.log(`[Sovereign Memory] LocalLTM stored records: ${memories.length}`);
      } catch {
        console.log(`[Sovereign Memory] LocalLTM: initialized`);
      }

      const health = await daemonHealth();
      console.log(`[Daemon] ${health ? `UP (${daemonUrl})` : `DOWN (${daemonUrl})`}`);
      try {
        const [devices, proposals, verification] = await Promise.all([
          daemonGet<{ devices: unknown[] }>("/v3/devices"),
          daemonGet<{ proposals: unknown[] }>("/v3/proposals/pending"),
          daemonGet<{ verification: { valid?: boolean } }>("/v3/events/verify"),
        ]);
        console.log(`[Devices] ${devices.devices?.length ?? 0}`);
        console.log(`[Pending proposals] ${proposals.proposals?.length ?? 0}`);
        console.log(`[Event chain] ${verification.verification?.valid ? "VERIFIED" : "CHECK FAILED"}`);
        const healthy = health && verification.verification?.valid === true;
        console.log(`\nSystem status: ${healthy ? "HEALTHY" : "DEGRADED"}\n`);
        if (!healthy) process.exitCode = 1;
      } catch (err) {
        console.log(`[Daemon data] unavailable: ${err instanceof Error ? err.message : String(err)}`);
        console.log(`\nSystem status: ${health ? "DEGRADED" : "DOWN"}\n`);
        process.exitCode = 1;
      }
      break;
    }

    case "world": {
      console.log("\n--- LIVE WORLD MODEL ---");
      try {
        const result = await daemonGet<{ state: Record<string, unknown> }>("/world-model/state");
        console.log(JSON.stringify(result.state, null, 2));
      } catch (err) {
        console.error(`World model unavailable: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
      break;
    }
    case "memory": {
      const query = args.slice(1).join(" ").trim();
      if (!query) {
        const all = await getAllMemories();
        console.log(`\nStored memories (${all.length} total):`);
        for (const m of all.slice(-10)) {
          console.log(`- [${m.source || "unknown"}] ${m.title} (${(m.tags || []).join(", ")})`);
        }
      } else {
        const results = await searchMemories(query, 5);
        console.log(`\nSearch results for "${query}" (${results.length} found):`);
        for (const m of results) {
          console.log(`- [Score: ${m.score.toFixed(2)}] ${m.title}`);
          console.log(`  ${m.body.slice(0, 120)}...`);
        }
      }
      break;
    }

    case "gate": {
      console.log("[exo gate] Dispatching diff to Autonomous Triad Advisory Council...");
      try {
        const python = process.env.MISHMASH_PYTHON || (process.platform === "win32" ? "python" : "python3");
        execFileSync(python, ["-m", "triad.triad_engine", "gate", "--worktree"], { stdio: "inherit" });
      } catch (err: unknown) {
        console.error("Triad gate verification failed.");
        process.exit(1);
      }
      break;
    }

    case "test": {
      console.log("[exo test] Running full multi-package test suites...");
      let testError: unknown;
      try {
        execSync("pnpm -r --stream test", { stdio: "inherit" });
      } catch (err) {
        testError = err;
      }

      try {
        execSync(
          `pnpm --filter @exocortex/daemon run record-test-observation -- ${testError ? "failed" : "passed"}`,
          { stdio: "inherit" },
        );
      } catch (err) {
        console.warn(
          "[exo test] Could not record the test outcome in shadow mode:",
          err instanceof Error ? err.message : String(err),
        );
      }

      if (testError) throw testError;
      break;
    }

    case "help":
    default: {
      console.log(`
Sovereign Exocortex CLI ('exo')

Usage:
  exo <command> [arguments]

Commands:
  status        Check daemon health, registered devices, pending proposals, and event-chain integrity
  world         Inspect the live daemon world-model state
  memory [q]    Search sovereign LocalLTM memories or inspect recent records
  gate          Run Autonomous Triad pre-commit gate in isolated worktree
  test          Execute all unit & integration test suites across the monorepo
  help          Display this help message
`);
      break;
    }
  }
}

main().catch((err) => {
  console.error("exo error:", err);
  process.exit(1);
});
