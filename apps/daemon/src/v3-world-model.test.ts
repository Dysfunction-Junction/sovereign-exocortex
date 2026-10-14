import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { issueToken } from "./jwt.js";
import { setDatabase } from "./db-host.js";
import { ExocortexDatabase } from "@exocortex/core/db";
import { defaultWorldModelHost } from "./world-model-host.js";

const TEST_SECRET = "test-gateway-jwt-secret-secure-123";
const TEST_ENROLL_TOKEN = "test-gateway-enroll-token-secure-456";

process.env.GATEWAY_JWT_SECRET = TEST_SECRET;
process.env.GATEWAY_ENROLL_TOKEN = TEST_ENROLL_TOKEN;
process.env.NODE_ENV = "test";

const { server, setPendingFetcherForTest, setPendingSpeculatorForTest } = await import("./server.js");

test("v3 world-model endpoints integration test", async () => {
  process.env.SHADOW = "1";
  process.env.EXOCORTEX_SHADOW_RECORD = "1";
  // Use isolated in-memory SQLite for testing
  const memoryDb = new ExocortexDatabase({ path: ":memory:" });
  setDatabase(memoryDb);

  // Generate ECDSA P-256 key pair for admin device
  const { publicKey: adminPub } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const adminDer = adminPub.export({ format: "der", type: "spki" });

  // Register admin device
  memoryDb.registerDevice({
    device_id: "dev_admin_node",
    name: "Admin World Model Node",
    platform: "android",
    pubkey_spki: Buffer.from(adminDer),
    key_attested: 1,
    scopes: ["telemetry:write", "admin:write", "admin:read"],
    enrolled_at: Date.now(),
  });

  // Register non-admin device (telemetry only)
  const { publicKey: userPub } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const userDer = userPub.export({ format: "der", type: "spki" });
  memoryDb.registerDevice({
    device_id: "dev_user_node",
    name: "User Node",
    platform: "android",
    pubkey_spki: Buffer.from(userDer),
    key_attested: 1,
    scopes: ["telemetry:write"],
    enrolled_at: Date.now(),
  });

  const adminToken = issueToken("dev_admin_node", TEST_SECRET);
  const adminHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${adminToken}`,
  };

  const userToken = issueToken("dev_user_node", TEST_SECRET);
  const userHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${userToken}`,
  };

  // Bind server to ephemeral port
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. GET /v3/world-model/params: query initial Dirichlet count tables
    const paramsRes = await fetch(`${baseUrl}/v3/world-model/params`, {
      method: "GET",
      headers: adminHeaders,
    });
    assert.equal(paramsRes.status, 200);
    const paramsData = await paramsRes.json();
    assert.equal(paramsData.ok, true);
    assert.ok(Array.isArray(paramsData.params));
    assert.equal(paramsData.params.length, 12); // 3 factors * 4 kinds (A, B, C, D)

    // Filter by factor=repo_health and kind=A
    const filteredRes = await fetch(`${baseUrl}/v3/world-model/params?factor=repo_health&kind=A`, {
      method: "GET",
      headers: adminHeaders,
    });
    assert.equal(filteredRes.status, 200);
    const filteredData = await filteredRes.json();
    assert.equal(filteredData.ok, true);
    assert.equal(filteredData.params.length, 1);
    assert.equal(filteredData.params[0].factor, "repo_health");
    assert.equal(filteredData.params[0].kind, "A");

    // Invalid kind validation error (400 Bad Request)
    const badKindRes = await fetch(`${baseUrl}/v3/world-model/params?kind=INVALID`, {
      method: "GET",
      headers: adminHeaders,
    });
    assert.equal(badKindRes.status, 400);

    // 2. Ingest observation event via POST /v3/events and verify auto-snapshot
    const ingestRes = await fetch(`${baseUrl}/v3/events`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        device_id: "dev_admin_node",
        events: [
          {
            event_id: "evt_obs_001",
            stream: "sovereign",
            kind: "observation",
            payload: {
              factor: "repo_health",
              observation: "tests_pass",
            },
            ts_device: Date.now(),
          },
          {
            event_id: "evt_obs_002",
            stream: "sovereign",
            kind: "telemetry",
            payload: {
              app: "code.exe",
              foreground: "Visual Studio Code",
            },
            ts_device: Date.now() + 1,
          },
        ],
      }),
    });
    assert.equal(ingestRes.status, 200);
    const ingestData = await ingestRes.json();
    assert.equal(ingestData.ok, true);
    assert.equal(ingestData.result.insertedCount, 2);

    // 3. GET /v3/world-model/beliefs: verify belief snapshots were created
    const beliefsRes = await fetch(`${baseUrl}/v3/world-model/beliefs`, {
      method: "GET",
      headers: adminHeaders,
    });
    assert.equal(beliefsRes.status, 200);
    const beliefsData = await beliefsRes.json();
    assert.equal(beliefsData.ok, true);
    assert.ok(beliefsData.latest);
    assert.equal(beliefsData.latest.as_of_seq, 2);
    assert.equal(beliefsData.snapshots.length, 2);

    // Query specific belief snapshot by seq=1
    const seq1Res = await fetch(`${baseUrl}/v3/world-model/beliefs?seq=1`, {
      method: "GET",
      headers: adminHeaders,
    });
    assert.equal(seq1Res.status, 200);
    const seq1Data = await seq1Res.json();
    assert.equal(seq1Data.ok, true);
    assert.equal(seq1Data.snapshot.as_of_seq, 1);

    // Query non-numeric seq returns 400
    const badSeqRes = await fetch(`${baseUrl}/v3/world-model/beliefs?seq=invalid`, {
      method: "GET",
      headers: adminHeaders,
    });
    assert.equal(badSeqRes.status, 400);

    // 4. POST /v3/world-model/replay: permissions check
    // Non-admin device should be rejected with 403 Forbidden
    const unauthReplayRes = await fetch(`${baseUrl}/v3/world-model/replay`, {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({}),
    });
    assert.equal(unauthReplayRes.status, 403);

    // Invalid range validation (from_seq > to_seq) returns 400
    const badRangeRes = await fetch(`${baseUrl}/v3/world-model/replay`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ from_seq: 10, to_seq: 5 }),
    });
    assert.equal(badRangeRes.status, 400);

    // 5. Successful replay by admin node: deterministic reconstruction
    const replayRes = await fetch(`${baseUrl}/v3/world-model/replay`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({}),
    });
    assert.equal(replayRes.status, 200);
    const replayData = await replayRes.json();
    assert.equal(replayData.ok, true);
    assert.equal(replayData.replayedCount, 2);
    assert.equal(replayData.snapshotsCount, 2);
    assert.equal(replayData.latestSnapshot.as_of_seq, 2);

    // Verify replayed state matches beliefs before replay
    assert.equal(replayData.latestSnapshot.mode, beliefsData.latest.mode);
    assert.equal(replayData.latestSnapshot.q, beliefsData.latest.q);

    // Explicit failing test observations from the ordinary event stream create shadow rows.
    const failureIngest = await fetch(`${baseUrl}/v3/events`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        device_id: "dev_admin_node",
        events: [{
          event_id: "evt_obs_tests_fail",
          stream: "sovereign",
          kind: "observation",
          payload: { factor: "repo_health", observation: "tests_fail" },
          ts_device: Date.now() + 2,
        }],
      }),
    });
    assert.equal(failureIngest.status, 200);
    const proposalRows = memoryDb.listProposalsByState(["SURFACED", "STAGED", "SUPPRESSED", "GATED"]);
    assert.ok(proposalRows.some((row) => row.invariant_id === "inv_clean_test_suite" && row.shadow === 1));

    setPendingSpeculatorForTest(async () => {});
    setPendingFetcherForTest(async () => proposalRows
      .filter((row) => row.invariant_id === "inv_clean_test_suite" && row.shadow === 1 && ["SURFACED", "STAGED"].includes(row.state))
      .map((row) => ({ proposalId: row.proposal_id, approvalNonce: `nonce-${row.proposal_id}`, expiresAt: row.expires_at })));
    const pendingRes = await fetch(`${baseUrl}/v3/proposals/pending`, { headers: adminHeaders });
    assert.equal(pendingRes.status, 200);
    const pendingData = await pendingRes.json();
    assert.ok(pendingData.proposals.some((proposal: { invariantId: string }) => proposal.invariantId === "inv_clean_test_suite"));
  } finally {
    setPendingFetcherForTest(null);
    setPendingSpeculatorForTest(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
