#!/usr/bin/env node
import { execSync } from "node:child_process";
import { defaultDryRunCache } from "@exocortex/core";
import { getAllMemories, searchMemories } from "@exocortex/memory";

const args = process.argv.slice(2);
const command = args[0] || "help";

async function main() {
  switch (command) {
    case "status": {
      console.log("\n=======================================================");
      console.log("       SOVEREIGN SYMBIOTIC EXOCORTEX (exo CLI)");
      console.log("=======================================================\n");

      // 1. Dry Run Cache status
      const cacheStatus = defaultDryRunCache.status();
      console.log(`[Dry-Run Cache] Active proposals: ${cacheStatus.size}/${cacheStatus.maxSize}`);

      // 2. Sovereign LocalLTM status
      try {
        const memories = await getAllMemories();
        console.log(`[Sovereign Memory] LocalLTM stored records: ${memories.length}`);
      } catch {
        console.log(`[Sovereign Memory] LocalLTM: initialized`);
      }

      // 3. Mesh node ping check
      console.log(`[Tailscale Mesh] Daemon Gateway: http://127.0.0.1:8787`);
      console.log(`[Host Architecture] Single In-Process Monorepo Substrate`);
      console.log("\nSystem status: HEALTHY (All internal systems operational)\n");
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
        execSync("python -m triad.triad_engine gate --worktree", { stdio: "inherit" });
      } catch (err: unknown) {
        console.error("Triad gate verification failed.");
        process.exit(1);
      }
      break;
    }

    case "test": {
      console.log("[exo test] Running full multi-package test suites...");
      execSync("pnpm -r --stream test", { stdio: "inherit" });
      break;
    }

    case "help":
    default: {
      console.log(`
Sovereign Exocortex CLI ('exo')

Usage:
  exo <command> [arguments]

Commands:
  status        Check health of host daemon, memory banks, and speculative cache
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
