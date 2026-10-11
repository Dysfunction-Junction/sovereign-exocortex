import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { getDatabase } from "./db-host.js";
import { analyzeTestScreenshot } from "./vision-adapter.js";
import { recordTestScreenshotClassification } from "./vision-observation.js";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.length !== 2 || args[0] !== "--confirm-nonsensitive-test-screenshot") {
  console.error("Usage: pnpm --filter @exocortex/daemon vision-tests -- --confirm-nonsensitive-test-screenshot <screenshot-image>");
  process.exitCode = 2;
} else {
  const imagePath = args[1]!;
  console.warn("Only continue with a nonsensitive test-runner screenshot. The mobile app denylist does not apply to manually selected PC files.");
  const absolutePath = resolve(imagePath);
  const file = await stat(absolutePath);
  if (!file.isFile() || file.size > 20 * 1024 * 1024) {
    throw new Error("screenshot must be a regular file no larger than 20 MiB");
  }
  const classification = await analyzeTestScreenshot(await readFile(absolutePath));
  console.log(`Local vision classification: ${classification.status} (${classification.confidence.toFixed(2)})`);
  console.log(classification.summary);

  const db = getDatabase();
  try {
    const recorded = recordTestScreenshotClassification(classification, db);
    console.log(
      `[shadow] recorded ${recorded.eventId}; generated ${recorded.generatedPoliciesCount} proposal(s): ${recorded.proposalIds.join(", ") || "none"}`,
    );
  } finally {
    db.close();
  }
}
