import { getDatabase } from "./db-host.js";
import { recordCodeHealthObservation } from "./health-observation.js";

const outcome = process.argv.at(-1);
if (outcome !== "passed" && outcome !== "failed") {
  console.error("Usage: pnpm --filter @exocortex/daemon run record-test-observation -- <passed|failed>");
  process.exitCode = 2;
} else {
  const db = getDatabase();
  try {
    const result = recordCodeHealthObservation(outcome === "passed", db);
    console.log(
      `[shadow observation] test suite ${outcome}; generated ${result.generatedPoliciesCount} proposal(s): ${result.proposalIds.join(", ") || "none"}`,
    );
  } finally {
    db.close();
  }
}
