/**
 * Fi call/text backfill CLI.
 *
 *   npm run comms-backfill -- <FiHistory.csv> <contacts.csv>
 *
 * Appends one "past" event per call or text to the live database (EXOCORTEX_DB_PATH or
 * %LOCALAPPDATA%\exocortex.db). Raw phone numbers are never stored: contacts become person ids and unknown numbers
 * are HMAC-hashed with a local salt (COMMS_SALT, or a generated file comms-salt.txt next to the database).
 * Set COMMS_TIME_ZONE to an IANA zone (for example America/Chicago) to apply historical daylight-saving rules;
 * without it, timestamps use the fixed UTC offset in the export header.
 * Safe to re-run.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { backfillComms, readText } from "./comms-backfill.js";
import { getDatabase, getDefaultDbPath } from "./db-host.js";

const [fi, contacts] = process.argv.slice(2);
if (!fi || !contacts) {
  console.error("usage: npm run comms-backfill -- <FiHistory.csv> <contacts.csv>");
  process.exit(1);
}

function salt(): string {
  if (process.env.COMMS_SALT) return process.env.COMMS_SALT;
  const file = join(dirname(getDefaultDbPath()), "comms-salt.txt");
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  return readFileSync(file, "utf8").trim();
}

const r = backfillComms(getDatabase(), readText(fi), readText(contacts), salt(), process.env.COMMS_TIME_ZONE);
console.log(
  `rows ${r.rows}: inserted ${r.inserted}, already present ${r.duplicate}, automated skipped ${r.automated}, ` +
    `carrier twin rows dropped ${r.unknownDuplicates}, malformed ${r.malformed}; ` +
    `${r.matchedToContact} contact matches, ${r.anonymous} anonymous numbers`,
);
console.log("hash chain:", JSON.stringify(getDatabase().verifyEventChain()));
