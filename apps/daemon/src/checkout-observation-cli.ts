import { getDatabase } from "./db-host.js";
import { recordRepoCheckoutObservation } from "./repo-health.js";

const args = process.argv.slice(2).filter((a) => a !== "--");
const outcome = args[args.length - 1];
const repo = args.length > 1 ? args[0] : undefined;

if (args.length > 2 || (outcome !== "clean" && outcome !== "dirty")) {
  console.error("Usage: pnpm --filter @exocortex/daemon run record-checkout-observation -- [repo] <clean|dirty>");
  process.exitCode = 2;
} else {
  const db = getDatabase();
  try {
    const isClean = outcome === "clean";
    const result = recordRepoCheckoutObservation(isClean, db, {
      repoName: repo,
    });
    console.log(
      `[shadow observation] checkout ${outcome}${repo ? ` (${repo})` : ""}; generated ${result.generatedPoliciesCount} proposal(s): ${result.proposalIds.join(", ") || "none"}`,
    );
  } finally {
    db.close();
  }
}
