/**
 * Usage: tsx shadow-report-cli.ts <db-path> [--days N] [--baseline P]
 * Prints shadow-mode calibration metrics. Opens the database read-only.
 *
 * Exit codes: 0 pass, 1 circuit breaker tripped, 2 usage error,
 * 3 insufficient data, 4 heuristic scorer (baseline not beaten), 70 runtime error.
 */

import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { computeShadowMetrics, formatShadowReport, loadShadowRows, type ShadowVerdict } from "./shadow-metrics.js";

const EXIT: Record<ShadowVerdict, number> = { pass: 0, fail: 1, insufficient_data: 3, heuristic_scorer: 4 };

function usage(msg: string): never {
  console.error(`${msg}\nusage: shadow-report-cli <db-path> [--days N] [--baseline P (0..1)]`);
  process.exit(2);
}

function number(name: string, raw: string | undefined, ok: (n: number) => boolean, rule: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(n) || !ok(n)) usage(`--${name} must be ${rule}`);
  return n;
}

let parsed: ReturnType<typeof parseArgs<{ options: { days: { type: "string" }; baseline: { type: "string" } }; allowPositionals: true }>>;
try {
  parsed = parseArgs({
    options: { days: { type: "string" }, baseline: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
} catch (err) {
  usage((err as Error).message);
}
if (parsed.positionals.length !== 1) usage("exactly one <db-path> is required");

const windowDays = number("days", parsed.values.days, (n) => n > 0, "a number > 0");
const baselinePrecision = number("baseline", parsed.values.baseline, (n) => n >= 0 && n <= 1, "between 0 and 1");

try {
  const db = new DatabaseSync(parsed.positionals[0], { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const metrics = computeShadowMetrics(loadShadowRows(db), { nowMs: Date.now(), windowDays, baselinePrecision });
    console.log(formatShadowReport(metrics));
    process.exitCode = EXIT[metrics.verdict];
  } finally {
    db.close();
  }
} catch (err) {
  console.error(`shadow-report failed: ${(err as Error).message}`);
  process.exitCode = 70;
}
