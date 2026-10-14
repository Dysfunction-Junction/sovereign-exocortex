import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphClient } from "../src/graph-client.js";

const fakeFetch = (status: number, body: unknown, seen?: { init?: RequestInit; url?: string }) =>
  (async (url: string, init?: RequestInit) => {
    if (seen) {
      seen.url = url;
      seen.init = init;
    }
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;

test("GraphClient maps rows to untrusted hits and sends basic auth", async () => {
  const seen: { init?: RequestInit; url?: string } = {};
  const rows = [
    ["Summaries", "Android Dev", "x".repeat(900), "markdown/a.md", 7],
    ["Tags", "ok", null, null, "bad"],
    [1, 2],
  ];
  const c = new GraphClient({
    queryUrl: "https://g.example/db/neo4j/query/v2",
    username: "u",
    password: "p",
    fetchImpl: fakeFetch(200, { data: { values: rows } }, seen),
  });
  const r = await c.search("android", 3);
  assert.equal(r.available, true);
  if (!r.available) return;
  assert.equal(r.hits.length, 2);
  assert.equal(r.hits[0]!.snippet.length, 300);
  assert.equal(r.hits[0]!.untrusted, true);
  assert.equal(r.hits[1]!.links, 0);
  assert.match(String((seen.init!.headers as Record<string, string>).Authorization), /^Basic /);
  assert.deepEqual(JSON.parse(String(seen.init!.body)).parameters, { q: "android", k: 3 });
});

test("GraphClient never throws: bad auth, server error, junk and timeouts map to unavailable", async () => {
  const mk = (f: typeof fetch) =>
    new GraphClient({ queryUrl: "http://x", username: "u", password: "p", fetchImpl: f, timeoutMs: 50 });
  assert.deepEqual(await mk(fakeFetch(401, {})).search("q"), { available: false, reason: "unauthorized" });
  assert.deepEqual(await mk(fakeFetch(500, {})).search("q"), { available: false, reason: "error" });
  assert.deepEqual(await mk(fakeFetch(200, { nope: 1 })).search("q"), { available: false, reason: "error" });
  const down = (async () => {
    throw new Error("down");
  }) as unknown as typeof fetch;
  assert.deepEqual(await mk(down).search("q"), { available: false, reason: "unreachable" });
});

test("GraphClient.fromEnv maps bolt-style URIs and requires credentials", () => {
  assert.equal(GraphClient.fromEnv({}), null);
  assert.equal(GraphClient.fromEnv({ NEO4J_URI: "neo4j+s://a.databases.neo4j.io", NEO4J_USERNAME: "u" }), null);
  assert.equal(GraphClient.fromEnv({ NEO4J_URI: "garbage", NEO4J_USERNAME: "u", NEO4J_PASSWORD: "p" }), null);
  assert.ok(GraphClient.fromEnv({ NEO4J_URI: "bolt://localhost:7687", NEO4J_USERNAME: "u", NEO4J_PASSWORD: "p" }));
});
