import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { getDatabase } from "./db-host.js";
import { analyzeTestScreenshot } from "./vision-adapter.js";
import { recordTestScreenshotClassification } from "./vision-observation.js";

const imagePath = process.argv[2];
if (!imagePath || process.argv.length !== 3) {
  console.error("Usage: pnpm --filter @exocortex/daemon vision-tests -- <screenshot-image>");
  process.exitCode = 2;
} else {
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
