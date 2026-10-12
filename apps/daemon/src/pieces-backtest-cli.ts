/**
 * Backtest the life graph's next-topic prediction on past (Pieces) sessions.
 *
 *   npm run pieces-backtest [-- --train 0.7]
 *
 * Reads only kind "past" events from the live database (EXOCORTEX_DB_PATH or %LOCALAPPDATA%\exocortex.db),
 * seeds a throwaway graph from the oldest slice, and scores predictions on the newer slice. Writes nothing.
 */

import { backtestNextTopic } from "@exocortex/world-model";
import { getDatabase } from "./db-host.js";

const i = process.argv.indexOf("--train");
const trainFraction = i >= 0 ? Number(process.argv[i + 1]) : 0.7;
if (!(trainFraction > 0 && trainFraction < 1)) {
  console.error("--train must be between 0 and 1");
  process.exit(1);
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const sessions = getDatabase().listEvents({ kind: "past" }).map((e) => {
  const p = JSON.parse(String(e.payload)) as { tags?: unknown; persons?: unknown };
  return { ts: e.ts_device, tags: strs(p.tags), persons: strs(p.persons) };
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
