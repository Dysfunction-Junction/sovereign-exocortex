import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { issueToken } from "./jwt.js";
import { setDatabase } from "./db-host.js";
import { ExocortexDatabase } from "@exocortex/core/db";

const TEST_SECRET = "test-gateway-jwt-secret-secure-123";
const TEST_ENROLL_TOKEN = "test-gateway-enroll-token-secure-456";

process.env.GATEWAY_JWT_SECRET = TEST_SECRET;
process.env.GATEWAY_ENROLL_TOKEN = TEST_ENROLL_TOKEN;
process.env.DEVICE_REGISTRY_PATH = "none";
process.env.NODE_ENV = "test";

// Dynamically import server after env vars are set
const { server, ingestConsumerForDatabase } = await import("./server.js");

test("v3 event store endpoints integration test", async () => {
  // Use in-memory SQLite for testing
  const memoryDb = new ExocortexDatabase({ path: ":memory:" });
  setDatabase(memoryDb);

  // Generate a valid ECDSA P-256 key pair
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pubkeyDer = publicKey.export({ format: "der", type: "spki" });
  const pubkeyB64 = Buffer.from(pubkeyDer).toString("base64");

  // Issue valid test token
  const token = issueToken("dev_s26_ultra", TEST_SECRET);
  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  const enrollHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${TEST_ENROLL_TOKEN}`,
  };

  // Bind server to an ephemeral test port
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Enrollment rejection without valid enrollment bearer token
    const badEnrollRes = await fetch(`${baseUrl}/v3/devices/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: "dev_s26_ultra",
        name: "Galaxy S26 Ultra",
        platform: "android",
        pubkey_b64: pubkeyB64,
      }),
    });
    assert.equal(badEnrollRes.status, 401);

    // 2. Enrollment rejection with invalid SPKI key
    const invalidKeyRes = await fetch(`${baseUrl}/v3/devices/enroll`, {
      method: "POST",
      headers: enrollHeaders,
      body: JSON.stringify({
        device_id: "dev_bad_key",
        name: "Bad Device",
        platform: "android",
        pubkey_b64: "not_a_valid_der_key",
      }),
    });
    assert.equal(invalidKeyRes.status, 400);

    // 3. Successful enrollment with valid enrollment token and key
    const enrollRes = await fetch(`${baseUrl}/v3/devices/enroll`, {
      method: "POST",
      headers: enrollHeaders,
      body: JSON.stringify({
        device_id: "dev_s26_ultra",
        name: "Galaxy S26 Ultra",
        platform: "android",
        pubkey_b64: pubkeyB64,
        key_attested: 1,
        scopes: ["telemetry:write", "approval:write"],
      }),
    });
    assert.equal(enrollRes.status, 200);
    // admin scopes are granted from the PC only (grant-scope-cli), never by enrollment
    assert.equal(memoryDb.getDevice("dev_s26_ultra")?.key_attested, 0, "enroll must not trust client key_attested");
    assert.equal(memoryDb.grantDeviceScope("dev_s26_ultra", "admin:read"), true);
    const enrollData = await enrollRes.json();
    assert.equal(enrollData.ok, true);
    assert.equal(enrollData.enrolled, "dev_s26_ultra");

    // 4. Duplicate enrollment rejection (409 Conflict)
    const dupEnrollRes = await fetch(`${baseUrl}/v3/devices/enroll`, {
      method: "POST",
      headers: enrollHeaders,
      body: JSON.stringify({
        device_id: "dev_s26_ultra",
        name: "Galaxy S26 Ultra",
        platform: "android",
        pubkey_b64: pubkeyB64,
      }),
    });
    assert.equal(dupEnrollRes.status, 409);

    // 5. Query enrolled devices (returns base64 pubkey)
    const devicesRes = await fetch(`${baseUrl}/v3/devices`, {
      headers: authHeaders,
    });
    assert.equal(devicesRes.status, 200);
    const devicesData = await devicesRes.json();
    assert.equal(devicesData.ok, true);
    assert.equal(devicesData.devices.length, 1);
    assert.equal(devicesData.devices[0].device_id, "dev_s26_ultra");
    assert.equal(devicesData.devices[0].pubkey_b64, pubkeyB64);

    // 6. Device spoofing rejection: device_id mismatch with token
    const spoofReq = {
      device_id: "dev_spoofed_victim",
      events: [
        {
          event_id: "e_spoof_1",
          kind: "telemetry",
          ts_device: 1728000001,
          schema_ver: 1,
          payload: { spoof: true },
        },
      ],
    };
    const spoofRes = await fetch(`${baseUrl}/v3/events`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(spoofReq),
    });
    assert.equal(spoofRes.status, 403);

    // 7. Legitimate batch event ingestion
    const batchReq = {
      device_id: "dev_s26_ultra",
      events: [
        {
          event_id: "e_001",
          kind: "telemetry",
          ts_device: 1728000001,
          schema_ver: 1,
          payload: { app: "com.android.chrome", foreground: true },
        },
        {
          event_id: "e_002",
          kind: "observation",
          ts_device: 1728000005,
          schema_ver: 1,
          payload: { invariant: "clean_suite", state: true },
        },
      ],
    };

    const ingestRes = await fetch(`${baseUrl}/v3/events`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(batchReq),
    });
    assert.equal(ingestRes.status, 200);
    const ingestData = await ingestRes.json();
    assert.equal(ingestData.ok, true);
    assert.equal(ingestData.result.insertedCount, 2);
    assert.equal(ingestData.result.duplicateCount, 0);
    assert.equal(typeof ingestData.result.events[0].prev_hash_b64, "string");
    assert.equal(typeof ingestData.result.events[0].hash_b64, "string");
    await ingestConsumerForDatabase(memoryDb).idle();

    // 8. Idempotent re-ingestion
    const replayRes = await fetch(`${baseUrl}/v3/events`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(batchReq),
    });
    assert.equal(replayRes.status, 200);
    const replayData = await replayRes.json();
    assert.equal(replayData.ok, true);
    assert.equal(replayData.result.insertedCount, 0);
    assert.equal(replayData.result.duplicateCount, 2);

    // 9. Query events with strict parsing
    const queryRes = await fetch(`${baseUrl}/v3/events?limit=10&sinceSeq=0`, {
      headers: authHeaders,
    });
    assert.equal(queryRes.status, 200);
    const queryData = await queryRes.json();
    assert.equal(queryData.ok, true);
    assert.equal(queryData.events.length, 2);
    assert.equal(queryData.events[0].seq, 1);
    assert.equal(queryData.events[1].seq, 2);

    // 10. Query param rejection for non-integers
    const badParamRes = await fetch(`${baseUrl}/v3/events?limit=invalid_number`, {
      headers: authHeaders,
    });
    assert.equal(badParamRes.status, 400);

    // 11. Verify cryptographic event chain (admin scope)
    const verifyRes = await fetch(`${baseUrl}/v3/events/verify`, {
      headers: authHeaders,
    });
    assert.equal(verifyRes.status, 200);
    const verifyData = await verifyRes.json();
    assert.equal(verifyData.ok, true);
    assert.equal(verifyData.verification.valid, true);
    assert.equal(verifyData.verification.totalEvents, 2);

    // 12. Rejection of unauthenticated request
    const unauthRes = await fetch(`${baseUrl}/v3/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batchReq),
    });
    assert.equal(unauthRes.status, 401);

    // 13. Enroll second non-admin device
    const enrollGuestRes = await fetch(`${baseUrl}/v3/devices/enroll`, {
      method: "POST",
      headers: enrollHeaders,
      body: JSON.stringify({
        device_id: "dev_pixel_guest",
        name: "Pixel 9 Guest",
        platform: "android",
        pubkey_b64: pubkeyB64,
        key_attested: 0,
        scopes: ["telemetry:write"],
      }),
    });
    assert.equal(enrollGuestRes.status, 200);
    const guestToken = issueToken("dev_pixel_guest", TEST_SECRET);
    const guestAuthHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${guestToken}`,
    };

    // 14. Non-admin forbidden from verify endpoint
    const guestVerifyRes = await fetch(`${baseUrl}/v3/events/verify`, {
      headers: guestAuthHeaders,
    });
    assert.equal(guestVerifyRes.status, 403);

    // 15. Validation rejection for float ts_device
    const floatTsRes = await fetch(`${baseUrl}/v3/events`, {
      method: "POST",
      headers: guestAuthHeaders,
      body: JSON.stringify({
        device_id: "dev_pixel_guest",
        events: [
          {
            event_id: "e_guest_float",
            kind: "telemetry",
            ts_device: 1728000001.5,
            payload: { ok: false },
          },
        ],
      }),
    });
    assert.equal(floatTsRes.status, 400);

    // 16. Cross-device event_id collision returns 409 and leaks no payload
    const crossCollisionRes = await fetch(`${baseUrl}/v3/events`, {
      method: "POST",
      headers: guestAuthHeaders,
      body: JSON.stringify({
        device_id: "dev_pixel_guest",
        events: [
          {
            event_id: "e_001", // Already owned by dev_s26_ultra
            kind: "telemetry",
            ts_device: 1728000010,
            payload: { stolen: true },
          },
        ],
      }),
    });
    assert.equal(crossCollisionRes.status, 409);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setDatabase(null);
  }
});

test("retrying an ingested event does not re-run projection hooks", async () => {
  const { defaultPredictionHost } = await import("./prediction-host.js");
  const memoryDb = new ExocortexDatabase({ path: ":memory:" });
  memoryDb.registerDevice({
    device_id: "dev_retry", name: "dev_retry", platform: "android", pubkey_spki: new Uint8Array([0]),
    key_attested: 0, scopes: ["telemetry:write"], enrolled_at: Date.now(), revoked_at: null,
  });
  setDatabase(memoryDb);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const seen: number[] = [];
  const original = defaultPredictionHost.onEventsAppended.bind(defaultPredictionHost);
  defaultPredictionHost.onEventsAppended = (events, db) => {
    seen.push(...events.map((e) => e.seq));
    return original(events, db);
  };
  try {
    const body = JSON.stringify({
      device_id: "dev_retry",
      events: [{ event_id: "e_retry_once", kind: "telemetry", ts_device: 1728000000000, payload: { ok: true } }],
    });
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${issueToken("dev_retry", TEST_SECRET)}` };
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${baseUrl}/v3/events`, { method: "POST", headers, body });
      assert.equal(res.status, 200);
    }
    await ingestConsumerForDatabase(memoryDb).idle();
    assert.equal(seen.length, 1, "hooks must see the event once, not again on the retry");
  } finally {
    defaultPredictionHost.onEventsAppended = original;
    server.close();
    setDatabase(null);
  }
});
