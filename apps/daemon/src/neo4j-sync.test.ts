import test from "node:test";
import assert from "node:assert/strict";
import { Neo4jSyncService } from "./neo4j-sync.js";
import { issueToken } from "./jwt.js";
import { setDatabase } from "./db-host.js";
import { ExocortexDatabase } from "@exocortex/core/db";
import { WorldModelHost } from "./world-model-host.js";

const TEST_SECRET = "test-neo4j-jwt-secret-123";
process.env.GATEWAY_JWT_SECRET = TEST_SECRET;
process.env.NODE_ENV = "test";

const { server } = await import("./server.js");

function deviceRow(id: string, scopes: string[]) {
  return {
    device_id: id,
    name: id,
    platform: "windows" as const,
    pubkey_spki: new Uint8Array([0]),
    key_attested: 0,
    scopes,
    enrolled_at: Date.now(),
    revoked_at: null,
  };
}

async function listen(): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const a = server.address();
  return typeof a === "object" && a ? a.port : 0;
}

test("Neo4jSyncService: checkHealth parses node and edge counts from Cypher response", async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      return {
        ok: true,
        json: async () => ({
          results: [
            { data: [{ row: [763] }] },
            { data: [{ row: [1453] }] },
          ],
          errors: [],
        }),
      } as Response;
    }) as typeof fetch;

    const sync = new Neo4jSyncService({
      url: "http://127.0.0.1:7474",
      user: "neo4j",
      password: "secretpassword",
    });

    const ok = await sync.checkHealth();
    assert.equal(ok, true);
    const status = sync.getStatus();
    assert.equal(status.connected, true);
    assert.equal(status.nodeCount, 763);
    assert.equal(status.edgeCount, 1453);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("Neo4jSyncService: syncGraph sends chunked Cypher MERGE statements with Basic auth", async () => {
  const origFetch = globalThis.fetch;
  const capturedRequests: Array<{ url: string; headers: HeadersInit; body: string }> = [];

  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedRequests.push({
        url: String(input),
        headers: (init?.headers ?? {}) as HeadersInit,
        body: String(init?.body ?? ""),
      });
      return {
        ok: true,
        json: async () => ({ results: [], errors: [] }),
      } as Response;
    }) as typeof fetch;

    const sync = new Neo4jSyncService({
      url: "http://127.0.0.1:7474",
      user: "neo4j",
      password: "codecode",
      batchSize: 2,
    });

    const result = await sync.syncGraph({
      entities: [
        { id: "e1", type: "PERSON", name: "Alpha", activation: 1, lastActive: 100 },
        { id: "e2", type: "PROJECT", name: "Beta", activation: 0.8, lastActive: 200 },
        { id: "e3", type: "TOPIC", name: "Gamma", activation: 0.5, lastActive: 300 },
      ],
      edges: [
        { id: "ed1", sourceId: "e1", targetId: "e2", relation: "WORKS_ON", weight: 1, observedCount: 1, lastObserved: 100 },
      ],
    });

    assert.equal(result.entities, 3);
    assert.equal(result.edges, 1);
    assert.ok(capturedRequests.length >= 3); // schema + 2 entity chunks + 1 edge chunk

    const first = capturedRequests[0];
    assert.ok(String(first.url).includes("/db/neo4j/tx/commit"));
    assert.equal((first.headers as Record<string, string>)["Authorization"], `Basic ${Buffer.from("neo4j:codecode").toString("base64")}`);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("GET /v3/world-model/neo4j/status enforces scope and returns status", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  db.registerDevice(deviceRow("dev_admin_read", ["admin:read"]));
  db.registerDevice(deviceRow("dev_plain_user", ["telemetry:write"]));
  setDatabase(db);
  const port = await listen();

  try {
    // 1. Missing scope -> 403
    const userRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/neo4j/status`, {
      headers: { Authorization: `Bearer ${issueToken("dev_plain_user", TEST_SECRET)}` },
    });
    assert.equal(userRes.status, 403);

    // 2. Admin read -> 200
    const adminRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/neo4j/status`, {
      headers: { Authorization: `Bearer ${issueToken("dev_admin_read", TEST_SECRET)}` },
    });
    assert.equal(adminRes.status, 200);
    const data = await adminRes.json();
    assert.equal(data.ok, true);
    assert.ok("connected" in data);
    assert.ok("nodeCount" in data);
  } finally {
    server.close();
    setDatabase(null);
  }
});

test("POST /v3/world-model/neo4j/sync enforces admin:write scope", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  db.registerDevice(deviceRow("dev_admin_read", ["admin:read"]));
  db.registerDevice(deviceRow("dev_admin_write", ["admin:write"]));
  setDatabase(db);
  const port = await listen();

  try {
    // 1. Read-only admin cannot trigger sync -> 403
    const readRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/neo4j/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${issueToken("dev_admin_read", TEST_SECRET)}` },
    });
    assert.equal(readRes.status, 403);

    // 2. Write admin can trigger sync -> 200
    const writeRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/neo4j/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${issueToken("dev_admin_write", TEST_SECRET)}` },
    });
    assert.equal(writeRes.status, 200);
    const data = await writeRes.json();
    assert.equal(data.ok, true);
    assert.ok("result" in data);
  } finally {
    server.close();
    setDatabase(null);
  }
});
