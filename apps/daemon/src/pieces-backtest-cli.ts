/**
 * Backtest the life graph's next-topic prediction on past (Pieces) sessions.
 *
 *   npm run pieces-backtest [-- --train 0.7]
 *
 * Reads only kind "past" events from the live database (EXOCORTEX_DB_PATH or %LOCALAPPDATA%\exocortex.db),
 * seeds a throwaway graph from the oldest slice, and scores predictions on the newer slice. Writes nothing.
 */

import { backtestAnyTopic, backtestLadder, backtestNextTopic } from "@exocortex/world-model";
import { getDatabase } from "./db-host.js";

const i = process.argv.indexOf("--train");
const trainFraction = i >= 0 ? Number(process.argv[i + 1]) : 0.7;
if (!(trainFraction > 0 && trainFraction < 1)) {
  console.error("--train must be between 0 and 1");
  process.exit(1);
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const sessions = getDatabase().listEvents({ kind: "past" }).flatMap((e) => {
  const p = JSON.parse(String(e.payload)) as { origin?: unknown; tags?: unknown; persons?: unknown; time_basis?: unknown };
  if (p.origin !== "pieces-backfill") return [];
  const timeBasis = p.time_basis === "range_start" ? ("range_start" as const) : ("record_created" as const);
  return [{ ts: e.ts_device, tags: strs(p.tags), persons: strs(p.persons), timeBasis }];
});

const r = backtestNextTopic(sessions, { trainFraction });
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const row = (name: string, s: typeof r.model) =>
  `${name.padEnd(12)} top1 ${pct(s.top1).padStart(6)}  top3 ${pct(s.top3).padStart(6)}  MRR ${s.mrr.toFixed(3)}  coverage ${pct(s.coverage)}`;
console.log(`train ${r.train} sessions, test ${r.test} (${r.evaluated} had a recurring topic to predict)`);
console.log(row("graph", r.model));
console.log(row("most common", r.mostCommon));
console.log(row("repeat last", r.repeatLast));
console.log(`graph 95% CI: top1 ${pct(r.ci95.top1[0])} to ${pct(r.ci95.top1[1])}, top3 ${pct(r.ci95.top3[0])} to ${pct(r.ci95.top3[1])}`);

const o = backtestAnyTopic(sessions, [1, 3, 5], { trainFraction });
console.log(`\ncoarse target: next session touches any of the top-k topics (${o.evaluated} cases)`);
for (const k of [1, 3, 5]) {
  const [lo, hi] = o.ci95Graph[k]!;
  console.log(
    `k=${k}  graph ${pct(o.graph[k]!).padStart(6)} (${pct(lo)} to ${pct(hi)})  most common ${pct(o.mostCommon[k]!).padStart(6)}  repeat last ${pct(o.repeatLast[k]!).padStart(6)}`,
  );
}

console.log("\nladder, broad to narrow (model = previous-session context; baseline = always the commonest label, persist = repeat the previous label)");
for (const row of backtestLadder(sessions, { trainFraction })) {
  console.log(
    `${row.level.padEnd(38)} classes ${String(row.classes).padStart(3)}  n ${String(row.n).padStart(3)}  ` +
      `model ${pct(row.model).padStart(6)}  baseline ${pct(row.baseline).padStart(6)}  persist ${pct(row.persistence).padStart(6)}  p ${row.p.toFixed(3)}  ${row.verdict}`,
  );
}
