#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { chmod, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
} from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { z } from "zod";

import {
  AgentMeshRouter,
  assertTaskPatchPromotable,
  type TaskTrafficGate,
} from "./router.js";
import {
  ensurePrivateDirectory,
  parseOrigin,
  stateDirectory,
} from "./security.js";
import { MCP_PROFILES } from "./mcp-profiles.js";
import {
  MESH_SKILL_IDS,
  MESH_SKILLS,
  MESH_SKILLS_VERSION,
  getMeshSkill,
  meshSkillCatalog,
} from "./mesh-skills.js";
import { createProviderAdmin } from "./provider-admin.js";
import { createPatchPromotionService } from "./patch-promotion.js";
import { requireHumanApproval } from "./human-approval.js";
import {
  INSTRUCTION_PROPOSAL_STATES,
  INSTRUCTION_PROPOSAL_TARGET_KINDS,
  InstructionProposalStore,
  instructionProposalApprovalConfirmation,
} from "./instruction-proposals.js";
import {
  AUTH_CHALLENGE_STATUSES,
  createInteractiveAuthBroker,
} from "./pty-auth.js";
import {
  WorkerCompanionUnavailableError,
  WORKER_CAPABILITY_PROTOCOL,
  WorkerRegistry,
  createWorkerDispatchEnvelope,
  workerDisableConfirmation,
  workerRegistrationConfirmation,
  workerRemoveConfirmation,
  type WorkerCompanion,
  type WorkerTransport,
} from "./workers.js";
import {
  startDashboard,
  type DashboardHandle,
  type DashboardProgressEvent,
} from "./dashboard.js";
import {
  PROVIDERS,
  QUESTION_STATUSES,
  TASK_MODES,
  TASK_STATUSES,
} from "./types.js";
import { registerOrchestrationTools } from "./orchestration-tools.js";
import {
  assertImplementationDirectionsAcknowledged,
  assertWriterDirectionsAcknowledged,
  TrafficControlRegistry,
  TrafficController,
  resolveTrafficLocation,
} from "./traffic-control.js";
import { registerTrafficControlTools } from "./traffic-tools.js";
import {
  loadBridgeAllowlistFile,
  PeerChannelRegistry,
  PeerWakePump,
} from "./peer-channels.js";

function originArgument(argv: string[]): string | undefined {
  const inline = argv.find((arg) => arg.startsWith("--origin="));
  if (inline) return inline.slice("--origin=".length);
  const index = argv.indexOf("--origin");
  return index >= 0 ? argv[index + 1] : undefined;
}

function response(data: unknown) {
  const structuredContent =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { value: data };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent,
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const detail =
    error && typeof error === "object" && "task" in error
      ? { message, task: (error as { task: unknown }).task }
      : { message };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(detail, null, 2) }],
    structuredContent: detail,
    isError: true,
  };
}

const origin = parseOrigin(originArgument(process.argv.slice(2)));
const trafficEnabled = process.env.AGENT_MESH_TRAFFIC_CONTROL === "1";
const trafficRegistry = new TrafficControlRegistry({ origin });
const bridgeAllowlistPath =
  process.env.AGENT_MESH_TRAFFIC_BRIDGE_ALLOWLIST_FILE?.trim();
const bridgeAllowlist = bridgeAllowlistPath
  ? await loadBridgeAllowlistFile({
      path: bridgeAllowlistPath,
      resolveRepoKey: async (path) =>
        (await resolveTrafficLocation(path)).repoKey,
    })
  : [];
const peerRegistry = new PeerChannelRegistry({
  origin,
  agentResolver: (agentId) => trafficRegistry.getAgent(agentId),
  bridgeAllowlist,
  trafficPath: trafficRegistry.path,
  bindingValidator: (member) => {
    const agent = trafficRegistry.getAgent(member.agentId);
    if (!agent) return false;
    if (member.runId) {
      return trafficRegistry.activeRun(agent.id)?.id === member.runId;
    }
    if (member.taskId) {
      return (
        agent.meshTaskId === member.taskId &&
        ["launching", "running"].includes(agent.status)
      );
    }
    return true;
  },
});
const instructionRepositoryRoots = new Map<string, string>();
const instructionProposals = new InstructionProposalStore({
  origin,
  repositoryRoots: instructionRepositoryRoots,
});
function effectiveHarnessPrompt(provider: string, prompt: string): string {
  const active = instructionProposals.activeInstruction({
    kind: "harness_instructions",
    identifier: provider,
  });
  return active
    ? `${active.content}\n\n## Delegated task\n\n${prompt}`
    : prompt;
}
let router!: AgentMeshRouter;
const trafficPeerGate: TaskTrafficGate = {
  async reserve(task, options) {
    if (task.provider === "cursor") {
      // Cursor CLI has no per-run secret-safe scoped MCP injection surface.
      // Use SDK-local Cursor agents for authenticated peer channels.
      await trafficRegistry.reserve(task, {
        workspace: options?.workspace,
      });
      return undefined;
    }
    let location;
    try {
      location = await resolveTrafficLocation(task.effectiveCwd);
    } catch {
      return undefined;
    }
    try {
      const existing = options?.peerAgentId
        ? trafficRegistry.requireAgent(options.peerAgentId)
        : task.sessionId && !options?.forkSession
          ? trafficRegistry.findAgentByExternal(
              "mesh-cli",
              `${task.provider}:session-${task.sessionId}`,
            )
          : undefined;
      if (existing && existing.lane !== "mesh-cli") {
        throw new Error("Mesh continuation peer identity is not a mesh agent.");
      }
      const agent = trafficRegistry.upsertAgent({
        id: existing?.id,
        lane: "mesh-cli",
        externalId:
          existing?.externalId ?? `${task.provider}:task-${task.id}`,
        provider: task.provider,
        sessionId: task.sessionId,
        meshTaskId: task.id,
        name: task.description,
        status: "launching",
        model: task.model,
        modelSelection: task.model ? { id: task.model } : null,
        location,
        adopted: false,
        peerReadOnly:
          task.mode !== "implement" && task.mcpProfile === "none",
      });
      const member = peerRegistry.ensureAgentEnrollment({
        agentId: agent.id,
        taskId: task.id,
        sessionId: task.sessionId ?? undefined,
        role: task.provider,
        assignment: {
          description: task.description,
          mode: task.mode,
        },
        observedGitHead: task.baseCommit ?? undefined,
      });
      // MESH[2026-07-25T22:05Z][agent:cursor-parent][direction:user/11]
      // What: blocks implementation dispatch only on an unresolved direction conflict.
      // Why: this comment previously claimed writers must acknowledge direction
      //   before acquiring a write lease. That was true of the original gate and
      //   became false when pending targets stopped blocking, because a new agent
      //   inherits every active direction as pending and cannot acknowledge before
      //   it launches. A merely-pending target does not block; only an agent's own
      //   conflict-needs-clarity does, because that needs a human to resolve it.
      // Aligns-with: direction user revision 11 (stale comment found in review).
      // Status: complete
      assertImplementationDirectionsAcknowledged({
        operation: "Implementation dispatch",
        mode: task.mode,
        repoKey: location.repoKey,
        agentIds: [agent.id],
        registry: peerRegistry,
      });
      await trafficRegistry.reserve(task, {
        workspace: options?.workspace,
      });
      return {
        origin,
        agentId: agent.id,
        memberId: member.id,
        membershipGeneration: member.generation,
        taskId: task.id,
        ...(options?.peerCausalRoot
          ? { causalRoot: options.peerCausalRoot }
          : {}),
        ...(options?.peerCausalPath?.length
          ? { causalPath: options.peerCausalPath }
          : {}),
      };
    } catch (error) {
      try {
        peerRegistry.settleTaskBinding(task.id);
      } catch {
        // A failed reservation must not leave a usable task-bound capability.
      }
      trafficRegistry.release(task.id);
      throw error;
    }
  },
  release(taskId) {
    try {
      peerRegistry.settleTaskBinding(taskId);
    } catch {
      // Capability invalidation is independently recoverable from task state.
    }
    try {
      const task = router.registry.get(taskId);
      if (task) trafficRegistry.settleMeshTask(task);
    } catch {
      // Traffic reconciliation will repair status metadata.
    } finally {
      try {
        trafficRegistry.release(taskId);
      } catch {
        // PID/run-state fencing still prevents unsafe writer takeover.
      }
    }
  },
  bindSession(taskId, sessionId, peer) {
    const agent = trafficRegistry.findAgentByMeshTask(taskId);
    if (!agent) return undefined;
    trafficRegistry.bindMeshSession({
      agentId: agent.id,
      taskId,
      sessionId,
    });
    peerRegistry.bindMemberSession({
      agentId: agent.id,
      taskId,
      sessionId,
      rotateGeneration: false,
    });
    const rebound = peerRegistry.bindingForAgent({
      agentId: agent.id,
      taskId,
    });
    return {
      origin,
      agentId: rebound.agentId,
      memberId: rebound.memberId,
      membershipGeneration: rebound.membershipGeneration,
      taskId,
      ...(peer?.causalRoot ? { causalRoot: peer.causalRoot } : {}),
      ...(peer?.causalPath?.length
        ? { causalPath: peer.causalPath }
        : {}),
    };
  },
  reserveCleanupPath: (worktreePath, cleanupId) =>
    trafficRegistry.reserveCleanupPath(worktreePath, cleanupId),
  releaseCleanupPath: (cleanupId) =>
    trafficRegistry.releaseCleanupPath(cleanupId),
};
router = new AgentMeshRouter(
  origin,
  undefined,
  undefined,
  trafficPeerGate,
);
trafficRegistry.setTaskStatusResolver(
  (taskId) => router.registry.get(taskId)?.status,
);
const trafficController = trafficEnabled
  ? new TrafficController({
      origin,
      router,
      registry: trafficRegistry,
      peerRegistry,
    })
  : undefined;
const peerWakePump = trafficController
  ? new PeerWakePump(peerRegistry, {
      controllerLease: () => {
        try {
          return trafficController.authorizePeerAdministration();
        } catch {
          return {
            active: false,
            ownerInstanceId: null,
            generation: 0,
          };
        }
      },
      wake: (job) =>
        trafficController.wakePeerAgent({
          agentId: job.recipientAgentId,
          channelId: job.channelId,
          firstSequence: job.firstSequence,
          lastSequence: job.lastSequence,
          messageCount: job.messageCount,
          policyVersion: job.policyVersion,
          wakeJobId: job.id,
          causalRoot: job.causalRoot,
          causalPath: job.causalPath,
        }),
    })
  : undefined;
peerWakePump?.start();
const providerAdmin = createProviderAdmin();
const authBroker = createInteractiveAuthBroker();
const patchPromotions = createPatchPromotionService({ origin, registry: router.registry });

function directionTargetAgents(repoKey: string): string[] {
  const agentIds = new Set<string>();
  let afterSequence = 0;
  for (;;) {
    const page = peerRegistry.directionOutbox({
      repoKey,
      afterSequence,
      limit: 500,
      includeHistory: false,
    });
    for (const entry of page) {
      for (const target of entry.targets) agentIds.add(target.agentId);
    }
    if (page.length < 500) break;
    const nextSequence = Math.max(
      ...page.map((entry) => entry.revision.sequence),
    );
    if (nextSequence <= afterSequence) break;
    afterSequence = nextSequence;
  }
  return [...agentIds];
}

function workerTransportLabel(transport: WorkerTransport): string {
  return transport.kind === "ssh" ? `ssh:${transport.alias}` : "local mesh process";
}

async function assertPatchPromotionReady(
  taskId: string,
  targetRepo: string,
): Promise<void> {
  const task = router.registry.require(taskId);
  assertTaskPatchPromotable(task);
  const location = await resolveTrafficLocation(targetRepo);
  assertWriterDirectionsAcknowledged({
    operation: "Patch promotion",
    repoKey: location.repoKey,
    agentIds: directionTargetAgents(location.repoKey),
    registry: peerRegistry,
  });
}
const localWorkerCompanion: WorkerCompanion = {
  async probe({ worker }) {
    if (worker.transport.kind !== "local") {
      throw new WorkerCompanionUnavailableError("probe");
    }
    return { health: "healthy", message: "Local mesh process is available." };
  },
  async dispatch({ worker, envelope, signal }) {
    if (worker.transport.kind !== "local") {
      throw new WorkerCompanionUnavailableError("dispatch");
    }
    if (signal.aborted) throw new Error("Worker dispatch was cancelled before launch.");
    const mesh = await router.start(
      {
        provider: envelope.task.provider,
        prompt: envelope.task.prompt,
        description: envelope.task.description,
        cwd: envelope.task.cwd,
        mode: envelope.task.mode,
        model: envelope.task.model ?? undefined,
        effort: envelope.task.effort ?? undefined,
        mcpProfile: envelope.task.mcpProfile,
        isolation: envelope.task.isolation,
        timeoutMs: envelope.task.timeoutMs,
        baseRef: envelope.task.baseRef ?? undefined,
      },
      { background: true },
    );
    if (signal.aborted) {
      await router.cancel(mesh.task.id).catch(() => undefined);
      throw new Error("Worker dispatch timed out during launch.");
    }
    void router
      .getResult(mesh.task.id, true, envelope.task.timeoutMs)
      .finally(() => {
        workerRegistry.completeDispatch(worker.id);
      })
      .catch(() => undefined);
    return {
      dispatchId: envelope.dispatchId,
      accepted: true,
      remoteTaskId: mesh.task.id,
      acceptedAt: new Date().toISOString(),
    };
  },
};
const workerRegistry = new WorkerRegistry({
  allowedSshAliases: (process.env.AGENT_MESH_ALLOWED_SSH_ALIASES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  companion: localWorkerCompanion,
});
let dashboard: DashboardHandle | undefined;
let dashboardBootstrapFile: string | undefined;
const nativeTaskStore = new InMemoryTaskStore();
const nativeTaskMessageQueue = new InMemoryTaskMessageQueue();
const server = new McpServer(
  { name: "agent-mesh-mcp", version: "0.2.0" },
  {
    capabilities: {
      tasks: { requests: { tools: { call: {} } } },
      prompts: {},
      resources: {},
    },
    taskStore: nativeTaskStore,
    taskMessageQueue: nativeTaskMessageQueue,
  },
);
if (trafficController) {
  registerTrafficControlTools({
    server,
    controller: trafficController,
    peerRegistry,
  });
}
const orchestration = registerOrchestrationTools({
  server,
  router,
  origin,
  providerAdmin,
  trafficGate: trafficPeerGate,
});

function effectiveMeshSkill(id: string) {
  const skill = getMeshSkill(id);
  const active = instructionProposals.activeInstruction({
    kind: "mesh_skill",
    identifier: id,
  });
  return active ? { ...skill, body: active.content } : skill;
}

function effectiveMeshSkillsDocument(): string {
  return `# Agent Mesh Skills

Version: ${MESH_SKILLS_VERSION}

Escalation tiers, lowest to highest. Start at the tier the work needs, and
escalate exactly one tier when it proves riskier than that tier assumes.

${MESH_SKILL_IDS.map((id) => effectiveMeshSkill(id).body).join("\n---\n\n")}`;
}

server.registerResource(
  "agent-mesh-skills",
  "mesh://skills",
  {
    title: "Agent Mesh Skills",
    description: "Canonical escalation-tier doctrine for running work through the mesh.",
    mimeType: "text/markdown",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "text/markdown",
        text: effectiveMeshSkillsDocument(),
      },
    ],
  }),
);

for (const skillId of MESH_SKILL_IDS) {
  const skill = MESH_SKILLS[skillId];
  server.registerResource(
    `agent-mesh-skill-${skill.id}`,
    `mesh://skills/${skill.id}`,
    {
      title: skill.title,
      description: skill.description,
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: effectiveMeshSkill(skill.id).body,
        },
      ],
    }),
  );

  server.registerPrompt(
    skill.id,
    {
      title: skill.title,
      description: skill.description,
      argsSchema: { objective: z.string().max(8_000).optional() },
    },
    async ({ objective }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: objective
              ? `${effectiveMeshSkill(skill.id).body}\n\nObjective: ${objective}`
              : effectiveMeshSkill(skill.id).body,
          },
        },
      ],
    }),
  );
}

server.registerTool(
  "mesh_skills_list",
  {
    title: "List mesh skills",
    description:
      "List the four escalation tiers with their titles, descriptions, and tier numbers; instruction bodies come from mesh_skill_get.",
    inputSchema: {},
  },
  async () => response({ version: MESH_SKILLS_VERSION, skills: meshSkillCatalog() }),
);

server.registerTool(
  "mesh_skill_get",
  {
    title: "Read one mesh skill",
    description:
      "Return one tier's full instruction body for harnesses that receive tool allowlists without prompts or resources.",
    inputSchema: { skill_id: z.enum(MESH_SKILL_IDS) },
  },
  async ({ skill_id }) => {
    try {
      return response({
        version: MESH_SKILLS_VERSION,
        skill: effectiveMeshSkill(skill_id),
      });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "instruction_proposals_list",
  {
    title: "List instruction proposals",
    description:
      "List durable evidence-backed instruction proposals by state and target.",
    inputSchema: {
      state: z.enum(INSTRUCTION_PROPOSAL_STATES).optional(),
      target_kind: z.enum(INSTRUCTION_PROPOSAL_TARGET_KINDS).optional(),
      target_identifier: z.string().min(1).max(512).optional(),
      limit: z.number().int().min(1).max(1_000).default(100),
    },
  },
  async ({ state, target_kind, target_identifier, limit }) => {
    try {
      return response(
        instructionProposals.listProposals({
          state,
          targetKind: target_kind,
          targetIdentifier: target_identifier,
          limit,
        }),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "instruction_proposal_get",
  {
    title: "Read instruction proposal",
    description:
      "Read one proposal with its replacement content, friction evidence, digest, state, and approval.",
    inputSchema: { proposal_id: z.string().uuid() },
  },
  async ({ proposal_id }) => {
    try {
      return response(instructionProposals.getProposal(proposal_id));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "instruction_proposal_approve",
  {
    title: "Approve exact instruction proposal",
    description:
      "Digest-bound approval with exact confirmation and out-of-band human UI.",
    inputSchema: {
      proposal_id: z.string().uuid(),
      expected_digest: z.string().regex(/^[0-9a-f]{64}$/),
      confirmation: z.string().min(1).max(200),
      expires_at: z.string().datetime().optional(),
    },
  },
  async ({
    proposal_id,
    expected_digest,
    confirmation,
    expires_at,
  }) => {
    try {
      const expected = instructionProposalApprovalConfirmation(
        proposal_id,
        expected_digest,
      );
      if (confirmation !== expected) {
        throw new Error(`Confirmation must exactly equal "${expected}".`);
      }
      const proposal = instructionProposals.getProposal(proposal_id);
      if (
        proposal.state !== "proposed" ||
        proposal.contentDigest !== expected_digest
      ) {
        throw new Error(
          "Only the exact current proposed content can be approved.",
        );
      }
      // Without this gate, injected model text could authorize rewriting the
      // rules agents run under. Model-authored confirmations are never authority.
      // MESH[2026-07-25T20:52Z][agent:claude-builder][direction:user/1]
      // What: gave the approval the target, digest, rationale, and friction volume.
      // Why: approving a rewrite of the rules agents run under from one sentence
      //   gave the human no way to tell which instructions changed or on what evidence.
      // Aligns-with: direction user revision 1 (structured approval requests).
      // Status: complete
      await requireHumanApproval({
        title: "Approve instruction proposal",
        summary: `Approve instruction proposal ${proposal.id} for ${proposal.target.kind} ${proposal.target.identifier}.`,
        operation: "instruction_proposal_approve",
        target: `${proposal.target.kind} ${proposal.target.identifier}`,
        reversible: false,
        reversal:
          "Applying an approved proposal rewrites the instruction set agents run under; the mesh does not restore the previous text.",
        fields: [
          { label: "Proposal", value: proposal.id },
          { label: "Target kind", value: proposal.target.kind },
          { label: "Target identifier", value: proposal.target.identifier },
          ...(proposal.target.relativePath
            ? [{ label: "Relative path", value: proposal.target.relativePath }]
            : []),
          {
            label: "Supporting friction events",
            value: `${proposal.frictionEvidence.eventIds.length} recorded (${proposal.frictionEvidence.summary.total} total observations)`,
          },
          {
            label: "Approval binding",
            value:
              "Approval is bound to this exact content digest; any later edit produces a new digest and voids it.",
          },
        ],
        evidence: [
          `Rationale: ${proposal.rationale}`,
          `Friction by kind: ${
            proposal.frictionEvidence.summary.byKind
              .map((entry) => `${entry.kind}=${entry.count}`)
              .join(", ") || "none recorded"
          }`,
          `Friction by provider: ${
            proposal.frictionEvidence.summary.byProvider
              .map((entry) => `${entry.provider}=${entry.count}`)
              .join(", ") || "none recorded"
          }`,
        ],
        digests: [{ label: "Proposed content sha256", value: expected_digest }],
      });
      return response(
        instructionProposals.approveProposal({
          proposalId: proposal_id,
          expectedDigest: expected_digest,
          expiresAt: expires_at,
        }),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "instruction_proposal_reject",
  {
    title: "Reject instruction proposal",
    description:
      "Reject a proposed or approved instruction change with a durable reason.",
    inputSchema: {
      proposal_id: z.string().uuid(),
      reason: z.string().min(1).max(4_000),
    },
  },
  async ({ proposal_id, reason }) => {
    try {
      return response(
        instructionProposals.rejectProposal({
          proposalId: proposal_id,
          reason,
        }),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "instruction_proposal_apply",
  {
    title: "Apply approved instruction proposal",
    description:
      "Apply the exact approved content once; fail closed on missing, void, mismatched, or previously consumed authority.",
    inputSchema: {
      proposal_id: z.string().uuid(),
      expected_digest: z.string().regex(/^[0-9a-f]{64}$/),
      repository_root: z.string().min(1).optional(),
    },
  },
  async ({ proposal_id, expected_digest, repository_root }) => {
    try {
      const proposal = instructionProposals.getProposal(proposal_id);
      if (proposal.target.kind === "repository_ruleset") {
        if (!repository_root) {
          throw new Error(
            "Repository ruleset application requires its allowed repository root.",
          );
        }
        const location = await resolveTrafficLocation(repository_root);
        if (location.repoKey !== proposal.target.identifier) {
          throw new Error(
            "Repository ruleset proposal is bound to a different repository.",
          );
        }
        instructionRepositoryRoots.set(
          proposal.target.identifier,
          location.repoRoot,
        );
      } else if (repository_root) {
        throw new Error(
          "Only repository ruleset proposals accept a repository root.",
        );
      }
      return response(
        instructionProposals.applyProposal({
          proposalId: proposal_id,
          expectedDigest: expected_digest,
        }),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "models_list",
  {
    title: "List coding-agent models",
    description:
      "List current models and provider capabilities. Cursor, Codex, Grok, and Antigravity are queried dynamically; Claude accepts aliases/full IDs but has no machine-readable catalog.",
    inputSchema: {
      provider: z.enum(PROVIDERS).optional(),
    },
  },
  async ({ provider }) => {
    try {
      return response(await router.listModels(provider));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "provider_status",
  {
    title: "Inspect provider status",
    description:
      "Read installed version, binary, authentication/account, configured defaults, and supported administration capabilities without mutation.",
    inputSchema: { provider: z.enum(PROVIDERS) },
  },
  async ({ provider }) => {
    try {
      return response(await providerAdmin.providerStatus(provider));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "provider_usage",
  {
    title: "Inspect provider usage",
    description:
      "Return normalized rate-limit, credit, cost, and session usage where the provider exposes it; unsupported fields are explicit.",
    inputSchema: { provider: z.enum(PROVIDERS) },
  },
  async ({ provider }) => {
    try {
      return response(await providerAdmin.providerUsage(provider));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "provider_doctor",
  {
    title: "Run provider diagnostics",
    description: "Run the provider's allowlisted read-only health diagnostics.",
    inputSchema: { provider: z.enum(PROVIDERS) },
  },
  async ({ provider }) => {
    try {
      return response(await providerAdmin.providerDoctor(provider));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "provider_models",
  {
    title: "List provider models",
    description:
      "List the current Cursor, Codex, Grok, or Antigravity catalog, or Claude's safe aliases and validated full model IDs.",
    inputSchema: { provider: z.enum(PROVIDERS) },
  },
  async ({ provider }) => {
    try {
      return response(await providerAdmin.listProviderModels(provider));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "provider_update_check",
  {
    title: "Check provider update",
    description: "Read current/latest provider version information without updating.",
    inputSchema: { provider: z.enum(PROVIDERS) },
  },
  async ({ provider }) => {
    try {
      return response(await providerAdmin.providerUpdateCheck(provider));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "provider_update",
  {
    title: "Update provider CLI",
    description:
      'Mutating operation. Confirmation must exactly equal "UPDATE <provider>".',
    inputSchema: {
      provider: z.enum(PROVIDERS),
      confirmation: z.string().min(1).max(64),
    },
  },
  async ({ provider, confirmation }) => {
    try {
      if (confirmation !== `UPDATE ${provider}`) {
        throw new Error(`Confirmation must exactly equal "UPDATE ${provider}".`);
      }
      const status = await providerAdmin.providerStatus(provider);
      if (!status.capabilities.update) {
        throw new Error(`${provider} does not expose a verified update operation.`);
      }
      await requireHumanApproval({
        title: "Update provider CLI",
        summary: `Update the ${provider} CLI installed on this machine.`,
        operation: "provider_update",
        target: status.binaryPath ?? `${provider} CLI`,
        reversible: false,
        reversal:
          "The mesh exposes no downgrade; returning to the current version is a manual reinstall.",
        fields: [
          { label: "Provider", value: provider },
          { label: "Current version", value: status.version ?? "unknown" },
          { label: "Binary", value: status.binaryPath ?? "unknown" },
          { label: "Account", value: status.auth.summary },
          {
            label: "Effect",
            value:
              "Replaces the installed CLI that mesh tasks execute; running tasks keep the old binary until they exit.",
          },
        ],
      });
      return response(
        await providerAdmin.providerUpdate(provider, { confirmation }),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "provider_logout",
  {
    title: "Log out provider CLI",
    description:
      'Destructive credential removal. Confirmation must exactly equal "LOGOUT <provider>".',
    inputSchema: {
      provider: z.enum(PROVIDERS),
      confirmation: z.string().min(1).max(64),
    },
  },
  async ({ provider, confirmation }) => {
    try {
      if (confirmation !== `LOGOUT ${provider}`) {
        throw new Error(`Confirmation must exactly equal "LOGOUT ${provider}".`);
      }
      const status = await providerAdmin.providerStatus(provider);
      if (!status.capabilities.logout) {
        throw new Error(`${provider} does not expose a logout operation.`);
      }
      await requireHumanApproval({
        title: "Log out provider CLI",
        summary: `Log out the ${provider} CLI and destroy its stored credentials.`,
        operation: "provider_logout",
        target: `${provider} CLI credentials`,
        reversible: false,
        reversal:
          "Logging out destroys the stored credentials; restoring access requires a fresh interactive login.",
        fields: [
          { label: "Provider", value: provider },
          { label: "Current account", value: status.auth.summary },
          ...(status.auth.account?.email
            ? [{ label: "Account email", value: status.auth.account.email }]
            : []),
          ...(status.auth.account?.plan
            ? [{ label: "Plan", value: status.auth.account.plan }]
            : []),
          { label: "Installed version", value: status.version ?? "unknown" },
          {
            label: "Effect",
            value:
              "Every queued and future task for this provider fails until someone logs in again.",
          },
        ],
      });
      return response(
        await providerAdmin.providerLogout(provider, { confirmation }),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "auth_start",
  {
    title: "Start interactive authentication",
    description:
      "Start an allowlisted provider or downstream MCP login/logout in a durable pseudo-terminal. Returns a browser URL/device code when available.",
    inputSchema: {
      target: z.enum(["provider", "mcp"]),
      provider: z.enum(PROVIDERS),
      operation: z.enum(["login", "logout"]).default("login"),
      server_name: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
        .optional(),
      cwd: z.string().min(1).optional(),
      confirm_logout: z.boolean().default(false),
      timeout_ms: z.number().int().min(1_000).max(1_800_000).default(600_000),
    },
  },
  async ({
    target,
    provider,
    operation,
    server_name,
    cwd,
    confirm_logout,
    timeout_ms,
  }) => {
    try {
      if (operation === "logout") {
        await requireHumanApproval({
          title: "Log out in an interactive terminal",
          summary: `Start an interactive ${provider} logout${
            server_name ? ` for MCP server ${server_name}` : ""
          }.`,
          operation: "auth_start",
          target: server_name ? `${provider} → ${server_name}` : `${provider} CLI`,
          reversible: false,
          reversal:
            "Logging out destroys the stored credentials; restoring access requires a fresh interactive login.",
          fields: [
            { label: "Provider", value: provider },
            { label: "Target", value: target },
            ...(server_name ? [{ label: "MCP server", value: server_name }] : []),
            ...(cwd ? [{ label: "Working directory", value: cwd }] : []),
            {
              label: "Effect",
              value: "Credentials are destroyed in a durable pseudo-terminal session.",
            },
          ],
        });
      }
      return response(
        await authBroker.startChallenge({
          target,
          provider,
          operation,
          serverName: server_name,
          cwd,
          confirmLogout: confirm_logout,
          timeoutMs: timeout_ms,
        }),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "auth_status",
  {
    title: "Inspect authentication challenge",
    description: "Return a redacted durable PTY/OAuth challenge record.",
    inputSchema: { challenge_id: z.string().uuid() },
  },
  async ({ challenge_id }) => {
    try {
      const challenge = await authBroker.getChallenge(challenge_id);
      if (!challenge) throw new Error(`Unknown authentication challenge: ${challenge_id}`);
      return response(challenge);
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "auth_list",
  {
    title: "List authentication challenges",
    description: "List redacted authentication challenges and their current state.",
    inputSchema: {
      target: z.enum(["provider", "mcp"]).optional(),
      provider: z.enum(PROVIDERS).optional(),
      status: z.enum(AUTH_CHALLENGE_STATUSES).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    },
  },
  async ({ target, provider, status, limit }) => {
    try {
      return response(await authBroker.listChallenges({ target, provider, status, limit }));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "auth_submit",
  {
    title: "Submit authentication input",
    description:
      "Submit a pasted redirect URL, one-time code, or Enter response to a waiting authentication challenge.",
    inputSchema: {
      challenge_id: z.string().uuid(),
      input: z.string().max(8_192),
    },
  },
  async ({ challenge_id, input }) => {
    try {
      return response(await authBroker.submitChallengeInput(challenge_id, input));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "auth_cancel",
  {
    title: "Cancel authentication challenge",
    description: "Cancel a queued or active PTY/OAuth authentication flow.",
    inputSchema: { challenge_id: z.string().uuid() },
  },
  async ({ challenge_id }) => {
    try {
      return response(await authBroker.cancelChallenge(challenge_id));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "agent_start",
  {
    title: "Start a delegated coding agent",
    description:
      "Delegate a task to Cursor, Codex, Claude, Grok, or Antigravity. The target must differ from this client's fixed origin. Implementation defaults to an isolated git worktree; workspace=live explicitly writes in the canonical checkout.",
    inputSchema: {
      provider: z.enum(PROVIDERS),
      prompt: z.string().min(1),
      description: z.string().min(1).max(160),
      cwd: z.string().min(1).describe("Absolute project directory under an allowed development root"),
      mode: z.enum(TASK_MODES).default("review"),
      model: z.string().min(1).optional(),
      effort: z.string().min(1).optional(),
      mcp_profile: z.enum(MCP_PROFILES).default("none"),
      isolation: z.enum(["auto", "none", "worktree"]).default("auto"),
      workspace: z.enum(["live", "worktree"]).default("worktree"),
      base_ref: z.string().min(1).optional(),
      background: z.boolean().default(true),
      timeout_ms: z.number().int().min(1_000).max(7_200_000).default(900_000),
    },
  },
  async ({
    provider,
    prompt,
    description,
    cwd,
    mode,
    model,
    effort,
    mcp_profile,
    isolation,
    workspace,
    base_ref,
    background,
    timeout_ms,
  }) => {
    try {
      return response(
        await router.start(
          {
            provider,
            prompt: effectiveHarnessPrompt(provider, prompt),
            description,
            cwd,
            mode,
            model,
            effort,
            mcpProfile: mcp_profile,
            isolation,
            workspace,
            baseRef: base_ref,
            timeoutMs: timeout_ms,
          },
          { background },
        ),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

const nativeMeshTasks = new Map<string, string>();
async function monitorNativeTask(nativeTaskId: string, meshTaskId: string): Promise<void> {
  let currentMeshTaskId = meshTaskId;
  try {
    for (;;) {
      const nativeTask = await nativeTaskStore.getTask(nativeTaskId);
      if (!nativeTask) return;
      if (nativeTask.status === "cancelled") {
        await router.cancel(currentMeshTaskId).catch(() => undefined);
        return;
      }
      const mesh = await router.getResult(currentMeshTaskId, false, 0);
      if (mesh.task.status === "completed") {
        const continuation = router.registry.latestChildTask(origin, currentMeshTaskId);
        if (continuation) {
          currentMeshTaskId = continuation.id;
          nativeMeshTasks.set(nativeTaskId, currentMeshTaskId);
          continue;
        }
      }
      if (mesh.task.status === "waiting_for_input") {
        await nativeTaskStore.updateTaskStatus(
          nativeTaskId,
          "input_required",
          mesh.questions?.[0]?.question ?? "Parent input required",
        );
      } else if (
        ["queued", "running", "cancelling", "resuming"].includes(mesh.task.status)
      ) {
        await nativeTaskStore.updateTaskStatus(
          nativeTaskId,
          "working",
          `${mesh.task.provider}: ${mesh.task.status}`,
        );
      } else {
        const result = response(mesh);
        await nativeTaskStore.storeTaskResult(
          nativeTaskId,
          mesh.task.status === "completed" ? "completed" : "failed",
          {
            ...result,
            ...(mesh.task.status === "completed" ? {} : { isError: true }),
          },
        );
        return;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 500);
        timer.unref();
      });
    }
  } catch (error) {
    const current = await nativeTaskStore.getTask(nativeTaskId).catch(() => null);
    if (current?.status !== "cancelled") {
      await nativeTaskStore
        .storeTaskResult(nativeTaskId, "failed", failure(error))
        .catch(() => undefined);
    }
  } finally {
    nativeMeshTasks.delete(nativeTaskId);
  }
}

server.experimental.tasks.registerToolTask(
  "agent_start_task",
  {
    title: "Start a native MCP delegated task",
    description:
      "Task-protocol version of agent_start. Returns an MCP task handle with polling, cancellation, and input-required state.",
    inputSchema: {
      provider: z.enum(PROVIDERS),
      prompt: z.string().min(1),
      description: z.string().min(1).max(160),
      cwd: z.string().min(1),
      mode: z.enum(TASK_MODES).default("review"),
      model: z.string().min(1).optional(),
      effort: z.string().min(1).optional(),
      mcp_profile: z.enum(MCP_PROFILES).default("none"),
      isolation: z.enum(["auto", "none", "worktree"]).default("auto"),
      workspace: z.enum(["live", "worktree"]).default("worktree"),
      base_ref: z.string().min(1).optional(),
      timeout_ms: z.number().int().min(1_000).max(7_200_000).default(900_000),
    },
    execution: { taskSupport: "required" },
  },
  {
    async createTask(args, extra) {
      const task = await extra.taskStore.createTask({
        ttl: Math.min(
          24 * 60 * 60 * 1_000,
          Math.max(extra.taskRequestedTtl ?? 60_000, args.timeout_ms + 60_000),
        ),
        pollInterval: 1_000,
      });
      const mesh = await router.start(
        {
          provider: args.provider,
          prompt: effectiveHarnessPrompt(args.provider, args.prompt),
          description: args.description,
          cwd: args.cwd,
          mode: args.mode,
          model: args.model,
          effort: args.effort,
          mcpProfile: args.mcp_profile,
          isolation: args.isolation,
          workspace: args.workspace,
          baseRef: args.base_ref,
          timeoutMs: args.timeout_ms,
        },
        { background: true },
      );
      nativeMeshTasks.set(task.taskId, mesh.task.id);
      void monitorNativeTask(task.taskId, mesh.task.id).catch(() => undefined);
      return { task };
    },
    async getTask(_args, extra) {
      return extra.taskStore.getTask(extra.taskId);
    },
    async getTaskResult(_args, extra) {
      return (await extra.taskStore.getTaskResult(
        extra.taskId,
      )) as ReturnType<typeof response>;
    },
  },
);

server.registerTool(
  "agent_status",
  {
    title: "Get delegated-agent status",
    description:
      "Return the current durable task record, pending questions, and bounded provider progress metadata.",
    inputSchema: { task_id: z.string().uuid() },
  },
  async ({ task_id }) => {
    try {
      return response(await router.getStatusReport(task_id));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "agent_result",
  {
    title: "Get delegated-agent result",
    description: "Return a completed result, or optionally wait for a running task.",
    inputSchema: {
      task_id: z.string().uuid(),
      wait: z.boolean().default(false),
      timeout_ms: z.number().int().min(0).max(600_000).default(30_000),
    },
  },
  async ({ task_id, wait, timeout_ms }) => {
    try {
      return response(await router.getResult(task_id, wait, timeout_ms));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "agent_cancel",
  {
    title: "Cancel a delegated agent",
    description: "Interrupt a running provider turn or process and mark the task cancelled.",
    inputSchema: { task_id: z.string().uuid() },
  },
  async ({ task_id }) => {
    try {
      return response(await router.cancel(task_id));
    } catch (error) {
      return failure(error);
    }
  },
);

const sessionInput = {
  provider: z.enum(PROVIDERS),
  session_id: z.string().min(1),
  prompt: z.string().min(1),
  description: z.string().min(1).max(160),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  mcp_profile: z.enum(MCP_PROFILES).optional(),
  mode: z.enum(TASK_MODES).optional(),
  background: z.boolean().default(true),
  timeout_ms: z.number().int().min(1_000).max(7_200_000).default(900_000),
};

server.registerTool(
  "session_resume",
  {
    title: "Resume a mesh session",
    description:
      "Continue a Cursor, Codex, Claude, Grok, or Antigravity session previously created by this mesh.",
    inputSchema: sessionInput,
  },
  async (input) => {
    try {
      return response(
        await router.continueSession({
          provider: input.provider,
          sessionId: input.session_id,
          prompt: effectiveHarnessPrompt(input.provider, input.prompt),
          description: input.description,
          model: input.model,
          effort: input.effort,
          mcpProfile: input.mcp_profile,
          mode: input.mode,
          timeoutMs: input.timeout_ms,
          background: input.background,
          fork: false,
        }),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "session_fork",
  {
    title: "Fork a mesh session",
    description:
      "Fork a prior Codex, Claude, or Grok session. Cursor and Antigravity do not expose session-fork operations.",
    inputSchema: sessionInput,
  },
  async (input) => {
    try {
      return response(
        await router.continueSession({
          provider: input.provider,
          sessionId: input.session_id,
          prompt: effectiveHarnessPrompt(input.provider, input.prompt),
          description: input.description,
          model: input.model,
          effort: input.effort,
          mcpProfile: input.mcp_profile,
          mode: input.mode,
          timeoutMs: input.timeout_ms,
          background: input.background,
          fork: true,
        }),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "sessions_search",
  {
    title: "Search mesh sessions",
    description:
      "Search task/session metadata created by the mesh. A non-empty query can also search native Codex threads.",
    inputSchema: {
      query: z.string().optional(),
      provider: z.enum(PROVIDERS).optional(),
      status: z.enum(TASK_STATUSES).optional(),
      limit: z.number().int().min(1).max(100).default(20),
      include_native_codex: z
        .boolean()
        .default(false)
        .describe("Only honored by an origin=codex router"),
    },
  },
  async ({ query, provider, status, limit, include_native_codex }) => {
    try {
      return response(
        await router.searchSessions({
          query,
          provider,
          status,
          limit,
          includeNativeCodex: include_native_codex,
        }),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "agent_questions",
  {
    title: "List delegated-agent questions",
    description:
      "List blocking questions raised by headless delegated agents. Answer from parent context when possible; otherwise present the exact question to the user, then call question_answer.",
    inputSchema: {
      task_id: z.string().uuid().optional(),
      status: z.enum(QUESTION_STATUSES).default("pending"),
      limit: z.number().int().min(1).max(100).default(20),
    },
  },
  async ({ task_id, status, limit }) => {
    try {
      return response(router.listQuestions({ taskId: task_id, status, limit }));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "question_answer",
  {
    title: "Answer and resume a blocked agent",
    description:
      "Answer a pending delegated-agent question. Live Codex requests continue in the same turn; disconnected and generic-envelope questions resume their provider session/worktree. If the parent cannot answer, ask the user before invoking this tool.",
    inputSchema: {
      question_id: z.string().uuid(),
      answer: z.string().min(1).max(8_000),
      additional_context: z.string().max(8_000).optional(),
      background: z.boolean().default(true),
      timeout_ms: z.number().int().min(1_000).max(7_200_000).default(900_000),
    },
  },
  async ({ question_id, answer, additional_context, background, timeout_ms }) => {
    try {
      return response(
        await router.answerQuestion({
          questionId: question_id,
          answer,
          additionalContext: additional_context,
          background,
          timeoutMs: timeout_ms,
        }),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

const historyInput = {
  task_id: z.string().uuid(),
  cursor: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(500).default(50),
  tail: z.boolean().default(false),
};

server.registerTool(
  "agent_history",
  {
    title: "Read delegated-agent transcript",
    description:
      "Read a bounded, redacted page of the task's user/assistant/error/question transcript.",
    inputSchema: historyInput,
  },
  async ({ task_id, cursor, limit, tail }) => {
    try {
      return response(await router.getTaskHistory(task_id, { cursor, limit, tail }));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "agent_events",
  {
    title: "Read delegated-agent event timeline",
    description:
      "Read bounded metadata-only provider events for progress, tool activity, turns, and internal subagent activity.",
    inputSchema: historyInput,
  },
  async ({ task_id, cursor, limit, tail }) => {
    try {
      return response(await router.getTaskEvents(task_id, { cursor, limit, tail }));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "session_history",
  {
    title: "Read full mesh session history",
    description:
      "Read a redacted transcript page across every mesh task that resumed the same provider session.",
    inputSchema: {
      provider: z.enum(PROVIDERS),
      session_id: z.string().min(1),
      cursor: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(100),
    },
  },
  async ({ provider, session_id, cursor, limit }) => {
    try {
      return response(
        await router.getSessionHistory({
          provider,
          sessionId: session_id,
          cursor,
          limit,
        }),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "patch_preview",
  {
    title: "Preview patch promotion",
    description:
      "Validate a captured task patch against a clean target repository without applying it.",
    inputSchema: {
      task_id: z.string().uuid(),
      target_repo: z.string().min(1),
    },
  },
  async ({ task_id, target_repo }) => {
    try {
      await assertPatchPromotionReady(task_id, target_repo);
      return response(
        await patchPromotions.preview({ taskId: task_id, targetRepo: target_repo }),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "patch_apply",
  {
    title: "Apply verified patch",
    description:
      'Apply a verified patch without committing. Confirmation must exactly equal "APPLY <task-id>".',
    inputSchema: {
      task_id: z.string().uuid(),
      target_repo: z.string().min(1),
      confirmation: z.string().min(1).max(128),
    },
  },
  async ({ task_id, target_repo, confirmation }) => {
    try {
      if (confirmation !== `APPLY ${task_id}`) {
        throw new Error(`Confirmation must exactly equal "APPLY ${task_id}".`);
      }
      await assertPatchPromotionReady(task_id, target_repo);
      // MESH[2026-07-25T20:56Z][agent:claude-builder][direction:user/1]
      // What: previewed the promotion first so the dialog carries the digest,
      //   byte size, affected paths, and target cleanliness.
      // Why: "apply this patch?" told the human nothing about what would change.
      //   Preview is read-only and takes no promotion lock, so it is safe here.
      // Aligns-with: direction user revision 1 (structured approval requests).
      // Status: complete
      const task = router.registry.require(task_id);
      const preview = await patchPromotions.preview({
        taskId: task_id,
        targetRepo: target_repo,
      });
      await requireHumanApproval({
        title: "Apply verified patch",
        summary: `Apply task ${task_id}'s verified patch to ${preview.targetRepo}.`,
        operation: "patch_apply",
        target: preview.targetRepo,
        reversible: true,
        reversal:
          "patch_rollback restores the recorded pre-apply state while the promotion record survives.",
        fields: [
          { label: "Task", value: task_id },
          {
            label: "Produced by",
            value: `${task.provider}${task.model ? ` / ${task.model}` : ""}`,
          },
          { label: "Source worktree", value: preview.sourceRepo },
          { label: "Base commit", value: preview.baseCommit },
          { label: "Patch size", value: `${preview.patchBytes} bytes` },
          {
            label: "Affected paths",
            value: `${preview.affectedPaths.length} (listed in the detail page)`,
          },
          {
            label: "Target repository",
            value: preview.preStatus.clean
              ? "clean — no uncommitted changes"
              : "NOT clean — the target has uncommitted changes",
          },
          ...(preview.activePromotionId
            ? [{ label: "Active promotion", value: preview.activePromotionId }]
            : []),
        ],
        affectedPaths: preview.affectedPaths,
        digests: [
          { label: "Patch sha256", value: preview.patchSha256 },
          { label: "Pre-apply status sha256", value: preview.preStatus.sha256 },
          {
            label: "Affected files sha256 (before)",
            value: preview.preFingerprint.sha256,
          },
          {
            label: "Affected files sha256 (expected after)",
            value: preview.expectedPostFingerprint.sha256,
          },
        ],
      });
      return response(
        await patchPromotions.apply({
          taskId: task_id,
          targetRepo: target_repo,
          confirmation,
        }),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "patch_rollback",
  {
    title: "Rollback promoted patch",
    description:
      'Reverse a prior clean promotion. Confirmation must exactly equal "ROLLBACK <promotion-id>".',
    inputSchema: {
      promotion_id: z.string().uuid(),
      confirmation: z.string().min(1).max(128),
    },
  },
  async ({ promotion_id, confirmation }) => {
    try {
      if (confirmation !== `ROLLBACK ${promotion_id}`) {
        throw new Error(
          `Confirmation must exactly equal "ROLLBACK ${promotion_id}".`,
        );
      }
      const promotion = (
        await patchPromotions.listPromotions({ limit: 1_000 })
      ).find((record) => record.id === promotion_id);
      await requireHumanApproval({
        title: "Rollback promoted patch",
        summary: `Reverse patch promotion ${promotion_id}${
          promotion ? ` in ${promotion.targetRepo}` : ""
        }.`,
        operation: "patch_rollback",
        target: promotion?.targetRepo ?? `promotion ${promotion_id}`,
        reversible: true,
        reversal:
          "The same task's patch can be applied again, but edits made on top of the promotion since it was applied are not preserved.",
        fields: [
          { label: "Promotion", value: promotion_id },
          ...(promotion
            ? [
                { label: "Task", value: promotion.taskId },
                { label: "Target repository", value: promotion.targetRepo },
                {
                  label: "Applied at",
                  value: promotion.appliedAt ?? "never recorded as applied",
                },
                { label: "Promotion state", value: promotion.state },
                {
                  label: "Affected paths",
                  value: `${promotion.affectedPaths.length} (listed in the detail page)`,
                },
              ]
            : [
                {
                  label: "Record",
                  value:
                    "No matching promotion record was found for this origin; the rollback will fail unless one exists.",
                },
              ]),
        ],
        affectedPaths: promotion?.affectedPaths,
        digests: promotion
          ? [
              { label: "Patch sha256", value: promotion.patchSha256 },
              { label: "Pre-apply status sha256", value: promotion.preStatus.sha256 },
              ...(promotion.postStatus
                ? [
                    {
                      label: "Post-apply status sha256",
                      value: promotion.postStatus.sha256,
                    },
                  ]
                : []),
            ]
          : undefined,
      });
      return response(
        await patchPromotions.rollback({
          promotionId: promotion_id,
          confirmation,
        }),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "patch_promotions",
  {
    title: "List patch promotions",
    description: "List promotion and rollback audit records for this mesh origin.",
    inputSchema: {
      task_id: z.string().uuid().optional(),
      target_repo: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(1_000).default(100),
    },
  },
  async ({ task_id, target_repo, limit }) => {
    try {
      return response(
        await patchPromotions.listPromotions({
          taskId: task_id,
          targetRepo: target_repo,
          limit,
        }),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "worker_register",
  {
    title: "Register worker",
    description:
      'Register a local or preapproved SSH worker. Confirmation must equal "REGISTER WORKER <name>". The returned token is shown once.',
    inputSchema: {
      name: z.string().min(1).max(64),
      kind: z.enum(["local", "ssh"]),
      ssh_alias: z.string().min(1).max(128).optional(),
      control_endpoint: z.string().url().optional(),
      confirmation: z.string().min(1).max(128),
    },
  },
  async ({ name, kind, ssh_alias, control_endpoint, confirmation }) => {
    try {
      const required = workerRegistrationConfirmation(name);
      if (confirmation !== required) {
        throw new Error(`Confirmation must exactly equal "${required}".`);
      }
      await requireHumanApproval({
        title: "Register worker",
        summary: `Register ${kind} worker ${name} so this mesh can dispatch tasks to it.`,
        operation: "worker_register",
        target: kind === "ssh" ? `ssh:${ssh_alias ?? "(missing alias)"}` : "this machine",
        reversible: true,
        reversal: "worker_disable stops dispatch and worker_remove deletes the worker.",
        fields: [
          { label: "Worker name", value: name },
          { label: "Transport", value: kind },
          ...(kind === "ssh"
            ? [{ label: "SSH alias", value: ssh_alias ?? "(missing)" }]
            : []),
          ...(control_endpoint
            ? [{ label: "Control endpoint", value: control_endpoint }]
            : []),
          {
            label: "Effect",
            value:
              "Issues a dispatch token, written once to a private file under the state directory.",
          },
        ],
      });
      const registration = workerRegistry.register({
        name,
        transport:
          kind === "local"
            ? { kind: "local" }
            : { kind: "ssh", alias: ssh_alias ?? "" },
        controlEndpoint: control_endpoint,
        confirmation,
      });
      let worker = registration.worker;
      if (kind === "local") {
        const inventories = await Promise.all(
          PROVIDERS.map(async (provider) => ({
            status: await providerAdmin.providerStatus(provider),
            models: await providerAdmin.listProviderModels(provider).catch(() => []),
          })),
        );
        worker = workerRegistry.heartbeat({
          workerId: registration.worker.id,
          token: registration.token,
          activeTasks: 0,
          capabilities: {
            protocol: WORKER_CAPABILITY_PROTOCOL,
            maxConcurrentTasks: Number(process.env.AGENT_MESH_MAX_CONCURRENT || 3),
            modes: [...TASK_MODES],
            isolation: ["auto", "none", "worktree"],
          },
          providers: inventories.map(({ status, models }) => ({
            provider: status.provider,
            installed: status.installed,
            version: status.version,
            models: models.map((model) => model.id),
          })),
        });
      }
      const tokenDirectory = join(stateDirectory(), "worker-tokens");
      await ensurePrivateDirectory(tokenDirectory);
      const tokenFile = join(tokenDirectory, `${registration.worker.id}.token`);
      await writeFile(tokenFile, `${registration.token}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(tokenFile, 0o600);
      return response({ worker, tokenFile });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "workers_list",
  {
    title: "List workers",
    description: "List local/remote worker health and capabilities without tokens.",
    inputSchema: { include_disabled: z.boolean().default(true) },
  },
  async ({ include_disabled }) => {
    try {
      return response(workerRegistry.list({ includeDisabled: include_disabled }));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "worker_status",
  {
    title: "Inspect worker",
    description: "Return one worker's redacted status and capabilities.",
    inputSchema: { worker_id: z.string().uuid() },
  },
  async ({ worker_id }) => {
    try {
      return response(workerRegistry.status(worker_id));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "worker_probe",
  {
    title: "Probe worker",
    description: "Run a bounded health probe through the configured companion transport.",
    inputSchema: {
      worker_id: z.string().uuid(),
      timeout_ms: z.number().int().min(100).max(30_000).default(10_000),
    },
  },
  async ({ worker_id, timeout_ms }) => {
    try {
      return response(await workerRegistry.probe(worker_id, { timeoutMs: timeout_ms }));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "worker_dispatch",
  {
    title: "Dispatch worker task",
    description:
      "Dispatch a typed task to an online worker. Local workers execute through this router; remote workers fail closed without an installed companion.",
    inputSchema: {
      worker_id: z.string().uuid(),
      provider: z.enum(PROVIDERS),
      prompt: z.string().min(1).max(1_048_576),
      description: z.string().min(1).max(160),
      cwd: z.string().min(1),
      mode: z.enum(TASK_MODES).default("review"),
      model: z.string().max(256).optional(),
      effort: z.string().max(64).optional(),
      mcp_profile: z.enum(MCP_PROFILES).default("none"),
      isolation: z.enum(["auto", "none", "worktree"]).default("auto"),
      timeout_ms: z.number().int().min(1_000).max(7_200_000).default(900_000),
      base_ref: z.string().max(256).optional(),
    },
  },
  async ({
    worker_id,
    provider,
    prompt,
    description,
    cwd,
    mode,
    model,
    effort,
    mcp_profile,
    isolation,
    timeout_ms,
    base_ref,
  }) => {
    try {
      const envelope = createWorkerDispatchEnvelope({
        workerId: worker_id,
        task: {
          taskId: randomUUID(),
          origin,
          provider,
          prompt: effectiveHarnessPrompt(provider, prompt),
          description,
          cwd,
          mode,
          model: model ?? null,
          effort: effort ?? null,
          mcpProfile: mcp_profile,
          isolation,
          timeoutMs: timeout_ms,
          baseRef: base_ref ?? null,
        },
      });
      return response(await workerRegistry.dispatch(worker_id, envelope));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "worker_disable",
  {
    title: "Disable worker",
    description: 'Confirmation must exactly equal "DISABLE WORKER <worker-id>".',
    inputSchema: {
      worker_id: z.string().uuid(),
      confirmation: z.string().min(1).max(128),
    },
  },
  async ({ worker_id, confirmation }) => {
    try {
      const required = workerDisableConfirmation(worker_id);
      if (confirmation !== required) {
        throw new Error(`Confirmation must exactly equal "${required}".`);
      }
      const worker = workerRegistry.status(worker_id);
      await requireHumanApproval({
        title: "Disable worker",
        summary: `Stop dispatching mesh tasks to worker ${worker.name}.`,
        operation: "worker_disable",
        target: workerTransportLabel(worker.transport),
        reversible: false,
        reversal:
          "The mesh exposes no re-enable tool; restoring dispatch means removing and registering the worker again.",
        fields: [
          { label: "Worker", value: `${worker.name} (${worker_id})` },
          { label: "Transport", value: workerTransportLabel(worker.transport) },
          { label: "Status", value: worker.status },
          { label: "Active tasks", value: String(worker.activeTasks) },
          {
            label: "Last heartbeat",
            value: worker.lastHeartbeatAt ?? "never",
          },
          {
            label: "Effect",
            value: "Queued dispatches stop; in-flight tasks are not cancelled.",
          },
        ],
      });
      return response(
        workerRegistry.disable({ workerId: worker_id, confirmation }),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "worker_remove",
  {
    title: "Remove disabled worker",
    description: 'Confirmation must exactly equal "REMOVE WORKER <worker-id>".',
    inputSchema: {
      worker_id: z.string().uuid(),
      confirmation: z.string().min(1).max(128),
    },
  },
  async ({ worker_id, confirmation }) => {
    try {
      const required = workerRemoveConfirmation(worker_id);
      if (confirmation !== required) {
        throw new Error(`Confirmation must exactly equal "${required}".`);
      }
      const worker = workerRegistry.status(worker_id);
      await requireHumanApproval({
        title: "Remove disabled worker",
        summary: `Permanently remove disabled worker ${worker.name} and destroy its dispatch token.`,
        operation: "worker_remove",
        target: workerTransportLabel(worker.transport),
        reversible: false,
        reversal:
          "Removal deletes the worker record and its token file; re-registering issues a different worker identity and token.",
        fields: [
          { label: "Worker", value: `${worker.name} (${worker_id})` },
          { label: "Transport", value: workerTransportLabel(worker.transport) },
          { label: "Status", value: worker.status },
          { label: "Registered at", value: worker.createdAt },
          {
            label: "Effect",
            value:
              "Deletes the registration and the private token file under the state directory.",
          },
        ],
      });
      const removed = workerRegistry.remove({ workerId: worker_id, confirmation });
      await unlink(
        join(stateDirectory(), "worker-tokens", `${worker_id}.token`),
      ).catch(() => undefined);
      return response(removed);
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "dashboard_start",
  {
    title: "Start operator dashboard",
    description:
      "Start the authenticated read-only dashboard on loopback. The bearer token remains in a private token file.",
    inputSchema: {
      host: z.enum(["127.0.0.1", "::1"]).default("127.0.0.1"),
      port: z.number().int().min(0).max(65_535).default(0),
    },
  },
  async ({ host, port }) => {
    try {
      if (dashboard) throw new Error("Dashboard is already running.");
      const taskStates = new Map<string, string>();
      const trafficAgentStates = new Map<string, string>();
      const trafficParticipantStates = new Map<string, string>();
      const peerChannelStates = new Map<string, string>();
      const peerWakeStates = new Map<string, string>();
      const startedDashboard = await startDashboard({
        host,
        port,
        sources: {
          tasks: () => router.registry.search({ origin, limit: 500 }),
          sessions: () => {
            const sessions = new Map<string, Record<string, unknown>>();
            for (const task of router.registry.search({ origin, limit: 500 })) {
              if (!task.sessionId) continue;
              const key = `${task.provider}:${task.sessionId}`;
              const prior = sessions.get(key);
              sessions.set(key, {
                provider: task.provider,
                sessionId: task.sessionId,
                name: task.description,
                status: task.status,
                taskCount: Number(prior?.taskCount ?? 0) + 1,
                createdAt: prior?.createdAt ?? task.createdAt,
                updatedAt: task.updatedAt,
                completedAt: task.completedAt,
              });
            }
            return [...sessions.values()];
          },
          questions: () => [
            ...router.listQuestions({ status: "pending", limit: 500 }),
            ...router.listQuestions({ status: "answered", limit: 500 }),
            ...router.listQuestions({ status: "dismissed", limit: 500 }),
          ],
          usage: () =>
            Promise.all(PROVIDERS.map((provider) => providerAdmin.providerUsage(provider))),
          workers: () => workerRegistry.list(),
          ...(trafficController
            ? { traffic: () => trafficController.dashboardSnapshot() }
            : {}),
          peers: () => peerRegistry.dashboardSnapshot(),
          subscribeProgress(listener) {
            const timer = setInterval(() => {
              const tasks = router.registry.search({ origin, limit: 500 });
              for (const task of tasks) {
                const prior = taskStates.get(task.id);
                if (prior !== task.status) {
                  taskStates.set(task.id, task.status);
                  const event: DashboardProgressEvent = {
                    type: "task_status",
                    taskId: task.id,
                    provider: task.provider,
                    status: task.status,
                    at: task.updatedAt,
                  };
                  listener(event);
                }
              }
              if (trafficController) {
                const traffic = trafficController.dashboardSnapshot();
                for (const agent of traffic.agents) {
                  const id = typeof agent.id === "string" ? agent.id : "";
                  const status =
                    typeof agent.status === "string" ? agent.status : "unknown";
                  if (!id || trafficAgentStates.get(id) === status) continue;
                  trafficAgentStates.set(id, status);
                  listener({
                    type: "traffic_agent_status",
                    trafficAgentId: id,
                    lane: typeof agent.lane === "string" ? agent.lane : undefined,
                    provider:
                      typeof agent.provider === "string"
                        ? agent.provider
                        : undefined,
                    status,
                    at:
                      typeof agent.updatedAt === "string"
                        ? agent.updatedAt
                        : new Date().toISOString(),
                  });
                }
                for (const participant of traffic.participants) {
                  const id =
                    typeof participant.id === "string" ? participant.id : "";
                  const status =
                    typeof participant.status === "string"
                      ? participant.status
                      : "unknown";
                  if (
                    !id ||
                    trafficParticipantStates.get(id) === status
                  ) {
                    continue;
                  }
                  trafficParticipantStates.set(id, status);
                  listener({
                    type: "traffic_participant_status",
                    trafficParticipantId: id,
                    status,
                    at:
                      typeof participant.updatedAt === "string"
                        ? participant.updatedAt
                        : new Date().toISOString(),
                  });
                }
              }
              const peerSnapshot = peerRegistry.dashboardSnapshot();
              const peerChannels = Array.isArray(peerSnapshot.channels)
                ? peerSnapshot.channels
                : [];
              for (const candidate of peerChannels) {
                if (!candidate || typeof candidate !== "object") continue;
                const channel = candidate as Record<string, unknown>;
                const id = typeof channel.id === "string" ? channel.id : "";
                const status =
                  typeof channel.status === "string"
                    ? channel.status
                    : "unknown";
                if (!id || peerChannelStates.get(id) === status) continue;
                peerChannelStates.set(id, status);
                listener({
                  type: "peer_channel_status",
                  peerChannelId: id,
                  status,
                  at:
                    typeof channel.updatedAt === "string"
                      ? channel.updatedAt
                      : new Date().toISOString(),
                });
              }
              const peerWakes = Array.isArray(peerSnapshot.wakes)
                ? peerSnapshot.wakes
                : [];
              for (const candidate of peerWakes) {
                if (!candidate || typeof candidate !== "object") continue;
                const wake = candidate as Record<string, unknown>;
                const id = typeof wake.id === "string" ? wake.id : "";
                const status =
                  typeof wake.state === "string" ? wake.state : "unknown";
                if (!id || peerWakeStates.get(id) === status) continue;
                peerWakeStates.set(id, status);
                listener({
                  type: "peer_wake_status",
                  peerWakeId: id,
                  status,
                  at:
                    typeof wake.updatedAt === "string"
                      ? wake.updatedAt
                      : new Date().toISOString(),
                });
              }
            }, 1_000);
            timer.unref();
            return () => clearInterval(timer);
          },
        },
      });
      try {
        dashboardBootstrapFile = join(stateDirectory(), "dashboard.bootstrap");
        await writeFile(
          dashboardBootstrapFile,
          `${startedDashboard.bootstrapCode}\n`,
          {
            encoding: "utf8",
            mode: 0o600,
          },
        );
        await chmod(dashboardBootstrapFile, 0o600);
        dashboard = startedDashboard;
      } catch (error) {
        await startedDashboard.close().catch(() => undefined);
        dashboardBootstrapFile = undefined;
        throw error;
      }
      return response({
        running: true,
        origin: startedDashboard.origin,
        host: startedDashboard.host,
        port: startedDashboard.port,
        tokenFile: startedDashboard.tokenFile,
        bootstrapUrl: startedDashboard.bootstrapUrl,
        bootstrapFile: dashboardBootstrapFile,
      });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "dashboard_status",
  {
    title: "Inspect operator dashboard",
    description: "Return loopback dashboard state without revealing its token.",
    inputSchema: {},
  },
  async () =>
    response(
      dashboard
        ? {
            running: true,
            origin: dashboard.origin,
            host: dashboard.host,
            port: dashboard.port,
            tokenFile: dashboard.tokenFile,
            bootstrapUrl: dashboard.bootstrapUrl,
            bootstrapFile: dashboardBootstrapFile,
          }
        : { running: false },
    ),
);

server.registerTool(
  "dashboard_stop",
  {
    title: "Stop operator dashboard",
    description: "Stop the local read-only dashboard and remove its token file.",
    inputSchema: {},
  },
  async () => {
    try {
      if (!dashboard) return response({ running: false });
      await dashboard.close();
      dashboard = undefined;
      if (dashboardBootstrapFile) {
        await unlink(dashboardBootstrapFile).catch(() => undefined);
        dashboardBootstrapFile = undefined;
      }
      return response({ running: false });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "task_cleanup",
  {
    title: "Remove an isolated task worktree",
    description:
      "Explicitly remove a terminal task's mesh-owned worktree while preserving its result and patch artifacts.",
    inputSchema: { task_id: z.string().uuid() },
  },
  async ({ task_id }) => {
    try {
      return response(await router.cleanup(task_id));
    } catch (error) {
      return failure(error);
    }
  },
);

let shutdownPromise: Promise<void> | undefined;
const shutdown = () => {
  shutdownPromise ??= (async () => {
    nativeTaskStore.cleanup();
    await dashboard?.close().catch(() => undefined);
    dashboard = undefined;
    if (dashboardBootstrapFile) {
      await unlink(dashboardBootstrapFile).catch(() => undefined);
      dashboardBootstrapFile = undefined;
    }
    await peerWakePump?.stop().catch(() => undefined);
    await trafficController?.close().catch(() => undefined);
    await authBroker.close().catch(() => undefined);
    await patchPromotions.close().catch(() => undefined);
    workerRegistry.close();
    await orchestration.close();
    await router.close();
    instructionProposals.close();
    peerRegistry.close();
    trafficRegistry.close();
    process.exit(0);
  })();
  return shutdownPromise;
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
process.stdin.once("end", () => void shutdown());
process.stdin.once("close", () => void shutdown());
server.server.onclose = () => {
  void shutdown();
};

await server.connect(new StdioServerTransport());
console.error(`[agent-mesh] ready (origin=${origin}, pid=${process.pid})`);
