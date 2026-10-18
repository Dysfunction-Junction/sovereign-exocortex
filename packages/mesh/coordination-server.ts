#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { parseOrigin } from "./security.js";
import { SwarmRegistry } from "./swarm.js";
import {
  verifyCoordinationCapability,
  verifyManagedPeerCapability,
} from "./coordination-auth.js";
import { PlaybookRegistry, parseStepReport } from "./playbooks.js";
import {
  PeerChannelRegistry,
  registerBoundPeerTools,
  type ManagedPeerBinding,
} from "./peer-channels.js";
import { TrafficControlRegistry } from "./traffic-control.js";

function optionalArgument(name: string): string | undefined {
  const args = process.argv.slice(2);
  const inline = args.find((value) => value.startsWith(`${name}=`));
  if (inline) {
    const val = inline.slice(name.length + 1);
    return val.length > 0 ? val : undefined;
  }
  const index = args.indexOf(name);
  if (index >= 0) {
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      return next.length > 0 ? next : undefined;
    }
  }
  return undefined;
}

function argument(name: string): string {
  const val = optionalArgument(name);
  if (!val) throw new Error(`Missing required argument: ${name}`);
  return val;
}

function response(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent:
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : { value: data },
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ message }, null, 2) }],
    structuredContent: { message },
    isError: true,
  };
}

const origin = parseOrigin(argument("--origin"));
const swarmIdArgument = optionalArgument("--swarm-id");
const memberIdArgument = optionalArgument("--member-id");
const coordinationCapabilityArgument = optionalArgument("--capability");
const hasCoordination = Boolean(
  swarmIdArgument || memberIdArgument || coordinationCapabilityArgument,
);
let coordinationSwarms: SwarmRegistry | undefined;
let coordinationPlaybooks: PlaybookRegistry | undefined;
let coordinationSwarmId: string | undefined;
let coordinationMemberId: string | undefined;
if (hasCoordination) {
  coordinationSwarmId = z.string().uuid().parse(swarmIdArgument);
  coordinationMemberId = z.string().uuid().parse(memberIdArgument);
  if (
    !coordinationCapabilityArgument ||
    !verifyCoordinationCapability(
      {
        origin,
        swarmId: coordinationSwarmId,
        memberId: coordinationMemberId,
      },
      coordinationCapabilityArgument,
    )
  ) {
    throw new Error("Invalid coordination capability.");
  }
  coordinationSwarms = new SwarmRegistry(origin);
  coordinationPlaybooks = new PlaybookRegistry(origin);
  const swarm = coordinationSwarms.get(coordinationSwarmId);
  const member = swarm.members.find(
    (candidate) => candidate.id === coordinationMemberId,
  );
  if (!member) throw new Error("Coordination member does not belong to this swarm.");
  if (swarm.status !== "active") throw new Error("Coordination swarm is closed.");
}

const peerAgentIdArgument = optionalArgument("--peer-agent-id");
const peerMemberIdArgument = optionalArgument("--peer-member-id");
const peerGenerationArgument = optionalArgument("--peer-generation");
const peerCapabilityArgument = optionalArgument("--peer-capability");
const peerTaskIdArgument = optionalArgument("--peer-task-id");
const peerRunIdArgument = optionalArgument("--peer-run-id");
const peerCausalRootArgument = optionalArgument("--peer-causal-root");
const peerCausalPathArgument = optionalArgument("--peer-causal-path");
const hasPeer = Boolean(
  peerAgentIdArgument ||
    peerMemberIdArgument ||
    peerGenerationArgument ||
    peerCapabilityArgument ||
    peerTaskIdArgument ||
    peerRunIdArgument ||
    peerCausalRootArgument ||
    peerCausalPathArgument,
);
let peerTraffic: TrafficControlRegistry | undefined;
let peers: PeerChannelRegistry | undefined;
let peerBinding: ManagedPeerBinding | undefined;
if (hasPeer) {
  const context = {
    origin,
    agentId: z.string().uuid().parse(peerAgentIdArgument),
    memberId: z.string().uuid().parse(peerMemberIdArgument),
    membershipGeneration: z.coerce
      .number()
      .int()
      .min(1)
      .parse(peerGenerationArgument),
    ...(peerTaskIdArgument
      ? { taskId: z.string().uuid().parse(peerTaskIdArgument) }
      : {}),
    ...(peerRunIdArgument
      ? { runId: z.string().uuid().parse(peerRunIdArgument) }
      : {}),
    ...(peerCausalRootArgument
      ? { causalRoot: z.string().min(1).max(512).parse(peerCausalRootArgument) }
      : {}),
    ...(peerCausalPathArgument
      ? {
          causalPath: peerCausalPathArgument
            .split(",")
            .filter(Boolean)
            .map((value) => z.string().uuid().parse(value)),
        }
      : {}),
  };
  if (
    !peerCapabilityArgument ||
    !verifyManagedPeerCapability(context, peerCapabilityArgument)
  ) {
    throw new Error("Invalid managed-peer capability.");
  }
  peerTraffic = new TrafficControlRegistry({ origin });
  peers = new PeerChannelRegistry({
    origin,
    agentResolver: (agentId) => peerTraffic!.getAgent(agentId),
    trafficPath: peerTraffic.path,
    bindingValidator: (member) => {
      const agent = peerTraffic!.getAgent(member.agentId);
      if (!agent) return false;
      if (member.runId) {
        return peerTraffic!.activeRun(agent.id)?.id === member.runId;
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
  peerBinding = context;
  peers.assertBinding(peerBinding);
}
if (!hasCoordination && !hasPeer) {
  throw new Error("Scoped MCP requires coordination or managed-peer context.");
}

const server = new McpServer(
  { name: "agent-mesh-coordination", version: "0.2.0" },
  { capabilities: {} },
);

if (
  coordinationSwarms &&
  coordinationPlaybooks &&
  coordinationSwarmId &&
  coordinationMemberId
) {
const swarms = coordinationSwarms;
const playbooks = coordinationPlaybooks;
const swarmId = coordinationSwarmId;
const memberId = coordinationMemberId;
function ownBarrier(barrierId: string) {
  const barrier = swarms.barrier(barrierId);
  if (barrier.swarmId !== swarmId) {
    throw new Error("Barrier belongs to another swarm.");
  }
  return barrier;
}

server.registerTool(
  "coordination_status",
  {
    title: "Read coordination status",
    description: "Read this delegated member's identity and current swarm state.",
    inputSchema: {},
  },
  async () => response({ swarm: swarms.get(swarmId), memberId }),
);

server.registerTool(
  "coordination_inbox",
  {
    title: "Read coordination inbox",
    description: "Read directed and broadcast messages after a sequence cursor.",
    inputSchema: {
      after_sequence: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1_000).default(100),
    },
  },
  async ({ after_sequence, limit }) => {
    try {
      return response(swarms.inbox(swarmId, memberId, after_sequence, limit));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "coordination_wait",
  {
    title: "Wait for coordination message",
    description: "Long-poll this member's inbox with a bounded deadline.",
    inputSchema: {
      after_sequence: z.number().int().min(0).default(0),
      timeout_ms: z.number().int().min(0).max(600_000).default(30_000),
    },
  },
  async ({ after_sequence, timeout_ms }) => {
    try {
      return response(
        await swarms.waitForInbox(swarmId, memberId, after_sequence, timeout_ms),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "coordination_send",
  {
    title: "Send coordination message",
    description: "Send a directed or broadcast message as this member.",
    inputSchema: {
      to_member_id: z.string().uuid().optional(),
      kind: z.enum(["message", "feedback", "decision", "question"]).default("message"),
      body: z.string().min(1).max(64_000),
    },
  },
  async ({ to_member_id, ...args }) => {
    try {
      return response(
        swarms.send(swarmId, {
          ...args,
          fromMemberId: memberId,
          toMemberId: to_member_id,
        }),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "coordination_blackboard",
  {
    title: "Read coordination blackboard",
    description: "Read durable shared swarm facts and decisions.",
    inputSchema: {},
  },
  async () => {
    try {
      return response(swarms.blackboard(swarmId));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "coordination_blackboard_set",
  {
    title: "Write coordination blackboard",
    description: "Write a versioned shared fact as this member.",
    inputSchema: {
      key: z.string().min(1).max(200),
      value: z.string().max(128_000),
      expected_version: z.number().int().min(0).optional(),
    },
  },
  async ({ expected_version, ...args }) => {
    try {
      return response(
        swarms.blackboardSet(swarmId, {
          ...args,
          authorMemberId: memberId,
          expectedVersion: expected_version,
        }),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "coordination_barrier_status",
  {
    title: "Read coordination barrier",
    description: "Read one barrier's arrival and completion state.",
    inputSchema: { barrier_id: z.string().uuid() },
  },
  async ({ barrier_id }) => {
    try {
      return response(ownBarrier(barrier_id));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "coordination_barrier_arrive",
  {
    title: "Arrive at coordination barrier",
    description: "Record this member's idempotent arrival at a wave barrier.",
    inputSchema: { barrier_id: z.string().uuid() },
  },
  async ({ barrier_id }) => {
    try {
      ownBarrier(barrier_id);
      return response(swarms.arrive(barrier_id, memberId));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "coordination_review_submit",
  {
    title: "Submit sealed coordination review",
    description: "Submit this member's independent review without seeing peer reviews.",
    inputSchema: {
      verdict: z.string().min(1).max(120),
      body: z.string().min(1).max(128_000),
    },
  },
  async (args) => {
    try {
      return response(swarms.submitReview(swarmId, { ...args, memberId }));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "coordination_step_report_submit",
  {
    title: "Submit typed playbook step report",
    description:
      "Submit this member's schema-validated outcome, findings, tests, artifacts, and metrics.",
    inputSchema: {
      outcome: z.enum(["passed", "failed", "blocked"]),
      summary: z.string().min(1).max(16_000),
      findings: z
        .array(
          z.object({
            id: z.string().regex(/^[a-z][a-z0-9._-]*$/).max(120),
            severity: z.enum(["low", "medium", "high", "critical"]),
            status: z.enum(["open", "resolved", "accepted"]),
            summary: z.string().min(1).max(4_000),
            resolutionOf: z
              .string()
              .regex(/^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/)
              .max(241)
              .optional(),
          }),
        )
        .max(200)
        .default([]),
      tests: z
        .array(
          z.object({
            name: z.string().min(1).max(500),
            status: z.enum(["passed", "failed", "skipped"]),
          }),
        )
        .max(500)
        .default([]),
      artifacts: z
        .array(
          z.object({
            kind: z.enum(["patch", "report", "log", "benchmark", "documentation"]),
            path: z.string().min(1).max(2_000),
            sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
          }),
        )
        .max(200)
        .default([]),
      metrics: z.record(z.string(), z.number().finite()).default({}),
    },
  },
  async (args) => {
    try {
      const report = parseStepReport(args);
      return response(
        playbooks.submitStepReportByMember(swarmId, memberId, report),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "coordination_prior_reports",
  {
    title: "Read prior playbook reports",
    description:
      "Read bounded untrusted report prose and evidence from dependency waves for this step.",
    inputSchema: {},
  },
  async () => {
    try {
      return response(
        playbooks.priorReportsForMember(swarmId, memberId),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "coordination_open_findings",
  {
    title: "Read unresolved playbook findings",
    description:
      "Read namespaced findings that still require two-step verification to resolve.",
    inputSchema: {},
  },
  async () => {
    try {
      return response(
        playbooks.openFindingsForMember(swarmId, memberId),
      );
    } catch (error) {
      return failure(error);
    }
  },
);
}

if (peers && peerBinding) {
  registerBoundPeerTools({
    server,
    registry: peers,
    binding: peerBinding,
  });
}

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  coordinationSwarms?.close();
  coordinationPlaybooks?.close();
  peers?.close();
  peerTraffic?.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.stdin.once("end", shutdown);
process.stdin.once("close", shutdown);
server.server.onclose = shutdown;

await server.connect(new StdioServerTransport());
console.error(
  `[agent-mesh-coordination] ready (` +
    `swarm=${coordinationSwarmId ?? "none"}, ` +
    `member=${coordinationMemberId ?? "none"}, ` +
    `peer=${peerBinding?.memberId ?? "none"}, pid=${process.pid})`,
);
