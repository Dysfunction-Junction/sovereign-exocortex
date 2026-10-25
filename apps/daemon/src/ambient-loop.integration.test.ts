import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { forwardApprove, forwardDelegate, type DelegateEnvelope } from "./network.js";
import { defaultReposRoot, MISHMASH_LAUNCH, startMishmash, stopMishmash, tsxBin } from "./mishmash-launch.js";
import { checkAllNodesHealth, checkNodeHealth } from "./mishmash-sentinel.js";

function envelope(to: string, action: string, capability: string, payload: Record<string, unknown> = {}): DelegateEnvelope {
  return {
    v: 1,
    id: `ambient-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: "pieces-android-companion-seamless",
    to,
    capability,
    action,
    payload,
  };
}

const reposRoot = defaultReposRoot();
const siblingsPresent = MISHMASH_LAUNCH.every((spec) => existsSync(join(reposRoot, spec.repo)));

test("ambient autonomic loop: telemetry -> pattern ranking -> SecondGuess staging -> Triad risk gating -> mesh actuation", {
  timeout: 90_000,
  skip: !siblingsPresent || !tsxBin(),
}, async () => {
  const ports: Record<string, number> = {};
  const probes: import("node:http").Server[] = [];
  for (const spec of MISHMASH_LAUNCH) {
    const probe = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        const p = typeof address === "object" && address ? address.port : 0;
        resolve(p);
      });
      probe.on("error", reject);
    });
    ports[spec.id] = port;
    probes.push(probe);
  }
  await Promise.all(probes.map((p) => new Promise<void>((res) => p.close(() => res()))));

  // pieces-for-all refuses memory writes without a gateway token; use a throwaway one for this run.
  const priorToken = process.env.GATEWAY_TOKEN;
  process.env.GATEWAY_TOKEN = priorToken || `test-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const handle = await startMishmash({ reposRoot, ports });
  const relayEnv = { ...handle.env, GATEWAY_TOKEN: process.env.GATEWAY_TOKEN as string };
  try {
    // Step 1: Simulated phone telemetry batch (Android Accessibility / notification listener events)
    const telemetryEvents = [
      { package: "com.android.chrome", app_label: "Chrome", timestamp: "2026-10-08T12:00:00.000Z" },
      { package: "com.android.chrome", app_label: "Chrome", timestamp: "2026-10-08T12:30:00.000Z" },
      { package: "com.google.android.keep", app_label: "Google Keep", timestamp: "2026-10-08T11:00:00.000Z" },
    ];

    // Step 2: Ingest telemetry batch into pattern-analyzer (:39402)
    const rankOutcome = await forwardDelegate(
      envelope("pattern-analyzer", "rank", "patterns", { events: telemetryEvents }),
      relayEnv,
    );
    assert.equal(rankOutcome.status, 200, `pattern-analyzer status: ${JSON.stringify(rankOutcome.body)}`);
    const rankBody = rankOutcome.body as { ok: boolean; result: { totalCandidates: number; returned: number; order: Array<{ id: string; promotionScore: number }> } };
    assert.equal(rankBody.ok, true);
    assert.equal(rankBody.result.returned, 2);
    assert.equal(rankBody.result.order[0].id, "cluster-com.android.chrome");

    // Step 3: Forward candidate pool to registry-app (:39403) for SecondGuess staging
    const stageOutcome = await forwardDelegate(
      envelope("registry-app", "stage", "staging", { events: telemetryEvents }),
      relayEnv,
    );
    assert.equal(stageOutcome.status, 200, `registry-app status: ${JSON.stringify(stageOutcome.body)}`);
    const stageBody = stageOutcome.body as { ok: boolean; result: { staged: number; topId: string } };
    assert.equal(stageBody.ok, true);
    assert.equal(stageBody.result.topId, "cluster-com.android.chrome");

    // Step 4: Triad (:8789) intent classification & risk assessment for low-risk ambient memory query
    const triadLowRisk = await forwardDelegate(
      envelope("autonomous-triad", "classify", "intent", { text: "what did i do on Monday?" }),
      relayEnv,
    );
    assert.equal(triadLowRisk.status, 200, `triad low-risk status: ${JSON.stringify(triadLowRisk.body)}`);
    const lowRiskBody = triadLowRisk.body as {
      ok: boolean;
      result: { intent: string; risk_level: string; approval_required: boolean; high_stakes: boolean };
    };
    assert.equal(lowRiskBody.ok, true);
    assert.equal(lowRiskBody.result.intent, "MEMORY");
    assert.equal(lowRiskBody.result.risk_level, "low");
    assert.equal(lowRiskBody.result.approval_required, false);
    assert.equal(lowRiskBody.result.high_stakes, false);

    // Step 5: Triad (:8789) intent classification & risk assessment for high-stakes action
    const triadHighRisk = await forwardDelegate(
      envelope("autonomous-triad", "classify", "intent", { text: "database migration for auth tokens" }),
      relayEnv,
    );
    assert.equal(triadHighRisk.status, 200, `triad high-risk status: ${JSON.stringify(triadHighRisk.body)}`);
    const highRiskBody = triadHighRisk.body as {
      ok: boolean;
      result: { intent: string; risk_level: string; approval_required: boolean; high_stakes: boolean };
    };
    assert.equal(highRiskBody.ok, true);
    assert.equal(highRiskBody.result.high_stakes, true);
    assert.equal(highRiskBody.result.risk_level, "high");
    assert.equal(highRiskBody.result.approval_required, true);

    // Step 6: When low-risk, autonomic actuation via agent-mesh-mcp (:39401)
    const meshOutcome = await forwardDelegate(
      envelope("agent-mesh-mcp", "skills", "mesh", {}),
      relayEnv,
    );
    assert.equal(meshOutcome.status, 200, `mesh status: ${JSON.stringify(meshOutcome.body)}`);
    const meshBody = meshOutcome.body as { ok: boolean; result: { skills: unknown[] } };
    assert.equal(meshBody.ok, true);
    assert.ok(meshBody.result.skills.length > 0);

    // Step 7: Feedback relay via hermes-api (:3000)
    const hermesOutcome = await forwardDelegate(
      envelope("hermes-api", "relay", "device", { summary: "ambient loop cycle executed successfully" }),
      relayEnv,
    );
    assert.equal(hermesOutcome.status, 200, `hermes status: ${JSON.stringify(hermesOutcome.body)}`);
    const hermesBody = hermesOutcome.body as { ok: boolean; result: { accepted: boolean } };
    assert.equal(hermesBody.ok, true);
    assert.equal(hermesBody.result.accepted, true);

    // =========================================================================
    // Evolution Cycle N+2: Predictive Pre-Execution & Biometric Gating Plane
    // =========================================================================

    // Step 8: Speculative pre-execution proposal generated by registry-app (:39403)
    const speculateOutcome = await forwardDelegate(
      envelope("registry-app", "speculate", "staging", { events: telemetryEvents }),
      relayEnv,
    );
    assert.equal(speculateOutcome.status, 200, `registry speculate status: ${JSON.stringify(speculateOutcome.body)}`);
    const speculateBody = speculateOutcome.body as {
      ok: boolean;
      result: {
        status: string;
        proposalId: string;
        candidateId: string;
        summary: string;
        riskLevel: string;
        requiresBiometric: boolean;
        approvalNonce: string;
        expiresAt: number;
      };
    };
    assert.equal(speculateBody.ok, true);
    assert.equal(speculateBody.result.status, "dry_run_ready");
    assert.ok(speculateBody.result.proposalId.startsWith("prop_"));
    assert.ok(speculateBody.result.approvalNonce.length >= 16);
    const { proposalId, approvalNonce } = speculateBody.result;

    // Step 9: Triad (:8789) classification verifying biometric gating policy flag
    const triadGateClassify = await forwardDelegate(
      envelope("autonomous-triad", "classify", "intent", { text: "execute database migration for staged auth tokens" }),
      relayEnv,
    );
    assert.equal(triadGateClassify.status, 200);
    const gateClassifyBody = triadGateClassify.body as {
      ok: boolean;
      result: { high_stakes: boolean; risk_level: string; approval_required: boolean; requires_biometric: boolean };
    };
    assert.equal(gateClassifyBody.ok, true);
    assert.equal(gateClassifyBody.result.risk_level, "high");
    assert.equal(gateClassifyBody.result.approval_required, true);
    assert.equal(gateClassifyBody.result.requires_biometric, true);

    // Step 10: Fail-closed security: attempt approval with INVALID nonce via forwardApprove
    const invalidApprove = await forwardApprove(
      { proposalId, nonce: "invalid_tampered_nonce_1234" },
      relayEnv,
    );
    assert.equal(invalidApprove.status, 409, `invalid nonce must fail closed: ${JSON.stringify(invalidApprove.body)}`);
    const invalidBody = invalidApprove.body as { ok: boolean; status: string; upstream_status?: number };
    assert.equal(invalidBody.ok, false);
    assert.equal(invalidBody.status, "release_failed");
    assert.equal(invalidBody.upstream_status, 403);

    // Step 11: Authorized execution: release proposal with VALID nonce via forwardApprove (mobile 1-tap/biometric bridge)
    const validApprove = await forwardApprove(
      { proposalId, nonce: approvalNonce, reason: "Verified on Pixel via biometric authentication" },
      relayEnv,
    );
    assert.equal(validApprove.status, 200, `valid approval status: ${JSON.stringify(validApprove.body)}`);
    const validBody = validApprove.body as {
      ok: boolean;
      status: string;
      proposal_id: string;
      release: { ok: boolean; result: { status: string; proposalId: string; releasedPayload: unknown } };
    };
    assert.equal(validBody.ok, true);
    assert.equal(validBody.status, "approved");
    assert.equal(validBody.proposal_id, proposalId);
    assert.equal(validBody.release.ok, true);
    assert.equal(validBody.release.result.status, "released");

    // =========================================================================
    // Evolution Cycle N+3: Bi-Directional Actuation & Autonomous Playbook Synthesis
    // =========================================================================

    // Step 12: Mesh Actuation Dispatch: released payload dispatched to agent-mesh-mcp (:39401)
    const dispatchOutcome = await forwardDelegate(
      envelope("agent-mesh-mcp", "dispatch", "mesh", {
        proposalId,
        skillId: "mesh-do",
        payload: validBody.release.result,
      }),
      relayEnv,
    );
    assert.equal(dispatchOutcome.status, 200, `mesh dispatch status: ${JSON.stringify(dispatchOutcome.body)}`);
    const dispatchBody = dispatchOutcome.body as {
      ok: boolean;
      result: { status: string; skill: { id: string; tier: number }; executionId: string };
    };
    assert.equal(dispatchBody.ok, true);
    assert.equal(dispatchBody.result.status, "dispatched");
    assert.equal(dispatchBody.result.skill.id, "mesh-do");
    assert.ok(dispatchBody.result.executionId.startsWith("exec_"));

    // Step 13: Mesh Playbook Execution: HTTP playbook execution is not implemented, so the mesh must say so
    // instead of fabricating a completed run.
    const playbookOutcome = await forwardDelegate(
      envelope("agent-mesh-mcp", "playbook", "mesh", {
        playbookId: "ambient_biometric_sync",
        proposalId,
      }),
      relayEnv,
    );
    assert.equal(playbookOutcome.status, 501, `mesh playbook status: ${JSON.stringify(playbookOutcome.body)}`);
    const playbookBody = playbookOutcome.body as {
      ok: boolean;
      result: { ok: boolean; error: string; playbookId: string; runId?: string; status?: string };
    };
    assert.equal(playbookBody.ok, false);
    assert.equal(playbookBody.result.error, "HTTP playbook execution is not implemented");
    assert.equal(playbookBody.result.playbookId, "ambient_biometric_sync");
    assert.equal(playbookBody.result.runId, undefined);
    assert.equal(playbookBody.result.status, undefined);

    // Step 14: Bi-directional Device Actuation via Hermes Bridge (:3000 -> :8766)
    const deviceOutcome = await forwardDelegate(
      envelope("hermes-api", "device", "device", {
        command: "notify",
        target: "com.pieces.android.companion",
        text: "Action executed following biometric verification",
        proposalId,
      }),
      relayEnv,
    );
    assert.equal(deviceOutcome.status, 200, `hermes device status: ${JSON.stringify(deviceOutcome.body)}`);
    const deviceBody = deviceOutcome.body as {
      ok: boolean;
      result: { status: string; command: string; delivered: boolean; dispatchId: string };
    };
    assert.equal(deviceBody.ok, true);
    assert.equal(deviceBody.result.status, "sent_to_relay");
    assert.equal(deviceBody.result.command, "notify");
    assert.equal(deviceBody.result.delivered, true);
    assert.ok(deviceBody.result.dispatchId.startsWith("dev_"));

    // Step 15: Replay attack prevention: single-use nonce is now consumed, second release must 404/fail
    const replayApprove = await forwardApprove(
      { proposalId, nonce: approvalNonce },
      relayEnv,
    );
    assert.notEqual(replayApprove.status, 200, "replayed nonce must not succeed");
    assert.equal(replayApprove.status, 404);

    // Step 16: Proposal rejection & cache eviction flow
    const secondSpeculate = await forwardDelegate(
      envelope("registry-app", "speculate", "staging", { events: telemetryEvents }),
      relayEnv,
    );
    assert.equal(secondSpeculate.status, 200);
    const secondBody = secondSpeculate.body as { ok: boolean; result: { proposalId: string; approvalNonce: string } };
    const propToReject = secondBody.result.proposalId;

    const rejectOutcome = await forwardApprove(
      { proposalId: propToReject, action: "reject", reason: "User tapped dismiss" },
      relayEnv,
    );
    assert.equal(rejectOutcome.status, 200, `reject status: ${JSON.stringify(rejectOutcome.body)}`);
    const rejectBody = rejectOutcome.body as { ok: boolean; status: string; upstream_notified: boolean };
    assert.equal(rejectBody.ok, true);
    assert.equal(rejectBody.status, "rejected");
    assert.equal(rejectBody.upstream_notified, true);

    // Verify rejection evicted the proposal: attempting to release now fails with 404
    const postRejectRelease = await forwardApprove(
      { proposalId: propToReject, nonce: secondBody.result.approvalNonce },
      relayEnv,
    );
    assert.equal(postRejectRelease.status, 404, "rejected proposal must be evicted from cache");

    // =========================================================================
    // Evolution Cycle N+4: Live Mobile Glass Integration & Autonomic Playbook Self-Synthesis
    // =========================================================================

    // Step 17: Autonomic Playbook Synthesis: frequent recurring cluster induces a DAG playbook
    const synthOutcome = await forwardDelegate(
      envelope("agent-mesh-mcp", "synthesize", "mesh", {
        candidateId: "cluster-com.android.chrome",
        packageName: "com.android.chrome",
        sequence: ["open_reader", "extract_body", "stage_digest"],
        supportCount: 5,
        daysObserved: 3,
      }),
      relayEnv,
    );
    assert.equal(synthOutcome.status, 200, `mesh synthesis status: ${JSON.stringify(synthOutcome.body)}`);
    const synthBody = synthOutcome.body as {
      ok: boolean;
      result: {
        status: string;
        playbookId: string;
        pb_hash: string;
        tier: number;
        requiresBiometricApproval: boolean;
      };
    };
    assert.equal(synthBody.ok, true);
    assert.equal(synthBody.result.status, "synthesized");
    assert.equal(synthBody.result.tier, 1, "synthesized playbooks must start at unescalated tier 1");
    assert.equal(synthBody.result.requiresBiometricApproval, true, "template escalation requires biometric signoff");
    assert.ok(synthBody.result.pb_hash.length === 64, "pb_hash must be a 256-bit SHA-256 hex digest");
    const synthesizedPlaybookId = synthBody.result.playbookId;

    // Step 18: Security Invariant: Playbook synthesis rejects security-sensitive surfaces
    const sensitiveSynth = await forwardDelegate(
      envelope("agent-mesh-mcp", "synthesize", "mesh", {
        candidateId: "cluster-banking",
        packageName: "com.chase.sig.android",
        sensitiveSurfaces: ["Bank Login Screen", "Auth PIN Entry"],
        supportCount: 10,
      }),
      relayEnv,
    );
    assert.equal(sensitiveSynth.status, 422, "sensitive surfaces must be rejected");
    const sensitiveBody = sensitiveSynth.body as { ok: boolean; result?: { error: string } };
    assert.equal(sensitiveBody.ok, true);

    // Step 19: Pre-execute and stage the synthesized playbook in DryRunCache (:39403)
    const synthSpeculate = await forwardDelegate(
      envelope("registry-app", "speculate", "staging", {
        candidateId: "cluster-com.android.chrome",
        actionPayload: { playbookId: synthesizedPlaybookId, action: "playbook" },
      }),
      relayEnv,
    );
    assert.equal(synthSpeculate.status, 200);
    const synthSpecBody = synthSpeculate.body as {
      ok: boolean;
      result: { proposalId: string; approvalNonce: string; status: string };
    };
    assert.equal(synthSpecBody.ok, true);
    assert.equal(synthSpecBody.result.status, "dry_run_ready");
    const synthProposalId = synthSpecBody.result.proposalId;
    const synthNonce = synthSpecBody.result.approvalNonce;

    // Step 20: Mobile biometric client signs approval and releases the synthesized playbook
    const synthApprove = await forwardApprove(
      {
        proposalId: synthProposalId,
        nonce: synthNonce,
        reason: "User confirmed synthesized playbook template via fingerprint",
        biometricAttestation: { method: "fingerprint", timestamp: new Date().toISOString() },
      },
      relayEnv,
    );
    assert.equal(synthApprove.status, 200, `synth approval failed: ${JSON.stringify(synthApprove.body)}`);
    const synthApproveBody = synthApprove.body as {
      ok: boolean;
      status: string;
      release: { ok: boolean; result: { status: string } };
    };
    assert.equal(synthApproveBody.ok, true);
    assert.equal(synthApproveBody.status, "approved");
    assert.equal(synthApproveBody.release.result.status, "released");

    // Step 21: Auto-demotion on user undo or failure drops the playbook into quarantine
    const demoteOutcome = await forwardDelegate(
      envelope("agent-mesh-mcp", "demote", "mesh", {
        playbookId: synthesizedPlaybookId,
        reason: "user_undo",
      }),
      relayEnv,
    );
    assert.equal(demoteOutcome.status, 200, `demote status: ${JSON.stringify(demoteOutcome.body)}`);
    const demoteBody = demoteOutcome.body as {
      ok: boolean;
      result: { status: string; playbookId: string; autonomousAllowed: boolean };
    };
    assert.equal(demoteBody.ok, true);
    assert.equal(demoteBody.result.status, "quarantined");
    assert.equal(demoteBody.result.autonomousAllowed, false, "quarantined playbook cannot run autonomously");

    // Verify quarantined playbook execution fails closed with 403
    const blockedExec = await forwardDelegate(
      envelope("agent-mesh-mcp", "playbook", "mesh", {
        playbookId: synthesizedPlaybookId,
      }),
      relayEnv,
    );
    assert.equal(blockedExec.status, 403, "quarantined playbook execution must fail closed");

    // =========================================================================
    // Evolution Cycle N+5: Continuous Ambient Sentinel & Daemon Supervisor
    // =========================================================================

    // Step 22: Sentinel background health probe monitors all operational nodes
    const healthStatuses = await checkAllNodesHealth(handle.upstreams);
    assert.equal(healthStatuses.length, Object.keys(handle.upstreams).length, "sentinel must probe all configured upstream nodes without dropping any");
    for (const node of healthStatuses) {
      assert.equal(node.healthy, true, `sentinel health check failed for node ${node.id} on port ${node.port}: ${node.statusText}`);
    }

    // Dead port returns healthy: false (negative health check)
    const deadProbe = await checkNodeHealth(59999, 300);
    assert.equal(deadProbe.healthy, false, "dead port must report healthy: false");

    // =========================================================================
    // Evolution Cycle N+6: Surprisal Feedback Engine & Continuous Reinforcement
    // =========================================================================

    // Step 23: Low surprisal on approved behavior reinforces the model weight
    const approveFeedback = await forwardDelegate(
      envelope("pattern-analyzer", "feedback", "patterns", {
        actionType: "approve",
        candidateId: "cluster-com.android.chrome",
        priorConfidence: 0.85,
      }),
      relayEnv,
    );
    assert.equal(approveFeedback.status, 200, `approve feedback status: ${JSON.stringify(approveFeedback.body)}`);
    const approveFeedbackBody = approveFeedback.body as {
      ok: boolean;
      result: {
        actionType: string;
        outcome: string;
        candidateId: string;
        surprisal: number;
        multiplier: number;
        demoteRecommended: boolean;
      };
    };
    assert.equal(approveFeedbackBody.ok, true);
    assert.equal(approveFeedbackBody.result.outcome, "approved");
    assert.ok(approveFeedbackBody.result.surprisal < 1.0, "approved actions must have low surprisal");
    assert.ok(approveFeedbackBody.result.multiplier > 1.0, "approved actions must have multiplier > 1.0");
    assert.equal(approveFeedbackBody.result.demoteRecommended, false);

    // Step 24: High surprisal on undone/divergent behavior triggers demotion
    const undoFeedback = await forwardDelegate(
      envelope("pattern-analyzer", "feedback", "patterns", {
        actionType: "undone",
        candidateId: "cluster-com.android.chrome",
        priorConfidence: 0.05,
      }),
      relayEnv,
    );
    assert.equal(undoFeedback.status, 200, `undo feedback status: ${JSON.stringify(undoFeedback.body)}`);
    const undoFeedbackBody = undoFeedback.body as {
      ok: boolean;
      result: {
        actionType: string;
        outcome: string;
        candidateId: string;
        surprisal: number;
        multiplier: number;
        demoteRecommended: boolean;
      };
    };
    assert.equal(undoFeedbackBody.ok, true);
    assert.equal(undoFeedbackBody.result.outcome, "undone");
    assert.ok(undoFeedbackBody.result.surprisal > 3.0, "undone actions must have high surprisal");
    assert.ok(undoFeedbackBody.result.multiplier < 0.5, "undone actions must have penalizing multiplier < 0.5");
    assert.equal(undoFeedbackBody.result.demoteRecommended, true);

    // Negative feedback test: missing outcome fails closed with 400
    const badFeedback = await forwardDelegate(
      envelope("pattern-analyzer", "feedback", "patterns", {
        candidateId: "cluster-com.android.chrome",
      }),
      relayEnv,
    );
    assert.equal(badFeedback.status, 400, "feedback without outcome must fail closed with 400");

    // =========================================================================
    // Evolution Cycle N+7: Sovereign Memory Independence (Zero-Cloud LocalLTM)
    // =========================================================================

    // Step 25: Store and retrieve memories locally via pieces-for-all (:39400) with zero cloud token rent
    const storeMemory = await forwardDelegate(
      envelope("pieces-for-all", "memory", "memory", {
        action: "add",
        title: "Autonomous Triad Sentinel Protocol",
        body: "Air-gapped background execution loop with zero cloud egress and local biometric gating.",
        tags: ["exocortex", "sentinel", "sovereign"],
      }),
      relayEnv,
    );
    assert.equal(storeMemory.status, 200, `store memory status: ${JSON.stringify(storeMemory.body)}`);
    const storeBody = storeMemory.body as {
      ok: boolean;
      result: { status: string; memory: { title: string } };
    };
    assert.equal(storeBody.ok, true);
    assert.equal(storeBody.result.status, "added");
    assert.equal(storeBody.result.memory.title, "Autonomous Triad Sentinel Protocol");

    const searchMemory = await forwardDelegate(
      envelope("pieces-for-all", "memory", "memory", {
        action: "search",
        query: "sentinel protocol air-gapped",
        limit: 3,
      }),
      relayEnv,
    );
    assert.equal(searchMemory.status, 200, `search memory status: ${JSON.stringify(searchMemory.body)}`);
    const searchBody = searchMemory.body as {
      ok: boolean;
      result: {
        status: string;
        matches: Array<{ title: string; score: number; untrusted: boolean }>;
      };
    };
    assert.equal(searchBody.ok, true);
    assert.equal(searchBody.result.status, "searched");
    assert.ok(searchBody.result.matches.length >= 1, "must find relevant memory match");
    assert.equal(searchBody.result.matches[0].title, "Autonomous Triad Sentinel Protocol");
    assert.ok(searchBody.result.matches[0].score > 0, "score must be positive");
    assert.equal(searchBody.result.matches[0].untrusted, true, "memory retrieved from store must be labeled untrusted");

    // Negative memory test: invalid add payload fails closed with 400
    const badMemoryAdd = await forwardDelegate(
      envelope("pieces-for-all", "memory", "memory", {
        action: "add",
        title: "",
      }),
      relayEnv,
    );
    assert.equal(badMemoryAdd.status, 400, "memory add with empty title must fail closed with 400");

    // Negative memory test: empty query fails closed with 400
    const badMemorySearch = await forwardDelegate(
      envelope("pieces-for-all", "memory", "memory", {
        action: "search",
        query: "",
      }),
      relayEnv,
    );
    assert.equal(badMemorySearch.status, 400, "memory search with empty query must fail closed with 400");
  } finally {
    await stopMishmash(handle);
    if (priorToken === undefined) delete process.env.GATEWAY_TOKEN;
    else process.env.GATEWAY_TOKEN = priorToken;
  }

});

