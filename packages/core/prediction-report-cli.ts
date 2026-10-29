/**
 * Usage: tsx prediction-report-cli.ts <db-path> [--days N] [--guide-by <context.path>] [--stream screen|app] [--eval]
 *
 * The ledger holds two prediction streams (companion-app screens and foreground-app arrivals). They are
 * scored separately, so the report covers one stream at a time; the default, screen, keeps the
 * existing ledger comparable. --eval always replays the screen-view events.
 *
 * Prints the next-action prediction log: hit rates against the frequency baseline, calibration, and the
 * probability guide (what really happened after each guess, misses included). Opens the database
 * read-only. With --eval it also replays every screen view in the event log through the engine and the
 * frequency baseline (prequential, so every score is out-of-sample) and reports the paired log-loss gain.
 *
 * Exit codes: 0 ok, 2 usage error, 3 not enough data, 70 runtime error.
 */

import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { computePredictionReport, formatPredictionReport, loadPredictionRows } from "./prediction-log.js";
import { ProbEngine, baselineEngine, compareLogLoss, prequential, summarize, type EvaluationSummary } from "./prob-engine.js";
import { buildScreenExamples, type RawEvent } from "./prediction-events.js";

const MIN_EXAMPLES = 30;
const pct = (v: number | null): string => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const num = (v: number | null, d = 4): string => (v === null ? "n/a" : v.toFixed(d));

function usage(msg: string): never {
  console.error(`${msg}\nusage: prediction-report-cli <db-path> [--days N] [--guide-by context.path] [--stream screen|app] [--eval]`);
  process.exit(2);
}

function line(label: string, s: EvaluationSummary): string {
  return `  ${label.padEnd(10)} n=${s.n}  log loss ${num(s.meanLogLoss)}  Brier ${num(s.meanBrier)}  top-1 ${pct(s.top1)}  top-3 ${pct(s.top3)}  ECE ${num(s.ece)}`;
}

let parsed: ReturnType<typeof parseArgs<{ options: { days: { type: "string" }; "guide-by": { type: "string" }; stream: { type: "string" }; eval: { type: "boolean" } }; allowPositionals: true }>>;
try {
  parsed = parseArgs({ options: { days: { type: "string" }, "guide-by": { type: "string" }, stream: { type: "string" }, eval: { type: "boolean" } }, allowPositionals: true });
} catch (e) {
  usage(e instanceof Error ? e.message : String(e));
}
const dbPath = parsed.positionals[0];
if (!dbPath || parsed.positionals.length > 1) usage("exactly one <db-path> is required");
let days: number | undefined;
if (parsed.values.days !== undefined) {
  days = Number(parsed.values.days);
  if (!Number.isFinite(days) || days <= 0) usage("--days must be a positive number");
}
const stream = parsed.values.stream ?? "screen";
if (stream !== "screen" && stream !== "app") usage("--stream must be screen or app");

try {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  const has = (name: string): boolean => raw.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name) !== undefined;
  let exit = 0;

  if (has("predictions")) {
    const since = days !== undefined ? Date.now() - days * 86_400_000 : 0;
    const rows = loadPredictionRows(raw, since, stream);
    console.log(`Prediction stream: ${stream}`);
    console.log(formatPredictionReport(computePredictionReport(rows, { guideBy: parsed.values["guide-by"] })));
  } else {
    console.log("Next-action prediction log: no predictions recorded yet (the daemon creates the table on the first screen view).");
    exit = 3;
  }

  if (parsed.values.eval) {
    const events = raw
      .prepare("SELECT seq, device_id, kind, ts_device, payload FROM events WHERE kind IN ('touch','telemetry') ORDER BY seq")
      .all() as unknown as RawEvent[];
    const examples = buildScreenExamples(events);
    console.log("");
    console.log(`Offline evaluation over the event log (${examples.length} consecutive screen-view pairs)`);
    if (examples.length < MIN_EXAMPLES) {
      console.log(`  Not enough data: need at least ${MIN_EXAMPLES} pairs.`);
      exit = 3;
    } else {
      const engine = prequential(examples, new ProbEngine());
      const base = prequential(examples, baselineEngine());
      console.log(line("engine", summarize(engine)));
      console.log(line("baseline", summarize(base)));
      const cmp = compareLogLoss(engine, base);
      console.log(`  Paired log-loss gain over baseline: ${num(cmp.meanLogLossGain)} nats  (SE ${num(cmp.standardError)}, z ${num(cmp.z, 2)})`);
      console.log(`  Verdict: ${cmp.significantlyBetter ? "engine is significantly better than frequency counting" : "no significant improvement over frequency counting"}`);
    }
  }
  process.exit(exit);
} catch (e) {
  console.error("prediction-report-cli error:", e instanceof Error ? e.message : e);
  process.exit(70);
}
