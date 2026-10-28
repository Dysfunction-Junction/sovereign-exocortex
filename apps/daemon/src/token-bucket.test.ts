import test from "node:test";
import assert from "node:assert/strict";
import { TokenBucket } from "./token-bucket.js";

test("allows the capacity, then refuses, then refills over time", () => {
  let now = 0;
  const b = new TokenBucket(30, 30 / 60_000, () => now);
  for (let i = 0; i < 30; i++) assert.equal(b.take("dev"), true, `take ${i}`);
  assert.equal(b.take("dev"), false);
  now += 1_999; // 2 s refills one token; 1.999 s does not
  assert.equal(b.take("dev"), false);
  now += 1;
  assert.equal(b.take("dev"), true);
  assert.equal(b.take("dev"), false);
});

test("buckets are per device and never exceed capacity", () => {
  let now = 0;
  const b = new TokenBucket(2, 2 / 60_000, () => now);
  assert.equal(b.take("a"), true);
  assert.equal(b.take("a"), true);
  assert.equal(b.take("a"), false);
  assert.equal(b.take("b"), true, "another device is unaffected");
  now += 10 * 60_000;
  assert.equal(b.take("a"), true);
  assert.equal(b.take("a"), true);
  assert.equal(b.take("a"), false, "refill is capped at capacity");
});
