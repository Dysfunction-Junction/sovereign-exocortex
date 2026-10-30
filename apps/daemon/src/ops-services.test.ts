/**
 * @file ops-services.test.ts
 * Comprehensive test suite for Workstation Node service operations:
 * - Fixed registry & validation (404, path tricks, case variants)
 * - Security & loopback isolation (403 for non-loopback, 403 for wrong scopes)
 * - Immediate 202 Accepted before restart completion
 * - Single-flight 409 and cooldown 429
 * - Health status mapping (200, non-200, timeout, error classes) with fakes
 * - In-memory DB round-trip for worldmodel (no event loss)
 * - Fixed command strings for scheduled tasks
 * - Audit logging
 * - Response hygiene (no paths or secrets)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { ExocortexDatabase } from "@exocortex/core/db";

const TEST_SECRET = "ops-test-secret-long-enough-32bytes-min";
process.env.GATEWAY_JWT_SECRET = TEST_SECRET;
process.env.DEVICE_REGISTRY_PATH = "none";
process.env.NODE_ENV = "test";

const { setDatabase, getDatabase } = await import("./db-host.js");
const { issueToken } = await import("./jwt.js");
const { server } = await import("./server.js");
const {
  isValidServiceId,
  checkServiceHealth,
  getServicesStatus,
  requestServiceRestart,
  resetOpsServicesState,
  recordRestartAudit,
  setOpsIngestConsumer,
} = await import("./ops-services.js");

function createMockDevice(db: ExocortexDatabase, deviceId: string, scopes: string[]) {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  db.registerDevice({
    device_id: deviceId,
    name: `Test Device ${deviceId}`,
    platform: "windows",
    pubkey_spki: new Uint8Array(publicKey.export({ format: "der", type: "spki" })),
    key_attested: 1,
    scopes,
    enrolled_at: Date.now(),
    revoked_at: null,
  });
}

test("registry: validates fixed ids and rejects unknown, casing, and path tricks", () => {
  assert.equal(isValidServiceId("daemon"), true);
  assert.equal(isValidServiceId("proxy"), true);
  assert.equal(isValidServiceId("piecesos"), true);
  assert.equal(isValidServiceId("worldmodel"), true);

  // Rejections
  assert.equal(isValidServiceId("DAEMON"), false);
  assert.equal(isValidServiceId("proxy "), false);
  assert.equal(isValidServiceId("../daemon"), false);
  assert.equal(isValidServiceId("daemon/.."), false);
  assert.equal(isValidServiceId(".."), false);
  assert.equal(isValidServiceId(""), false);
  assert.equal(isValidServiceId("unknown"), false);
  assert.equal(isValidServiceId(123), false);
  assert.equal(isValidServiceId(null), false);
  assert.equal(isValidServiceId(undefined), false);
  assert.equal(isValidServiceId({}), false);
});

test("health mapping: timeout, refused, 200, non-200, and database checks using injected fakes", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  setDatabase(db);

  // 1. Daemon self health
  const daemonHealth = await checkServiceHealth("daemon", { getDb: () => db });
  assert.equal(daemonHealth.status, "healthy");
  assert.equal(daemonHealth.port, 8788);
  assert.equal(typeof daemonHealth.pid, "number");
  assert.equal(typeof daemonHealth.uptime_s, "number");
  assert.match(daemonHealth.detail, /^serving \(pid \d+, uptime \d+s\)$/);

  // 2. Proxy 200 OK
  const fakeFetch200 = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof globalThis.fetch;
  const proxyOk = await checkServiceHealth("proxy", { fetch: fakeFetch200, isTaskInstalled: () => true });
  assert.equal(proxyOk.status, "healthy");
  assert.equal(proxyOk.restart.available, true);
  assert.match(proxyOk.detail, /HTTP 200 ok/);

  // 3. Proxy non-200 (HTTP 502)
  const fakeFetch502 = (async () => new Response("Bad Gateway", { status: 502 })) as unknown as typeof globalThis.fetch;
  const proxy502 = await checkServiceHealth("proxy", { fetch: fakeFetch502 });
  assert.equal(proxy502.status, "unhealthy");
  assert.equal(proxy502.detail, "HTTP 502");

  // 4. Proxy timeout
  const fakeFetchTimeout = (async () => {
    const err = new Error("The operation timed out");
    err.name = "TimeoutError";
    throw err;
  }) as unknown as typeof globalThis.fetch;
  const proxyTimeout = await checkServiceHealth("proxy", { fetch: fakeFetchTimeout });
  assert.equal(proxyTimeout.status, "unhealthy");
  assert.match(proxyTimeout.detail, /TimeoutError/);

  // 5. PiecesOS connection refused
  const fakeFetchRefused = (async () => {
    const err = new TypeError("fetch failed");
    err.name = "FetchError";
    throw err;
  }) as unknown as typeof globalThis.fetch;
  const piecesosRefused = await checkServiceHealth("piecesos", { fetch: fakeFetchRefused });
  assert.equal(piecesosRefused.status, "unhealthy");
  assert.equal(piecesosRefused.detail, "FetchError");

  // 6. Worldmodel healthy with quick_check
  const wmHealthy = await checkServiceHealth("worldmodel", { getDb: () => db });
  assert.equal(wmHealthy.status, "healthy");
  assert.match(wmHealthy.detail, /quick_check ok/);
  assert.equal(wmHealthy.restart.available, true); // In-process restart is always available
});

test("restart: returns 202 immediately before process runner completes", async () => {
  resetOpsServicesState();
  const db = new ExocortexDatabase({ path: ":memory:" });
  setDatabase(db);
  createMockDevice(db, "test_admin_device", ["admin:write"]);

  let runnerResolve: (() => void) | null = null;
  const blockingRunner = async () => {
    return new Promise<{ exitCode: number }>((resolve) => {
      runnerResolve = () => resolve({ exitCode: 0 });
    });
  };

  const t0 = Date.now();
  const result = await requestServiceRestart("daemon", "test_admin_device", {
    getDb: () => db,
    spawnRunner: blockingRunner,
  });
  const elapsed = Date.now() - t0;

  // Must return 202 in well under 100ms, not blocked on runner
  assert.equal(result.status, 202);
  if (result.status === 202) {
    assert.equal(result.data.accepted, true);
    assert.equal(result.data.id, "daemon");
  }
  assert.ok(elapsed < 100, `Expected instant return, took ${elapsed}ms`);

  // Clean up the background promise
  if (runnerResolve) (runnerResolve as () => void)();
});

test("restart: enforces single-flight 409 and cooldown 429", async () => {
  resetOpsServicesState();
  const db = new ExocortexDatabase({ path: ":memory:" });
  setDatabase(db);
  createMockDevice(db, "test_admin_device", ["admin:write"]);

  let currentTime = 1_000_000;
  const now = () => currentTime;

  let resolveRunner: (() => void) | null = null;
  const slowRunner = async () =>
    new Promise<{ exitCode: number }>((resolve) => {
      resolveRunner = () => resolve({ exitCode: 0 });
    });

  // 1. First restart accepted
  const res1 = await requestServiceRestart("daemon", "test_admin_device", {
    getDb: () => db,
    spawnRunner: slowRunner,
    now,
  });
  assert.equal(res1.status, 202);

  // 2. Immediate second restart -> 409 Conflict (already in progress)
  const res2 = await requestServiceRestart("daemon", "test_admin_device", {
    getDb: () => db,
    spawnRunner: slowRunner,
    now,
  });
  assert.equal(res2.status, 409);
  assert.match(res2.error, /already in progress/i);

  // Yield to allow setImmediate to start the slowRunner, then resolve it
  await new Promise((resolve) => setImmediate(resolve));
  if (resolveRunner) (resolveRunner as () => void)();
  await new Promise((resolve) => setImmediate(resolve));

  // 3. Request after finish but before 30s cooldown expires -> 429
  currentTime += 15_000; // 15 seconds later
  const res3 = await requestServiceRestart("daemon", "test_admin_device", {
    getDb: () => db,
    spawnRunner: async () => ({ exitCode: 0 }),
    now,
  });
  assert.equal(res3.status, 429);
  assert.match(res3.error, /cooldown active/i);

  // 4. Request after cooldown expires (31s) -> 202 Accepted
  currentTime += 16_000; // 31 seconds total
  const res4 = await requestServiceRestart("daemon", "test_admin_device", {
    getDb: () => db,
    spawnRunner: async () => ({ exitCode: 0 }),
    now,
  });
  assert.equal(res4.status, 202);
});

test("restart: spawns exactly fixed command strings without user input or interpolation", async () => {
  resetOpsServicesState();
  const db = new ExocortexDatabase({ path: ":memory:" });
  setDatabase(db);
  createMockDevice(db, "test_admin_device", ["admin:write"]);

  const spawnedCalls: Array<{ command: string; args: string[] }> = [];
  const trackingRunner = async (command: string, args: string[]) => {
    spawnedCalls.push({ command, args });
    return { exitCode: 0 };
  };

  const deps: any = {
    getDb: () => db,
    spawnRunner: trackingRunner,
    now: () => Date.now(),
  };

  await requestServiceRestart("daemon", "test_admin_device", deps);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(spawnedCalls[0], {
    command: "schtasks",
    args: ["/run", "/tn", "ExocortexRestart-daemon"],
  });

  resetOpsServicesState();
  await requestServiceRestart("proxy", "test_admin_device", deps);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(spawnedCalls[1], {
    command: "schtasks",
    args: ["/run", "/tn", "ExocortexRestart-proxy"],
  });

  resetOpsServicesState();
  await requestServiceRestart("piecesos", "test_admin_device", deps);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(spawnedCalls[2], {
    command: "schtasks",
    args: ["/run", "/tn", "ExocortexRestart-piecesos"],
  });
});

test("restart: worldmodel round-trip with in-memory DB preserves all events", async () => {
  resetOpsServicesState();
  const db = new ExocortexDatabase({ path: ":memory:" });
  setDatabase(db);
  createMockDevice(db, "dev_writer", ["telemetry:write", "admin:write"]);

  let stopped = false;
  let started = false;
  setOpsIngestConsumer(() => ({
    stop: () => { stopped = true; },
    idle: async () => {},
    start: () => { started = true; },
  }));

  // 1. Ingest events before restart
  const preBatch = {
    device_id: "dev_writer",
    events: [
      {
        event_id: "ev_pre_1",
        kind: "test_event",
        ts_device: 1000,
        schema_ver: 1 as const,
        payload: { greeting: "hello before restart" },
      },
      {
        event_id: "ev_pre_2",
        kind: "test_event",
        ts_device: 1001,
        schema_ver: 1 as const,
        payload: { greeting: "world before restart" },
      },
    ],
  };
  db.ingestBatch(preBatch);
  assert.equal(db.listEvents({ kind: "test_event" }).length, 2);

  // 2. Perform in-process worldmodel restart
  const restartRes = await requestServiceRestart("worldmodel", "dev_writer");
  assert.equal(restartRes.status, 202);

  // Wait for the detached async restart to settle
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(stopped, true, "Ingest consumer was cleanly stopped");
  assert.equal(started, true, "Ingest consumer was restarted");

  // 3. Ingest event after restart
  const postDb = getDatabase();
  const postBatch = {
    device_id: "dev_writer",
    events: [
      {
        event_id: "ev_post_1",
        kind: "test_event",
        ts_device: 2000,
        schema_ver: 1 as const,
        payload: { greeting: "survived restart" },
      },
    ],
  };
  postDb.ingestBatch(postBatch);

  // 4. Verify all 3 test events survive with exact data intact
  const testEvents = postDb.listEvents({ kind: "test_event" });
  assert.equal(testEvents.length, 3);
  assert.equal(testEvents[0].event_id, "ev_pre_1");
  assert.equal(testEvents[1].event_id, "ev_pre_2");
  assert.equal(testEvents[2].event_id, "ev_post_1");

  // Verify audit event is present
  const auditEvents = postDb.listEvents({ kind: "service_restart_audit" });
  assert.ok(auditEvents.length >= 1, "Audit event was recorded");
});

test("audit: every restart request writes structured metadata-only event", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  setDatabase(db);
  createMockDevice(db, "audit_device", ["admin:write"]);

  recordRestartAudit(db, {
    id: "daemon",
    deviceId: "audit_device",
    action: "accepted",
  });

  const auditEvents = db.listEvents({ kind: "service_restart_audit" });
  assert.equal(auditEvents.length, 1);
  const payload = JSON.parse(auditEvents[0].payload);
  assert.equal(payload.service_id, "daemon");
  assert.equal(payload.requested_by, "audit_device");
  assert.equal(payload.action, "accepted");
  // Verify no sensitive keys
  assert.equal(payload.token, undefined);
  assert.equal(payload.secret, undefined);
  assert.equal(payload.path, undefined);
});

test("response hygiene: health and restart responses contain no file paths or secrets", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  setDatabase(db);
  createMockDevice(db, "hygiene_device", ["admin:read", "admin:write"]);

  const services = await getServicesStatus({ getDb: () => db });
  for (const svc of services) {
    const serialized = JSON.stringify(svc);
    assert.doesNotMatch(serialized, /C:\\|Users|SECRET|Bearer|password/i);
  }

  const restartRes = await requestServiceRestart("daemon", "hygiene_device", {
    getDb: () => db,
    spawnRunner: async () => ({ exitCode: 0 }),
  });
  const serializedRestart = JSON.stringify(restartRes);
  assert.doesNotMatch(serializedRestart, /C:\\|Users|SECRET|Bearer|password/i);
});

test("HTTP routes integration: loopback isolation, scopes, 404s, and 202 flow", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  setDatabase(db);

  createMockDevice(db, "read_only_device", ["admin:read"]);
  createMockDevice(db, "write_only_device", ["admin:write"]);
  createMockDevice(db, "no_admin_device", ["telemetry:write"]);

  const readToken = issueToken("read_only_device", TEST_SECRET);
  const writeToken = issueToken("write_only_device", TEST_SECRET);
  const noAdminToken = issueToken("no_admin_device", TEST_SECRET);

  // Listen on ephemeral loopback port
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. GET /ops/services with no token -> 401
    const unauthRes = await fetch(`${baseUrl}/ops/services`);
    assert.equal(unauthRes.status, 401);

    // 2. GET /ops/services with token lacking admin:read -> 403
    const noScopeRes = await fetch(`${baseUrl}/ops/services`, {
      headers: { Authorization: `Bearer ${noAdminToken}` },
    });
    assert.equal(noScopeRes.status, 403);

    // 3. GET /ops/services with admin:read -> 200
    const listRes = await fetch(`${baseUrl}/ops/services`, {
      headers: { Authorization: `Bearer ${readToken}` },
    });
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.equal(Array.isArray(listData), true);
    assert.equal(listData.length, 4);

    // 4. POST /ops/services/daemon/restart with token lacking admin:write -> 403
    const forbiddenRestartRes = await fetch(`${baseUrl}/ops/services/daemon/restart`, {
      method: "POST",
      headers: { Authorization: `Bearer ${readToken}` },
    });
    assert.equal(forbiddenRestartRes.status, 403);

    // 5. POST /ops/services/unknown/restart -> 404
    const unknownSvcRes = await fetch(`${baseUrl}/ops/services/not_a_service/restart`, {
      method: "POST",
      headers: { Authorization: `Bearer ${writeToken}` },
    });
    assert.equal(unknownSvcRes.status, 404);

    // 6. POST /ops/services/../daemon/restart (path traversal trick) -> 404
    const pathTrickRes = await fetch(`${baseUrl}/ops/services/%2e%2e/daemon/restart`, {
      method: "POST",
      headers: { Authorization: `Bearer ${writeToken}` },
    });
    assert.equal(pathTrickRes.status, 404);

    // 7. Non-loopback request rejection (simulate remote IP via mock socket)
    const mockReq = new EventEmitter() as any;
    mockReq.method = "GET";
    mockReq.url = "/ops/services";
    mockReq.headers = { authorization: `Bearer ${readToken}` };
    mockReq.socket = { remoteAddress: "192.168.1.50" };

    let resCode = 0;
    let resBody = "";
    const mockRes = {
      writeHead(code: number) { resCode = code; },
      setHeader() {},
      end: (data: string) => {},
    } as any;

    await new Promise<void>((resolve) => {
      mockRes.end = (data: string) => {
        resBody = data;
        resolve();
      };
      server.emit("request", mockReq, mockRes);
    });

    assert.equal(resCode, 403);
    assert.match(resBody, /loopback/i);
  } finally {
    server.close();
  }
});
