import { test } from "node:test";
import assert from "node:assert/strict";
import { Mem0Client } from "../mem0-client.js";

const out = (results: unknown[]) => `Search results:\n ${JSON.stringify({ results })}\n`;

test("Mem0Client parses the CLI output into untrusted, clipped, capped hits", async () => {
  const seen: string[] = [];
  const rows = [
    { id: "a", memory: "x".repeat(900), score: 0.63119, categories: ["project", 7], createdAt: "2026-10-12T04:22:51+00:00" },
    { id: "b", memory: "second", score: 0.5 },
    { bogus: true },
    { id: "c", memory: "third" },
  ];
  const c = new Mem0Client("/x/mem0.js", 1000, async (script, q) => {
    seen.push(script, q);
    return out(rows);
  });
  const r = await c.search("restart daemon", 2);
  assert.equal(r.available, true);
  if (!r.available) return;
  assert.deepEqual(seen, ["/x/mem0.js", "restart daemon"]);
  assert.equal(r.hits.length, 2);
  assert.equal(r.hits[0]!.memory.length, 400);
  assert.deepEqual(r.hits[0]!.categories, ["project"]);
  assert.equal(r.hits[0]!.score, 0.63);
  assert.equal(r.hits[1]!.untrusted, true);
});

test("Mem0Client never throws: CLI failure, junk output and no JSON map to unavailable", async () => {
  const mk = (run: () => Promise<string>) => new Mem0Client("/x", 50, run);
  assert.deepEqual(await mk(async () => { throw new Error("spawn failed"); }).search("q"), { available: false, reason: "unreachable" });
  assert.deepEqual(await mk(async () => "Mem0 error: bad key").search("q"), { available: false, reason: "error" });
  assert.deepEqual(await mk(async () => "Search results:\n {not json").search("q"), { available: false, reason: "error" });
  assert.deepEqual(await mk(async () => '{"nope":1}').search("q"), { available: false, reason: "error" });
});

test("Mem0Client.fromEnv needs MEM0_CLI", () => {
  assert.equal(Mem0Client.fromEnv({}), null);
  assert.ok(Mem0Client.fromEnv({ MEM0_CLI: "C:/x/mem0.js" }));
});
