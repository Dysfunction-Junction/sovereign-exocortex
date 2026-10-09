import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createGatewayApp } from "../src/server.js";
import { PiecesClient, assertLocalPiecesRoute } from "../src/pieces.js";
import { OpenRouterClient } from "../src/openrouter.js";
import { parseDistilledMemories } from "../src/memories.js";
import type { ReasoningClient } from "../src/reasoning.js";

test("local route guard refuses qgpt", () => {
  assert.throws(() => assertLocalPiecesRoute("/qgpt/question"), /qgpt/);
  assert.doesNotThrow(() => assertLocalPiecesRoute("/assets/create?transferables=false"));
  assert.doesNotThrow(() => assertLocalPiecesRoute("/workstream_events/identifiers?limit=12"));
});

test("parseDistilledMemories reads a JSON array and drops incomplete items", () => {
  const answer = "Here you go:\n[{\"title\":\"Proxy fix\",\"body\":\"Updated the socket timeout.\"},{\"title\":\"\"}]";
  const memories = parseDistilledMemories(answer);
  assert.equal(memories.length, 1);
  assert.equal(memories[0]?.title, "Proxy fix");
});

test("PiecesClient.createAsset posts to the local asset route", async () => {
  let createBody = "";
  const fetchFn: typeof fetch = async (url, init) => {
    const urlStr = String(url);
    assert.equal(urlStr.includes("/qgpt"), false);
    if (urlStr.endsWith("/applications")) {
      return new Response(JSON.stringify({
        iterable: [{
          id: "cli-app",
          name: "PIECES_FOR_DEVELOPERS_CLI",
          platform: "WINDOWS",
          version: "5.0.0",
          onboarded: false,
          privacy: "OPEN",
        }],
      }), { status: 200 });
    }
    if (urlStr.includes("/assets/create")) {
      createBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ id: "asset-9" }), { status: 200 });
    }
    return new Response("no", { status: 404 });
  };

  const pieces = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn });
  const saved = await pieces.createAsset({ name: "Proxy fix", content: "Updated the socket timeout." });
  assert.equal(saved.ok, true);
  if (saved.ok) assert.equal(saved.id, "asset-9");
  const payload = JSON.parse(createBody) as { type: string; asset: { metadata: { name: string } } };
  assert.equal(payload.type, "SEEDED_ASSET");
  assert.equal(payload.asset.metadata.name, "Proxy fix");
});

test("POST /memorize distills local capture, logs it, and saves through /assets/create", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pieces-memories-"));
  const logPath = join(dir, "memories.jsonl");
  const fetchFn: typeof fetch = async (url, init) => {
    const urlStr = String(url);
    assert.equal(urlStr.includes("/qgpt"), false);
    if (urlStr.endsWith("/.well-known/health")) return new Response("ok:test", { status: 200 });
    if (urlStr.endsWith("/.well-known/version")) return new Response("12.6.2", { status: 200 });
    if (urlStr.includes("/workstream_events/identifiers")) {
      return new Response(JSON.stringify({ iterable: [{ id: "evt-1" }] }), { status: 200 });
    }
    if (urlStr.includes("/workstream_events/batch/fetch")) {
      return new Response(JSON.stringify({
        workstreamEvents: {
          iterable: [{ id: "evt-1", readable: "Edited apps/proxy/src/server.ts", created: { value: "2026-10-06T12:00:00.000Z" } }],
        },
      }), { status: 200 });
    }
    if (urlStr.endsWith("/applications")) {
      return new Response(JSON.stringify({
        iterable: [{ id: "cli-app", name: "PIECES_FOR_DEVELOPERS_CLI", platform: "WINDOWS", version: "5.0.0", onboarded: false, privacy: "OPEN" }],
      }), { status: 200 });
    }
    if (urlStr.includes("/assets/create")) {
      assert.match(String(init?.body), /Proxy timeout/);
      return new Response(JSON.stringify({ id: "asset-saved" }), { status: 200 });
    }
    return new Response("no", { status: 404 });
  };

  const reasoning: ReasoningClient = {
    provider: "claude",
    billing: "subscription",
    hasCredentials: () => true,
    getModel: () => "claude-subscription",
    chat: async () => ({
      id: "mem-1",
      content: "[{\"title\":\"Proxy timeout\",\"body\":\"The proxy socket timeout was updated.\"}]",
      model: "claude-subscription",
    }),
  };

  const pieces = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn });
  const app = createGatewayApp({
    piecesClient: pieces,
    openRouterClient: new OpenRouterClient({ apiKey: "" }),
    reasoningClient: reasoning,
    memoryLogPath: logPath,
    saveMemoriesToPieces: true,
  });
  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));

  try {
    const port = (srv.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/memorize`, { method: "POST" });
    const body = await res.json() as { logged: number; piecesSaved: number; qgpt: boolean; memories: Array<{ assetId?: string }> };
    assert.equal(res.status, 200);
    assert.equal(body.logged, 1);
    assert.equal(body.piecesSaved, 1);
    assert.equal(body.qgpt, false);
    assert.equal(body.memories[0]?.assetId, "asset-saved");
    const log = await readFile(logPath, "utf8");
    assert.match(log, /Proxy timeout/);
  } finally {
    srv.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("PiecesClient.createAsset does not retry after the caller aborted", async () => {
  const controller = new AbortController();
  let createCalls = 0;
  const fetchFn: typeof fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.endsWith("/applications")) {
      return new Response(JSON.stringify({
        iterable: [{ id: "cli-app", name: "PIECES_FOR_DEVELOPERS_CLI" }],
      }), { status: 200 });
    }
    if (urlStr.includes("/assets/create")) {
      createCalls++;
      controller.abort();
      throw new Error("This operation was aborted");
    }
    return new Response("no", { status: 404 });
  };
  const pieces = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn });
  const saved = await pieces.createAsset({ name: "x", content: "y" }, { signal: controller.signal });
  assert.equal(saved.ok, false);
  assert.equal(createCalls, 1);
});
