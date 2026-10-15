import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { issueToken } from "./jwt.js";
import { setDatabase } from "./db-host.js";
import { ExocortexDatabase } from "@exocortex/core/db";

const TEST_SECRET = "test-gateway-jwt-secret-shadow-123";
const TEST_ENROLL_TOKEN = "test-gateway-enroll-token-shadow-456";

process.env.GATEWAY_JWT_SECRET = TEST_SECRET;
process.env.GATEWAY_ENROLL_TOKEN = TEST_ENROLL_TOKEN;
process.env.NODE_ENV = "test";

const { server } = await import("./server.js");

test("v3 shadow calibration endpoints & circuit breaker integration test", async () => {
  const memoryDb = new ExocortexDatabase({ path: ":memory:" });
  setDatabase(memoryDb);

  // Enroll device
  const { publicKey: devPub } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const devDer = devPub.export({ format: "der", type: "spki" });
  memoryDb.registerDevice({
    device_id: "dev_phone_user",
    name: "User Mobile Device",
    platform: "android",
    pubkey_spki: Buffer.from(devDer),
    key_attested: 1,
    scopes: ["telemetry:write"],
    enrolled_at: Date.now(),
  });

  const token = issueToken("dev_phone_user", TEST_SECRET);
  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Unauthenticated requests to /v3/shadow/metrics should return 401
    const unauthMetrics = await fetch(`${baseUrl}/v3/shadow/metrics`);
    assert.equal(unauthMetrics.status, 401);

    // 2. Initial state: no proposals or labels -> insufficient_data verdict
    const initMetricsRes = await fetch(`${baseUrl}/v3/shadow/metrics`, {
      method: "GET",
      headers: authHeaders,
    });
    assert.equal(initMetricsRes.status, 200);
    const initMetrics = await initMetricsRes.json();
    assert.equal(initMetrics.ok, true);
    assert.equal(initMetrics.automated_verdict, "INSUFFICIENT_DATA");
    assert.equal(initMetrics.breaker_tripped, false);
    assert.equal(initMetrics.metrics.surfaced, 0);

    // 3. Query parameter validation
    const badDaysRes = await fetch(`${baseUrl}/v3/shadow/metrics?days=invalid`, {
      method: "GET",
      headers: authHeaders,
    });
    assert.equal(badDaysRes.status, 400);

    const badThresholdRes = await fetch(`${baseUrl}/v3/shadow/metrics?threshold=1.5`, {
      method: "GET",
      headers: authHeaders,
    });
    assert.equal(badThresholdRes.status, 400);

    const badMinLabelsRes = await fetch(`${baseUrl}/v3/shadow/metrics?min_labels=-10`, {
      method: "GET",
      headers: authHeaders,
    });
    assert.equal(badMinLabelsRes.status, 400);

    // 4. Ingest an event and proposal for testing POST /v3/shadow/labels
    const now = Date.now();
    const eventRes = memoryDb.ingestEvent("dev_phone_user", {
      event_id: "evt_base_setup",
      kind: "observation",
      ts_device: now - 1000,
      schema_ver: 1,
      payload: { ready: true },
    });

    memoryDb.insertProposal({
      proposal_id: "prop_test_surface_1",
      created_seq: eventRes.event.seq,
      invariant_id: null,
      policy_type: "PRAGMATIC",
      tier: 1,
      summary: "Restart phone bridge relay",
      action: JSON.stringify({ cmd: "restart" }),
      action_hash: new Uint8Array([1, 2, 3]),
      efe: 1.2,
      risk_term: 0.1,
      ambiguity_term: 0.05,
      state: "SURFACED",
      shadow: 1,
      expires_at: now + 3600000,
      updated_at: now,
    });

    memoryDb.recordGateDecision({
      proposal_id: "prop_test_surface_1",
      mode: "MAINTENANCE",
      decision: "SURFACE",
      reason: "urgent",
      ts: now - 500,
    });

    // 5. POST /v3/shadow/labels: negative validation
    // Missing proposal_id -> 400
    const missingPropRes = await fetch(`${baseUrl}/v3/shadow/labels`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ label: "wanted" }),
    });
    assert.equal(missingPropRes.status, 400);

    // Invalid label -> 400
    const invalidLabelRes = await fetch(`${baseUrl}/v3/shadow/labels`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ proposal_id: "prop_test_surface_1", label: "invalid_label" }),
    });
    assert.equal(invalidLabelRes.status, 400);

    // Non-existent proposal -> 404
    const notFoundPropRes = await fetch(`${baseUrl}/v3/shadow/labels`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ proposal_id: "non_existent_prop", label: "wanted" }),
    });
    assert.equal(notFoundPropRes.status, 404);

    // Valid label recording -> 200
    const labelRes = await fetch(`${baseUrl}/v3/shadow/labels`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        proposal_id: "prop_test_surface_1",
        label: "wanted",
        source: "tap",
        latency_ms: 320,
      }),
    });
    assert.equal(labelRes.status, 200);
    const labelData = await labelRes.json();
    assert.equal(labelData.ok, true);
    assert.equal(labelData.proposal_id, "prop_test_surface_1");
    assert.equal(labelData.label, "wanted");

    // Verify stored label in DB
    const labels = memoryDb.getShadowLabels("prop_test_surface_1");
    assert.equal(labels.length, 1);
    assert.equal(labels[0].label, "wanted");
    assert.equal(labels[0].latency_ms, 320);

    // 6. Test label ingestion through batch POST /v3/events
    const eventBatchRes = await fetch(`${baseUrl}/v3/events`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        device_id: "dev_phone_user",
        events: [
          {
            event_id: "evt_label_stream_1",
            kind: "label",
            ts_device: now,
            schema_ver: 1,
            payload: {
              proposal_id: "prop_test_surface_1",
              label: "already_did",
              source: "tap",
            },
          },
        ],
      }),
    });
    assert.equal(eventBatchRes.status, 200);
    // Updated label should now be already_did
    const updatedLabels = memoryDb.getShadowLabels("prop_test_surface_1");
    assert.equal(updatedLabels[0].label, "already_did");

    // 7. Seed dataset that trips the circuit breaker:
    // 50 proposals: 30 wanted, 20 not_wanted -> precision = 30/50 = 0.60 < 0.90 threshold
    for (let i = 2; i <= 51; i++) {
      const pid = `prop_sim_${i}`;
      memoryDb.insertProposal({
        proposal_id: pid,
        created_seq: eventRes.event.seq,
        invariant_id: null,
        policy_type: "PRAGMATIC",
        tier: 1,
        summary: `Simulated proposal ${i}`,
        action: JSON.stringify({ cmd: "noop" }),
        action_hash: new Uint8Array([i]),
        efe: 1.0,
        risk_term: 0.1,
        ambiguity_term: 0.05,
        state: "SURFACED",
        shadow: 1,
        expires_at: now + 3600000,
        updated_at: now,
      });

      memoryDb.recordGateDecision({
        proposal_id: pid,
        mode: "MAINTENANCE",
        decision: "SURFACE",
        reason: "eval",
        ts: now - 100,
      });

      const label = i <= 31 ? "wanted" : "not_wanted";
      memoryDb.recordShadowLabel({
        proposal_id: pid,
        label,
        actual: JSON.stringify({ source: "tap" }),
        latency_ms: 150,
        ts: now - 50,
      });
    }

    // Check metrics: breaker should now be TRIPPED
    const trippedMetricsRes = await fetch(`${baseUrl}/v3/shadow/metrics?min_labels=50`, {
      method: "GET",
      headers: authHeaders,
    });
    assert.equal(trippedMetricsRes.status, 200);
    const trippedMetrics = await trippedMetricsRes.json();
    assert.equal(trippedMetrics.ok, true);
    assert.equal(trippedMetrics.breaker_tripped, true);
    assert.equal(trippedMetrics.automated_verdict, "BREAKER_TRIPPED_PRECISION_LOW");
    assert.equal(trippedMetrics.effective_shadow, true);
    assert.ok(trippedMetrics.metrics.precision < 0.90);

    // 8. Test Circuit Breaker Rollback Clamping on /network/approve
    // Approval of an action MUST be rejected with HTTP 423 Locked when breaker is tripped
    const approveAttemptRes = await fetch(`${baseUrl}/network/approve`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        proposal_id: "prop_sim_2",
        action: "approve",
        nonce: "test-nonce-123",
      }),
    });
    assert.equal(approveAttemptRes.status, 423);
    const approveAttempt = await approveAttemptRes.json();
    assert.equal(approveAttempt.ok, false);
    assert.equal(approveAttempt.automated_verdict, "BREAKER_TRIPPED_PRECISION_LOW");
    assert.equal(approveAttempt.breaker_tripped, true);

    // 9. Test GET /v3/shadow/pending and auto-advance on shadow label ingestion
    memoryDb.insertProposal({
      proposal_id: "prop_shadow_pending_test",
      created_seq: eventRes.event.seq,
      invariant_id: null,
      policy_type: "PRAGMATIC",
      tier: 1,
      summary: "Shadow candidate for mobile quick-labeling",
      action: JSON.stringify({ target: "cache_clean" }),
      action_hash: new Uint8Array([4, 5, 6]),
      efe: 0.8,
      risk_term: 0.2,
      ambiguity_term: 0.05,
      state: "SURFACED",
      shadow: 1,
      expires_at: Date.now() + 3600000,
      updated_at: Date.now(),
    });

    // Verify /v3/shadow/pending requires approval:write or admin scope
    const unprivilegedRes = await fetch(`${baseUrl}/v3/shadow/pending`, {
      method: "GET",
      headers: authHeaders,
    });
    assert.equal(unprivilegedRes.status, 403);

    memoryDb.grantDeviceScope("dev_phone_user", "approval:write");
    const pendingShadowRes = await fetch(`${baseUrl}/v3/shadow/pending`, {
      method: "GET",
      headers: authHeaders,
    });
    assert.equal(pendingShadowRes.status, 200);
    const pendingShadowData = await pendingShadowRes.json();
    assert.equal(pendingShadowData.ok, true);
    const foundShadow = pendingShadowData.proposals.find((p: any) => p.proposalId === "prop_shadow_pending_test");
    assert.ok(foundShadow, "expected prop_shadow_pending_test in /v3/shadow/pending");
    assert.equal(foundShadow.shadow, true);
    assert.equal(foundShadow.riskLevel, "low");

    // Also test GET /v3/proposals/pending?include_shadow=1 (requires approval:write scope)
    memoryDb.grantDeviceScope("dev_phone_user", "approval:write");
    const pendingMergedRes = await fetch(`${baseUrl}/v3/proposals/pending?include_shadow=1`, {
      method: "GET",
      headers: authHeaders,
    });
    assert.equal(pendingMergedRes.status, 200);
    const pendingMergedData = await pendingMergedRes.json();
    assert.ok(pendingMergedData.proposals.some((p: any) => p.proposalId === "prop_shadow_pending_test"));

    // Labeling it wanted should advance state to APPROVED and remove from pending
    const labelShadowRes = await fetch(`${baseUrl}/v3/shadow/labels`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        proposal_id: "prop_shadow_pending_test",
        label: "wanted",
        source: "tap",
        latency_ms: 450,
      }),
    });
    assert.equal(labelShadowRes.status, 200);
    assert.equal(memoryDb.getProposal("prop_shadow_pending_test")?.state, "APPROVED");

    // Must no longer appear in /v3/shadow/pending
    const pendingAfterLabelRes = await fetch(`${baseUrl}/v3/shadow/pending`, {
      method: "GET",
      headers: authHeaders,
    });
    const pendingAfterLabelData = await pendingAfterLabelRes.json();
    assert.ok(!pendingAfterLabelData.proposals.some((p: any) => p.proposalId === "prop_shadow_pending_test"));

    // Verify non-shadow proposal (shadow: 0) is never leaked in shadow pending endpoints,
    // and labeling a non-shadow row does not advance its state.
    memoryDb.insertProposal({
      proposal_id: "prop_live_control",
      created_seq: eventRes.event.seq,
      invariant_id: null,
      policy_type: "PRAGMATIC",
      tier: 1,
      summary: "Live control proposal",
      action: JSON.stringify({ cmd: "restart" }),
      action_hash: new Uint8Array([99]),
      efe: 1.0,
      risk_term: 0.1,
      ambiguity_term: 0.05,
      state: "SURFACED",
      shadow: 0,
      expires_at: now + 3600000,
      updated_at: now,
    });

    const pendingShadowCheck = await fetch(`${baseUrl}/v3/shadow/pending`, {
      method: "GET",
      headers: authHeaders,
    });
    const pendingShadowCheckData = await pendingShadowCheck.json();
    assert.ok(!pendingShadowCheckData.proposals.some((p: any) => p.proposalId === "prop_live_control"));

    const labelLiveRes = await fetch(`${baseUrl}/v3/shadow/labels`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        proposal_id: "prop_live_control",
        label: "wanted",
        source: "tap",
        latency_ms: 100,
      }),
    });
    assert.equal(labelLiveRes.status, 200);
    // Non-shadow proposal state MUST remain SURFACED (never advanced via shadow labels)
    assert.equal(memoryDb.getProposal("prop_live_control")?.state, "SURFACED");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
