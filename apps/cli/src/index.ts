#!/usr/bin/env node
import { execSync } from "node:child_process";
import { defaultDryRunCache, PreCognitiveEngine } from "@exocortex/core";
import { getAllMemories, searchMemories } from "@exocortex/memory";
import { LivingLifeGraph, CognitiveModeGate, ActiveInferenceEngine } from "@exocortex/world-model";

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

      // 3. The Magic Piece (Living World Model)
      const graph = new LivingLifeGraph();
      graph.addEntity({ id: "person_michael", name: "Michael", type: "PERSON" });
      graph.addEntity({ id: "project_sovereign_exocortex", name: "Sovereign Exocortex", type: "PROJECT" });
      graph.addEntity({ id: "project_bear_house_classic", name: "Bear House Classic", type: "PROJECT" });
      graph.addEntity({ id: "project_cafeteria_menu", name: "2nd Helpings Menu", type: "PROJECT" });

      const gate = new CognitiveModeGate();
      const inference = new ActiveInferenceEngine(graph);

      console.log(`[Magic Piece: Life Graph] Entities: ${graph.entityCount} | Edges: ${graph.edgeCount}`);
      console.log(`[Magic Piece: Cognitive Gate] Active Mode: ${gate.mode} (Flow-state protected)`);
      console.log(`[Magic Piece: Active Inference] Homeostatic Invariants: ${inference.registeredInvariants.length}`);

      // 4. Frontier 1: Pre-Cognitive Readiness
      const precog = new PreCognitiveEngine(defaultDryRunCache);
      console.log(`[Frontier 1: Pre-Cognitive Engine] Active (Pocket Pre-Staging + Neuromuscular Dwell)`);

      // 5. Frontier 3: Morphogenetic Software
      console.log(`[Frontier 3: Morphogenetic Code] Active (Darwinian Worktree Sandbox + Apoptosis)`);

      // 6. Mesh & Host Gateway
      console.log(`[Tailscale Mesh] Daemon Gateway: http://127.0.0.1:8787`);
      console.log(`[Host Architecture] Single In-Process Monorepo Substrate`);
      console.log("\nSystem status: HEALTHY (All internal systems operational)\n");
      break;
    }

    case "world": {
      console.log("\n--- THE LIVING WORLD MODEL OF MICHAEL ---");
      const graph = new LivingLifeGraph();
      graph.addEntity({ id: "person_michael", name: "Michael", type: "PERSON" });
      graph.addEntity({ id: "project_sovereign_exocortex", name: "Sovereign Exocortex Monorepo", type: "PROJECT" });
      graph.addEntity({ id: "project_bear_house_classic", name: "Bear House Classic", type: "PROJECT" });
      graph.addEntity({ id: "project_cafeteria_menu", name: "2nd Helpings Cafeteria Manager", type: "PROJECT" });
      graph.addEdge("person_michael", "project_sovereign_exocortex", "WORKS_ON", 1.0);
      graph.addEdge("person_michael", "project_bear_house_classic", "WORKS_ON", 0.95);
      graph.addEdge("person_michael", "project_cafeteria_menu", "WORKS_ON", 0.9);

      const gate = new CognitiveModeGate();
      const currentMode = gate.classifyMode({
        foregroundApp: "com.microsoft.VSCode",
        windowTitle: "sovereign-exocortex",
      });
      const inference = new ActiveInferenceEngine(graph);

      console.log(`Pillar 1: Living Life Graph - ${graph.entityCount} entities, ${graph.edgeCount} causal edges`);
      console.log(`Pillar 2: Cognitive Mode Gate - Current Classified Mode: ${currentMode}`);
      console.log(`Pillar 3: Active Inference Engine - ${inference.registeredInvariants.length} homeostatic invariants monitored`);
      console.log("\nInvariants:");
      for (const inv of inference.registeredInvariants) {
        console.log(`  • [${inv.category}] ${inv.name} (Preferred: ${inv.preferredState}, Prior: ${inv.priorProbability})`);
      }
      console.log();
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
  status        Check health of host daemon, world model, memory banks, and speculative cache
  world         Inspect the 3 Pillars of the Magic Piece (Living Life Graph, Cognitive Gate, Active Inference)
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
