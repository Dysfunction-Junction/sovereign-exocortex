/**
 * Replay benchmark and provenance coverage for the world-model store (P1-G1, and boot replay time for P2-G1).
 *
 * Usage: pnpm world-model-bench <ledger.db> [--runs N] [--out evidence.json]
 *
 * The source ledger is copied with VACUUM INTO from a read-only connection; every measurement runs on that scratch
 * copy, so the source file is never written (plan stop rule S7).
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { ExocortexDatabase } from "@exocortex/core/db";
import { provenanceOf, PROVENANCE_REGISTRY_VERSION, type Provenance } from "@exocortex/core";
import { WorldModelHost } from "./world-model-host.js";

interface Args {
  source: string;
  runs: number;
  out: string | null;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--runs" || argv[i] === "--out") flags.set(argv[i], argv[++i] ?? "");
    else positional.push(argv[i]);
  }
  if (positional.length !== 1) throw new Error("usage: world-model-bench <ledger.db> [--runs N] [--out evidence.json]");
  const runs = flags.has("--runs") ? Number(flags.get("--runs")) : 5;
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  const out = flags.get("--out");
  return { source: resolve(positional[0]), runs, out: out ? resolve(out) : null };
}

function llamaServerRunning(): boolean {
  if (process.platform !== "win32") return false;
  try {
    return /llama-server/i.test(execSync('tasklist /FI "IMAGENAME eq llama-server.exe" /NH', { encoding: "utf8" }));
  } catch {
    return false;
  }
}

function dumpHash(host: WorldModelHost): string {
  const snap = host.lifeGraph.snapshot();
  const dump = {
    entities: snap.entities.map((e) => [e.id, e.type, e.name]).sort(),
    edges: snap.edges.map((e) => [e.id, e.observedCount, e.lastObserved]).sort(),
  };
  return createHash("sha256").update(JSON.stringify(dump)).digest("hex");
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const scratchDir = mkdtempSync(join(tmpdir(), "wm-bench-"));
  const scratch = join(scratchDir, "ledger.db");
  try {
    const source = new DatabaseSync(args.source, { readOnly: true });
    source.prepare("VACUUM INTO ?").run(scratch);
    source.close();

    const db = new ExocortexDatabase({ path: scratch });
    try {
      const events = db.raw.prepare("SELECT event_id, kind, device_id, payload FROM events ORDER BY seq").all() as Array<{
        event_id: string;
        kind: string;
        device_id: string;
        payload: string;
      }>;
      const byClass: Record<string, number> = {};
      const byRule: Record<string, number> = {};
      const seen = new Map<string, Provenance>();
      for (const ev of events) {
        const p = provenanceOf(ev, { resolveInput: (id) => seen.get(id) });
        seen.set(ev.event_id, p);
        byClass[p.class] = (byClass[p.class] ?? 0) + 1;
        byRule[p.rule] = (byRule[p.rule] ?? 0) + 1;
      }

      const timings: number[] = [];
      const hashes = new Set<string>();
      let last: WorldModelHost | null = null;
      const clockT0 = Date.UTC(2026, 9, 31);
      const clockPlus30d = clockT0 + 30 * 86_400_000;
      const realNow = Date.now;
      let hashAtT0 = "";
      let hashAtPlus30d = "";
      for (let i = 0; i < args.runs; i++) {
        const fakeClock = i % 2 === 0 ? clockT0 : clockPlus30d;
        Date.now = () => fakeClock;
        let host: WorldModelHost;
        let dt = 0;
        try {
          host = WorldModelHost.createIsolatedForTest();
          const t0 = performance.now();
          host.rehydrate(db);
          dt = performance.now() - t0;
        } finally {
          Date.now = realNow;
        }
        timings.push(dt);
        const h = dumpHash(host);
        hashes.add(h);
        if (i === 0) hashAtT0 = h;
        if (i === 1) hashAtPlus30d = h;
        last = host;
      }
      const status = last!.getStoreStatus();
      const report = {
        gate: "P1-G1",
        command: `pnpm world-model-bench <ledger copy> --runs ${args.runs}`,
        ran_at: new Date().toISOString(),
        host_state: { llama_server_running: llamaServerRunning() },
        measured: {
          registry_version: PROVENANCE_REGISTRY_VERSION,
          events: events.length,
          world_model_cursor: db.getConsumerCursor("world-model"),
          by_class: byClass,
          by_rule: byRule,
          unclassified: byClass.unclassified ?? 0,
          unclassified_seen_by_host: status.unclassified.total,
          hydrate_ms: { runs: timings.map((t) => Math.round(t)), median: Math.round(median(timings)), max: Math.round(Math.max(...timings)) },
          after_hydrate: { entities: last!.lifeGraph.entityCount, edges: last!.lifeGraph.edgeCount },
          graph_skipped: status.graphSkipped,
          artifacts: status.artifacts,
          identical_dumps_across_runs: hashes.size === 1,
          clock_independence_30d: {
            hash_t0: hashAtT0,
            hash_plus_30d: hashAtPlus30d,
            identical: args.runs >= 2 && hashAtT0 === hashAtPlus30d,
          },
        },
        threshold: { unclassified: 0 },
        pass: (byClass.unclassified ?? 0) === 0 && status.unclassified.total === 0 && hashes.size === 1 && (args.runs < 2 || hashAtT0 === hashAtPlus30d),
      };
      const json = JSON.stringify(report, null, 2);
      if (args.out) writeFileSync(args.out, json + "\n");
      console.log(json);
    } finally {
      db.close();
    }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

main();
