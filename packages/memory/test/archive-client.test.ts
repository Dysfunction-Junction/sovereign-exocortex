import "./setup-ltm.js"; // must stay first: redirects memory.add away from the tracked data file
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { ArchiveClient } from "../src/archive-client.js";
import { createGatewayApp } from "../src/server.js";
import { PiecesClient } from "../src/pieces.js";
import { OpenRouterClient } from "../src/openrouter.js";

const hit = (extra: Record<string, unknown> = {}) => ({
  itemId: "a".repeat(32), score: 0.8123, kind: "photo", source: "oldpc", title: "IMG_1.jpg", path: "Trip/IMG_1.jpg", ts: 5, snippet: "x".repeat(900), ...extra,
});

function fakeFetch(status: number, body: unknown, seen: Array<{ url: string; auth: string | null; body: string }> = []): typeof fetch {
  return (async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    seen.push({ url: String(url), auth: init?.headers?.Authorization ?? null, body: String(init?.body) });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

test("ArchiveClient returns untrusted, clipped hits and sends the bearer token", async () => {
  const seen: Array<{ url: string; auth: string | null; body: string }> = [];
  const c = new ArchiveClient({ baseUrl: "https://bank.example/", token: "tok-123", fetchImpl: fakeFetch(200, { hits: [hit(), { bogus: true }] }, seen) });
  const r = await c.search("beach trip", 3);
  assert.equal(r.available, true);
  if (!r.available) return;
  assert.equal(r.hits.length, 1, "malformed hits are dropped");
  assert.equal(r.hits[0].untrusted, true);
  assert.equal(r.hits[0].score, 0.81);
  assert.equal(r.hits[0].snippet.length, 300);
  assert.equal(seen[0].url, "https://bank.example/search");
  assert.equal(seen[0].auth, "Bearer tok-123");
  assert.deepEqual(JSON.parse(seen[0].body), { q: "beach trip", k: 3 });
});

test("ArchiveClient never throws: locked, wrong token, server error, junk and timeouts all map to unavailable", async () => {
  const refused = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  const hang = ((_u: string, init?: { signal?: AbortSignal }) =>
    new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("timeout", "TimeoutError"))))) as unknown as typeof fetch;
  const cases: Array<[typeof fetch, string]> = [
    [refused, "locked-or-unreachable"],
    [fakeFetch(401, { error: "unauthorized" }), "unauthorized"],
    [fakeFetch(500, {}), "error"],
    [fakeFetch(200, { nothits: 1 }), "error"],
    [hang, "locked-or-unreachable"],
  ];
  for (const [fetchImpl, reason] of cases) {
    const r = await new ArchiveClient({ baseUrl: "http://x", token: "t", fetchImpl, timeoutMs: 50 }).search("q");
    assert.deepEqual(r, { available: false, reason });
  }
});

test("ArchiveClient.fromEnv needs both settings and a valid URL", () => {
  assert.equal(ArchiveClient.fromEnv({}), null);
  assert.equal(ArchiveClient.fromEnv({ DATABANK_URL: "https://x" }), null);
  assert.equal(ArchiveClient.fromEnv({ DATABANK_URL: "not a url", DATABANK_TOKEN: "t" }), null);
  assert.ok(ArchiveClient.fromEnv({ DATABANK_URL: "https://x", DATABANK_TOKEN: "t" }));
});

function searchVia(client: ArchiveClient | null): Promise<{ status: number; body: any }> {
  const app = createGatewayApp({
    piecesClient: new PiecesClient({ baseUrl: "http://127.0.0.1:39300" }),
    openRouterClient: new OpenRouterClient({ apiKey: "" }),
    archiveClient: client,
  });
  const srv = createServer(app.handleRequest);
  return new Promise((resolve, reject) => {
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      const data = JSON.stringify({
        v: 1, id: "arch-1", from: "pieces-android-companion-seamless", to: "pieces-for-all", capability: "memory", action: "memory",
        payload: { action: "search", query: "beach trip", limit: 3 },
      });
      const req = request({ host: "127.0.0.1", port, method: "POST", path: "/mishmash/delegate", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { srv.close(); resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); });
      });
      req.on("error", (e) => { srv.close(); reject(e); });
      req.end(data);
    });
  });
}

test("memory.search adds archive matches next to local ones", async () => {
  const r = await searchVia(new ArchiveClient({ baseUrl: "http://x", token: "t", fetchImpl: fakeFetch(200, { hits: [hit()] }) }));
  assert.equal(r.status, 200);
  assert.equal(r.body.result.status, "searched");
  assert.ok(Array.isArray(r.body.result.matches));
  assert.equal(r.body.result.archive.available, true);
  assert.equal(r.body.result.archive.hits[0].title, "IMG_1.jpg");
  assert.equal(r.body.result.archive.hits[0].untrusted, true);
});

test("memory.search still answers locally when the vault is locked", async () => {
  const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  const r = await searchVia(new ArchiveClient({ baseUrl: "http://x", token: "t", fetchImpl: down }));
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.result.matches));
  assert.deepEqual(r.body.result.archive, { available: false, reason: "locked-or-unreachable" });
});

test("memory.search response is unchanged when no archive is configured", async () => {
  const r = await searchVia(null);
  assert.equal(r.status, 200);
  assert.equal("archive" in r.body.result, false);
});
