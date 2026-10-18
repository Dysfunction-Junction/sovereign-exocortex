import test from "node:test";
import assert from "node:assert/strict";
import { Neo4jSyncService, labelForType, safeRelType } from "./neo4j-sync.js";
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

  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (url, init) => {
      if (String(url).includes("/db/neo4j/tx/commit")) {
        return {
          ok: true,
          json: async () => ({ results: [], errors: [] }),
        } as Response;
      }
      return origFetch(url, init);
    }) as typeof fetch;

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
    globalThis.fetch = origFetch;
    server.close();
    setDatabase(null);
  }
});

test("Neo4jSyncService labelForType & safeRelType: prevents Cypher syntax errors and injection", () => {
  // Allowlisted types mapped cleanly to PascalCase
  assert.equal(labelForType("person"), "Person");
  assert.equal(labelForType("PROJECT"), "Project");
  assert.equal(labelForType("routine"), "Routine");
  assert.equal(labelForType("context_state"), "ContextState");

  // Non-allowlisted types sanitized as valid Cypher identifiers starting with ASCII letter
  assert.equal(labelForType("CustomType"), "CustomType");
  assert.equal(labelForType("123Numeric"), "Type_123Numeric");
  assert.equal(labelForType("3D_MODEL"), "Type_3D_MODEL");
  assert.equal(labelForType("a`b; DROP n;"), "a_b__DROP_n_");
  assert.equal(labelForType(""), "Generic");
  assert.equal(labelForType(null), "Generic");
  assert.equal(labelForType(undefined), "Generic");

  // safeRelType validation
  assert.equal(safeRelType("WORKS_ON"), "WORKS_ON");
  assert.equal(safeRelType("RELATED"), "RELATED");
  assert.equal(safeRelType("lower_case"), "RELATED");
  assert.equal(safeRelType("123_INVALID"), "RELATED");
  assert.equal(safeRelType("REL`DROP"), "RELATED");
  assert.equal(safeRelType(null), "RELATED");
});

test("GET /v3/world-model/neo4j/analytics enforces scope and returns computed metrics", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  db.registerDevice(deviceRow("dev_admin_read", ["admin:read"]));
  db.registerDevice(deviceRow("dev_plain_user", ["telemetry:write"]));
  setDatabase(db);
  const port = await listen();

  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (url, init) => {
      if (String(url).includes("/db/neo4j/tx/commit")) {
        return {
          ok: true,
          json: async () => ({
            results: [
              { data: [{ row: [763] }] },
              { data: [{ row: [2102] }] },
              { data: [{ row: ["person_michael", "Michael", "PERSON", 194] }] },
              { data: [{ row: ["person_ana", "Ana", "PERSON", 1777972800000] }] },
              { data: [{ row: ["TOPIC", 602] }] },
              { data: [{ row: ["HAS_TOPIC", 952] }] },
            ],
            errors: [],
          }),
        } as Response;
      }
      return origFetch(url, init);
    }) as typeof fetch;

    // 1. Missing scope -> 403
    const userRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/neo4j/analytics`, {
      headers: { Authorization: `Bearer ${issueToken("dev_plain_user", TEST_SECRET)}` },
    });
    assert.equal(userRes.status, 403);

    // 2. Admin read -> 200 with analytics
    const adminRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/neo4j/analytics`, {
      headers: { Authorization: `Bearer ${issueToken("dev_admin_read", TEST_SECRET)}` },
    });
    assert.equal(adminRes.status, 200);
    const data = await adminRes.json();
    assert.equal(data.ok, true);
    assert.equal(data.analytics.nodeCount, 763);
    assert.equal(data.analytics.edgeCount, 2102);
    assert.equal(data.analytics.hubs[0].id, "person_michael");
    assert.equal(data.analytics.hubs[0].degree, 194);
    assert.equal(data.analytics.staleEntities[0].id, "person_ana");
  } finally {
    globalThis.fetch = origFetch;
    server.close();
    setDatabase(null);
  }
});

test("POST /v3/world-model/neo4j/query enforces read-only safety and handles NL & Cypher", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  db.registerDevice(deviceRow("dev_admin_read", ["admin:read"]));
  setDatabase(db);
  const port = await listen();

  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (url, init) => {
      if (String(url).includes("/db/neo4j/tx/commit")) {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                columns: ["id", "label", "type", "degree"],
                data: [{ row: ["project_sovereign_exocortex", "Sovereign Exocortex", "PROJECT", 42] }],
              },
            ],
            errors: [],
          }),
        } as Response;
      }
      return origFetch(url, init);
    }) as typeof fetch;

    // 1. Rejects dangerous mutations in Cypher mode with HTTP 400
    const mutationRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/neo4j/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issueToken("dev_admin_read", TEST_SECRET)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "MATCH (n) DETACH DELETE n", mode: "cypher" }),
    });
    assert.equal(mutationRes.status, 400);
    const mutData = await mutationRes.json();
    assert.ok(mutData.error.includes("Forbidden operation"));

    // 1b. Rejects comment-obfuscated mutations and CALL statements with HTTP 400
    const obfuscatedRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/neo4j/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issueToken("dev_admin_read", TEST_SECRET)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "MATCH (n) /* hide */ DETACH // delete\nDELETE n", mode: "cypher" }),
    });
    assert.equal(obfuscatedRes.status, 400);

    const callRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/neo4j/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issueToken("dev_admin_read", TEST_SECRET)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "CALL apoc.warmup.run()", mode: "cypher" }),
    });
    assert.equal(callRes.status, 400);

    // 1c. Rejects invalid mode with HTTP 400
    const badModeRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/neo4j/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issueToken("dev_admin_read", TEST_SECRET)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "MATCH (n) RETURN n", mode: "sql" }),
    });
    assert.equal(badModeRes.status, 400);

    // 2. Executes valid read-only Cypher (including keyword inside string literal)
    const cypherRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/neo4j/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issueToken("dev_admin_read", TEST_SECRET)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "MATCH (n:Project) WHERE n.name = 'SET_OF_RULES' RETURN n.id, n.label", mode: "cypher" }),
    });
    assert.equal(cypherRes.status, 200);
    const cypherData = await cypherRes.json();
    assert.equal(cypherData.ok, true);
    assert.equal(cypherData.result.rows[0].id, "project_sovereign_exocortex");

    // 3. Executes Natural Language query
    const nlRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/neo4j/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issueToken("dev_admin_read", TEST_SECRET)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "show me projects", mode: "nl" }),
    });
    assert.equal(nlRes.status, 200);
    const nlData = await nlRes.json();
    assert.equal(nlData.ok, true);
    assert.equal(nlData.result.mode, "nl");
    assert.ok(nlData.result.matchedEntityIds.includes("project_sovereign_exocortex"));
  } finally {
    globalThis.fetch = origFetch;
    server.close();
    setDatabase(null);
  }
});
