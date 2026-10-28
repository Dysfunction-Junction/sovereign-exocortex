import test from "node:test";
import assert from "node:assert/strict";
import { ExocortexDatabase } from "@exocortex/core/db";
import { DelegateDenialReason, DenialLimiter, DELEGATE_DENIED_KIND, recordDelegateDenial } from "./delegate-audit.js";
import { TokenBucket } from "./token-bucket.js";

function setup(burst = 3, refillPerMs = 1 / 60_000) {
  let clock = 1_000_000;
  const limiter = new DenialLimiter(new TokenBucket(burst, refillPerMs, () => clock));
  const db = new ExocortexDatabase({ path: ":memory:" });
  const deny = (deviceId: string, to?: unknown, action?: unknown, reason: DelegateDenialReason = "unmapped") =>
    recordDelegateDenial(db, { deviceId, to, action, reason }, () => clock, limiter);
  const events = () => db.listEvents({ kind: DELEGATE_DENIED_KIND }).map((e) => JSON.parse(String(e.payload)) as Record<string, unknown>);
  return { db, deny, events, advance: (ms: number) => (clock += ms) };
}

test("names in the delegate map are logged; client-chosen text is never stored verbatim", () => {
  const { deny, events, db } = setup(10);
  deny("dev_a", "pieces-for-all", "ping");
  deny("dev_a", "evil\nname with spaces\u0000", "ghp_secrettoken1234567890");
  deny("dev_a", "x".repeat(200), "ok");
  deny("dev_a", "pieces-for-all", "ghp_secrettoken1234567890");
  deny("dev_a", 42, undefined);
  const logged = events();
  assert.equal(logged.length, 5);
  assert.deepEqual([logged[0]!.delegate_to, logged[0]!.delegate_action, logged[0]!.unrecognized], ["pieces-for-all", "ping", undefined]);
  assert.deepEqual([logged[1]!.delegate_to, logged[1]!.delegate_action, logged[1]!.unrecognized], [null, null, true]);
  assert.equal(logged[2]!.delegate_to, null);
  assert.equal(logged[2]!.delegate_action, null);
  assert.equal(logged[2]!.unrecognized, true);
  assert.deepEqual([logged[3]!.delegate_to, logged[3]!.delegate_action, logged[3]!.unrecognized], ["pieces-for-all", null, true]);
  assert.equal(logged[4]!.unrecognized, true);
  assert.doesNotMatch(JSON.stringify(logged), /ghp_|evil|xxxx/);
  assert.equal(db.verifyEventChain().valid, true, "the hash chain stays valid with denial events in it");
});

test("pre-body denials (to/action never read) are not flagged unrecognized", () => {
  const { deny, events } = setup(10);
  deny("dev_a", undefined, undefined, "scope");
  assert.equal(events()[0]!.unrecognized, undefined);
  assert.equal(events()[0]!.delegate_to, null);
});

test("burst then slow refill; dropped denials are counted in the next record", () => {
  const { deny, events, advance } = setup(3);
  const results = [1, 2, 3, 4, 5].map(() => deny("dev_a", "a", "b"));
  assert.deepEqual(results, [true, true, true, false, false]);
  assert.equal(events().length, 3);
  assert.equal(events().every((e) => e.suppressed_before === undefined), true);
  // another device has its own budget
  assert.equal(deny("dev_b", "a", "b"), true);
  advance(60_000); // one token back
  assert.equal(deny("dev_a", "a", "b"), true);
  const last = events().filter((e) => e.denied_device === "dev_a").at(-1)!;
  assert.equal(last.suppressed_before, 2, "the record after a gap says how many were dropped");
  advance(60_000);
  assert.equal(deny("dev_a", "a", "b"), true);
  assert.equal(events().filter((e) => e.denied_device === "dev_a").at(-1)!.suppressed_before, undefined);
});

test("prototype keys are not stored; hermes-api and memory denials are recorded as real attempts", () => {
  const { deny, events } = setup(20);
  deny("dev_a", "__proto__", "constructor");
  deny("dev_a", "pieces-for-all", "toString");
  deny("dev_a", "hermes-api", "tap", "shadow");
  deny("dev_a", "pieces-for-all", "memory", "scope");
  const logged = events();
  assert.deepEqual([logged[0]!.delegate_to, logged[0]!.delegate_action, logged[0]!.unrecognized], [null, null, true]);
  assert.deepEqual([logged[1]!.delegate_to, logged[1]!.delegate_action, logged[1]!.unrecognized], ["pieces-for-all", null, true]);
  assert.deepEqual([logged[2]!.delegate_to, logged[2]!.delegate_action, logged[2]!.unrecognized], ["hermes-api", null, undefined]);
  assert.deepEqual([logged[3]!.delegate_to, logged[3]!.delegate_action, logged[3]!.unrecognized], ["pieces-for-all", "memory", undefined]);
});
