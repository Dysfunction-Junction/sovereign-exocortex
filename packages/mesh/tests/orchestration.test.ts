import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  getOrchestrationPreset,
  listOrchestrationPresets,
} from "../src/orchestration-presets.js";
import { PlanRegistry } from "../src/plans.js";
import { SwarmRegistry } from "../src/swarm.js";
import { InitiativeRegistry } from "../src/initiatives.js";
import { deriveTaskTimingMetrics } from "../src/telemetry.js";
import {
  buildAntigravityMcpProfile,
  buildClaudeMcpProfile,
  buildCodexMcpProfile,
  buildGrokMcpProfile,
  COORDINATION_TOOLS,
  MANAGED_PEER_TOOLS,
  isMcpProfileAllowed,
} from "../src/mcp-profiles.js";
import type { TaskRecord } from "../src/types.js";
import { TaskRegistry } from "../src/registry.js";
import {
  coordinationCapability,
  managedPeerCapability,
  verifyCoordinationCapability,
  verifyManagedPeerCapability,
} from "../src/coordination-auth.js";
import { isProviderOutputEvent } from "../src/telemetry.js";
import {
  BUILTIN_PLAYBOOKS,
  PLAYBOOK_POLICY_VERSION,
  PlaybookRegistry,
  compileExecutionManifest,
  digestJson,
  evaluateWaveGate,
  goalDigest,
  listBuiltinPlaybooks,
  openFindings,
  parseStepReport,
  validatePlaybookDefinition,
} from "../src/playbooks.js";
import {
  PlaybookController,
  PlaybookRunDriver,
  builtinAutoRunAllowed,
  runAdvanceDue,
} from "../src/playbook-tools.js";
import {
  InstructionProposalStore,
  instructionProposalContentDigest,
  type InstructionFrictionEvidence,
} from "../src/instruction-proposals.js";
import { AgentMeshRouter } from "../src/router.js";
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderModel,
  ProviderResult,
  ProviderRunHooks,
  ProviderRunRequest,
} from "../src/types.js";
import type { ProviderAdministration } from "../src/provider-admin.js";
import {
  MESH_WRITE_SYNCHRONIZATION_PROTOCOL,
  ORCHESTRATION_POLICY,
  ORCHESTRATION_POLICY_VERSION,
  prependWriteSynchronizationProtocol,
  taskPolicyAddendum,
} from "../src/orchestration-policy.js";
import {
  MAX_DIALOG_CHARACTERS,
  MAX_DETAIL_VIEWS,
  buildApprovalDialogText,
  escapeAppleScriptString,
  renderApprovalDetailPage,
  requireHumanApproval,
  type ApprovalChoice,
  type ApprovalRequest,
} from "../src/human-approval.js";

const temporary: string[] = [];
function tempPath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), "agent-mesh-orchestration-"));
  temporary.push(directory);
  return join(directory, name);
}

function proposalEvidence(
  eventId = crypto.randomUUID(),
): InstructionFrictionEvidence {
  return {
    eventIds: [eventId],
    summary: {
      total: 2,
      byKind: [{ kind: "retry", count: 2 }],
      byProvider: [{ provider: "codex", count: 2 }],
    },
  };
}

function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const createdAt = "2026-07-13T00:00:00.000Z";
  return {
    id: crypto.randomUUID(),
    origin: "cursor",
    provider: "codex",
    description: "Test task",
    mode: "review",
    status: "queued",
    cwd: "/tmp/project",
    effectiveCwd: "/tmp/project",
    repoRoot: null,
    worktreePath: null,
    baseCommit: null,
    model: "gpt-5.6-sol",
    effort: "ultra",
    mcpProfile: "none",
    sessionId: null,
    parentTaskId: null,
    initiativeId: null,
    swarmId: null,
    swarmMemberId: null,
    ownerPid: process.pid,
    pid: null,
    resultPath: null,
    eventsPath: null,
    transcriptPath: null,
    pendingQuestionId: null,
    patchPath: null,
    changedFiles: [],
    artifactStatus: "not_applicable",
    error: null,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    ...overrides,
  };
}

class ImmediateCodexAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;

  capabilities(): ProviderCapabilities {
    return {
      provider: this.provider,
      dynamicModelDiscovery: true,
      resume: true,
      fork: true,
      nativeSessionSearch: false,
      nativeCancellation: false,
      notes: [],
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    return [{ id: "gpt-test", isDefault: true, reasoningEfforts: ["high"] }];
  }

  async run(
    request: ProviderRunRequest,
    hooks: ProviderRunHooks,
  ): Promise<ProviderResult> {
    const sessionId = crypto.randomUUID();
    hooks.onSession(sessionId);
    hooks.onStarted({ cancel: async () => undefined });
    hooks.onEvent?.({ type: "assistant" });
    return {
      output: `completed ${request.taskId}`,
      sessionId,
    };
  }
}

class ScriptedSynthesisAdapter implements ProviderAdapter {
  constructor(
    readonly provider: "codex" | "claude",
    private readonly definition: unknown,
  ) {}

  capabilities(): ProviderCapabilities {
    return {
      provider: this.provider,
      dynamicModelDiscovery: true,
      resume: true,
      fork: true,
      nativeSessionSearch: false,
      nativeCancellation: false,
      notes: [],
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    return [
      {
        id:
          this.provider === "codex"
            ? "gpt-5.6-sol"
            : "claude-opus-5",
        isDefault: true,
      },
    ];
  }

  async run(
    request: ProviderRunRequest,
    hooks: ProviderRunHooks,
  ): Promise<ProviderResult> {
    const sessionId = crypto.randomUUID();
    hooks.onSession(sessionId);
    hooks.onStarted({ cancel: async () => undefined });
    return {
      output: request.prompt.startsWith("Adversarially review")
        ? "Candidate is bounded and safe; retain its single review wave."
        : JSON.stringify(this.definition),
      sessionId,
    };
  }
}

function fakeProviderAdmin(): ProviderAdministration {
  return {
    async providerStatus(provider) {
      return {
        provider,
        installed: provider === "codex",
        version: provider === "codex" ? "test" : null,
        binaryPath: provider === "codex" ? "/fake/codex" : null,
        auth: {
          state: provider === "codex" ? "authenticated" : "unauthenticated",
          account: null,
          summary: "test",
        },
        configuredModel: null,
        defaultModel: provider === "codex" ? "gpt-test" : null,
        defaultModelSource: provider === "codex" ? "provider" : "unknown",
        capabilities: {
          dynamicModelDiscovery: true,
          nativeDoctor: false,
          readOnlyUpdateCheck: false,
          update: false,
          logout: false,
          usage: { rateLimits: false, cost: false, session: false },
          notes: [],
        },
        warnings: [],
      };
    },
    async listProviderModels(provider) {
      return provider === "codex"
        ? [{ id: "gpt-test", isDefault: true, reasoningEfforts: ["high"] }]
        : [];
    },
    async providerUsage(provider) {
      return {
        provider,
        rateLimits: { status: "unsupported", value: null, reason: "test" },
        cost: { status: "unsupported", value: null, reason: "test" },
        session: { status: "unsupported", value: null, reason: "test" },
      };
    },
    async providerDoctor(provider) {
      return {
        provider,
        health: "ok",
        native: false,
        checks: [],
        summary: "test",
      };
    },
    async providerUpdateCheck(provider) {
      return {
        provider,
        supported: false,
        currentVersion: null,
        latestVersion: null,
        updateAvailable: null,
        source: "test",
        reason: "test",
      };
    },
    async providerUpdate() {
      throw new Error("unsupported");
    },
    async providerLogout() {
      throw new Error("unsupported");
    },
  };
}

function synthesisProviderAdmin(): ProviderAdministration {
  const admin = fakeProviderAdmin();
  return {
    ...admin,
    async providerStatus(provider) {
      const available = provider === "codex" || provider === "claude";
      return {
        provider,
        installed: available,
        version: available ? "test" : null,
        binaryPath: available ? `/fake/${provider}` : null,
        auth: {
          state: available ? "authenticated" : "unauthenticated",
          account: null,
          summary: "test",
        },
        configuredModel: null,
        defaultModel:
          provider === "codex"
            ? "gpt-5.6-sol"
            : provider === "claude"
              ? "claude-opus-5"
              : null,
        defaultModelSource: available ? "provider" : "unknown",
        capabilities: {
          dynamicModelDiscovery: true,
          nativeDoctor: false,
          readOnlyUpdateCheck: false,
          update: false,
          logout: false,
          usage: { rateLimits: false, cost: false, session: false },
          notes: [],
        },
        warnings: [],
      };
    },
    async listProviderModels(provider) {
      if (provider === "codex") return [{ id: "gpt-5.6-sol", isDefault: true }];
      if (provider === "claude") {
        return [{ id: "claude-opus-5", isDefault: true }];
      }
      return [];
    },
  };
}

afterEach(() => {
  delete process.env.AGENT_MESH_ALLOWED_ROOTS;
  delete process.env.AGENT_MESH_PLAYBOOK_AUTO_RUN_BUILTINS;
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("orchestration presets", () => {
  it("publishes the bumped write-synchronization policy without adding it to read-only addenda", () => {
    expect(ORCHESTRATION_POLICY_VERSION).toBe("2026-07-25.3");
    expect(ORCHESTRATION_POLICY).toContain(
      MESH_WRITE_SYNCHRONIZATION_PROTOCOL,
    );
    expect(MESH_WRITE_SYNCHRONIZATION_PROTOCOL).toContain(
      "// MESH[2026-07-25T15:42Z][agent:codex-reviewer][direction:d41f/3]",
    );
    expect(
      prependWriteSynchronizationProtocol("Implement the change."),
    ).toMatch(/^## Mandatory write synchronization/);
    expect(
      taskPolicyAddendum({ role: "researcher" }),
    ).not.toContain("Mandatory write synchronization");
  });

  it("uses maximum-quality models and serializes the implementation writer", () => {
    const presets = listOrchestrationPresets();
    expect(presets.map((preset) => preset.name)).toHaveLength(5);
    const productionize = getOrchestrationPreset("productionize");
    expect(productionize.modelPolicy.codex).toEqual({
      model: "gpt-5.6-sol",
      effort: "ultra",
    });
    expect(productionize.modelPolicy.claude.model).toBe("claude-opus-5");
    expect(productionize.modelPolicy.claude).toMatchObject({
      effort: "max",
      fallbackModel: "claude-fable-5",
    });
    expect(productionize.modelPolicy.grok).toEqual({
      model: "grok-4.5",
      effort: "high",
    });
    expect(productionize.modelPolicy.antigravity).toEqual({
      model: "gemini-3.6-flash-high",
      effort: "high",
    });
    expect(productionize.maxConcurrency).toBe(4);
    expect(productionize.agents.map((agent) => agent.id)).toEqual(
      expect.arrayContaining([
        "grok-planner",
        "grok-reviewer",
        "antigravity-planner",
        "antigravity-reviewer",
      ]),
    );
    expect(productionize.singleWriter).toBe(true);
    expect(productionize.waves.map((wave) => wave.id)).toEqual([
      "plan",
      "implement",
      "adversarial-review",
      "test-and-finalize",
    ]);
  });
});

describe("instruction proposal control plane", () => {
  it("persists digested proposals and enforces one-way state transitions", () => {
    const path = tempPath("instruction-proposals.db");
    const store = new InstructionProposalStore({ origin: "cursor", path });
    const proposed = store.createProposal({
      target: { kind: "mesh_skill", identifier: "mesh-review" },
      proposedContent: "# Replacement mesh review doctrine\n",
      rationale: "Repeated retries show that the review boundary is ambiguous.",
      frictionEvidence: proposalEvidence(),
    });
    expect(proposed).toMatchObject({
      sequence: 1,
      state: "proposed",
      approval: null,
      contentDigest: instructionProposalContentDigest(
        "# Replacement mesh review doctrine\n",
      ),
    });
    expect(proposed.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      store.applyProposal({
        proposalId: proposed.id,
        expectedDigest: proposed.contentDigest,
      }),
    ).toThrow(/approved before application/);
    expect(() =>
      store.approveProposal({
        proposalId: proposed.id,
        expectedDigest: "0".repeat(64),
      }),
    ).toThrow(/digest mismatch/);

    const approved = store.approveProposal({
      proposalId: proposed.id,
      expectedDigest: proposed.contentDigest,
    });
    expect(approved.state).toBe("approved");
    expect(approved.approval).toMatchObject({
      status: "approved",
      digest: proposed.contentDigest,
      method: "out_of_band_human",
    });
    expect(() =>
      store.approveProposal({
        proposalId: proposed.id,
        expectedDigest: proposed.contentDigest,
      }),
    ).toThrow(/cannot be approved/);

    const rejected = store.rejectProposal({
      proposalId: proposed.id,
      reason: "The proposed wording is too broad.",
    });
    expect(rejected).toMatchObject({
      state: "rejected",
      rejectionReason: "The proposed wording is too broad.",
      approval: { status: "void", voidReason: "proposal_rejected" },
    });
    expect(() =>
      store.approveProposal({
        proposalId: rejected.id,
        expectedDigest: rejected.contentDigest,
      }),
    ).toThrow(/cannot be approved/);
    expect(() =>
      store.rejectProposal({
        proposalId: rejected.id,
        reason: "reject twice",
      }),
    ).toThrow(/cannot be rejected/);
    expect(() =>
      store.applyProposal({
        proposalId: rejected.id,
        expectedDigest: rejected.contentDigest,
      }),
    ).toThrow(/approved before application/);

    const directlyRejected = store.createProposal({
      target: { kind: "harness_instructions", identifier: "grok" },
      proposedContent: "Record the retry before asking for a provider fallback.",
      rationale: "This draft overfits a single retry.",
      frictionEvidence: proposalEvidence(),
    });
    expect(
      store.rejectProposal({
        proposalId: directlyRejected.id,
        reason: "A single event is not a recurrent pattern.",
      }).state,
    ).toBe("rejected");

    const obsolete = store.createProposal({
      target: { kind: "harness_instructions", identifier: "claude" },
      proposedContent: "Use a bounded retry and report the friction event.",
      rationale: "The provider retry rule was missing.",
      frictionEvidence: proposalEvidence(),
    });
    const replacement = store.supersedeProposal(obsolete.id, {
      target: { kind: "harness_instructions", identifier: "claude" },
      proposedContent:
        "Use one bounded retry, then record and report the friction event.",
      rationale: "The replacement makes the retry count explicit.",
      frictionEvidence: proposalEvidence(),
    });
    expect(store.getProposal(obsolete.id).state).toBe("superseded");
    expect(replacement.supersedesProposalId).toBe(obsolete.id);
    expect(() =>
      store.approveProposal({
        proposalId: obsolete.id,
        expectedDigest: obsolete.contentDigest,
      }),
    ).toThrow(/cannot be approved/);
    expect(() =>
      store.applyProposal({
        proposalId: obsolete.id,
        expectedDigest: obsolete.contentDigest,
      }),
    ).toThrow(/approved before application/);

    const approvedObsolete = store.createProposal({
      target: { kind: "harness_instructions", identifier: "antigravity" },
      proposedContent: "Record idle waits after one bounded status check.",
      rationale: "Idle waits recur without a clear reporting boundary.",
      frictionEvidence: proposalEvidence(),
    });
    const approvedObsoleteState = store.approveProposal({
      proposalId: approvedObsolete.id,
      expectedDigest: approvedObsolete.contentDigest,
    });
    store.supersedeProposal(approvedObsolete.id, {
      target: approvedObsolete.target,
      proposedContent:
        "Record idle waits after one bounded status check and one timed wait.",
      rationale: "The replacement distinguishes status checks from timed waits.",
      frictionEvidence: proposalEvidence(),
    });
    expect(store.getProposal(approvedObsolete.id)).toMatchObject({
      state: "superseded",
      approval: {
        id: approvedObsoleteState.approval!.id,
        status: "void",
        voidReason: "proposal_superseded",
      },
    });

    const successorToRejected = store.supersedeProposal(rejected.id, {
      target: rejected.target,
      proposedContent: "# Narrow replacement mesh review doctrine\n",
      rationale: "A new proposal replaces, rather than revives, the rejection.",
      frictionEvidence: proposalEvidence(),
    });
    expect(store.getProposal(rejected.id).state).toBe("rejected");
    expect(successorToRejected.state).toBe("proposed");
    expect(store.auditEvents().map((event) => event.sequence)).toEqual(
      Array.from(
        { length: store.auditEvents().length },
        (_, index) => index + 1,
      ),
    );
    store.close();
  });

  it("voids digest approval when approved content is mutated", () => {
    const path = tempPath("instruction-proposal-tamper.db");
    const store = new InstructionProposalStore({ origin: "cursor", path });
    const proposal = store.createProposal({
      target: { kind: "mesh_skill", identifier: "mesh-waves" },
      proposedContent: "Original approved doctrine.",
      rationale: "Repeated gate failures need a sharper rule.",
      frictionEvidence: proposalEvidence(),
    });
    const approved = store.approveProposal({
      proposalId: proposal.id,
      expectedDigest: proposal.contentDigest,
    });
    const approvalId = approved.approval!.id;
    const tamper = new DatabaseSync(path);
    tamper
      .prepare(
        "UPDATE instruction_proposals SET proposed_content = ? WHERE id = ?",
      )
      .run("Injected replacement doctrine.", proposal.id);
    tamper.close();

    expect(() =>
      store.applyProposal({
        proposalId: proposal.id,
        expectedDigest: proposal.contentDigest,
      }),
    ).toThrow(/content changed after approval/);
    expect(store.getApproval(approvalId)).toMatchObject({
      status: "void",
      voidReason: "proposal_content_or_integrity_changed",
    });
    store.close();
  });

  it("confines repository rulesets, rejects symlinks, and applies idempotently", () => {
    const root = mkdtempSync(join(tmpdir(), "mesh-instruction-root-"));
    temporary.push(root);
    const outside = tempPath("outside-rules.md");
    writeFileSync(outside, "outside stays unchanged\n");
    writeFileSync(join(root, "AGENTS.md"), "old rules\n");
    symlinkSync(outside, join(root, "LINKED.md"));
    const store = new InstructionProposalStore({
      origin: "cursor",
      path: tempPath("instruction-rulesets.db"),
      repositoryRoots: new Map([["repo-key", root]]),
    });
    const createApproved = (relativePath: string, content: string) => {
      const proposal = store.createProposal({
        target: {
          kind: "repository_ruleset",
          identifier: "repo-key",
          relativePath,
        },
        proposedContent: content,
        rationale: "Recurring coordination failures require a repository rule.",
        frictionEvidence: proposalEvidence(),
      });
      return store.approveProposal({
        proposalId: proposal.id,
        expectedDigest: proposal.contentDigest,
      });
    };

    for (const [relativePath, pattern] of [
      ["../outside-rules.md", /parent directory/],
      [outside, /must be relative/],
      ["LINKED.md", /must not be a symlink/],
    ] as const) {
      const proposal = createApproved(relativePath, "untrusted overwrite\n");
      expect(() =>
        store.applyProposal({
          proposalId: proposal.id,
          expectedDigest: proposal.contentDigest,
        }),
      ).toThrow(pattern);
    }
    expect(readFileSync(outside, "utf8")).toBe("outside stays unchanged\n");

    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    for (const gitPath of [
      ".git/hooks/pre-commit",
      ".GIT/config",
      ".git./config",
      "GIT~1/config",
    ]) {
      const proposal = createApproved(gitPath, "#!/bin/sh\ncalc.exe\n");
      expect(() =>
        store.applyProposal({
          proposalId: proposal.id,
          expectedDigest: proposal.contentDigest,
        }),
      ).toThrow(/Git metadata/);
    }
    expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);

    const approved = createApproved(
      "AGENTS.md",
      "New exact repository instructions.\n",
    );
    const applied = store.applyProposal({
      proposalId: approved.id,
      expectedDigest: approved.contentDigest,
    });
    expect(applied).toMatchObject({
      state: "applied",
      approval: { status: "consumed" },
    });
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(
      "New exact repository instructions.\n",
    );
    expect(
      store.applyProposal({
        proposalId: approved.id,
        expectedDigest: approved.contentDigest,
      }),
    ).toEqual(applied);
    expect(() =>
      store.rejectProposal({
        proposalId: applied.id,
        reason: "too late",
      }),
    ).toThrow(/cannot be rejected/);
    expect(() =>
      store.approveProposal({
        proposalId: applied.id,
        expectedDigest: applied.contentDigest,
      }),
    ).toThrow(/cannot be approved/);
    store.close();
  });

  it("isolates proposal sequences and reads by mesh origin", () => {
    const path = tempPath("instruction-origin.db");
    const cursor = new InstructionProposalStore({ origin: "cursor", path });
    const codex = new InstructionProposalStore({ origin: "codex", path });
    const proposal = cursor.createProposal({
      target: { kind: "harness_instructions", identifier: "grok" },
      proposedContent: "Record fallback friction before changing providers.",
      rationale: "Fallbacks were invisible in prior runs.",
      frictionEvidence: proposalEvidence(),
    });
    expect(codex.listProposals()).toEqual([]);
    expect(() => codex.getProposal(proposal.id)).toThrow(
      /Unknown instruction proposal/,
    );
    expect(
      codex.createProposal({
        target: { kind: "harness_instructions", identifier: "grok" },
        proposedContent: "Report fallback exhaustion with evidence.",
        rationale: "The other origin has an independent instruction history.",
        frictionEvidence: proposalEvidence(),
      }).sequence,
    ).toBe(1);
    expect(cursor.listProposals()).toHaveLength(1);
    cursor.close();
    codex.close();
  });
});

describe("playbook control plane", () => {
  it("validates every built-in and rejects executable or cyclic definitions", () => {
    const catalog = listBuiltinPlaybooks();
    expect(catalog).toHaveLength(7);
    expect(new Set(catalog.map((playbook) => playbook.id)).size).toBe(7);
    for (const playbook of catalog) {
      const validated = validatePlaybookDefinition(playbook);
      expect(validated.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(validated.taskCount).toBeLessThanOrEqual(playbook.limits.maxTasks);
      expect(JSON.stringify(playbook)).not.toMatch(
        /"command"|"env"|"mcpServers"|"url"/,
      );
      for (const step of playbook.waves.flatMap((wave) => wave.steps)) {
        expect(
          step.providerOptions.filter(
            (option) => option.provider === "claude",
          ),
        ).toEqual([
          {
            provider: "claude",
            model: "claude-opus-5",
            effort: "max",
          },
          {
            provider: "claude",
            model: "claude-fable-5",
            effort: "max",
          },
        ]);
      }
    }

    const executable = {
      ...structuredClone(BUILTIN_PLAYBOOKS[2]),
      id: "custom/executable",
      command: "rm -rf /",
    };
    expect(() => validatePlaybookDefinition(executable)).toThrow();

    const cyclic = structuredClone(BUILTIN_PLAYBOOKS[2]);
    cyclic.id = "custom/cyclic";
    cyclic.waves[0]!.dependsOn = [cyclic.waves.at(-1)!.id];
    expect(() => validatePlaybookDefinition(cyclic)).toThrow(/acyclic/);
    const unsafeWorkspace = structuredClone(BUILTIN_PLAYBOOKS[2]);
    unsafeWorkspace.id = "custom/unsafe-workspace";
    unsafeWorkspace.workspace.strategy = "shared_readonly";
    expect(() => validatePlaybookDefinition(unsafeWorkspace)).toThrow(
      /single_writer_initiative/,
    );
    const reportBypass = structuredClone(BUILTIN_PLAYBOOKS[3]);
    reportBypass.id = "custom/report-bypass";
    reportBypass.waves.at(-1)!.steps[0]!.requiredReport = false;
    expect(() => validatePlaybookDefinition(reportBypass)).toThrow(
      /all-required independent steps/,
    );
    expect(() =>
      parseStepReport({
        outcome: "passed",
        summary: "looks good",
        findings: [],
        tests: [],
        artifacts: [],
        metrics: {},
        command: "skip-next-wave",
      }),
    ).toThrow();
    expect(
      builtinAutoRunAllowed(BUILTIN_PLAYBOOKS[3], {
        AGENT_MESH_PLAYBOOK_AUTO_RUN_BUILTINS: "1",
        AGENT_MESH_PLAYBOOK_AUTO_RUN_WRITERS: "1",
      }),
    ).toBe(true);
    expect(
      builtinAutoRunAllowed(BUILTIN_PLAYBOOKS[1], {
        AGENT_MESH_PLAYBOOK_AUTO_RUN_BUILTINS: "1",
        AGENT_MESH_PLAYBOOK_AUTO_RUN_WRITERS: "1",
      }),
    ).toBe(false);
    expect(builtinAutoRunAllowed(BUILTIN_PLAYBOOKS[3], {})).toBe(false);
    expect(
      builtinAutoRunAllowed(BUILTIN_PLAYBOOKS[3], {
        AGENT_MESH_PLAYBOOK_AUTO_RUN_BUILTINS: "1",
      }),
    ).toBe(false);
    const findingRun = {
      manifest: {
        waves: [
          { steps: [{ id: "reviewer-a", role: "reviewer" }] },
          { steps: [{ id: "fixer", role: "builder" }] },
          {
            steps: [
              { id: "verifier-a", role: "reviewer" },
              { id: "verifier-b", role: "reviewer" },
            ],
          },
        ],
      },
      waves: [
        {
          ordinal: 0,
          steps: [
            {
              ordinal: 0,
              stepId: "reviewer-a",
              provider: "claude",
              status: "completed",
              report: {
                outcome: "passed",
                findings: [
                  {
                    id: "finding-a",
                    severity: "high",
                    status: "open",
                    summary: "race",
                  },
                ],
              },
            },
          ],
        },
        {
          ordinal: 1,
          steps: [
            {
              ordinal: 0,
              stepId: "fixer",
              provider: "codex",
              status: "completed",
              report: {
                outcome: "passed",
                findings: [
                  {
                    id: "fix-vote",
                    severity: "high",
                    status: "resolved",
                    summary: "fixed",
                    resolutionOf: "reviewer-a:finding-a",
                  },
                ],
              },
            },
          ],
        },
      ],
    } as never;
    expect(openFindings(findingRun)).toHaveLength(1);
    (findingRun as any).waves.push({
      ordinal: 2,
      steps: ["verifier-a", "verifier-b"].map((stepId, ordinal) => ({
        ordinal,
        stepId,
        provider: ordinal === 0 ? "claude" : "grok",
        status: "completed",
        report: {
          outcome: "passed",
          findings: [
            {
              id: `vote-${ordinal}`,
              severity: "high",
              status: "resolved",
              summary: "verified",
              resolutionOf: "reviewer-a:finding-a",
            },
          ],
        },
      })),
    });
    expect(openFindings(findingRun)).toHaveLength(0);
  });

  it("validates the read-only retrospective and requires friction evidence", () => {
    expect(PLAYBOOK_POLICY_VERSION).toBe("2026-07-25.3");
    const retrospective = listBuiltinPlaybooks().find(
      (playbook) => playbook.id === "builtin/retrospective",
    )!;
    expect(validatePlaybookDefinition(retrospective).definition).toEqual(
      retrospective,
    );
    expect(retrospective.workspace.strategy).toBe("shared_readonly");
    expect(retrospective.waves.map((wave) => wave.id)).toEqual([
      "independent-analysis",
      "reconciliation",
      "instruction-proposals",
    ]);
    expect(retrospective.waves.map((wave) => wave.gate.type)).toEqual([
      "independent_reports",
      "all_required_reports",
      "friction_evidence",
    ]);
    expect(
      retrospective.waves.flatMap((wave) =>
        wave.steps.map((step) => step.taskMode),
      ),
    ).not.toContain("implement");
    expect(retrospective.waves[0]!.steps).toHaveLength(2);

    const proposalWave = {
      ...structuredClone(retrospective.waves[2]),
      status: "collecting",
      steps: [
        {
          ...structuredClone(retrospective.waves[2]!.steps[0]),
          status: "completed",
          provider: "codex",
          report: {
            outcome: "passed",
            findings: [],
            tests: [],
            artifacts: [],
            metrics: {},
            proposals: [
              {
                target: {
                  kind: "harness_instructions",
                  identifier: "codex",
                },
                proposedContent: "Record coordination friction.",
                rationale: "Retries recur.",
                frictionEvidence: {
                  eventIds: [],
                  summary: {
                    total: 2,
                    byKind: [{ kind: "retry", count: 2 }],
                    byProvider: [{ provider: "codex", count: 2 }],
                  },
                },
              },
            ],
          },
        },
      ],
    } as never;
    const run = {
      manifest: { waves: retrospective.waves },
      waves: [proposalWave],
    } as never;
    expect(evaluateWaveGate(run, proposalWave)).toEqual({
      passed: false,
      reason:
        "Every instruction proposal must cite at least one recorded friction event.",
    });
    (proposalWave as any).steps[0].report.proposals[0].frictionEvidence.eventIds = [
      crypto.randomUUID(),
    ];
    expect(evaluateWaveGate(run, proposalWave).passed).toBe(true);
  });

  it("persists revisions, digest approval, idempotent runs, reports, and audit chain", () => {
    const playbookPath = tempPath("playbooks.db");
    const registry = new PlaybookRegistry("cursor", playbookPath);
    const goal = registry.createGoal({
      title: "Fix login race",
      cwd: "/tmp/project",
      baseCommit: "a".repeat(40),
      objective: "Reproduce and fix the login race.",
      constraints: ["One writer"],
      successCriteria: ["Regression test passes"],
      riskTags: ["concurrency"],
    });
    const submitted = registry.submitGoal(goal.id, goal.version);
    expect(() =>
      registry.reviseGoal(goal.id, {
        objective: "mutate submitted goal",
        expectedVersion: goal.version,
      }),
    ).toThrow(/submitted goals are immutable/);
    const definition = structuredClone(BUILTIN_PLAYBOOKS[2]);
    definition.id = "custom/login-race";
    definition.autoRunEligible = false;
    const playbook = registry.createPlaybook({
      definition,
      source: "custom",
      goalId: goal.id,
      author: "test",
    });
    registry.markReviewReady(playbook.id, playbook.version);
    const approval = registry.approvePlaybook({
      playbookId: playbook.id,
      expectedVersion: playbook.version,
      expectedDigest: playbook.digest,
      goalId: submitted.id,
      expectedGoalVersion: submitted.version,
      expectedGoalDigest: goalDigest(submitted),
      method: "human",
    });
    const resolved = new Map(
      definition.waves.flatMap((wave) =>
        wave.steps.map((step) => [step.id, step.providerOptions[0]!] as const),
      ),
    );
    const manifest = compileExecutionManifest({
      goal: submitted,
      definition,
      resolvedProviders: resolved,
      playbookIdentity: {
        id: playbook.id,
        version: playbook.version,
        digest: playbook.digest,
      },
    });
    const unsafeResolved = new Map(resolved);
    for (const sensitiveStep of definition.waves
      .filter((wave) =>
        ["tests_passed", "no_open_findings"].includes(wave.gate.type),
      )
      .flatMap((wave) => wave.steps)) {
      const codex = sensitiveStep.providerOptions.find(
        (option) => option.provider === "codex",
      );
      if (codex) unsafeResolved.set(sensitiveStep.id, codex);
    }
    expect(() =>
      compileExecutionManifest({
        goal: submitted,
        definition,
        resolvedProviders: unsafeResolved,
        playbookIdentity: {
          id: playbook.id,
          version: playbook.version,
          digest: playbook.digest,
        },
      }),
    ).toThrow(/distinct providers/);
    const otherGoal = registry.createGoal({
      title: "Different goal",
      cwd: "/tmp/project",
      baseCommit: "a".repeat(40),
      objective: "Execute a different objective.",
    });
    const otherSubmitted = registry.submitGoal(otherGoal.id, otherGoal.version);
    const otherManifest = compileExecutionManifest({
      goal: otherSubmitted,
      definition,
      resolvedProviders: resolved,
      playbookIdentity: {
        id: playbook.id,
        version: playbook.version,
        digest: playbook.digest,
      },
    });
    expect(() =>
      registry.createRun({
        manifest: otherManifest,
        approvalId: approval.id,
        trustedBuiltin: false,
        idempotencyKey: "wrong-goal-run",
      }),
    ).toThrow(/not bound/);
    const run = registry.createRun({
      manifest,
      approvalId: approval.id,
      trustedBuiltin: false,
      idempotencyKey: "run-login-race",
    });
    expect(registry.getApproval(approval.id).status).toBe("consumed");
    const secondApproval = registry.approvePlaybook({
      playbookId: playbook.id,
      expectedVersion: playbook.version,
      expectedDigest: playbook.digest,
      goalId: submitted.id,
      expectedGoalVersion: submitted.version,
      expectedGoalDigest: goalDigest(submitted),
      method: "human",
    });
    expect(secondApproval.status).toBe("approved");
    expect(registry.listApprovals(playbook.id).map((item) => item.id)).toEqual(
      expect.arrayContaining([approval.id, secondApproval.id]),
    );
    expect(
      registry.createRun({
        manifest,
        approvalId: approval.id,
        trustedBuiltin: false,
        idempotencyKey: "run-login-race",
      }).id,
    ).toBe(run.id);
    expect(() =>
      registry.createRun({
        manifest,
        trustedBuiltin: true,
        idempotencyKey: "run-login-race",
      }),
    ).toThrow(/different request/);
    expect(
      registry.reserveIdempotency("concurrent-test", "same-key", {
        value: 1,
      }),
    ).toEqual({ reserved: true });
    expect(() =>
      registry.reserveIdempotency("concurrent-test", "same-key", {
        value: 1,
      }),
    ).toThrow(/already in progress/);
    registry.releaseIdempotency("concurrent-test", "same-key");

    const swarmId = crypto.randomUUID();
    registry.linkRunResources(run.id, { swarmId });
    registry.transitionRun(run.id, ["ready"], "running");
    const firstWave = registry.getRun(run.id).waves[0]!;
    registry.claimWave(run.id, firstWave.waveId);
    registry.transitionWave(run.id, firstWave.waveId, ["reserving"], "dispatching");
    registry.transitionWave(run.id, firstWave.waveId, ["dispatching"], "running");
    const firstStep = firstWave.steps[0]!;
    const memberId = crypto.randomUUID();
    registry.reserveStep(run.id, firstStep.stepId, {
      memberId,
      taskId: crypto.randomUUID(),
    });
    registry.updateStepStatus(run.id, firstStep.stepId, "completed");
    registry.submitStepReportByMember(swarmId, memberId, {
      outcome: "passed",
      summary: "Reproduced with deterministic evidence.",
      findings: [],
      tests: [{ name: "reproduction", status: "passed" }],
      artifacts: [],
      metrics: { attempts: 1 },
    });
    expect(() =>
      registry.submitStepReportByMember(swarmId, memberId, {
        outcome: "failed",
        summary: "late overwrite",
        findings: [],
        tests: [],
        artifacts: [],
        metrics: {},
      }),
    ).toThrow(/unreported/);
    registry.transitionWave(run.id, firstWave.waveId, ["running"], "collecting");
    const collecting = registry
      .getRun(run.id)
      .waves.find((wave) => wave.waveId === firstWave.waveId)!;
    expect(evaluateWaveGate(registry.getRun(run.id), collecting).passed).toBe(true);
    const selfReportedFailure = structuredClone(registry.getRun(run.id));
    selfReportedFailure.waves[0]!.steps[0]!.report!.outcome = "failed";
    expect(
      evaluateWaveGate(
        selfReportedFailure,
        selfReportedFailure.waves[0]!,
      ).passed,
    ).toBe(false);
    registry.transitionWave(run.id, firstWave.waveId, ["collecting"], "passed");

    const recoveryRun = registry.createRun({
      manifest,
      trustedBuiltin: true,
      idempotencyKey: "lease-recovery-run",
    });
    registry.linkRunResources(recoveryRun.id, {
      swarmId: crypto.randomUUID(),
    });
    registry.claimWave(
      recoveryRun.id,
      recoveryRun.waves[0]!.waveId,
      2_000_000_000,
    );
    const recovered = registry.recoverRunLeases(recoveryRun.id);
    expect(recovered.status).toBe("reconciling");
    expect(recovered.waves[0]?.status).toBe("blocked");
    const paused = registry.transitionRun(
      recoveryRun.id,
      ["reconciling"],
      "paused_budget",
    );
    const increasedLimits = {
      ...paused.manifest.limits,
      maxAttemptsPerStep: Math.min(
        paused.manifest.limits.maxAttemptsPerStep + 1,
        5,
      ),
      maxRunWallMs: paused.manifest.limits.maxRunWallMs + 60_000,
    };
    const amended = registry.amendRunLimits(
      paused.id,
      paused.version,
      increasedLimits,
    );
    expect(amended).toMatchObject({
      status: "ready",
      manifest: { limits: increasedLimits },
    });

    const events = registry.auditEvents(run.id);
    expect(events.length).toBeGreaterThanOrEqual(4);
    const allEvents = registry.auditEvents();
    for (let index = 1; index < allEvents.length; index += 1) {
      expect(allEvents[index]!.previousHash).toBe(
        allEvents[index - 1]!.hash,
      );
    }
    expect(digestJson(manifest)).toMatch(/^[0-9a-f]{64}$/);
    registry.close();
    const tamper = new DatabaseSync(playbookPath);
    tamper
      .prepare(
        `UPDATE playbook_audit_events SET data_json = '{"tampered":true}'
         WHERE sequence = (
           SELECT MIN(sequence) FROM playbook_audit_events WHERE run_id = ?
         )`,
      )
      .run(run.id);
    tamper.close();
    const reopened = new PlaybookRegistry("cursor", playbookPath);
    expect(() => reopened.auditEvents(run.id)).toThrow(/hash verification/);
    reopened.close();
  });

  it("executes a fresh read-only playbook run end to end", async () => {
    const root = mkdtempSync(join(tmpdir(), "mesh-playbook-e2e-"));
    temporary.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "README.md"), "playbook e2e\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Playbook Test",
        "-c",
        "user.email=playbook@example.test",
        "commit",
        "-qm",
        "init",
      ],
      { cwd: root },
    );
    process.env.AGENT_MESH_ALLOWED_ROOTS = root;

    const tasks = new TaskRegistry(tempPath("playbook-e2e-mesh.db"));
    const router = new AgentMeshRouter("cursor", tasks, [
      new ImmediateCodexAdapter(),
    ]);
    const plans = new PlanRegistry("cursor", tempPath("playbook-e2e-plans.db"), tasks);
    const swarms = new SwarmRegistry("cursor", tempPath("playbook-e2e-swarms.db"), tasks);
    const initiatives = new InitiativeRegistry(
      "cursor",
      tempPath("playbook-e2e-initiatives.db"),
      tasks,
    );
    const controlPath = tempPath("playbook-e2e-control.db");
    let controller = new PlaybookController({
      router,
      origin: "cursor",
      providerAdmin: fakeProviderAdmin(),
      plans,
      swarms,
      initiatives,
      registry: new PlaybookRegistry("cursor", controlPath),
    });
    try {
      const goal = await controller.createGoal({
        title: "Review repository",
        objective: "Review the repository and report success.",
        cwd: root,
        successCriteria: ["Review completes"],
        idempotencyKey: "goal-e2e",
      });
      controller.registry.submitGoal(goal.id, goal.version);
      const definition = validatePlaybookDefinition({
        schema: "agent-mesh.playbook/v1",
        id: "custom/review-e2e",
        version: 1,
        title: "Review E2E",
        description: "One read-only verification wave.",
        category: "custom",
        difficulty: "small",
        autoRunEligible: false,
        workspace: { strategy: "shared_readonly" },
        limits: {
          maxTasks: 2,
          maxWaves: 1,
          maxConcurrentTasks: 1,
          maxAttemptsPerStep: 1,
          maxRunWallMs: 60_000,
          maxTaskWallMs: 30_000,
          maxPromptBytes: 32_000,
          maxResultBytes: 32_000,
          maxArtifactBytes: 1_000_000,
        },
        waves: [
          {
            id: "review",
            dependsOn: [],
            completion: "all_required",
            steps: [
              {
                id: "reviewer",
                role: "reviewer",
                taskMode: "review",
                capabilityProfile: "none",
                providerOptions: [
                  { provider: "codex", model: "gpt-test", effort: "high" },
                ],
                prompt: "Review and report.",
                condition: "always",
                requiredReport: false,
              },
            ],
            gate: { type: "all_succeeded" },
          },
        ],
      }).definition;
      const playbook = controller.registry.createPlaybook({
        definition,
        source: "custom",
        goalId: goal.id,
        author: "test",
      });
      controller.registry.markReviewReady(playbook.id, playbook.version);
      const approval = controller.registry.approvePlaybook({
        playbookId: playbook.id,
        expectedVersion: playbook.version,
        expectedDigest: playbook.digest,
        goalId: goal.id,
        expectedGoalVersion: goal.version,
        expectedGoalDigest: goalDigest(goal),
        method: "human",
      });
      let run = await controller.startRun({
        goalId: goal.id,
        definition,
        playbookIdentity: {
          id: playbook.id,
          version: playbook.version,
          digest: playbook.digest,
        },
        approvalId: approval.id,
        trustedBuiltin: false,
        idempotencyKey: "run-e2e",
        autoStart: true,
      });
      const firstTaskId = run.waves[0]?.steps[0]?.taskId;
      controller.close();
      controller = new PlaybookController({
        router,
        origin: "cursor",
        providerAdmin: fakeProviderAdmin(),
        plans,
        swarms,
        initiatives,
        registry: new PlaybookRegistry("cursor", controlPath),
      });
      for (let attempt = 0; attempt < 50 && run.status !== "completed"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        run = await controller.advanceRun(run.id, false);
      }
      expect(run.status).toBe("completed");
      expect(run.waves[0]?.status).toBe("passed");
      expect(run.waves[0]?.steps[0]).toMatchObject({
        status: "completed",
        provider: "codex",
        model: "gpt-test",
      });
      expect(run.waves[0]?.steps[0]?.taskId).toMatch(
        /^[0-9a-f-]{36}$/,
      );
      expect(run.waves[0]?.steps[0]?.taskId).toBe(firstTaskId);
      expect(run.tasksStarted).toBe(1);
      const stableVersion = controller.runReport(run.id).run.version;
      expect(controller.runReport(run.id).run.version).toBe(stableVersion);
      const duplicate = await controller.startRun({
        goalId: goal.id,
        definition,
        playbookIdentity: {
          id: playbook.id,
          version: playbook.version,
          digest: playbook.digest,
        },
        approvalId: approval.id,
        trustedBuiltin: false,
        idempotencyKey: "run-e2e",
        autoStart: true,
      });
      expect(duplicate.id).toBe(run.id);
      expect(swarms.list()).toHaveLength(1);
    } finally {
      controller.close();
      plans.close();
      swarms.close();
      initiatives.close();
      await router.close();
    }
  });

  it("rejects persisted playbook definition tampering", () => {
    const path = tempPath("playbook-digest-tamper.db");
    const registry = new PlaybookRegistry("cursor", path);
    const definition = structuredClone(BUILTIN_PLAYBOOKS[3]);
    definition.id = "custom/tamper-check";
    definition.autoRunEligible = false;
    const playbook = registry.createPlaybook({
      definition,
      source: "custom",
      author: "test",
    });
    registry.close();
    const database = new DatabaseSync(path);
    const stored = database
      .prepare(
        "SELECT definition_json FROM playbook_revisions WHERE playbook_id = ?",
      )
      .get(playbook.id) as { definition_json: string };
    const tampered = JSON.parse(stored.definition_json);
    tampered.title = "Tampered title";
    database
      .prepare(
        "UPDATE playbook_revisions SET definition_json = ? WHERE playbook_id = ?",
      )
      .run(JSON.stringify(tampered), playbook.id);
    database.close();
    const reopened = new PlaybookRegistry("cursor", path);
    expect(() => reopened.getPlaybook(playbook.id)).toThrow(
      /digest verification/,
    );
    reopened.close();
  });

  it("synthesizes a review-ready playbook through fresh adversarial phases", async () => {
    const root = mkdtempSync(join(tmpdir(), "mesh-playbook-synthesis-"));
    temporary.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "README.md"), "synthesis\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Playbook Test",
        "-c",
        "user.email=playbook@example.test",
        "commit",
        "-qm",
        "init",
      ],
      { cwd: root },
    );
    process.env.AGENT_MESH_ALLOWED_ROOTS = root;
    const candidate = validatePlaybookDefinition({
      schema: "agent-mesh.playbook/v1",
      id: "generated/synthesis",
      version: 1,
      title: "Synthesized review",
      description: "A bounded synthesized review playbook.",
      category: "custom",
      difficulty: "small",
      autoRunEligible: false,
      workspace: { strategy: "shared_readonly" },
      limits: {
        maxTasks: 2,
        maxWaves: 1,
        maxConcurrentTasks: 1,
        maxAttemptsPerStep: 1,
        maxRunWallMs: 60_000,
        maxTaskWallMs: 30_000,
        maxPromptBytes: 32_000,
        maxResultBytes: 32_000,
        maxArtifactBytes: 1_000_000,
      },
      waves: [
        {
          id: "review",
          dependsOn: [],
          completion: "all_required",
          steps: [
            {
              id: "reviewer",
              role: "reviewer",
              taskMode: "review",
              capabilityProfile: "none",
              providerOptions: [
                { provider: "codex", model: "gpt-5.6-sol", effort: "ultra" },
                {
                  provider: "claude",
                  model: "claude-opus-5",
                  effort: "max",
                },
              ],
              prompt: "Review the goal.",
              condition: "always",
              requiredReport: true,
            },
          ],
          gate: { type: "all_required_reports" },
        },
      ],
    }).definition;
    const tasks = new TaskRegistry(tempPath("playbook-synthesis-mesh.db"));
    const router = new AgentMeshRouter("cursor", tasks, [
      new ScriptedSynthesisAdapter("codex", candidate),
      new ScriptedSynthesisAdapter("claude", candidate),
    ]);
    const plans = new PlanRegistry(
      "cursor",
      tempPath("playbook-synthesis-plans.db"),
      tasks,
    );
    const swarms = new SwarmRegistry(
      "cursor",
      tempPath("playbook-synthesis-swarms.db"),
      tasks,
    );
    const initiatives = new InitiativeRegistry(
      "cursor",
      tempPath("playbook-synthesis-initiatives.db"),
      tasks,
    );
    const controller = new PlaybookController({
      router,
      origin: "cursor",
      providerAdmin: synthesisProviderAdmin(),
      plans,
      swarms,
      initiatives,
      registry: new PlaybookRegistry(
        "cursor",
        tempPath("playbook-synthesis-control.db"),
      ),
    });
    try {
      const goal = await controller.createGoal({
        title: "Synthesize review",
        objective: "Create a bounded review playbook.",
        cwd: root,
        successCriteria: ["Review report exists"],
        idempotencyKey: "synthesis-goal",
      });
      controller.registry.submitGoal(goal.id, goal.version);
      let synthesis = await controller.startSynthesis(
        goal.id,
        30_000,
        "synthesis-start",
      );
      for (
        let attempt = 0;
        attempt < 100 &&
        !["review_ready", "failed"].includes(synthesis.status);
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        synthesis = await controller.advanceSynthesis(synthesis.id, 30_000);
      }
      expect(synthesis.status, synthesis.error ?? "").toBe("review_ready");
      expect(synthesis.playbookId).toBeTruthy();
      expect(controller.registry.getPlaybook(synthesis.playbookId!)).toMatchObject({
        source: "generated",
        status: "review_ready",
      });
      const taskIds = [
        ...synthesis.candidateTaskIds,
        ...synthesis.criticTaskIds,
        synthesis.reconcilerTaskId!,
      ];
      const sessions = taskIds.map(
        (taskId) => router.registry.require(taskId).sessionId,
      );
      expect(new Set(sessions).size).toBe(taskIds.length);
    } finally {
      controller.close();
      plans.close();
      swarms.close();
      initiatives.close();
      await router.close();
    }
  });
});

describe("plan lifecycle", () => {
  it("versions revisions and requires a clean approving review", () => {
    const registry = new PlanRegistry("cursor", tempPath("plans.db"));
    const created = registry.create({
      title: "Productionize",
      objective: "Ship safely",
      cwd: "/tmp/project",
      preset: "productionize",
      body: "Initial body",
      author: "Cursor",
    });
    expect(created.status).toBe("draft");
    registry.submitForReview(created.id);
    registry.review(created.id, {
      reviewer: "Claude",
      provider: "claude",
      verdict: "changes_requested",
      feedback: "Add rollback.",
    });
    expect(() => registry.approve(created.id)).toThrow("requested changes");

    const revised = registry.revise(created.id, {
      body: "Initial body\n\nRollback.",
      summary: "Added rollback",
      author: "Cursor",
    });
    expect(revised.version).toBe(2);
    expect(revised.status).toBe("draft");
    registry.submitForReview(created.id);
    registry.review(created.id, {
      reviewer: "Codex",
      provider: "codex",
      verdict: "approve",
      feedback: "Ready.",
    });
    expect(registry.approve(created.id).status).toBe("approved");
    const firstTaskId = crypto.randomUUID();
    const resumedTaskId = crypto.randomUUID();
    expect(registry.attachExecution(created.id, { taskId: firstTaskId }).status).toBe(
      "executing",
    );
    expect(
      registry.transferExecutionReservation(created.id, firstTaskId, resumedTaskId),
    ).toMatchObject({ executionTaskId: resumedTaskId });
    expect(registry.complete(created.id).status).toBe("completed");
    registry.close();
  });

  it("recovers a pre-launch execution reservation after process loss", () => {
    const taskPath = tempPath("mesh.db");
    const planPath = tempPath("plans.db");
    const tasks = new TaskRegistry(taskPath);
    const interrupted = taskRecord({
      status: "interrupted",
      completedAt: "2026-07-13T00:00:01.000Z",
    });
    tasks.insert(interrupted);
    const first = new PlanRegistry("cursor", planPath);
    const plan = first.create({
      title: "Reserved",
      objective: "Recover",
      cwd: "/tmp/project",
      preset: "max_implementation",
      body: "Implement after reservation.",
      author: "Cursor",
    });
    first.submitForReview(plan.id);
    first.review(plan.id, {
      reviewer: "Claude",
      provider: "claude",
      verdict: "approve",
      feedback: "Ready.",
    });
    first.approve(plan.id);
    first.attachExecution(plan.id, { taskId: interrupted.id });
    first.close();

    const recovered = new PlanRegistry("cursor", planPath, tasks);
    expect(recovered.get(plan.id)).toMatchObject({
      status: "approved",
      executionTaskId: null,
      initiativeId: null,
    });
    recovered.close();
    tasks.close();
  });
});

describe("swarm coordination", () => {
  it("supports mailboxes, optimistic blackboards, barriers, and sealed reviews", async () => {
    const registry = new SwarmRegistry("cursor", tempPath("swarms.db"));
    const swarm = registry.create({
      name: "Review",
      objective: "Review independently",
      cwd: "/tmp/project",
      preset: "max_adversarial_review",
    });
    const codex = registry.addMember(swarm.id, {
      name: "codex-reviewer",
      provider: "codex",
      role: "reviewer",
    });
    const claude = registry.addMember(swarm.id, {
      name: "claude-reviewer",
      provider: "claude",
      role: "reviewer",
    });
    registry.send(swarm.id, {
      fromMemberId: codex.id,
      toMemberId: claude.id,
      kind: "feedback",
      body: "Check the lease.",
    });
    expect(registry.inbox(swarm.id, codex.id)).toHaveLength(0);
    expect(registry.inbox(swarm.id, claude.id)[0]?.body).toBe("Check the lease.");
    expect(await registry.waitForInbox(swarm.id, claude.id, 0, 1)).toHaveLength(1);

    const first = registry.blackboardSet(swarm.id, {
      key: "base",
      value: "abc123",
      authorMemberId: codex.id,
      expectedVersion: 0,
    });
    expect(first.version).toBe(1);
    expect(() =>
      registry.blackboardSet(swarm.id, {
        key: "base",
        value: "stale",
        authorMemberId: claude.id,
        expectedVersion: 0,
      }),
    ).toThrow("version conflict");

    const barrier = registry.createBarrier(swarm.id, "blind-review", 2);
    expect(registry.arrive(barrier.id, codex.id).completedAt).toBeNull();
    expect(registry.arrive(barrier.id, claude.id).completedAt).not.toBeNull();

    registry.submitReview(swarm.id, {
      memberId: codex.id,
      verdict: "changes",
      body: "Finding A",
    });
    expect(registry.reviews(swarm.id)).toEqual([]);
    expect(() => registry.revealReviews(swarm.id)).toThrow("every reviewer submits");
    registry.submitReview(swarm.id, {
      memberId: claude.id,
      verdict: "pass",
      body: "No additional findings.",
    });
    registry.updateMember(swarm.id, codex.id, { status: "completed" });
    registry.updateMember(swarm.id, claude.id, { status: "completed" });
    expect(registry.revealReviews(swarm.id)).toHaveLength(2);
    expect(() =>
      registry.submitReview(swarm.id, {
        memberId: codex.id,
        verdict: "changes",
        body: "Late finding",
      }),
    ).toThrow("already revealed");
    expect(() =>
      registry.addMember(swarm.id, {
        name: "late-reviewer",
        provider: "codex",
        role: "reviewer",
      }),
    ).toThrow("after sealed reviews are revealed");
    registry.close();
  });

  it("recovers terminal task members and abandoned dispatch claims", () => {
    const taskPath = tempPath("mesh.db");
    const swarmPath = tempPath("swarms.db");
    const tasks = new TaskRegistry(taskPath);
    const completed = taskRecord({
      status: "completed",
      completedAt: "2026-07-13T00:00:01.000Z",
    });
    tasks.insert(completed);

    const first = new SwarmRegistry("cursor", swarmPath);
    const swarm = first.create({
      name: "Recovery",
      objective: "Recover state",
      cwd: "/tmp/project",
      preset: "max_adversarial_review",
    });
    const settled = first.addMember(swarm.id, {
      name: "settled",
      provider: "codex",
      role: "reviewer",
      taskId: completed.id,
    });
    const abandoned = first.addMember(swarm.id, {
      name: "abandoned",
      provider: "claude",
      role: "reviewer",
    });
    expect(first.claimMemberDispatch(swarm.id, abandoned.id)).toBe(true);
    first.close();
    const raw = new DatabaseSync(swarmPath);
    raw
      .prepare("UPDATE swarm_members SET dispatch_owner_pid = ? WHERE id = ?")
      .run(2_147_483_647, abandoned.id);
    raw.close();

    const recovered = new SwarmRegistry("cursor", swarmPath, tasks);
    const members = recovered.get(swarm.id).members;
    expect(members.find((member) => member.id === settled.id)?.status).toBe("completed");
    expect(members.find((member) => member.id === abandoned.id)?.status).toBe("active");
    recovered.close();
    tasks.close();
  });

  it("rejects member mutations after a concurrent close", () => {
    const path = tempPath("swarms.db");
    const owner = new SwarmRegistry("cursor", path);
    const observer = new SwarmRegistry("cursor", path);
    const swarm = owner.create({
      name: "Close race",
      objective: "Stay closed",
      cwd: "/tmp/project",
      preset: "max_plan",
    });
    const member = owner.addMember(swarm.id, {
      name: "planner",
      provider: "codex",
      role: "planner",
    });
    owner.closeSwarm(swarm.id);
    expect(observer.claimMemberDispatch(swarm.id, member.id)).toBe(false);
    expect(() =>
      observer.updateMember(swarm.id, member.id, { status: "completed" }),
    ).toThrow("closed");
    expect(() =>
      observer.addMember(swarm.id, {
        name: "late",
        provider: "claude",
        role: "planner",
      }),
    ).toThrow("closed");
    owner.close();
    observer.close();
  });
});

describe("coordination profile", () => {
  const coordination = {
    origin: "cursor" as const,
    swarmId: crypto.randomUUID(),
    memberId: crypto.randomUUID(),
  };

  it("injects only the restricted coordination server for none profiles", () => {
    const claude = buildClaudeMcpProfile("none", { coordination });
    expect(Object.keys(claude.mcpConfig.mcpServers)).toEqual(["coordination"]);
    expect(claude.allowedTools).toHaveLength(COORDINATION_TOOLS.length);
    const codex = buildCodexMcpProfile("none", { coordination });
    expect(codex.mcp_servers.coordination?.enabled_tools).toEqual([
      ...COORDINATION_TOOLS,
    ]);
    const args =
      "args" in codex.mcp_servers.coordination!
        ? codex.mcp_servers.coordination.args
        : [];
    const capability = args[args.indexOf("--capability") + 1]!;
    expect(capability).toBe(coordinationCapability(coordination));
    expect(verifyCoordinationCapability(coordination, capability)).toBe(true);
    const grok = buildGrokMcpProfile("none", { coordination });
    expect(Object.keys(grok.mcp_servers)).toEqual(["coordination"]);
    expect(grok.allowedTools).toHaveLength(COORDINATION_TOOLS.length);
    expect(grok.mcp_servers.coordination).toMatchObject({
      args: expect.arrayContaining([
        "${AGENT_MESH_COORDINATION_ORIGIN}",
        "${AGENT_MESH_COORDINATION_CAPABILITY}",
      ]),
    });
    expect(JSON.stringify(grok)).not.toContain(capability);
    const antigravity = buildAntigravityMcpProfile("none", { coordination });
    expect(Object.keys(antigravity.mcpServers)).toEqual(["coordination"]);
    const antigravityCoordination = antigravity.mcpServers.coordination;
    expect(antigravityCoordination).toMatchObject({
      command: expect.stringContaining("coordinate.sh"),
    });
    if ("args" in antigravityCoordination) {
      const antigravityCapability =
        antigravityCoordination.args[
          antigravityCoordination.args.indexOf("--capability") + 1
        ];
      expect(antigravityCapability).toBe(capability);
    }
    expect(
      verifyCoordinationCapability(
        { ...coordination, memberId: crypto.randomUUID() },
        capability,
      ),
    ).toBe(false);
    expect(isMcpProfileAllowed("plan", "research")).toBe(true);
  });

  it("binds managed-peer capability to agent, member, generation, and task", () => {
    const peer = {
      origin: "cursor" as const,
      agentId: crypto.randomUUID(),
      memberId: crypto.randomUUID(),
      membershipGeneration: 4,
      taskId: crypto.randomUUID(),
    };
    const capability = managedPeerCapability(peer);
    expect(verifyManagedPeerCapability(peer, capability)).toBe(true);
    expect(
      verifyManagedPeerCapability(
        { ...peer, membershipGeneration: 5 },
        capability,
      ),
    ).toBe(false);
    const codex = buildCodexMcpProfile("none", { peer });
    expect(codex.mcp_servers.coordination?.enabled_tools).toEqual([
      ...MANAGED_PEER_TOOLS,
    ]);
    const args =
      "args" in codex.mcp_servers.coordination!
        ? codex.mcp_servers.coordination.args
        : [];
    expect(args[args.indexOf("--peer-capability") + 1]).toBe(capability);
  });
});

describe("derived telemetry", () => {
  it("distinguishes provider output from lifecycle events", () => {
    expect(isProviderOutputEvent({ type: "system" })).toBe(false);
    expect(isProviderOutputEvent({ type: "assistant" })).toBe(true);
    expect(isProviderOutputEvent({ method: "turn/started" })).toBe(false);
    expect(isProviderOutputEvent({ method: "item/agentMessage/delta" })).toBe(true);
  });

  it("records status transitions atomically through the task table trigger", () => {
    const registry = new TaskRegistry(tempPath("mesh.db"));
    const task = taskRecord({ description: "Telemetry" });
    const id = task.id;
    registry.insert(task);
    registry.update(id, {
      status: "running",
      updatedAt: "2026-07-13T00:00:01.000Z",
    });
    registry.update(id, {
      status: "completed",
      updatedAt: "2026-07-13T00:00:02.000Z",
      completedAt: "2026-07-13T00:00:02.000Z",
    });
    expect(registry.transitions(id).map((entry) => entry.toStatus)).toEqual([
      "queued",
      "running",
      "completed",
    ]);
    registry.close();
  });

  it("separates queue, active, input-wait, and wall time", () => {
    const task = {
      id: crypto.randomUUID(),
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "ultra",
      status: "completed",
      createdAt: "2026-07-13T00:00:00.000Z",
      completedAt: "2026-07-13T00:00:10.000Z",
    } as TaskRecord;
    const metrics = deriveTaskTimingMetrics(
      task,
      [
        {
          sequence: 1,
          taskId: task.id,
          fromStatus: null,
          toStatus: "queued",
          occurredAt: "2026-07-13T00:00:00.000Z",
        },
        {
          sequence: 2,
          taskId: task.id,
          fromStatus: "queued",
          toStatus: "running",
          occurredAt: "2026-07-13T00:00:02.000Z",
        },
        {
          sequence: 3,
          taskId: task.id,
          fromStatus: "running",
          toStatus: "waiting_for_input",
          occurredAt: "2026-07-13T00:00:06.000Z",
        },
        {
          sequence: 4,
          taskId: task.id,
          fromStatus: "waiting_for_input",
          toStatus: "running",
          occurredAt: "2026-07-13T00:00:08.000Z",
        },
        {
          sequence: 5,
          taskId: task.id,
          fromStatus: "running",
          toStatus: "completed",
          occurredAt: "2026-07-13T00:00:10.000Z",
        },
      ],
      "2026-07-13T00:00:03.000Z",
    );
    expect(metrics.queueMs).toBe(2_000);
    expect(metrics.activeMs).toBe(6_000);
    expect(metrics.waitingForInputMs).toBe(2_000);
    expect(metrics.timeToFirstOutputMs).toBe(3_000);
    expect(metrics.totalWallMs).toBe(10_000);
    expect(metrics).toMatchObject({
      requestedModel: "gpt-5.6-sol",
      requestedEffort: "ultra",
      actualModel: null,
      actualEffort: null,
      fallbackCount: 0,
      fallbackReason: null,
    });
  });
});

describe("structured human approval", () => {
  const originalStateDir = process.env.AGENT_MESH_STATE_DIR;

  afterEach(() => {
    if (originalStateDir === undefined) delete process.env.AGENT_MESH_STATE_DIR;
    else process.env.AGENT_MESH_STATE_DIR = originalStateDir;
  });

  function privateStateDirectory(): string {
    const directory = tempPath("state");
    process.env.AGENT_MESH_STATE_DIR = directory;
    return directory;
  }

  const pageMetadata = {
    requestedAt: "2026-07-25T20:00:00.000Z",
    expiresAt: "2026-07-25T20:02:00.000Z",
  };

  const patchApproval: ApprovalRequest = {
    title: "Apply verified patch",
    summary: "Apply task 41c's verified patch to /repo.",
    operation: "patch_apply",
    target: "/repo",
    reversible: true,
    reversal: "patch_rollback restores the recorded pre-apply state.",
    fields: [
      { label: "Task", value: "41c" },
      { label: "Produced by", value: "codex / gpt-5.6-sol" },
      { label: "Target repository", value: "clean — no uncommitted changes" },
    ],
    affectedPaths: ["src/router.ts", "src/worktree.ts"],
    diffExcerpt: "--- a/src/router.ts\n+++ b/src/router.ts\n@@\n-old\n+new\n",
    evidence: ["Preview verified the patch against a clean target."],
    digests: [{ label: "Patch sha256", value: "a".repeat(64) }],
  };

  it("assembles the dialog from the structured request and discloses truncation", () => {
    const text = buildApprovalDialogText({
      ...patchApproval,
      fields: [
        ...(patchApproval.fields ?? []),
        { label: "Notes", value: "x".repeat(5_000) },
      ],
    });
    expect(text).toContain("Apply verified patch");
    expect(text).toContain("Apply task 41c's verified patch to /repo.");
    expect(text).toContain("Operation: patch_apply");
    expect(text).toContain("Target: /repo");
    expect(text).toContain(
      "Reversible: yes — patch_rollback restores the recorded pre-apply state.",
    );
    expect(text).toContain("Task: 41c");
    expect(text).toContain(
      "Detail page also carries 2 affected paths, a diff excerpt, 1 evidence item, 1 digest.",
    );
    expect(text).toContain("Approval happens only in this dialog.");
    // Truncation is disclosed rather than silently cutting the value.
    expect(text).toMatch(/\[truncated \d+ characters\]/);
    expect(text).not.toContain("x".repeat(1_000));
    expect(text.length).toBeLessThanOrEqual(MAX_DIALOG_CHARACTERS + 64);
  });

  it("states irreversibility plainly and keeps the one-sentence path conservative", () => {
    expect(
      buildApprovalDialogText({
        title: "Log out provider CLI",
        summary: "Log out the codex CLI and destroy its stored credentials.",
        operation: "provider_logout",
        target: "codex CLI credentials",
        reversible: false,
        reversal: "Restoring access requires a fresh interactive login.",
      }),
    ).toContain(
      "Reversible: NO — Restoring access requires a fresh interactive login.",
    );
    const plain = buildApprovalDialogText("Rollback patch promotion 41c?");
    expect(plain).toContain("Rollback patch promotion 41c?");
    expect(plain).toContain("Reversible: NO");
    expect(() => buildApprovalDialogText("   ")).toThrow(
      "Human approval action must not be empty.",
    );
  });

  it("escapes AppleScript quotes, backslashes, newlines, and tabs", () => {
    expect(escapeAppleScriptString('a"b\\c\nd\te\rf')).toBe(
      'a\\"b\\\\c\\nd\\te\\rf',
    );
    const hostile = escapeAppleScriptString(
      buildApprovalDialogText({
        ...patchApproval,
        target: '/repo" with icon stop\ndo shell script "id',
      }),
    );
    // No value may close the literal: every quote stays backslash-escaped and no
    // raw newline survives to end the one-line script.
    expect(hostile).not.toMatch(/(^|[^\\])"/);
    expect(hostile).not.toContain("\n");
    expect(hostile).not.toContain("\r");
    expect(hostile).toContain('\\" with icon stop');
  });

  it("redacts secret-bearing values in both the dialog and the page", () => {
    const secret = "sk-liveKey1234567890abcdef";
    const request: ApprovalRequest = {
      ...patchApproval,
      fields: [{ label: "Environment", value: `api_key: ${secret}` }],
      evidence: [`Preview fetched with Bearer ${"t".repeat(40)}`],
    };
    const text = buildApprovalDialogText(request);
    const page = renderApprovalDetailPage(request, pageMetadata);
    for (const rendered of [text, page]) {
      expect(rendered).not.toContain(secret);
      expect(rendered).not.toContain("t".repeat(40));
      expect(rendered).toContain("[REDACTED]");
    }
  });

  it("escapes angle brackets and quotes in the detail page", () => {
    const page = renderApprovalDetailPage(
      {
        ...patchApproval,
        title: '<script>alert("mesh")</script>',
        fields: [
          { label: 'Label "quoted"', value: "<b>bold</b> & 'single'" },
        ],
        diffExcerpt: "-<div>old</div>\n+<div>new</div>",
      },
      pageMetadata,
    );
    expect(page).not.toContain('<script>alert("mesh")');
    expect(page).not.toContain("<b>bold</b>");
    expect(page).not.toContain("<div>old</div>");
    expect(page).toContain("&lt;script&gt;alert(&quot;mesh&quot;)&lt;/script&gt;");
    expect(page).toContain("Label &quot;quoted&quot;");
    expect(page).toContain("&amp;");
    expect(page).toContain("&#39;single&#39;");
  });

  it("renders a read-only page with no approve control and no network element", () => {
    const page = renderApprovalDetailPage(patchApproval, pageMetadata);
    expect(page).toContain("Apply verified patch");
    expect(page).toContain("Reversible");
    expect(page).toContain("src/worktree.ts");
    expect(page).toContain("a".repeat(64));
    expect(page).toContain("2026-07-25T20:02:00.000Z");
    // Authorization must stay in the native dialog: nothing here can approve, and
    // nothing here reaches the network.
    expect(page).not.toMatch(
      /<\s*(form|button|input|select|textarea|script|iframe|img|link|object|embed|a)\b/i,
    );
    expect(page).not.toMatch(/\b(src|href|action|formaction)\s*=/i);
    expect(page).not.toMatch(/\bon[a-z]+\s*=\s*["']/i);
    expect(page).not.toMatch(/https?:/i);
    expect(page).not.toContain("@import");
    expect(page).not.toContain("url(");
  });

  it("writes an owner-only detail page and deletes it once the human decides", async () => {
    const stateDirectory = privateStateDirectory();
    const choices: ApprovalChoice[] = ["details", "approve"];
    const offered: boolean[] = [];
    const opened: string[] = [];
    let modeAtOpen: number | undefined;
    let contents = "";

    await requireHumanApproval(patchApproval, {
      dialog: async (input) => {
        offered.push(input.offerDetails);
        expect(input.timeoutMs).toBeGreaterThan(0);
        expect(input.text).toContain("Operation: patch_apply");
        return choices.shift() ?? "cancel";
      },
      openDetails: async (path) => {
        opened.push(path);
        modeAtOpen = statSync(path).mode & 0o777;
        contents = readFileSync(path, "utf8");
      },
    });

    expect(offered).toEqual([true, true]);
    expect(opened).toHaveLength(1);
    const escapedApprovalsDir = join(stateDirectory, "approvals").replace(/\\/g, "\\\\");
    expect(opened[0]).toMatch(
      new RegExp(`^${escapedApprovalsDir}[/\\\\][0-9a-f-]+\\.html$`),
    );
    expect(modeAtOpen).toBe(process.platform === "win32" ? 0o666 : 0o600);
    expect(statSync(join(stateDirectory, "approvals")).mode & 0o777).toBe(
      process.platform === "win32" ? 0o666 : 0o700,
    );
    expect(contents).toContain("Apply verified patch");
    expect(contents).toContain("a".repeat(64));
    expect(existsSync(opened[0]!)).toBe(false);
  });

  it("bounds how many times the dialog may be re-presented", async () => {
    privateStateDirectory();
    const offered: boolean[] = [];
    const opened: string[] = [];

    await expect(
      requireHumanApproval(patchApproval, {
        dialog: async (input) => {
          offered.push(input.offerDetails);
          return "details";
        },
        openDetails: async (path) => {
          opened.push(path);
        },
      }),
    ).rejects.toThrow("Human approval was not granted.");

    expect(offered).toEqual([
      ...Array.from({ length: MAX_DETAIL_VIEWS }, () => true),
      false,
    ]);
    expect(opened).toHaveLength(MAX_DETAIL_VIEWS);
    expect(new Set(opened).size).toBe(1);
    expect(existsSync(opened[0]!)).toBe(false);
  });

  it("fails closed on cancellation, dialog failure, and an expired deadline", async () => {
    privateStateDirectory();

    await expect(
      requireHumanApproval(patchApproval, { dialog: async () => "cancel" }),
    ).rejects.toThrow("Human approval was not granted.");

    await expect(
      requireHumanApproval(patchApproval, {
        dialog: async () => {
          throw new Error("osascript is unavailable in this sandbox");
        },
      }),
    ).rejects.toThrow("Human approval was cancelled, timed out, or unavailable.");

    let clock = 1_000_000;
    const presented: number[] = [];
    await expect(
      requireHumanApproval(patchApproval, {
        timeoutMs: 5_000,
        now: () => clock,
        dialog: async () => {
          presented.push(clock);
          clock += 4_500;
          return "details";
        },
        openDetails: async () => undefined,
      }),
    ).rejects.toThrow("Human approval was cancelled, timed out, or unavailable.");
    // The deadline stays authoritative even while the human is reading details.
    expect(presented).toEqual([1_000_000]);

    await expect(requireHumanApproval("   ")).rejects.toThrow(
      "Human approval action must not be empty.",
    );
  });
});

describe("playbook run driver", () => {
  const wave = (
    status: string,
    stepStatuses: string[],
  ): Record<string, unknown> => ({
    status,
    steps: stepStatuses.map((stepStatus) => ({ status: stepStatus })),
  });
  const run = (
    status: string,
    waves: Array<Record<string, unknown>>,
    id = "run-1",
  ) => ({ id, status, waves }) as never;

  it("advances only when a settled wave is still open", () => {
    expect(
      runAdvanceDue(run("running", [wave("running", ["completed", "failed"])])),
    ).toBe(true);
    expect(
      runAdvanceDue(run("running", [wave("running", ["completed", "running"])])),
    ).toBe(false);
    expect(
      runAdvanceDue(run("running", [wave("passed", ["completed"])])),
    ).toBe(false);
    // A wave with no steps yet has not settled anything to collect.
    expect(runAdvanceDue(run("running", [wave("running", [])]))).toBe(false);
  });

  it("never drives a run that is waiting on a person or capacity", () => {
    for (const status of [
      "waiting_for_input",
      "paused_budget",
      "blocked_provider",
      "needs_attention",
      "created",
      "ready",
      "completed",
      "failed",
      "cancelled",
    ]) {
      expect(
        runAdvanceDue(run(status, [wave("running", ["completed"])])),
      ).toBe(false);
    }
  });

  it("advances a due run once and never confirms a manual gate", async () => {
    const calls: Array<{ runId: string; confirmManual: boolean }> = [];
    const due = run("running", [wave("running", ["completed"])]);
    const controller = {
      registry: {
        listRuns: () => [due],
        getRun: () => due,
      },
      advanceRun: async (runId: string, confirmManual: boolean) => {
        calls.push({ runId, confirmManual });
        return due;
      },
    } as never;
    await new PlaybookRunDriver(controller).tick();
    expect(calls).toEqual([{ runId: "run-1", confirmManual: false }]);
  });

  it("backs off instead of retrying a failing run every tick", async () => {
    let attempts = 0;
    const due = run("running", [wave("running", ["completed"])]);
    let clock = 0;
    const controller = {
      registry: { listRuns: () => [due], getRun: () => due },
      advanceRun: async () => {
        attempts += 1;
        throw new Error("Run version conflict.");
      },
    } as never;
    const driver = new PlaybookRunDriver(controller, 5_000, () => clock);
    await driver.tick();
    await driver.tick();
    expect(attempts).toBe(1);
    clock += 600_000;
    await driver.tick();
    expect(attempts).toBe(2);
  });
});
