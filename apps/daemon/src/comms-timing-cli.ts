/**
 * Backtest when recurring contacts reach out (top N saved contacts), on past Fi events.
 *
 *   npm run comms-timing [-- --train 0.7] [-- --top 10]
 *
 * Reads only kind "past" events with origin "comms-backfill". Writes nothing and prints only aggregates.
 */

import { backtestTiming, type CommsEvent } from "@exocortex/world-model";
import { getDatabase } from "./db-host.js";

const arg = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const trainFraction = arg("train", 0.7);
const topN = arg("top", 10);
if (!(trainFraction > 0 && trainFraction < 1) || !(topN >= 1)) {
  console.error("--train must be between 0 and 1 and --top at least 1");
  process.exit(1);
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const events = getDatabase().listEvents({ kind: "past" }).flatMap((e): CommsEvent[] => {
  const p = JSON.parse(String(e.payload)) as Record<string, unknown>;
  if (p.origin !== "comms-backfill") return [];
  const people = strs(p.people);
  if (!people.length) return [];
  return [{
    ts: e.ts_device,
    type: p.type === "text" ? "text" : "call",
    direction: p.direction === "out" ? "out" : p.direction === "missed" ? "missed" : "in",
    person: people[0]!,
    labels: strs(p.labels),
    hour: Number(p.local_hour) || 0,
    dow: Number(p.local_dow) || 0,
  }];
});

const r = backtestTiming(events, { trainFraction, topN, minTrainDays: arg("min", 15) });
const f = (x: number) => x.toFixed(3);
console.log(`top ${r.contacts} saved contacts, train ${(trainFraction * 100).toFixed(0)}%`);
console.log("rung".padEnd(52), "    n   model  commonest  yesterday    hit      p  verdict");
for (const row of r.rows) {
  console.log(
    `${row.level.padEnd(52)} ${String(row.n).padStart(5)} ${f(row.model).padStart(7)} ${f(row.baseline).padStart(10)} ` +
      `${f(row.persistence).padStart(10)} ${(row.hit * 100).toFixed(1).padStart(5)}% ${row.p.toFixed(3).padStart(6)}  ${row.verdict}`,
  );
}
