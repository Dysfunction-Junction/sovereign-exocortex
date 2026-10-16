import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetQuarantineForTest,
  handleMeshDelegate,
  startMeshDelegate,
} from "../mishmash-delegate.js";

const envelope = {
  v: 1,
  id: "0123456789abcdef",
  from: "pieces-android-companion-seamless",
  to: "agent-mesh-mcp",
  capability: "mesh",
  payload: {},
};

describe("mishmash delegate", () => {
  beforeEach(() => {
    _resetQuarantineForTest();
  });
  it("returns the four mesh skill tiers without starting a provider", () => {
    const outcome = handleMeshDelegate({ ...envelope, action: "skills" });
    expect(outcome.status).toBe(200);
    const result = outcome.body.result as { skills: Array<{ id: string; tier: number }> };
    expect(result.skills.map((skill) => skill.id)).toEqual([
      "mesh-do",
      "mesh-review",
      "mesh-waves",
      "mesh-swarm",
    ]);
    expect(result.skills.map((skill) => skill.tier)).toEqual([1, 2, 3, 4]);
  });

  it("handles dispatch action and resolves skill metadata", () => {
    const outcome = handleMeshDelegate({
      ...envelope,
      action: "dispatch",
      payload: { skillId: "mesh-review", target: "pattern-analyzer" },
    });
    expect(outcome.status).toBe(200);
    const result = outcome.body.result as any;
    expect(result.action).toBe("dispatch");
    expect(result.status).toBe("dispatched");
    expect(result.skill.id).toBe("mesh-review");
    expect(result.skill.tier).toBe(2);
    expect(result.executionId).toMatch(/^exec_/);
  });

  it("handles playbook action and returns completed execution state", () => {
    const outcome = handleMeshDelegate({
      ...envelope,
      action: "playbook",
      payload: { playbookId: "ambient_biometric_sync" },
    });
    expect(outcome.status).toBe(200);
    const result = outcome.body.result as any;
    expect(result.action).toBe("playbook");
    expect(result.playbookId).toBe("ambient_biometric_sync");
    expect(result.runId).toMatch(/^run_/);
    expect(result.status).toBe("completed");
  });

  it("synthesizes a new playbook DAG with pb_hash and unescalated tier 1", () => {
    const outcome = handleMeshDelegate({
      ...envelope,
      action: "synthesize",
      payload: {
        candidateId: "cluster-com.android.chrome",
        packageName: "com.android.chrome",
        sequence: ["open_tab", "read_article", "save_snippet"],
        supportCount: 5,
        daysObserved: 3,
      },
    });
    expect(outcome.status).toBe(200);
    const result = outcome.body.result as any;
    expect(result.action).toBe("synthesize");
    expect(result.status).toBe("synthesized");
    expect(result.tier).toBe(1);
    expect(result.requiresBiometricApproval).toBe(true);
    expect(result.pb_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.autonomousAllowed).toBe(false);
    expect(result.steps).toEqual(["open_tab", "read_article", "save_snippet"]);

    // Deterministic hash assertion: same input yields identical pb_hash and playbookId
    const outcome2 = handleMeshDelegate({
      ...envelope,
      action: "synthesize",
      payload: {
        candidateId: "cluster-com.android.chrome",
        packageName: "com.android.chrome",
        sequence: ["open_tab", "read_article", "save_snippet"],
        supportCount: 5,
      },
    });
    const result2 = outcome2.body.result as any;
    expect(result2.pb_hash).toBe(result.pb_hash);
    expect(result2.playbookId).toBe(result.playbookId);
  });

  it("rejects synthesis when supportCount is omitted, invalid, or < 3", () => {
    for (const invalidSc of [undefined, "five", NaN, 2.5, 2, -1]) {
      const outcome = handleMeshDelegate({
        ...envelope,
        action: "synthesize",
        payload: {
          candidateId: "cluster-com.android.chrome",
          packageName: "com.android.chrome",
          supportCount: invalidSc,
        },
      });
      expect(outcome.status).toBe(400);
      const res = outcome.body.result as any;
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/supportCount must be an integer >= 3/);
    }
  });

  it("rejects synthesis when packageName is missing or malformed", () => {
    for (const invalidPkg of [undefined, "", "Chrome", "com..invalid", 123]) {
      const outcome = handleMeshDelegate({
        ...envelope,
        action: "synthesize",
        payload: {
          candidateId: "cluster-test",
          packageName: invalidPkg,
          supportCount: 5,
        },
      });
      expect(outcome.status).toBe(400);
      const res = outcome.body.result as any;
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/valid packageName is required/);
    }
  });

  it("rejects synthesis when security-sensitive surfaces are touched or present in packageName", () => {
    // 1. Explicit sensitive surfaces
    const outcome = handleMeshDelegate({
      ...envelope,
      action: "synthesize",
      payload: {
        candidateId: "cluster-banking",
        packageName: "com.chase.sig.android",
        sensitiveSurfaces: ["Bank Login Screen", "Auth PIN Entry"],
        supportCount: 10,
      },
    });
    expect(outcome.status).toBe(422);
    const result = outcome.body.result as any;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/sensitive surface denylisted/);

    // 2. Implicit sensitive package without sensitiveSurfaces field provided
    const outcomeImplicit = handleMeshDelegate({
      ...envelope,
      action: "synthesize",
      payload: {
        candidateId: "cluster-auth",
        packageName: "com.paypal.android.p2pmobile",
        supportCount: 10,
      },
    });
    expect(outcomeImplicit.status).toBe(422);
  });

  it("rejects synthesis when sensitiveSurfaces contains non-strings", () => {
    const outcome = handleMeshDelegate({
      ...envelope,
      action: "synthesize",
      payload: {
        candidateId: "cluster-com.android.chrome",
        packageName: "com.android.chrome",
        sensitiveSurfaces: [1, null],
        supportCount: 5,
      },
    });
    expect(outcome.status).toBe(400);
    const result = outcome.body.result as any;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/sensitiveSurfaces must be an array of strings/);
  });

  it("prohibits self-escalation if steps require tier > 1", () => {
    const outcome = handleMeshDelegate({
      ...envelope,
      action: "synthesize",
      payload: {
        candidateId: "cluster-com.android.chrome",
        packageName: "com.android.chrome",
        steps: ["mesh-do", "mesh-waves"], // mesh-waves is tier 3
        supportCount: 5,
      },
    });
    expect(outcome.status).toBe(403);
    const result = outcome.body.result as any;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/self-escalation prohibited/);
  });

  it("demotes a failing or undone playbook to quarantine and blocks execution", () => {
    const targetPlaybook = "synth_com_android_chrome_demote_test";
    const outcome = handleMeshDelegate({
      ...envelope,
      action: "demote",
      payload: {
        playbookId: targetPlaybook,
        reason: "user_undo",
      },
    });
    expect(outcome.status).toBe(200);
    const result = outcome.body.result as any;
    expect(result.action).toBe("demote");
    expect(result.status).toBe("quarantined");
    expect(result.playbookId).toBe(targetPlaybook);
    expect(result.autonomousAllowed).toBe(false);
    expect(result.reason).toBe("user_undo");

    // Execution of quarantined playbook must now fail closed with 403
    const execOutcome = handleMeshDelegate({
      ...envelope,
      action: "playbook",
      payload: {
        playbookId: targetPlaybook,
      },
    });
    expect(execOutcome.status).toBe(403);
    const execResult = execOutcome.body.result as any;
    expect(execResult.ok).toBe(false);
    expect(execResult.error).toMatch(/quarantined and cannot be executed/);
  });

  it("demotes with pb_hash and blocks subsequent execution by pb_hash", () => {
    const targetPlaybook = "synth_com_android_chrome_hash_test";
    const targetHash = "abc123def4567890abcdef1234567890abcdef1234567890abcdef1234567890";
    const outcome = handleMeshDelegate({
      ...envelope,
      action: "demote",
      payload: {
        playbookId: targetPlaybook,
        pb_hash: targetHash,
        reason: "drift",
      },
    });
    expect(outcome.status).toBe(200);

    // Attempt to execute using an unquarantined playbookId name but passing the quarantined pb_hash
    const bypassAttempt = handleMeshDelegate({
      ...envelope,
      action: "playbook",
      payload: {
        playbookId: "innocent_playbook_name",
        pb_hash: targetHash,
      },
    });
    expect(bypassAttempt.status).toBe(403);
    const bypassResult = bypassAttempt.body.result as any;
    expect(bypassResult.ok).toBe(false);
    expect(bypassResult.error).toMatch(/quarantined and cannot be executed/);
  });

  it("demotes with uppercase pb_hash and blocks subsequent execution case-insensitively", () => {
    const targetPlaybook = "synth_com_android_chrome_case_test";
    const targetHashLower = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    const targetHashUpper = targetHashLower.toUpperCase();
    const outcome = handleMeshDelegate({
      ...envelope,
      action: "demote",
      payload: {
        playbook_id: targetPlaybook,
        pb_hash: targetHashUpper,
        reason: "execution_error",
      },
    });
    expect(outcome.status).toBe(200);

    // Execution with lowercase hash must be blocked
    const execOutcome = handleMeshDelegate({
      ...envelope,
      action: "playbook",
      payload: {
        playbook_id: "other_id",
        pb_hash: targetHashLower,
      },
    });
    expect(execOutcome.status).toBe(403);
  });

  it("rejects malformed hashes with 400 without modifying quarantine", () => {
    const outcome = handleMeshDelegate({
      ...envelope,
      action: "demote",
      payload: {
        playbook_id: "synth_short_hash_test",
        pb_hash: "not-a-sha256-hash",
      },
    });
    expect(outcome.status).toBe(400);
    const result = outcome.body.result as any;
    expect(result.error).toMatch(/invalid pb_hash format/);

    const execOutcome = handleMeshDelegate({
      ...envelope,
      action: "playbook",
      payload: {
        playbook_id: "synth_short_hash_test",
        pb_hash: "not-a-sha256-hash",
      },
    });
    expect(execOutcome.status).toBe(400);
  });

  it("rejects playbook or demote call with conflicting aliases", () => {
    const outcome = handleMeshDelegate({
      ...envelope,
      action: "playbook",
      payload: {
        playbookId: "alpha",
        playbook_id: "beta",
      },
    });
    expect(outcome.status).toBe(400);
    const result = outcome.body.result as any;
    expect(result.error).toMatch(/conflicting playbookId and playbook_id/);

    const hashConflictOutcome = handleMeshDelegate({
      ...envelope,
      action: "playbook",
      payload: {
        playbookId: "alpha",
        pb_hash: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        pbHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      },
    });
    expect(hashConflictOutcome.status).toBe(400);
    const hashResult = hashConflictOutcome.body.result as any;
    expect(hashResult.error).toMatch(/conflicting pb_hash and pbHash/);
  });

  it("enforces case-insensitive playbook name quarantine", () => {
    const outcome = handleMeshDelegate({
      ...envelope,
      action: "demote",
      payload: {
        playbookId: "SYNTH_UPPER_CASE_PLAYBOOK",
        reason: "user_undo",
      },
    });
    expect(outcome.status).toBe(200);

    const execOutcome = handleMeshDelegate({
      ...envelope,
      action: "playbook",
      payload: {
        playbookId: "synth_upper_case_playbook",
      },
    });
    expect(execOutcome.status).toBe(403);
  });

  it("fails closed with 507 when quarantine capacity is exhausted and blocks execution", () => {
    // Fill quarantine up to MAX_QUARANTINE_ENTRIES (1000)
    for (let i = 0; i < 1000; i++) {
      const fillOutcome = handleMeshDelegate({
        ...envelope,
        action: "demote",
        payload: {
          playbookId: `fill_quarantine_entry_${i}`,
          reason: "drift",
        },
      });
      expect(fillOutcome.status).toBe(200);
    }

    // Next unique demote must fail closed with 507
    const overflowOutcome = handleMeshDelegate({
      ...envelope,
      action: "demote",
      payload: {
        playbookId: "overflow_entry",
        reason: "execution_error",
      },
    });
    expect(overflowOutcome.status).toBe(507);
    const result = overflowOutcome.body.result as any;
    expect(result.error).toMatch(/quarantine capacity exceeded/);

    // Any subsequent execution must also fail closed
    const lockedDownExec = handleMeshDelegate({
      ...envelope,
      action: "playbook",
      payload: {
        playbookId: "unrelated_innocent_playbook",
      },
    });
    expect(lockedDownExec.status).toBe(403);
  });

  it("rejects demote call without playbookId", () => {
    const outcome = handleMeshDelegate({
      ...envelope,
      action: "demote",
      payload: {},
    });
    expect(outcome.status).toBe(400);
    const result = outcome.body.result as any;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/playbookId string is required/);
  });
  describe("loopback HTTP surface", () => {
    let server: Server | undefined;
    afterEach(async () => {
      await new Promise<void>((resolve) =>
        server ? server.close(() => resolve()) : resolve(),
      );
      server = undefined;
    });

    function post(
      port: number,
      headers: Record<string, string>,
      body: unknown,
    ): Promise<{ status: number; body: string }> {
      return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/mishmash/delegate",
            method: "POST",
            headers: { "content-length": Buffer.byteLength(payload), ...headers },
          },
          (res) => {
            let text = "";
            res.on("data", (chunk) => (text += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
          },
        );
        req.on("error", reject);
        req.end(payload);
      });
    }

    it("rejects browser-origin and DNS-rebound requests without changing state", async () => {
      server = await startMeshDelegate(0);
      const port = (server.address() as AddressInfo).port;
      const demote = { ...envelope, action: "demote", payload: { playbookId: "victim" } };

      const crossSite = await post(
        port,
        { "content-type": "text/plain", origin: "https://evil.example" },
        demote,
      );
      expect(crossSite.status).toBe(403);
      const rebound = await post(
        port,
        { "content-type": "application/json", host: `evil.example:${port}` },
        demote,
      );
      expect(rebound.status).toBe(403);
      expect(
        handleMeshDelegate({ ...envelope, action: "playbook", payload: { playbookId: "victim" } })
          .status,
      ).toBe(200);

      const local = await post(port, { "content-type": "application/json" }, {
        ...envelope,
        action: "ping",
      });
      expect(local.status).toBe(200);
    });
  });

  it("rejects (instead of hanging) when the port is already in use", async () => {
    const first = await startMeshDelegate(0);
    const taken = (first.address() as AddressInfo).port;
    try {
      await expect(startMeshDelegate(taken)).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await new Promise<void>((r) => first.close(() => r()));
    }
  });
});



