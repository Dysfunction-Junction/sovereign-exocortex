import test from "node:test";
import assert from "node:assert/strict";
import { ExocortexDatabase } from "@exocortex/core/db";
import { enrollV3Device, surfaceTestProposal } from "./dev-tools.js";
import { parseP256Spki } from "./approval-attestation.js";

test("enrollV3Device registers an android device with minimum scopes and no attested key", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  enrollV3Device(db, "dev_phone", "My Phone");
  const d = db.getDevice("dev_phone")!;
  assert.equal(d.platform, "android");
  assert.deepEqual(d.scopes, ["telemetry:write", "approval:write"]);
  assert.equal(d.key_attested, 0, "placeholder key must never count as an approval key");
  assert.ok(parseP256Spki(d.pubkey_spki), "placeholder is a valid P-256 SPKI");
  assert.equal(d.revoked_at, null);
  assert.throws(() => enrollV3Device(db, "dev_phone", "again"), "enrolling twice is refused by the primary key");
});

test("surfaceTestProposal creates one live SURFACED, read-only proposal", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  const now = Date.now();
  const id = surfaceTestProposal(db, now);
  const row = db.getProposal(id)!;
  assert.equal(row.state, "SURFACED");
  assert.equal(JSON.parse(row.action).command, "diagnostic_probe");
  assert.ok(row.expires_at > now);
  assert.deepEqual(db.listProposalsByState(["SURFACED"], now).map((p) => p.proposal_id), [id]);
  // a second call reuses the host device and makes a different proposal
  const id2 = surfaceTestProposal(db, now);
  assert.notEqual(id, id2);
});
