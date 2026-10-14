/**
 * Pieces backfill CLI.
 *
 *   npm run pieces-backfill -- <export dir>
 *
 * Appends one "past" event per Pieces workstream summary to the live database (EXOCORTEX_DB_PATH or
 * %LOCALAPPDATA%\exocortex.db). Past events are ignored by the predictors and the world-model replay.
 * Safe to re-run: already-imported summaries are skipped.
 */

import { getDatabase } from "./db-host.js";
import { backfillPieces } from "./pieces-backfill.js";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: npm run pieces-backfill -- <Pieces export dir>");
  process.exit(1);
}
const r = backfillPieces(getDatabase(), dir);
console.log(
  `summaries ${r.summaries}: inserted ${r.inserted}, already present ${r.duplicate}, skipped ${r.skipped}; ` +
    `${r.withRealRange} dated by activity range, ${r.summaries - r.skipped - r.withRealRange} by record creation`,
);
const chain = getDatabase().verifyEventChain();
if (chain) console.log("hash chain:", JSON.stringify(chain));
