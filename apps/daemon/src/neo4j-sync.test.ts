import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Neo4jSyncService, labelForType, safeRelType } from "./neo4j-sync.js";
import { issueToken } from "./jwt.js";
import { setDatabase } from "./db-host.js";
import { ExocortexDatabase } from "@exocortex/core/db";
import { HOST_DEVICE_ID } from "@exocortex/core";
import { defaultWorldModelHost } from "./world-model-host.js";
import { ShadowRecorder } from "./shadow-recorder.js";

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

/**
 * Records any outbound Neo4j HTTP calls (even if swallowed by a try/catch) so tests can
 * assert `neo4jCalls` is empty after route execution.
 */
function captureNeo4jHttp(origFetch: typeof fetch): { wrapper: typeof fetch; neo4jCalls: string[] } {
  const neo4jCalls: string[] = [];
  const wrapper = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (/\/db\/[^/]+\/(tx\/commit|query\/v2)|:7474(?!\d)/.test(urlStr)) {
      neo4jCalls.push(urlStr);
      return new Response("{}", { status: 599 });
    }
    return origFetch(input, init);
  }) as typeof fetch;
  return { wrapper, neo4jCalls };
}

test("Phase 3.3 cutover: server.ts contains zero imports or attachToHost wiring for Neo4jSyncService", () => {
  const serverPath = resolve(dirname(fileURLToPath(import.meta.url)), "./server.ts");
  const serverSource = readFileSync(serverPath, "utf8");
  assert.doesNotMatch(serverSource, /defaultNeo4jSyncService|neo4j-sync/);
  assert.doesNotMatch(serverSource, /attachToHost\s*\(\s*defaultWorldModelHost\s*\)/);
});

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
    assert.ok(capturedRequests.length >= 3);

    const first = capturedRequests[0];
    assert.ok(String(first.url).includes("/db/neo4j/tx/commit"));
    assert.equal((first.headers as Record<string, string>)["Authorization"], `Basic ${Buffer.from("neo4j:codecode").toString("base64")}`);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("Neo4jSyncService: syncGraph only upserts, so curated vocab topics and HAS_TOPIC links survive (P0-G4)", async () => {
  const origFetch = globalThis.fetch;
  const statements: string[] = [];
  try {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { statements?: Array<{ statement: string }> };
      for (const s of body.statements ?? []) statements.push(s.statement);
      return { ok: true, json: async () => ({ results: [], errors: [] }) } as Response;
    }) as typeof fetch;

    const sync = new Neo4jSyncService({ url: "http://127.0.0.1:7474", user: "neo4j", password: "x" });
    await sync.syncGraph({
      entities: [
        { id: "topic_typescript", type: "TOPIC", name: "typescript", activation: 0.4, lastActive: 100 },
        { id: "person_michael_hebert", type: "PERSON", name: "Michael", activation: 1, lastActive: 100 },
        { id: "doc_a", type: "DOC", name: "Doc A", activation: 1, lastActive: 100 },
      ],
      edges: [
        { id: "doc_a:HAS_TOPIC:topic_typescript", sourceId: "doc_a", targetId: "topic_typescript", relation: "HAS_TOPIC", weight: 0.8, observedCount: 1, lastObserved: 100 },
      ],
    });

    assert.ok(statements.length > 0);
    for (const s of statements) {
      assert.doesNotMatch(s, /\b(DELETE|DETACH|REMOVE|DROP)\b/i, `syncGraph sent a destructive statement: ${s}`);
      assert.doesNotMatch(s, /\bSET\s+[nr]\s*=/i, `syncGraph replaces properties: ${s}`);
    }
    const entityUpserts = statements.filter((s) => s.includes("MERGE (n:Entity {id: $id})"));
    assert.equal(entityUpserts.length, 3);
    for (const s of entityUpserts) {
      assert.match(s, /SET n:\w+, n \+= \{\s*activation: \$activation,\s*lastActive: \$lastActive,\s*propertiesJson: \$propertiesJson\s*\}/);
      assert.match(s, /WITH n\s+WHERE n\.vocab IS NULL AND n\.source IS NULL\s+SET n\.name = \$name, n\.type = \$type/);
    }
    assert.ok(statements.some((s) => /MERGE \(a\)-\[r:HAS_TOPIC \{id: \$id\}\]->\(b\)[\s\S]*SET r \+= \{/.test(s)));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("Neo4jSyncService labelForType & safeRelType: prevents Cypher syntax errors and injection", () => {
  assert.equal(labelForType("person"), "Person");
  assert.equal(labelForType("PROJECT"), "Project");
  assert.equal(labelForType("routine"), "Routine");
  assert.equal(labelForType("context_state"), "ContextState");

  assert.equal(labelForType("CustomType"), "CustomType");
  assert.equal(labelForType("123Numeric"), "Type_123Numeric");
  assert.equal(labelForType("3D_MODEL"), "Type_3D_MODEL");
  assert.equal(labelForType("a`b; DROP n;"), "a_b__DROP_n_");
  assert.equal(labelForType(""), "Generic");
  assert.equal(labelForType(null), "Generic");
  assert.equal(labelForType(undefined), "Generic");

  assert.equal(safeRelType("WORKS_ON"), "WORKS_ON");
  assert.equal(safeRelType("RELATED"), "RELATED");
  assert.equal(safeRelType("lower_case"), "RELATED");
  assert.equal(safeRelType("123_INVALID"), "RELATED");
  assert.equal(safeRelType("REL`DROP"), "RELATED");
  assert.equal(safeRelType(null), "RELATED");
});

test("GET /v3/world-model/{graph,neo4j}/status enforces scope and serves identical GraphStore status with zero Neo4j calls", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  db.registerDevice(deviceRow("dev_admin_read", ["admin:read"]));
  db.registerDevice(deviceRow("dev_plain_user", ["telemetry:write"]));
  setDatabase(db);
  const port = await listen();

  const origFetch = globalThis.fetch;
  const { wrapper, neo4jCalls } = captureNeo4jHttp(origFetch);
  try {
    globalThis.fetch = wrapper;

    for (const prefix of ["graph", "neo4j"] as const) {
      const userRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/${prefix}/status`, {
        headers: { Authorization: `Bearer ${issueToken("dev_plain_user", TEST_SECRET)}` },
      });
      assert.equal(userRes.status, 403);
    }

    const graphRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/graph/status`, {
      headers: { Authorization: `Bearer ${issueToken("dev_admin_read", TEST_SECRET)}` },
    });
    const aliasRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/neo4j/status`, {
      headers: { Authorization: `Bearer ${issueToken("dev_admin_read", TEST_SECRET)}` },
    });
    assert.equal(graphRes.status, 200);
    assert.equal(aliasRes.status, 200);

    const graphData = await graphRes.json();
    const aliasData = await aliasRes.json();
    assert.deepEqual(graphData, aliasData);
    assert.equal(graphData.ok, true);
    assert.equal(graphData.connected, true);
    assert.equal(graphData.serving, true);
    assert.equal(graphData.nodeCount, defaultWorldModelHost.lifeGraph.entityCount);
    assert.equal(graphData.edgeCount, defaultWorldModelHost.lifeGraph.edgeCount);
  } finally {
    globalThis.fetch = origFetch;
    server.close();
    setDatabase(null);
  }
  assert.deepEqual(neo4jCalls, []);
});

test("POST /v3/world-model/{graph,neo4j}/sync enforces admin:write scope and reports boot-rebuild status without Neo4j calls", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  db.registerDevice(deviceRow("dev_admin_read", ["admin:read"]));
  db.registerDevice(deviceRow("dev_admin_write", ["admin:write"]));
  setDatabase(db);
  const port = await listen();

  const origFetch = globalThis.fetch;
  const { wrapper, neo4jCalls } = captureNeo4jHttp(origFetch);
  try {
    globalThis.fetch = wrapper;

    for (const prefix of ["graph", "neo4j"] as const) {
      const readRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/${prefix}/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${issueToken("dev_admin_read", TEST_SECRET)}` },
      });
      assert.equal(readRes.status, 403);

      const writeRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/${prefix}/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${issueToken("dev_admin_write", TEST_SECRET)}` },
      });
      assert.equal(writeRes.status, 200);
      const data = await writeRes.json();
      assert.equal(data.ok, true);
      assert.equal(data.connected, true);
      assert.match(String(data.message), /rebuilt.*boot/i);
      assert.equal(data.result.entities, defaultWorldModelHost.lifeGraph.entityCount);
      assert.equal(data.result.edges, defaultWorldModelHost.lifeGraph.edgeCount);
      assert.equal(data.status.ok, true);
      assert.equal(data.status.connected, true);
      assert.equal(data.status.nodeCount, defaultWorldModelHost.lifeGraph.entityCount);
    }
  } finally {
    globalThis.fetch = origFetch;
    server.close();
    setDatabase(null);
  }
  assert.deepEqual(neo4jCalls, []);
});

test("GET /v3/world-model/{graph,neo4j}/analytics enforces scope and returns in-memory GraphStore analytics", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  db.registerDevice(deviceRow("dev_admin_read", ["admin:read"]));
  db.registerDevice(deviceRow("dev_plain_user", ["telemetry:write"]));
  setDatabase(db);
  const port = await listen();

  const origFetch = globalThis.fetch;
  const { wrapper, neo4jCalls } = captureNeo4jHttp(origFetch);
  try {
    globalThis.fetch = wrapper;

    for (const prefix of ["graph", "neo4j"] as const) {
      const userRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/${prefix}/analytics`, {
        headers: { Authorization: `Bearer ${issueToken("dev_plain_user", TEST_SECRET)}` },
      });
      assert.equal(userRes.status, 403);
    }

    const graphRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/graph/analytics`, {
      headers: { Authorization: `Bearer ${issueToken("dev_admin_read", TEST_SECRET)}` },
    });
    const aliasRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/neo4j/analytics`, {
      headers: { Authorization: `Bearer ${issueToken("dev_admin_read", TEST_SECRET)}` },
    });
    assert.equal(graphRes.status, 200);
    assert.equal(aliasRes.status, 200);

    const graphData = await graphRes.json();
    const aliasData = await aliasRes.json();
    assert.equal(graphData.ok, true);
    assert.equal(aliasData.ok, true);
    assert.equal(graphData.analytics.nodeCount, defaultWorldModelHost.lifeGraph.entityCount);
    assert.equal(graphData.analytics.edgeCount, defaultWorldModelHost.lifeGraph.edgeCount);
    assert.equal(aliasData.analytics.nodeCount, graphData.analytics.nodeCount);
    assert.equal(aliasData.analytics.edgeCount, graphData.analytics.edgeCount);
    assert.ok(Array.isArray(graphData.analytics.hubs));
    assert.ok(graphData.analytics.hubs.length > 0);
    assert.ok(Array.isArray(graphData.analytics.staleEntities));
    assert.ok(Array.isArray(graphData.analytics.typeDistribution));
    assert.ok(Array.isArray(graphData.analytics.edgeDistribution));
  } finally {
    globalThis.fetch = origFetch;
    server.close();
    setDatabase(null);
  }
  assert.deepEqual(neo4jCalls, []);
});

test("POST /v3/world-model/{graph,neo4j}/query rejects Cypher with 400 and serves NL queries from GraphStore", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  db.registerDevice(deviceRow("dev_admin_read", ["admin:read"]));
  db.registerDevice(deviceRow("dev_plain_user", ["telemetry:write"]));
  setDatabase(db);
  const port = await listen();

  const origFetch = globalThis.fetch;
  const { wrapper, neo4jCalls } = captureNeo4jHttp(origFetch);
  try {
    globalThis.fetch = wrapper;

    for (const prefix of ["graph", "neo4j"] as const) {
      // 1. Missing scope -> 403
      const userRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/${prefix}/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${issueToken("dev_plain_user", TEST_SECRET)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "show me projects", mode: "nl" }),
      });
      assert.equal(userRes.status, 403);

      // 2. Cypher mode is retired -> 400 with clear message (§6.1)
      const cypherRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/${prefix}/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${issueToken("dev_admin_read", TEST_SECRET)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "MATCH (n:Project) RETURN n.id, n.label", mode: "cypher" }),
      });
      assert.equal(cypherRes.status, 400);
      const cypherErr = await cypherRes.json();
      assert.match(String(cypherErr.error), /cypher.*retired/i);

      // 3. Invalid mode -> 400
      const badModeRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/${prefix}/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${issueToken("dev_admin_read", TEST_SECRET)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "SELECT * FROM nodes", mode: "sql" }),
      });
      assert.equal(badModeRes.status, 400);

      // 4. Empty query -> 400
      const emptyRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/${prefix}/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${issueToken("dev_admin_read", TEST_SECRET)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "   " }),
      });
      assert.equal(emptyRes.status, 400);

      // 5. Natural language query (both explicit mode: "nl" and default omitted mode) -> 200
      const nlRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/${prefix}/query`, {
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

      const defaultModeRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/${prefix}/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${issueToken("dev_admin_read", TEST_SECRET)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "sovereign exocortex" }),
      });
      assert.equal(defaultModeRes.status, 200);
      const defaultModeData = await defaultModeRes.json();
      assert.equal(defaultModeData.ok, true);
      assert.ok(defaultModeData.result.matchedEntityIds.includes("project_sovereign_exocortex"));
    }
  } finally {
    globalThis.fetch = origFetch;
    server.close();
    setDatabase(null);
  }
  assert.deepEqual(neo4jCalls, []);
});

test("world-model graph and neo4j alias routes return 503 with ok:false naming missing artifact hash when !graphServing", async () => {
  const brokenDb = new ExocortexDatabase({ path: ":memory:" });
  const cleanDb = new ExocortexDatabase({ path: ":memory:" });
  const missingSha = "ef".repeat(32);

  new ShadowRecorder(brokenDb).ensureHostDevice();
  brokenDb.registerDevice(deviceRow("dev_admin_all", ["admin:read", "admin:write"]));
  brokenDb.registerDevice(deviceRow("dev_plain_user", ["telemetry:write"]));
  const { event } = brokenDb.ingestEvent(HOST_DEVICE_ID, {
    event_id: "ev_missing_artifact_p3",
    kind: "curation_import",
    schema_ver: 1,
    ts_device: Date.now(),
    payload: {
      artifact_sha256: missingSha,
      media_type: "application/vnd.exocortex.vocabulary+json",
      count: 1,
    },
  });
  brokenDb.setConsumerCursor("world-model", event.seq);

  setDatabase(brokenDb);
  defaultWorldModelHost.rehydrate(brokenDb);
  assert.equal(defaultWorldModelHost.graphServing, false);

  const port = await listen();
  try {
    const adminToken = issueToken("dev_admin_all", TEST_SECRET);
    const plainToken = issueToken("dev_plain_user", TEST_SECRET);

    for (const prefix of ["graph", "neo4j"] as const) {
      // Scope check still runs before 503
      const unauthSync = await fetch(`http://127.0.0.1:${port}/v3/world-model/${prefix}/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${plainToken}` },
      });
      assert.equal(unauthSync.status, 403);

      const statusRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/${prefix}/status`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(statusRes.status, 503);
      const statusBody = await statusRes.json();
      assert.equal(statusBody.ok, false);
      assert.equal(statusBody.serving, false);
      assert.equal(statusBody.connected, false);
      assert.deepEqual(statusBody.store.artifacts.missing, [missingSha]);

      const syncRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/${prefix}/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(syncRes.status, 503);
      const syncBody = await syncRes.json();
      assert.equal(syncBody.ok, false);

      const analyticsRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/${prefix}/analytics`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(analyticsRes.status, 503);
      const analyticsBody = await analyticsRes.json();
      assert.equal(analyticsBody.ok, false);

      const queryRes = await fetch(`http://127.0.0.1:${port}/v3/world-model/${prefix}/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "show me projects", mode: "nl" }),
      });
      assert.equal(queryRes.status, 503);
      const queryBody = await queryRes.json();
      assert.equal(queryBody.ok, false);
    }
  } finally {
    server.close();
    defaultWorldModelHost.rehydrate(cleanDb);
    setDatabase(null);
    cleanDb.close();
  }
  assert.equal(defaultWorldModelHost.graphServing, true);
});
