import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExocortexDatabase } from "@exocortex/core/db";
import { eventToObservation } from "@exocortex/world-model";
import { backfillPieces, PAST_KIND } from "./pieces-backfill.js";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pieces-"));
  const put = (kind: string, name: string, rec: unknown) => {
    mkdirSync(join(root, "data", kind), { recursive: true });
    writeFileSync(join(root, "data", kind, `${name}.json`), JSON.stringify(rec));
  };
  put("ranges", "r1", { id: "r1", from: { value: "2026-08-29T17:00:00Z" }, to: { value: "2026-08-29T18:00:00Z" } });
  put("tags", "t1", { id: "t1", text: "android" });
  put("tags", "t2", { id: "t2", text: "proxy" });
  put("summaries", "s1", {
    id: "s1", name: "Proxy work", created: { value: "2026-09-01T00:00:00Z" },
    ranges: { indices: { r1: 0 } }, tags: { indices: { t1: 0, t2: 1, missing: 2 } },
  });
  put("summaries", "s2", { id: "s2", name: "No range", created: { value: "2026-08-10T00:00:00Z" } });
  put("summaries", "s3", { id: "s3", name: "No time at all" });
  return root;
}

test("backfill writes past events, oldest first, dated by range else creation", () => {
  const db = new ExocortexDatabase();
  const r = backfillPieces(db, fixture());
  assert.deepEqual(r, { summaries: 3, inserted: 2, duplicate: 0, skipped: 1, withRealRange: 1 });
  const events = db.listEvents({ kind: PAST_KIND });
  assert.equal(events.length, 2);
  assert.equal(events[0]!.ts_device, Date.parse("2026-08-10T00:00:00Z"));
  const p = JSON.parse(String(events[1]!.payload));
  assert.equal(p.time_basis, "range_start");
  assert.deepEqual(p.tags, ["android", "proxy"]);
  assert.equal(p.past, true);
  assert.equal(db.verifyEventChain().valid, true);
});

test("backfill is idempotent and invisible to the world model", () => {
  const db = new ExocortexDatabase();
  const dir = fixture();
  backfillPieces(db, dir);
  const again = backfillPieces(db, dir);
  assert.equal(again.inserted, 0);
  assert.equal(again.duplicate, 2);
  for (const e of db.listEvents()) assert.equal(eventToObservation(e), null);
});
