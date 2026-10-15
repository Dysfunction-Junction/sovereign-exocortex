/**
 * @file infer-outcomes-cli.ts
 * Standalone CLI runner to trigger outcome inference for surfaced shadow proposals.
 *
 * Usage:
 *   pnpm --filter @exocortex/daemon run infer-outcomes [--dry-run] [--horizon-hours N]
 */

import { getDatabase } from "./db-host.js";
import { inferProposalOutcomes } from "./inferred-outcomes.js";

const args = process.argv.slice(2).filter((a) => a !== "--");

let dryRun = false;
let horizonMs: number | undefined;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--dry-run") {
    dryRun = true;
  } else if (arg === "--horizon-hours") {
    if (i + 1 >= args.length) {
      console.error("Error: --horizon-hours requires a numeric value");
      process.exit(2);
    }
    const val = Number(args[++i]);
    if (!Number.isFinite(val) || val <= 0) {
      console.error("Error: --horizon-hours must be a positive finite number");
      process.exit(2);
    }
    horizonMs = Math.round(val * 3600 * 1000);
  } else if (arg === "--help" || arg === "-h") {
    console.log("Usage: pnpm --filter @exocortex/daemon run infer-outcomes [--dry-run] [--horizon-hours N]");
    process.exit(0);
  } else {
    console.error(`Unknown option: ${arg}`);
    console.error("Usage: pnpm --filter @exocortex/daemon run infer-outcomes [--dry-run] [--horizon-hours N]");
    process.exit(2);
  }
}

if (horizonMs !== undefined && !dryRun) {
  console.error("Error: --horizon-hours can only be used with --dry-run to simulate alternate evaluation horizons");
  process.exit(2);
}

const db = getDatabase();
try {
  console.log(`[inferred-outcomes] scanning proposals (dryRun=${dryRun}${horizonMs ? `, horizon=${horizonMs / 3600000}h` : ""})...`);
  const report = inferProposalOutcomes(db, {
    dryRun,
    horizonMs,
  });

  console.log("\n--- Inferred Outcome Pass Summary ---");
  console.log(`  Surfaced Evaluated: ${report.evaluatedCount}`);
  console.log(`  Already Did:        ${report.alreadyDidCount}`);
  console.log(`  Ignored:            ${report.ignoredCount}`);
  if (report.upgradedCount > 0) {
    console.log(`  Upgraded:           ${report.upgradedCount}`);
  }
  console.log(`  Skipped (Tap):      ${report.skippedTapCount}`);
  console.log(`  Still Pending:      ${report.stillPendingCount}`);
  console.log(`  Already Finalized:  ${report.finalizedCount}`);
  if (report.unresolvableCount > 0) {
    console.log(`  Unresolvable:       ${report.unresolvableCount}`);
  }

  if (report.results.length > 0) {
    console.log("\nActive Evaluations:");
    for (const r of report.results) {
      console.log(`  - [${r.label}] ${r.proposalId}: ${r.reason}${r.latencyMs != null ? ` (latency: ${r.latencyMs}ms)` : ""}`);
    }
  }
} catch (err) {
  console.error("[inferred-outcomes] failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  db.close();
}
