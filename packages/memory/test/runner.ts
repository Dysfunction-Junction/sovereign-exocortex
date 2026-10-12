/**
 * Test Runner for Pieces For All
 *
 * Runs all test suites under test/ using node:test and tsx.
 * Supports both `npm test` and `npm test -- --run` cleanly.
 */

import { run } from "node:test";
import { spec } from "node:test/reporters";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const testFiles = [
  join(__dirname, "openrouter.test.ts"),
  join(__dirname, "subscription.test.ts"),
  join(__dirname, "pieces.test.ts"),
  join(__dirname, "memories.test.ts"),
  join(__dirname, "server.test.ts"),
  join(__dirname, "local-ltm.test.ts"),
  join(__dirname, "embeddings.test.ts"),
  join(__dirname, "archive-client.test.ts"),
];

// Keep the suite hermetic: only embeddings.test.ts exercises embeddings (with a
// fake fetch). Everything else must not depend on a running Ollama.
process.env.EXOCORTEX_EMBEDDINGS ??= "0";

const testStream = run({
  files: testFiles,
  concurrency: 1,
});

testStream.compose(new spec()).pipe(process.stdout);

let hasFailures = false;

testStream.on("test:fail", () => {
  hasFailures = true;
  process.exitCode = 1;
});

testStream.on("error", (err) => {
  console.error("Test stream error:", err);
  hasFailures = true;
  process.exitCode = 1;
});

testStream.on("end", () => {
  if (hasFailures) {
    process.exitCode = 1;
  }
});
