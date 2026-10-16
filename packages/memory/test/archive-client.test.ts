import "./setup-ltm.js"; // must stay first: redirects memory.add away from the tracked data file
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchiveClient, archiveLocalMemoriesToRemote } from "../archive-client.js";
import { createGatewayApp } from "../server.js";
import { PiecesClient } from "../pieces.js";
import { OpenRouterClient } from "../openrouter.js";

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

test("ArchiveClient.health reports counts or mapped failures", async () => {
  const c = new ArchiveClient({
    baseUrl: "http://x",
    token: "tok",
    fetchImpl: fakeFetch(200, { ok: true, items: 14318, chunks: 21921, blobs: 12645 }),
  });
  const res = await c.health();
  assert.deepEqual(res, { available: true, items: 14318, chunks: 21921, blobs: 12645 });

  const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  const downClient = new ArchiveClient({ baseUrl: "http://x", token: "tok", fetchImpl: down });
  assert.deepEqual(await downClient.health(), { available: false, reason: "locked-or-unreachable" });
});

test("ArchiveClient.ingestText posts correctly and handles responses", async () => {
  const seen: Array<{ url: string; auth: string | null; body: string }> = [];
  const c = new ArchiveClient({
    baseUrl: "https://bank.example/",
    token: "tok-456",
    fetchImpl: fakeFetch(200, { itemId: "item-123", existed: false, chunks: 1, vectors: 1, blobId: "blob-123" }, seen),
  });
  const res = await c.ingestText({ source: "ltm", kind: "memory", title: "Note", text: "Note content" });
  assert.deepEqual(res, { ok: true, itemId: "item-123", existed: false, chunks: 1, vectors: 1, blobId: "blob-123" });
  assert.equal(seen[0].url, "https://bank.example/ingest/text");
  assert.equal(seen[0].auth, "Bearer tok-456");
  assert.deepEqual(JSON.parse(seen[0].body), { source: "ltm", kind: "memory", title: "Note", text: "Note content" });
});

test("archiveLocalMemoriesToRemote archives memories older than threshold and prunes with backup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "archive-remote-test-"));
  const file = join(dir, "memories.jsonl");
  const now = Date.parse("2026-10-15T00:00:00.000Z");
  const oldDate = new Date(now - 100 * 86_400_000).toISOString();
  const recentDate = new Date(now - 10 * 86_400_000).toISOString();

  const lines = [
    JSON.stringify({ title: "Old 1", body: "Old text 1", createdAt: oldDate, source: "test" }),
    JSON.stringify({ title: "Recent", body: "Recent text", createdAt: recentDate, source: "test" }),
    "not-json-line",
    JSON.stringify({ title: "Old 2", body: "Old text 2", createdAt: oldDate, source: "test" }),
  ];
  await writeFile(file, lines.join("\n") + "\n");

  const ingested: string[] = [];
  const c = new ArchiveClient({
    baseUrl: "http://x",
    token: "tok",
    fetchImpl: (async (_url: string, init?: { body?: string }) => {
      const b = JSON.parse(String(init?.body));
      ingested.push(b.title);
      return new Response(JSON.stringify({ itemId: `id-${b.title}`, existed: false, chunks: 1, vectors: 1 }), { status: 200 });
    }) as unknown as typeof fetch,
  });

  const res = await archiveLocalMemoriesToRemote(c, file, { olderThanDays: 90, prune: true, now });
  assert.equal(res.scanned, 3);
  assert.equal(res.archived, 2);
  assert.equal(res.kept, 2);
  assert.equal(res.pruned, true);
  assert.ok(res.backup);

  // Check remaining lines
  const remaining = (await readFile(file, "utf8")).trim().split("\n");
  assert.equal(remaining.length, 2);
  assert.ok(remaining[0].includes("Recent text"));
  assert.equal(remaining[1], "not-json-line");

  // Check backup exists and has all original content
  const backupContent = await readFile(res.backup!, "utf8");
  assert.equal(backupContent, lines.join("\n") + "\n");

  await rm(dir, { recursive: true, force: true });
});

