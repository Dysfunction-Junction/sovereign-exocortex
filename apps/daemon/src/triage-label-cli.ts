/**
 * Triage model labeling CLI.
 *
 *   npm run triage-label -- backfill [--models qwen3:1.7b,qwen3:4b]   run each model over stored events (resumable)
 *   npm run triage-label -- label [--all] [--any] [--models ...]      blind labeling: u / r / n, s = skip, q = quit
 *                                                                     (--any: also events no model has scored yet)
 *   npm run triage-label -- score [--models ...]                      accuracy, urgent recall, confusion per model
 *
 * Reads the live daemon database (EXOCORTEX_DB_PATH or %LOCALAPPDATA%\exocortex.db). It only appends
 * to triage_results and triage_labels; the event log is never modified.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { getDatabase } from "./db-host.js";
import { addLabel, backfill, ensureTables, formatReport, nextToLabel, score } from "./triage-labels.js";
import type { TriageCategory } from "./triage-host.js";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const models = (flag("models") ?? "qwen3:1.7b,qwen3:4b").split(",").map((m) => m.trim()).filter(Boolean);

const KEYS: Record<string, TriageCategory> = { u: "urgent", r: "routine", n: "noise" };

async function main(): Promise<void> {
  const db = getDatabase();
  ensureTables(db);

  if (cmd === "backfill") {
    console.log(`Running ${models.join(", ")} over stored telemetry (one model at a time; safe to stop and re-run).`);
    let last = 0;
    const summary = await backfill(db, {
      models,
      onProgress: (p) => {
        if (p.done - last >= 10) {
          last = p.done;
          console.log(`  ${p.model}: ${p.done}/${p.total}${p.failed ? ` (${p.failed} failed)` : ""}`);
        }
      },
    });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (cmd === "label") {
    const queue = nextToLabel(db, models, argv.includes("--all"), argv.includes("--any"));
    if (queue.length === 0) {
      console.log("Nothing to label. Pass --all to include events the models agree on, or --any to label before the models have run.");
      return;
    }
    const disagreements = queue.filter((c) => c.disagree).length;
    console.log(`${queue.length} events to label (${disagreements} where the models disagree). You will not see model output.`);
    console.log("urgent = needs action within ~24h or security/health; routine = needs action later; noise = ignorable.\n");
    const rl = createInterface({ input: stdin, output: stdout });
    let labeled = 0;
    try {
      for (const [i, c] of queue.entries()) {
        console.log(`--- ${i + 1}/${queue.length}  (event ${c.seq})`);
        console.log(c.text.slice(0, 500));
        for (;;) {
          const a = (await rl.question("[u]rgent [r]outine [n]oise [s]kip [q]uit > ")).trim().toLowerCase();
          if (a === "q") return void console.log(`\nStopped. ${labeled} labeled this session.`);
          if (a === "s") break;
          if (KEYS[a]) {
            addLabel(db, c.seq, KEYS[a]);
            labeled++;
            break;
          }
        }
        console.log();
      }
      console.log(`Done. ${labeled} labeled this session.`);
    } finally {
      rl.close();
    }
    return;
  }

  if (cmd === "score") {
    console.log(formatReport(score(db, models)));
    return;
  }

  console.log("commands: backfill | label [--all] | score   (option: --models a,b)");
  process.exitCode = cmd ? 2 : 0;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
