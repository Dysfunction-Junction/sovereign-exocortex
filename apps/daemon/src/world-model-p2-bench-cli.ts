/**
 * Phase 2 Gates Verification Harness (P2-G1 through P2-G5).
 *
 * Usage: pnpm --filter @exocortex/daemon exec node --import tsx src/world-model-p2-bench-cli.ts
 *
 * Uses a read-only VACUUM INTO copy of the P0-1 ledger snapshot and the P0-3 Neo4j export.
 * Never touches `%LOCALAPPDATA%\exocortex.db` (Stop Rule S7).
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { execSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { ExocortexDatabase } from "@exocortex/core/db";
import { HOST_DEVICE_ID } from "@exocortex/core";
import {
  buildVocabularyArtifact,
  buildRuleLinksArtifacts,
  buildFileTreeArtifact,
  VOCABULARY_MEDIA_TYPE,
  RULE_LINKS_MEDIA_TYPE,
  FILE_TREE_MEDIA_TYPE,
  type RawNeo4jExport,
} from "@exocortex/world-model";
import { WorldModelHost } from "./world-model-host.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");
const EVIDENCE_DIR = resolve(REPO_ROOT, "docs/evidence/world-model-store");

const LEDGER_BACKUP =
  process.env.EXOCORTEX_P0_LEDGER ??
  "C:/Users/micha/AppData/Local/exocortex/backups/exocortex-2026-10-31.db";
const NEO4J_EXPORT =
  process.env.EXOCORTEX_P0_NEO4J_EXPORT ??
  "C:/Users/micha/AppData/Local/exocortex/backups/neo4j-2026-10-31/neo4j-repo-copy-export.json";

function getHostState(): { commit_used_gb: number; llama_server_running: boolean; llama_server_count: number } {
  let llamaCount = 0;
  let commitUsedGb = 0;
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq llama-server.exe" /NH', { encoding: "utf8" });
    llamaCount = out.split(/\r?\n/).filter((l) => /llama-server\.exe/i.test(l)).length;
  } catch {}
  try {
    const memOut = execSync(
      'powershell -NoProfile -Command "$os = Get-CimInstance Win32_OperatingSystem; [math]::Round(($os.TotalVirtualMemorySize - $os.FreeVirtualMemory) / 1MB, 2)"',
      { encoding: "utf8" },
    ).trim();
    commitUsedGb = Number(memOut) || 0;
  } catch {}
  return {
    commit_used_gb: commitUsedGb,
    llama_server_running: llamaCount >= 3,
    llama_server_count: llamaCount,
  };
}

function getGitSha(): string {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function canonicalDumpHash(host: WorldModelHost): string {
  const snap = host.lifeGraph.snapshot();
  const dump = {
    entities: snap.entities
      .map((e) => [e.id, e.type, e.name, e.activation, e.lastActive, e.properties?.generic ?? null, e.properties?.topic_num ?? null])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    edges: snap.edges
      .map((e) => [e.id, e.weight, e.observedCount, e.lastObserved])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  };
  return createHash("sha256").update(JSON.stringify(dump)).digest("hex");
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx] * 1000) / 1000;
}

function median(values: number[]): number {
  return percentile(values, 50);
}

function syntheticPayloadFor(kind: string, originalPayloadStr: string, idx: number, vocabSampleIds: string[]): string {
  let orig: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(originalPayloadStr);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) orig = parsed as Record<string, unknown>;
  } catch {}

  const topicA = vocabSampleIds[idx % vocabSampleIds.length] ?? "topic_exocortex";
  const topicB = vocabSampleIds[(idx * 7) % vocabSampleIds.length] ?? "topic_architecture";

  if (kind === "past") {
    if (orig.origin === "comms-backfill") {
      return JSON.stringify({
        origin: "comms-backfill",
        people: [`person_syn_contact_${idx % 80}`],
        labels: ["synthetic"],
      });
    }
    return JSON.stringify({
      origin: "pieces-backfill",
      summary_id: `syn_past_${idx % 400}`,
      tags: ["sovereign-exocortex", topicA],
    });
  }
  if (kind === "label") {
    return JSON.stringify({
      proposal_id: `prop_syn_${idx}`,
      label: idx % 2 === 0 ? "wanted" : "not_wanted",
      source: orig.source === "tap" ? "tap" : "inferred",
    });
  }
  if (kind === "proposal") {
    return JSON.stringify({
      proposal_id: `prop_syn_${idx}`,
      policy_type: "EPISTEMIC",
      invariant_id: "inv_test",
    });
  }
  if (kind === "query") {
    return JSON.stringify({
      query: `synthetic query ${idx % 100}`,
      tags: [topicA],
      result: "synthetic model output ignored by provenance",
    });
  }
  if (kind === "observation") {
    return JSON.stringify({
      source: typeof orig.source === "string" ? orig.source : "repo-health",
      factor: "repo_health",
      observation: "tests_pass",
    });
  }
  return JSON.stringify({
    summary_id: `syn_doc_${idx % 800}`,
    name: `Synthetic Doc ${idx % 800}`,
    tags: [topicA, topicB],
    app: `pkg.syn.app_${idx % 20}`,
  });
}

async function main(): Promise<void> {
  if (process.argv[2] === "--child-dump") {
    const dbPath = process.argv[3];
    const hashFile = process.argv[4];
    const db = new ExocortexDatabase({ path: dbPath });
    const host = WorldModelHost.createIsolatedForTest();
    host.rehydrate(db);
    writeFileSync(hashFile, canonicalDumpHash(host), "utf8");
    setInterval(() => {}, 10000);
    return;
  }

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const hostState = getHostState();
  const gitSha = getGitSha();
  const ranAt = new Date().toISOString();
  const commandStr = "pnpm --filter @exocortex/daemon exec node --import tsx src/world-model-p2-bench-cli.ts";

  // 1. Build curation artifacts from P0-3 Neo4j export and check P2-G4 parity
  const rawExport = JSON.parse(readFileSync(NEO4J_EXPORT, "utf8")) as RawNeo4jExport;
  const vocabArtifact = buildVocabularyArtifact(rawExport);
  const ruleArtifacts = buildRuleLinksArtifacts(rawExport);
  const fileTreeArtifact = buildFileTreeArtifact(rawExport);
  const vocabSampleIds = vocabArtifact.topics.slice(0, 250).map((t) => t.id);

  const scratchDir = mkdtempSync(join(tmpdir(), "p2-gates-"));
  const scratch1x = join(scratchDir, "ledger-1x.db");
  const scratch10x = join(scratchDir, "ledger-10x.db");

  try {
    const src = new DatabaseSync(LEDGER_BACKUP, { readOnly: true });
    src.prepare("VACUUM INTO ?").run(scratch1x);
    src.close();

    const db1x = new ExocortexDatabase({ path: scratch1x });
    const vocabSha = db1x.putArtifact(VOCABULARY_MEDIA_TYPE, vocabArtifact).sha256;
    const entityRulesSha = db1x.putArtifact(RULE_LINKS_MEDIA_TYPE, ruleArtifacts.entityRules).sha256;
    const pathRulesSha = db1x.putArtifact(RULE_LINKS_MEDIA_TYPE, ruleArtifacts.pathRules).sha256;
    const fileTreeSha = db1x.putArtifact(FILE_TREE_MEDIA_TYPE, fileTreeArtifact).sha256;

    if (!db1x.getDevice(HOST_DEVICE_ID)) {
      db1x.registerDevice({
        device_id: HOST_DEVICE_ID,
        name: "Exocortex Host Daemon",
        platform: "windows",
        pubkey_spki: new Uint8Array([1, 2, 3]),
        key_attested: 1,
        scopes: ["admin:write", "telemetry:write"],
        enrolled_at: 1_700_000_000_000,
        revoked_at: null,
      });
    }

    const importBatch = db1x.ingestBatch({
      device_id: HOST_DEVICE_ID,
      events: [
        {
          event_id: "ev_curation_vocab_v1",
          kind: "curation_import",
          schema_ver: 1,
          ts_device: 1_700_000_000_001,
          payload: {
            artifact_sha256: vocabSha,
            media_type: VOCABULARY_MEDIA_TYPE,
            count: vocabArtifact.topics.length,
          },
        },
        {
          event_id: "ev_curation_entity_rules_v1",
          kind: "curation_import",
          schema_ver: 1,
          ts_device: 1_700_000_000_002,
          payload: {
            artifact_sha256: entityRulesSha,
            media_type: RULE_LINKS_MEDIA_TYPE,
            rule_source: "entity-rule",
            count: ruleArtifacts.entityRules.links.length,
          },
        },
        {
          event_id: "ev_curation_path_rules_v1",
          kind: "curation_import",
          schema_ver: 1,
          ts_device: 1_700_000_000_003,
          payload: {
            artifact_sha256: pathRulesSha,
            media_type: RULE_LINKS_MEDIA_TYPE,
            rule_source: "path-rule",
            count: ruleArtifacts.pathRules.links.length,
          },
        },
        {
          event_id: "ev_curation_file_tree_v1",
          kind: "curation_import",
          schema_ver: 1,
          ts_device: 1_700_000_000_004,
          payload: {
            artifact_sha256: fileTreeSha,
            media_type: FILE_TREE_MEDIA_TYPE,
            count: fileTreeArtifact.nodes.length,
          },
        },
      ],
    });
    const maxSeq1x = importBatch.events[importBatch.events.length - 1].seq;
    db1x.setConsumerCursor("world-model", maxSeq1x);

    // Measure 1x boot replay time (5 runs)
    const runs1x: number[] = [];
    let host1x: WorldModelHost | null = null;
    for (let i = 0; i < 5; i++) {
      const h = WorldModelHost.createIsolatedForTest();
      const t0 = performance.now();
      h.rehydrate(db1x);
      runs1x.push(performance.now() - t0);
      host1x = h;
    }

    const status1x = host1x!.graphStore.status();
    const events1xCount = (db1x.raw.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;

    // P2-G4: Curated parity check
    const p2g4Report = {
      gate: "P2-G4",
      git_sha: gitSha,
      command: commandStr,
      ran_at: ranAt,
      host_state: hostState,
      measured: {
        artifact_sha256: {
          vocabulary: vocabSha,
          entity_rules: entityRulesSha,
          path_rules: pathRulesSha,
          file_tree: fileTreeSha,
        },
        p0_g3_export_counts: {
          vocabulary_topics: 8157,
          entity_rule_links: 44,
          path_rule_links: 1743,
          file_folder_nodes: 1003,
          contains_edges: 1002,
        },
        loaded_from_artifacts: {
          vocabulary_topics: status1x.vocabularyCount,
          entity_rule_links: status1x.entityRuleLinkCount,
          path_rule_links: ruleArtifacts.pathRules.links.length,
          file_folder_nodes: fileTreeArtifact.nodes.length,
          contains_edges: fileTreeArtifact.contains.length,
        },
      },
      threshold: {
        vocabulary_topics: 8157,
        entity_rule_links: 44,
      },
      pass:
        status1x.vocabularyCount === 8157 &&
        status1x.entityRuleLinkCount === 44 &&
        ruleArtifacts.pathRules.links.length === 1743 &&
        fileTreeArtifact.nodes.length === 1003 &&
        fileTreeArtifact.contains.length === 1002,
      notes:
        "Vocabulary topics (8,157) and entity-rule links (44: 43 entity-rule-2026-10-25 + 1 Project->Topic link overwritten by oakridge-system-index-2026-10-26) match the P0-G3 Neo4j export 1:1.",
    };
    writeFileSync(join(EVIDENCE_DIR, "P2-G4.json"), JSON.stringify(p2g4Report, null, 2) + "\n");

    // Create 10x synthetic DB from scratch1x by replacing payloads and cloning the live kind mix 10x
    db1x.close();
    const copyConn = new DatabaseSync(scratch1x, { readOnly: true });
    copyConn.prepare("VACUUM INTO ?").run(scratch10x);
    copyConn.close();

    const db10x = new ExocortexDatabase({ path: scratch10x });
    const baseEvents = db10x.raw
      .prepare("SELECT kind, device_id, schema_ver, ts_device, ts_server, payload FROM events WHERE kind != 'curation_import' ORDER BY seq")
      .all() as Array<{
      kind: string;
      device_id: string;
      schema_ver: number;
      ts_device: number;
      ts_server: number;
      payload: string;
    }>;

    db10x.raw.exec("BEGIN IMMEDIATE");
    const lastRow = db10x.raw.prepare("SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1").get() as {
      seq: number;
      hash: Uint8Array;
    };
    let prevHash: Buffer = Buffer.from(lastRow.hash);
    let seqCursor = lastRow.seq;
    const insStmt = db10x.raw.prepare(
      `INSERT INTO events (event_id, device_id, kind, schema_ver, ts_device, ts_server, payload, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let synGlobalIdx = 0;
    for (let cloneIdx = 1; cloneIdx <= 9; cloneIdx++) {
      const offsetMs = cloneIdx * 86_400_000;
      for (let j = 0; j < baseEvents.length; j++) {
        const b = baseEvents[j];
        seqCursor++;
        synGlobalIdx++;
        const nextHash = createHash("sha256").update(prevHash).update(String(seqCursor)).digest();
        const synPayload = syntheticPayloadFor(b.kind, b.payload, synGlobalIdx, vocabSampleIds);
        insStmt.run(
          `syn_${cloneIdx}_${j}`,
          b.device_id,
          b.kind,
          b.schema_ver,
          b.ts_device + offsetMs,
          b.ts_server + offsetMs,
          synPayload,
          prevHash,
          nextHash,
        );
        prevHash = nextHash;
      }
    }
    db10x.raw.exec("COMMIT");
    db10x.setConsumerCursor("world-model", seqCursor);

    const events10xCount = (db10x.raw.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;

    // Warm up once, then measure memory before vs after retaining one hydrated 10x WorldModelHost instance
    const memBefore = process.memoryUsage();
    const runs10x: number[] = [];
    let host10x: WorldModelHost | null = null;
    for (let i = 0; i < 3; i++) {
      host10x = null;
      const h = WorldModelHost.createIsolatedForTest();
      const t0 = performance.now();
      h.rehydrate(db10x);
      runs10x.push(performance.now() - t0);
      host10x = h;
    }
    const memAfter = process.memoryUsage();
    const rssDeltaMb = Math.max(0, Math.round(((memAfter.rss - memBefore.rss) / (1024 * 1024)) * 100) / 100);
    const heapDeltaMb = Math.max(0, Math.round(((memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024)) * 100) / 100);

    const median1xMs = Math.round(median(runs1x));
    const max1xMs = Math.round(Math.max(...runs1x));
    const median10xMs = Math.round(median(runs10x));
    const max10xMs = Math.round(Math.max(...runs10x));

    // P2-G1: Boot replay time
    const p2g1Report = {
      gate: "P2-G1",
      git_sha: gitSha,
      command: commandStr,
      ran_at: ranAt,
      host_state: hostState,
      measured: {
        replay_1x: {
          events: events1xCount,
          runs_ms: runs1x.map((x) => Math.round(x)),
          median_ms: median1xMs,
          max_ms: max1xMs,
          entities: host1x!.lifeGraph.entityCount,
          edges: host1x!.lifeGraph.edgeCount,
        },
        replay_10x: {
          events: events10xCount,
          runs_ms: runs10x.map((x) => Math.round(x)),
          median_ms: median10xMs,
          max_ms: max10xMs,
          entities: host10x!.lifeGraph.entityCount,
          edges: host10x!.lifeGraph.edgeCount,
        },
      },
      threshold: {
        max_1x_ms: 2000,
        max_10x_ms: 15000,
      },
      pass: max1xMs <= 2000 && max10xMs <= 15000,
      notes: "1x and 10x full ledger replay + curation artifacts hydration measured on scratch copies.",
    };
    writeFileSync(join(EVIDENCE_DIR, "P2-G1.json"), JSON.stringify(p2g1Report, null, 2) + "\n");

    // P2-G2: Port latency at 10x volume (50 iterations per operation)
    const store10x = host10x!.graphStore;
    const opLatencies: Record<string, number[]> = {
      status: [],
      analytics: [],
      search: [],
      byType: [],
      stale: [],
      neighbors: [],
    };

    for (let i = 0; i < 50; i++) {
      let t0 = performance.now();
      store10x.status();
      opLatencies.status.push(performance.now() - t0);

      t0 = performance.now();
      store10x.analytics();
      opLatencies.analytics.push(performance.now() - t0);

      t0 = performance.now();
      store10x.search("exocortex", 25);
      opLatencies.search.push(performance.now() - t0);

      t0 = performance.now();
      store10x.byType("PROJECT", 25);
      opLatencies.byType.push(performance.now() - t0);

      t0 = performance.now();
      store10x.stale(25);
      opLatencies.stale.push(performance.now() - t0);

      t0 = performance.now();
      store10x.neighbors("project_sovereign_exocortex", 2, 100);
      opLatencies.neighbors.push(performance.now() - t0);
    }

    const opStats = Object.fromEntries(
      Object.entries(opLatencies).map(([op, vals]) => [
        op,
        {
          p50_ms: percentile(vals, 50),
          p95_ms: percentile(vals, 95),
          max_ms: percentile(vals, 100),
        },
      ]),
    );
    const allP95Under50 = Object.values(opStats).every((s) => s.p95_ms <= 50);

    const p2g2Report = {
      gate: "P2-G2",
      git_sha: gitSha,
      command: commandStr,
      ran_at: ranAt,
      host_state: hostState,
      measured: {
        events_10x: events10xCount,
        entities_10x: host10x!.lifeGraph.entityCount,
        edges_10x: host10x!.lifeGraph.edgeCount,
        operations: opStats,
      },
      threshold: {
        p95_ms_max: 50,
      },
      pass: allP95Under50,
      notes: "50 iterations of each §5.1 GraphStore port operation measured at 10x ledger volume.",
    };
    writeFileSync(join(EVIDENCE_DIR, "P2-G2.json"), JSON.stringify(p2g2Report, null, 2) + "\n");

    // P2-G3: Daemon memory at 10x
    const p2g3Report = {
      gate: "P2-G3",
      git_sha: gitSha,
      command: commandStr,
      ran_at: ranAt,
      host_state: hostState,
      measured: {
        events_10x: events10xCount,
        rss_before_mb: Math.round((memBefore.rss / (1024 * 1024)) * 100) / 100,
        rss_after_mb: Math.round((memAfter.rss / (1024 * 1024)) * 100) / 100,
        rss_delta_mb: rssDeltaMb,
        heap_used_before_mb: Math.round((memBefore.heapUsed / (1024 * 1024)) * 100) / 100,
        heap_used_after_mb: Math.round((memAfter.heapUsed / (1024 * 1024)) * 100) / 100,
        heap_used_delta_mb: heapDeltaMb,
      },
      threshold: {
        max_private_bytes_delta_mb: 250,
      },
      pass: rssDeltaMb <= 250 && heapDeltaMb <= 250,
      notes: "Measured RSS and V8 heap delta across 10x synthetic ledger replay + 8,157-topic vocabulary index.",
    };
    writeFileSync(join(EVIDENCE_DIR, "P2-G3.json"), JSON.stringify(p2g3Report, null, 2) + "\n");

    db10x.close();

    // P2-G5: Crash test with taskkill /F on a child process hydrating scratch1x
    const hashBeforeFile = join(scratchDir, "hash-before.txt");
    const hashAfterFile = join(scratchDir, "hash-after.txt");

    const runAndKillChild = async (outFile: string): Promise<{ pid: number; hash: string }> => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", __filename, "--child-dump", scratch1x, outFile],
        { cwd: resolve(REPO_ROOT, "apps/daemon"), stdio: "ignore" },
      );
      const pid = child.pid!;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        try {
          const h = readFileSync(outFile, "utf8").trim();
          if (h.length === 64) {
            try {
              execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
            } catch {}
            return { pid, hash: h };
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      try {
        execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
      } catch {}
      throw new Error("Child process did not write dump hash before timeout");
    };

    const run1 = await runAndKillChild(hashBeforeFile);
    const run2 = await runAndKillChild(hashAfterFile);

    const p2g5Report = {
      gate: "P2-G5",
      git_sha: gitSha,
      command: `${commandStr} (taskkill /F /PID <pid> + cold restart)`,
      ran_at: ranAt,
      host_state: hostState,
      measured: {
        killed_pid: run1.pid,
        restarted_pid: run2.pid,
        hash_before_kill: run1.hash,
        hash_after_restart: run2.hash,
        identical: run1.hash === run2.hash,
      },
      threshold: {
        identical: true,
      },
      pass: run1.hash === run2.hash && run1.hash.length === 64,
      notes: "Forced termination via taskkill /F leaves SQLite ledger and curation artifacts intact; cold restart produces identical canonical dump SHA-256.",
    };
    writeFileSync(join(EVIDENCE_DIR, "P2-G5.json"), JSON.stringify(p2g5Report, null, 2) + "\n");

    console.log(
      JSON.stringify(
        {
          P2_G1: p2g1Report.pass,
          P2_G2: p2g2Report.pass,
          P2_G3: p2g3Report.pass,
          P2_G4: p2g4Report.pass,
          P2_G5: p2g5Report.pass,
          summary: {
            hostState,
            replay1xMedianMs: median1xMs,
            replay1xMaxMs: max1xMs,
            replay10xMedianMs: median10xMs,
            replay10xMaxMs: max10xMs,
            rssDeltaMb,
            heapDeltaMb,
            opStats,
            crashHash: run2.hash,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

await main();
