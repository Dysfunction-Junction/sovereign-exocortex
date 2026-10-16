import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { InitiativeRegistry, type InitiativeRecord } from "./initiatives.js";
import {
  getOrchestrationPreset,
  listOrchestrationPresets,
  ORCHESTRATION_PRESETS,
  type OrchestrationPreset,
  type PresetAgent,
} from "./orchestration-presets.js";
import {
  ORCHESTRATION_POLICY,
  ORCHESTRATION_POLICY_VERSION,
  taskPolicyAddendum,
} from "./orchestration-policy.js";
import { PlanRegistry } from "./plans.js";
import type { AgentMeshRouter, TaskTrafficGate } from "./router.js";
import { canonicalizeAllowedCwd } from "./security.js";
import { SwarmRegistry, type SwarmRecord } from "./swarm.js";
import { MCP_PROFILES } from "./mcp-profiles.js";
import { PROVIDERS } from "./types.js";
import type { Origin, TaskRecord } from "./types.js";
import { registerPlaybookTools } from "./playbook-tools.js";
import type { ProviderAdministration } from "./provider-admin.js";

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

function failure(error: unknown, details: Record<string, unknown> = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const payload = { message, ...details };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}

const presetSchema = z.enum(ORCHESTRATION_PRESETS);
const commonId = z.string().uuid();

export function registerOrchestrationTools(input: {
  server: McpServer;
  router: AgentMeshRouter;
  origin: Origin;
  providerAdmin: ProviderAdministration;
  trafficGate?: TaskTrafficGate;
}) {
  const { server, router, origin, providerAdmin } = input;
  const plans = new PlanRegistry(origin, undefined, router.registry);
  const swarms = new SwarmRegistry(origin, undefined, router.registry);
  const initiatives = new InitiativeRegistry(
    origin,
    undefined,
    router.registry,
    input.trafficGate,
  );
  const playbookControl = registerPlaybookTools({
    server,
    router,
    origin,
    providerAdmin,
    plans,
    swarms,
    initiatives,
  });
  const monitors = new Set<Promise<void>>();
  let closing = false;

  server.registerResource(
    "agent-mesh-orchestration-policy",
    "mesh://policy/orchestration",
    {
      title: "Agent Mesh Orchestration Policy",
      description: "Canonical delegation, model, workspace, review, and telemetry policy.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: ORCHESTRATION_POLICY,
        },
      ],
    }),
  );

  server.registerPrompt(
    "orchestrate_agent_mesh",
    {
      title: "Orchestrate Agent Mesh",
      description: "Load the canonical policy before delegating a multi-agent coding task.",
      argsSchema: {
        objective: z.string().min(1).max(8_000),
        preset: presetSchema.default("productionize"),
      },
    },
    async ({ objective, preset }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `${ORCHESTRATION_POLICY}\n\nPreset: ${preset}\nObjective: ${objective}`,
          },
        },
      ],
    }),
  );

  server.registerTool(
    "orchestration_policy",
    {
      title: "Read orchestration policy",
      description: "Return the canonical policy and version used by every harness.",
      inputSchema: {},
    },
    async () => response({ version: ORCHESTRATION_POLICY_VERSION, policy: ORCHESTRATION_POLICY }),
  );

  server.registerTool(
    "presets_list",
    {
      title: "List orchestration presets",
      description: "List maximum-quality multi-agent delegation presets and wave definitions.",
      inputSchema: {},
    },
    async () => response(listOrchestrationPresets()),
  );

  server.registerTool(
    "preset_get",
    {
      title: "Inspect orchestration preset",
      description: "Return one preset's models, effort, roles, workspace strategy, and waves.",
      inputSchema: { name: presetSchema },
    },
    async ({ name }) => {
      try {
        return response(getOrchestrationPreset(name));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "plan_create",
    {
      title: "Create versioned plan",
      description: "Create a durable draft plan tied to a repository and orchestration preset.",
      inputSchema: {
        title: z.string().min(1).max(200),
        objective: z.string().min(1).max(4_000),
        cwd: z.string().min(1),
        preset: presetSchema.default("max_plan"),
        body: z.string().min(1).max(1_048_576),
        author: z.string().min(1).max(200),
      },
    },
    async (args) => {
      try {
        const cwd = await canonicalizeAllowedCwd(args.cwd);
        return response(plans.create({ ...args, cwd }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "plan_get",
    {
      title: "Read plan",
      description: "Read the current plan revision and its complete review history.",
      inputSchema: { plan_id: commonId },
    },
    async ({ plan_id }) => {
      try {
        return response(plans.get(plan_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "plans_list",
    {
      title: "List plans",
      description: "List durable plans owned by this MCP origin.",
      inputSchema: { limit: z.number().int().min(1).max(1_000).default(100) },
    },
    async ({ limit }) => response(plans.list(limit)),
  );

  server.registerTool(
    "plan_revise",
    {
      title: "Revise plan",
      description: "Create a new immutable plan revision and invalidate prior approval.",
      inputSchema: {
        plan_id: commonId,
        body: z.string().min(1).max(1_048_576),
        summary: z.string().min(1).max(4_000),
        author: z.string().min(1).max(200),
      },
    },
    async ({ plan_id, ...args }) => {
      try {
        return response(plans.revise(plan_id, args));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "plan_submit_review",
    {
      title: "Submit plan for review",
      description: "Move the current draft revision into under-review state.",
      inputSchema: { plan_id: commonId },
    },
    async ({ plan_id }) => {
      try {
        return response(plans.submitForReview(plan_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "plan_record_review",
    {
      title: "Record plan review",
      description: "Attach an approving or changes-requested review to the current revision.",
      inputSchema: {
        plan_id: commonId,
        reviewer: z.string().min(1).max(200),
        provider: z.enum(PROVIDERS).optional(),
        session_id: z.string().min(1).max(500).optional(),
        verdict: z.enum(["approve", "changes_requested"]),
        feedback: z.string().max(32_000).default(""),
      },
    },
    async ({ plan_id, session_id, ...args }) => {
      try {
        return response(
          plans.review(plan_id, { ...args, sessionId: session_id }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "plan_approve",
    {
      title: "Approve plan",
      description:
        "Approve the current revision only when it has an approving review and no requested changes.",
      inputSchema: { plan_id: commonId },
    },
    async ({ plan_id }) => {
      try {
        return response(plans.approve(plan_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "plan_attach_execution",
    {
      title: "Attach plan execution",
      description: "Link an approved plan to its execution task or initiative.",
      inputSchema: {
        plan_id: commonId,
        task_id: commonId.optional(),
        initiative_id: commonId.optional(),
      },
    },
    async ({ plan_id, task_id, initiative_id }) => {
      try {
        return response(
          plans.attachExecution(plan_id, { taskId: task_id, initiativeId: initiative_id }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "plan_complete",
    {
      title: "Complete plan execution",
      description: "Mark an executing plan complete after final review and tests.",
      inputSchema: { plan_id: commonId },
    },
    async ({ plan_id }) => {
      try {
        return response(plans.complete(plan_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "initiative_create",
    {
      title: "Create initiative workspace",
      description:
        "Create a long-lived mesh-owned worktree with a single-writer lease for a multi-wave effort.",
      inputSchema: {
        name: z.string().min(1).max(160),
        objective: z.string().min(1).max(8_000),
        cwd: z.string().min(1),
        preset: presetSchema.default("productionize"),
        strategy: z
          .enum(["shared_readonly", "single_writer_initiative", "competing_worktrees"])
          .default("single_writer_initiative"),
        base_ref: z.string().min(1).max(500).optional(),
      },
    },
    async ({ base_ref, ...args }) => {
      try {
        const cwd = await canonicalizeAllowedCwd(args.cwd);
        return response(
          await initiatives.create({ ...args, cwd, baseRef: base_ref }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "initiative_get",
    {
      title: "Inspect initiative",
      description: "Read initiative workspace and writer-lease state.",
      inputSchema: { initiative_id: commonId },
    },
    async ({ initiative_id }) => {
      try {
        return response(initiatives.get(initiative_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "initiatives_list",
    {
      title: "List initiatives",
      description: "List long-lived initiative workspaces owned by this origin.",
      inputSchema: { limit: z.number().int().min(1).max(1_000).default(100) },
    },
    async ({ limit }) => response(initiatives.list(limit)),
  );

  server.registerTool(
    "initiative_close",
    {
      title: "Close initiative",
      description:
        "Close an initiative after promotion. Its worktree is retained to avoid destructive cleanup.",
      inputSchema: { initiative_id: commonId },
    },
    async ({ initiative_id }) => {
      try {
        return response(await initiatives.closeInitiative(initiative_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "swarm_create",
    {
      title: "Create swarm",
      description: "Create a durable swarm coordination record.",
      inputSchema: {
        name: z.string().min(1).max(120),
        objective: z.string().min(1).max(8_000),
        cwd: z.string().min(1),
        preset: presetSchema,
        plan_id: commonId.optional(),
        initiative_id: commonId.optional(),
      },
    },
    async ({ plan_id, initiative_id, ...args }) => {
      try {
        const cwd = await canonicalizeAllowedCwd(args.cwd);
        return response(
          swarms.create({ ...args, cwd, planId: plan_id, initiativeId: initiative_id }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "swarm_get",
    {
      title: "Inspect swarm",
      description: "Read swarm members, status, and orchestration links.",
      inputSchema: { swarm_id: commonId },
    },
    async ({ swarm_id }) => {
      try {
        return response(swarms.get(swarm_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "swarms_list",
    {
      title: "List swarms",
      description: "List durable swarms owned by this origin.",
      inputSchema: { limit: z.number().int().min(1).max(1_000).default(100) },
    },
    async ({ limit }) => response(swarms.list(limit)),
  );

  server.registerTool(
    "swarm_link_plan",
    {
      title: "Link approved plan to swarm",
      description:
        "Link a versioned plan before dispatching any implementation wave.",
      inputSchema: { swarm_id: commonId, plan_id: commonId },
    },
    async ({ swarm_id, plan_id }) => {
      try {
        const swarm = swarms.get(swarm_id);
        const plan = plans.get(plan_id);
        if (plan.cwd !== swarm.cwd) throw new Error("Plan and swarm cwd do not match.");
        if (plan.status !== "approved" && plan.status !== "executing") {
          throw new Error("Only an approved or already-executing plan may be linked.");
        }
        return response(swarms.linkPlan(swarm_id, plan_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "swarm_member_add",
    {
      title: "Add swarm member",
      description: "Register a provider role in a swarm.",
      inputSchema: {
        swarm_id: commonId,
        name: z.string().min(1).max(120),
        provider: z.enum(PROVIDERS),
        role: z.string().min(1).max(120),
        task_id: commonId.optional(),
        session_id: z.string().max(500).optional(),
      },
    },
    async ({ swarm_id, task_id, session_id, ...args }) => {
      try {
        return response(
          swarms.addMember(swarm_id, {
            ...args,
            taskId: task_id,
            sessionId: session_id,
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "swarm_member_update",
    {
      title: "Update swarm member",
      description: "Attach task/session IDs or update member completion state.",
      inputSchema: {
        swarm_id: commonId,
        member_id: commonId,
        task_id: commonId.optional(),
        session_id: z.string().max(500).optional(),
        status: z.enum(["active", "waiting", "completed", "failed"]).optional(),
      },
    },
    async ({ swarm_id, member_id, task_id, session_id, status }) => {
      try {
        return response(
          swarms.updateMember(swarm_id, member_id, {
            taskId: task_id,
            sessionId: session_id,
            status,
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "swarm_message_send",
    {
      title: "Send swarm message",
      description: "Send a directed or broadcast durable message between swarm members.",
      inputSchema: {
        swarm_id: commonId,
        from_member_id: commonId,
        to_member_id: commonId.optional(),
        kind: z.enum(["message", "feedback", "decision", "question"]).default("message"),
        body: z.string().min(1).max(64_000),
      },
    },
    async ({ swarm_id, from_member_id, to_member_id, ...args }) => {
      try {
        return response(
          swarms.send(swarm_id, {
            ...args,
            fromMemberId: from_member_id,
            toMemberId: to_member_id,
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "swarm_inbox",
    {
      title: "Read swarm inbox",
      description: "Read directed and broadcast messages after a sequence cursor.",
      inputSchema: {
        swarm_id: commonId,
        member_id: commonId,
        after_sequence: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(1_000).default(100),
      },
    },
    async ({ swarm_id, member_id, after_sequence, limit }) => {
      try {
        return response(swarms.inbox(swarm_id, member_id, after_sequence, limit));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "swarm_wait",
    {
      title: "Wait for swarm message",
      description: "Long-poll a member inbox with a bounded deadline.",
      inputSchema: {
        swarm_id: commonId,
        member_id: commonId,
        after_sequence: z.number().int().min(0).default(0),
        timeout_ms: z.number().int().min(0).max(600_000).default(30_000),
      },
    },
    async ({ swarm_id, member_id, after_sequence, timeout_ms }) => {
      try {
        return response(
          await swarms.waitForInbox(swarm_id, member_id, after_sequence, timeout_ms),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "swarm_blackboard_set",
    {
      title: "Write swarm blackboard",
      description: "Persist a versioned shared fact or decision with optimistic concurrency.",
      inputSchema: {
        swarm_id: commonId,
        key: z.string().min(1).max(200),
        value: z.string().max(128_000),
        author_member_id: commonId,
        expected_version: z.number().int().min(0).optional(),
      },
    },
    async ({ swarm_id, author_member_id, expected_version, ...args }) => {
      try {
        return response(
          swarms.blackboardSet(swarm_id, {
            ...args,
            authorMemberId: author_member_id,
            expectedVersion: expected_version,
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "swarm_blackboard",
    {
      title: "Read swarm blackboard",
      description: "Read durable shared facts and decisions.",
      inputSchema: { swarm_id: commonId },
    },
    async ({ swarm_id }) => {
      try {
        return response(swarms.blackboard(swarm_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "swarm_barrier_create",
    {
      title: "Create swarm barrier",
      description: "Create a durable wave-completion barrier.",
      inputSchema: {
        swarm_id: commonId,
        name: z.string().min(1).max(120),
        required_count: z.number().int().min(1).max(100),
      },
    },
    async ({ swarm_id, name, required_count }) => {
      try {
        return response(swarms.createBarrier(swarm_id, name, required_count));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "swarm_barrier_arrive",
    {
      title: "Arrive at swarm barrier",
      description: "Record a member's idempotent arrival at a barrier.",
      inputSchema: { barrier_id: commonId, member_id: commonId },
    },
    async ({ barrier_id, member_id }) => {
      try {
        return response(swarms.arrive(barrier_id, member_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "swarm_barrier_status",
    {
      title: "Inspect swarm barrier",
      description: "Read barrier arrivals and completion state.",
      inputSchema: { barrier_id: commonId },
    },
    async ({ barrier_id }) => {
      try {
        return response(swarms.barrier(barrier_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "swarm_review_submit",
    {
      title: "Submit sealed swarm review",
      description: "Submit an independent review hidden until the parent reveals the wave.",
      inputSchema: {
        swarm_id: commonId,
        member_id: commonId,
        verdict: z.string().min(1).max(120),
        body: z.string().min(1).max(128_000),
      },
    },
    async ({ swarm_id, member_id, ...args }) => {
      try {
        return response(
          swarms.submitReview(swarm_id, { ...args, memberId: member_id }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "swarm_reviews_reveal",
    {
      title: "Reveal swarm reviews",
      description: "Reveal all sealed independent reviews after the review wave completes.",
      inputSchema: { swarm_id: commonId },
    },
    async ({ swarm_id }) => {
      try {
        return response(swarms.revealReviews(swarm_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "swarm_reviews",
    {
      title: "Read revealed swarm reviews",
      description:
        "Read reviews only after the sealed review gate has been successfully revealed.",
      inputSchema: { swarm_id: commonId },
    },
    async ({ swarm_id }) => {
      try {
        return response(swarms.reviews(swarm_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "swarm_close",
    {
      title: "Close swarm",
      description: "Close a completed swarm coordination record.",
      inputSchema: { swarm_id: commonId },
    },
    async ({ swarm_id }) => {
      try {
        return response(swarms.closeSwarm(swarm_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "swarm_reopen",
    {
      title: "Reopen abandoned swarm",
      description:
        "Reopen a closed swarm whose sealed reviews were never revealed, for task/session recovery.",
      inputSchema: { swarm_id: commonId },
    },
    async ({ swarm_id }) => {
      try {
        return response(swarms.reopenSwarm(swarm_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  async function priorWaveContext(
    preset: OrchestrationPreset,
    swarm: SwarmRecord,
    waveId: string,
  ): Promise<string> {
    const wave = preset.waves.find((candidate) => candidate.id === waveId);
    if (!wave?.revealPriorOutputs || wave.waitsFor.length === 0) return "";
    const priorIds = new Set(
      preset.waves
        .filter((candidate) => wave.waitsFor.includes(candidate.id))
        .flatMap((candidate) => candidate.agents),
    );
    const chunks: string[] = [];
    for (const member of swarm.members.filter((candidate) => priorIds.has(candidate.name))) {
      if (!member.taskId) continue;
      try {
        const envelope = await router.getResult(member.taskId, false, 0);
        chunks.push(
          JSON.stringify({
            member: member.name,
            taskId: envelope.task.id,
            status: envelope.task.status,
            sessionId: envelope.task.sessionId,
            artifactStatus: envelope.task.artifactStatus,
            changedFiles: envelope.artifacts?.changedFiles ?? [],
            patchPath: envelope.artifacts?.patchPath ?? null,
          }),
        );
      } catch {
        // A failed prior task is represented in member state and should not fabricate context.
      }
    }
    return chunks.length
      ? `\n\n## Server-generated prior-wave metadata\n${chunks.join("\n")}`
      : "";
  }

  function executionPlanFor(swarm: SwarmRecord) {
    if (!swarm.planId) {
      throw new Error("Implementation waves require a linked approved plan.");
    }
    const plan = plans.get(swarm.planId);
    if (plan.cwd !== swarm.cwd) throw new Error("Plan and swarm cwd do not match.");
    if (plan.status === "approved") return plan;
    throw new Error("Implementation waves require the current approved plan revision.");
  }

  async function monitorMemberTask(input: {
    swarmId: string;
    memberId: string;
    initialTask: TaskRecord;
    initiativeId?: string;
    writerTaskId?: string;
    planId?: string;
  }): Promise<void> {
    let currentTask = input.initialTask;
    let writerTaskId = input.writerTaskId;
    let planTaskId = input.planId ? input.initialTask.id : undefined;
    let publishedStatus: "active" | "waiting" = "active";
    for (;;) {
      if (closing) return;
      try {
        const child = router.registry.latestChildTask(origin, currentTask.id);
        if (child && child.id !== currentTask.id) {
          if (input.planId && planTaskId) {
            plans.transferExecutionReservation(input.planId, planTaskId, child.id);
            planTaskId = child.id;
          }
          if (input.initiativeId && writerTaskId) {
            initiatives.transferWriter(input.initiativeId, writerTaskId, child.id);
            writerTaskId = child.id;
          }
          currentTask = child;
          swarms.updateMember(input.swarmId, input.memberId, {
            taskId: child.id,
            sessionId: child.sessionId ?? undefined,
            status: "active",
          });
          publishedStatus = "active";
          continue;
        }
        const status = router.getStatus(currentTask.id);
        if (status.status === "waiting_for_input" && publishedStatus !== "waiting") {
          swarms.updateMember(input.swarmId, input.memberId, {
            sessionId: status.sessionId ?? undefined,
            status: "waiting",
          });
          publishedStatus = "waiting";
        } else if (
          ["completed", "failed", "cancelled", "interrupted"].includes(status.status)
        ) {
          const failedBeforeLaunch =
            status.status !== "completed" &&
            input.planId &&
            !router.registry
              .transitions(currentTask.id)
              .some((transition) => transition.toStatus === "running");
          if (failedBeforeLaunch) {
            if (input.initiativeId && writerTaskId) {
              initiatives.releaseWriter(input.initiativeId, writerTaskId);
            }
            plans.rollbackExecutionReservation(input.planId!, planTaskId!);
            swarms.resetMemberAfterPrelaunchFailure(
              input.swarmId,
              input.memberId,
              currentTask.id,
            );
            return;
          }
          swarms.updateMember(input.swarmId, input.memberId, {
            sessionId: status.sessionId ?? undefined,
            status: status.status === "completed" ? "completed" : "failed",
          });
          if (input.initiativeId && writerTaskId) {
            initiatives.releaseWriter(input.initiativeId, writerTaskId);
          }
          return;
        } else if (
          status.status !== "waiting_for_input" &&
          publishedStatus !== "active"
        ) {
          swarms.updateMember(input.swarmId, input.memberId, {
            sessionId: status.sessionId ?? undefined,
            status: "active",
          });
          publishedStatus = "active";
        }
      } catch {
        if (closing) return;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async function dispatchAgent(
    swarm: SwarmRecord,
    preset: OrchestrationPreset,
    agent: PresetAgent,
    mcpProfile: (typeof MCP_PROFILES)[number],
    timeoutMs: number,
    waveId: string,
  ): Promise<TaskRecord> {
    const member = swarm.members.find((candidate) => candidate.name === agent.id);
    if (!member) throw new Error(`Preset member is missing: ${agent.id}`);
    if (member.taskId) throw new Error(`Preset member already dispatched: ${agent.id}`);
    const initiative = swarm.initiativeId
      ? initiatives.get(swarm.initiativeId)
      : undefined;
    const prior = await priorWaveContext(preset, swarm, waveId);
    const prompt = `${taskPolicyAddendum({
      role: agent.role,
      swarmId: swarm.id,
      memberId: member.id,
      revealPriorOutputs: Boolean(prior),
    })}

## Objective

${swarm.objective}

Return a concise structured result for the parent orchestrator. If you need parent input, use the mesh blocking-question envelope.${prior}`;
    const implementation = agent.mode === "implement";
    const executionPlan = implementation ? executionPlanFor(swarm) : undefined;
    if (!swarms.claimMemberDispatch(swarm.id, member.id)) {
      throw new Error(`Preset member already dispatched or claimed: ${agent.id}`);
    }
    let task: TaskRecord | undefined;
    let writerAcquired = false;
    let planReserved = false;
    try {
      task = (
        await router.start(
          {
            provider: agent.provider,
            prompt,
            description: `${preset.name}/${waveId}/${agent.id}`,
            cwd: initiative ? initiative.effectiveCwd : swarm.cwd,
            mode: agent.mode,
            model: agent.model,
            effort: agent.effort,
            // Implement waves keep the requested profile (usually "research") so
            // builders can use Context7/Perplexity while coding and testing.
            mcpProfile,
            isolation: "none",
            timeoutMs,
            coordination: {
              origin,
              swarmId: swarm.id,
              memberId: member.id,
            },
          },
          {
            background: true,
            initiativeId: initiative?.id,
            existingWorktree:
              implementation && initiative
                ? {
                    repoRoot: initiative.repoRoot,
                    worktreePath: initiative.worktreePath,
                    baseCommit: initiative.baseCommit,
                  }
                : undefined,
            onReserved: async (reservedTask) => {
              task = reservedTask;
              if (executionPlan) {
                plans.attachExecution(executionPlan.id, {
                  taskId: reservedTask.id,
                  initiativeId: initiative?.id,
                });
                planReserved = true;
              }
              if (implementation && initiative) {
                initiatives.acquireWriter(
                  initiative.id,
                  reservedTask.id,
                  agent.provider,
                );
                writerAcquired = true;
              }
              swarms.updateMember(swarm.id, member.id, {
                taskId: reservedTask.id,
                status: "active",
              });
            },
          },
        )
      ).task;
    } catch (error) {
      if (task && writerAcquired && initiative) {
        try {
          initiatives.releaseWriter(initiative.id, task.id);
        } catch {
          // A concurrent recovery may already have released the lease.
        }
      }
      if (task && planReserved && executionPlan) {
        try {
          plans.rollbackExecutionReservation(executionPlan.id, task.id);
        } catch {
          // Startup recovery will reconcile a pre-launch reservation.
        }
      }
      swarms.releaseMemberDispatch(swarm.id, member.id);
      throw error;
    }
    if (!task) throw new Error("Provider task did not start.");
    const monitoring = monitorMemberTask({
        swarmId: swarm.id,
        memberId: member.id,
        initialTask: task,
        initiativeId: implementation ? initiative?.id : undefined,
        writerTaskId: implementation ? task.id : undefined,
      planId: executionPlan?.id,
      })
      .catch(() => undefined)
      .finally(() => monitors.delete(monitoring));
    monitors.add(monitoring);
    return task;
  }

  async function dispatchWave(input: {
    swarmId: string;
    waveId: string;
    mcpProfile: (typeof MCP_PROFILES)[number];
    timeoutMs: number;
  }) {
    const swarm = swarms.get(input.swarmId);
    const preset = getOrchestrationPreset(swarm.preset);
    const wave = preset.waves.find((candidate) => candidate.id === input.waveId);
    if (!wave) throw new Error(`Unknown preset wave: ${input.waveId}`);
    for (const dependency of wave.waitsFor) {
      const dependencyWave = preset.waves.find((candidate) => candidate.id === dependency)!;
      const dependencyMembers = swarm.members.filter((member) =>
        dependencyWave.agents.includes(member.name),
      );
      const dependencyComplete =
        dependencyMembers.length === dependencyWave.agents.length &&
        (dependencyWave.completion === "all"
          ? dependencyMembers.every((member) => member.status === "completed")
          : dependencyMembers.some((member) => member.status === "completed"));
      if (!dependencyComplete) {
        throw new Error(`Wave dependency is incomplete: ${dependency}`);
      }
    }
    const tasks: TaskRecord[] = [];
    const dispatchErrors: Array<{ agentId: string; message: string }> = [];
    for (const agentId of wave.agents) {
      const agent = preset.agents.find((candidate) => candidate.id === agentId)!;
      try {
        tasks.push(
          await dispatchAgent(
            swarm,
            preset,
            agent,
            input.mcpProfile,
            input.timeoutMs,
            wave.id,
          ),
        );
      } catch (error) {
        dispatchErrors.push({
          agentId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      started: dispatchErrors.length === 0,
      swarm: swarms.get(swarm.id),
      wave,
      tasks,
      dispatchErrors,
    };
  }

  server.registerTool(
    "preset_start",
    {
      title: "Start orchestration preset",
      description:
        "Create a swarm, optional initiative workspace, preset members, and dispatch the first wave.",
      inputSchema: {
        name: z.string().min(1).max(120),
        objective: z.string().min(1).max(8_000),
        cwd: z.string().min(1),
        preset: presetSchema.default("productionize"),
        plan_id: commonId.optional(),
        mcp_profile: z.enum(MCP_PROFILES).default("research"),
        timeout_ms: z.number().int().min(1_000).max(86_400_000).default(7_200_000),
        base_ref: z.string().min(1).max(500).optional(),
      },
    },
    async ({ plan_id, mcp_profile, timeout_ms, base_ref, ...args }) => {
      let initiative: InitiativeRecord | undefined;
      let swarm: SwarmRecord | undefined;
      try {
        if (process.env.AGENT_MESH_ALLOW_LEGACY_PRESET_EXECUTION !== "1") {
          throw new Error(
            "Direct preset execution is disabled; create a goal and start a version-pinned playbook run.",
          );
        }
        const cwd = await canonicalizeAllowedCwd(args.cwd);
        const preset = getOrchestrationPreset(args.preset);
        const firstWave = preset.waves[0]!;
        const firstWaveImplements = firstWave.agents.some(
          (agentId) =>
            preset.agents.find((candidate) => candidate.id === agentId)?.mode ===
            "implement",
        );
        if (plan_id) {
          const plan = plans.get(plan_id);
          if (plan.cwd !== cwd) throw new Error("Plan and preset cwd do not match.");
          if (firstWaveImplements && plan.status !== "approved") {
            throw new Error("An implementation-first preset requires an approved plan.");
          }
        } else if (firstWaveImplements) {
          throw new Error("An implementation-first preset requires plan_id.");
        }
        initiative =
          preset.workspaceStrategy === "single_writer_initiative"
            ? await initiatives.create({
                name: args.name,
                objective: args.objective,
                cwd,
                preset: args.preset,
                strategy: preset.workspaceStrategy,
                baseRef: base_ref,
              })
            : undefined;
        swarm = swarms.create({
          name: args.name,
          objective: args.objective,
          cwd,
          preset: args.preset,
          planId: plan_id,
          initiativeId: initiative?.id,
        });
        for (const agent of preset.agents) {
          swarms.addMember(swarm.id, {
            name: agent.id,
            provider: agent.provider,
            role: agent.role,
          });
        }
        const dispatched = await dispatchWave({
          swarmId: swarm.id,
          waveId: firstWave.id,
          mcpProfile: mcp_profile,
          timeoutMs: timeout_ms,
        });
        return response({ preset, initiative, ...dispatched });
      } catch (error) {
        const recovery: Record<string, unknown> = {};
        if (swarm) {
          const current = swarms.get(swarm.id);
          const hasDispatchedTask = current.members.some((member) => member.taskId);
          if (hasDispatchedTask) {
            recovery.swarm = current;
            recovery.initiative = initiative;
            recovery.action = "Inspect retained tasks and resume or close explicitly.";
          } else {
            try {
              recovery.swarm = swarms.closeSwarm(swarm.id);
              if (initiative) {
                recovery.initiative = await initiatives.discardCleanInitiative(
                  initiative.id,
                );
              }
              recovery.action = "Staged resources were closed and the clean worktree removed.";
            } catch (cleanupError) {
              recovery.swarm = swarms.get(swarm.id);
              recovery.initiative = initiative
                ? initiatives.get(initiative.id)
                : undefined;
              recovery.cleanupError =
                cleanupError instanceof Error
                  ? cleanupError.message
                  : String(cleanupError);
              recovery.action = "Retained resources require explicit operator recovery.";
            }
          }
        } else if (initiative) {
          try {
            recovery.initiative = await initiatives.discardCleanInitiative(
              initiative.id,
            );
            recovery.action = "The clean staged worktree was removed.";
          } catch (cleanupError) {
            recovery.initiative = initiatives.get(initiative.id);
            recovery.cleanupError =
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
            recovery.action = "Retained initiative requires explicit operator recovery.";
          }
        }
        return failure(error, Object.keys(recovery).length ? { recovery } : {});
      }
    },
  );

  server.registerTool(
    "swarm_dispatch_wave",
    {
      title: "Dispatch preset wave",
      description:
        "Dispatch a later preset wave after all declared dependency members settle.",
      inputSchema: {
        swarm_id: commonId,
        wave_id: z.string().min(1).max(120),
        mcp_profile: z.enum(MCP_PROFILES).default("research"),
        timeout_ms: z.number().int().min(1_000).max(86_400_000).default(7_200_000),
      },
    },
    async ({ swarm_id, wave_id, mcp_profile, timeout_ms }) => {
      try {
        if (process.env.AGENT_MESH_ALLOW_LEGACY_PRESET_EXECUTION !== "1") {
          throw new Error(
            "Direct preset wave dispatch is disabled; advance the owning playbook run.",
          );
        }
        return response(
          await dispatchWave({
            swarmId: swarm_id,
            waveId: wave_id,
            mcpProfile: mcp_profile,
            timeoutMs: timeout_ms,
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "agent_metrics",
    {
      title: "Read task timing metrics",
      description:
        "Return atomic status transitions and derived queue, active, wait, first-output, and wall time.",
      inputSchema: { task_id: commonId },
    },
    async ({ task_id }) => {
      try {
        return response(await router.getTaskMetrics(task_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "initiative_metrics",
    {
      title: "Read initiative timing metrics",
      description: "Aggregate timing metrics across all tasks linked to an initiative.",
      inputSchema: { initiative_id: commonId },
    },
    async ({ initiative_id }) => {
      try {
        initiatives.get(initiative_id);
        return response(await router.getInitiativeMetrics(initiative_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  return {
    plans,
    swarms,
    initiatives,
    async close() {
      closing = true;
      await Promise.allSettled([...monitors]);
      plans.close();
      swarms.close();
      initiatives.close();
      playbookControl.close();
    },
  };
}
