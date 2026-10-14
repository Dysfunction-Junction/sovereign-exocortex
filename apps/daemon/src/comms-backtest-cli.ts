/**
 * Backtest the call/text ladder on past (Fi) events.
 *
 *   npm run comms-backtest [-- --train 0.7]
 *
 * Reads only kind "past" events with origin "comms-backfill" from the live database. Writes nothing and prints
 * only aggregate metrics (no person ids or numbers).
 */

import { backtestComms, type CommsEvent } from "@exocortex/world-model";
import { getDatabase } from "./db-host.js";

const i = process.argv.indexOf("--train");
const trainFraction = i >= 0 ? Number(process.argv[i + 1]) : 0.7;
if (!(trainFraction > 0 && trainFraction < 1)) {
  console.error("--train must be between 0 and 1");
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

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const r = backtestComms(events, { trainFraction });
console.log(`${r.events} events -> ${r.conversations} conversations (same person within 30 min merged); train ${pct(trainFraction)}`);
console.log("rung".padEnd(44), "classes   n   top1   top3  top3-base  commonest  repeat-last      p  verdict");
for (const row of r.rows) {
  console.log(
    `${row.level.padEnd(44)} ${String(row.classes).padStart(5)} ${String(row.n).padStart(4)} ${pct(row.top1).padStart(6)} ` +
      `${pct(row.top3).padStart(6)} ${pct(row.baseline3).padStart(9)} ${pct(row.baseline).padStart(9)} ${pct(row.persistence).padStart(11)} ${row.p.toFixed(3).padStart(6)}  ${row.verdict}`,
  );
}
