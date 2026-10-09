import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { isProcessAlive, redactSecrets, stateDirectory } from "./security.js";
import {
  MCP_PROFILES,
  type McpProfile,
} from "./mcp-profiles.js";
import {
  PROVIDERS,
  TASK_MODES,
  type Origin,
  type Provider,
  type TaskMode,
} from "./types.js";
import type { WorkspaceStrategy } from "./orchestration-presets.js";
import { agentMeshHmac } from "./coordination-auth.js";
import {
  INSTRUCTION_PROPOSAL_TARGET_KINDS,
  type InstructionFrictionEvidence,
  type InstructionProposalTarget,
} from "./instruction-proposals.js";
import { PEER_FRICTION_KINDS } from "./peer-channels.js";

export const PLAYBOOK_SCHEMA_VERSION = "agent-mesh.playbook/v1" as const;
export const PLAYBOOK_POLICY_VERSION = "2026-07-25.3" as const;
export const PLAYBOOK_CATEGORIES = [
  "long_running",
  "full_sdlc",
  "bug_hunting",
  "integration_tests",
  "data_structures",
  "docs",
  "custom",
] as const;
export const PLAYBOOK_DIFFICULTIES = [
  "small",
  "standard",
  "complex",
  "critical",
] as const;
export const PLAYBOOK_ROLES = [
  "planner",
  "builder",
  "reviewer",
  "judge",
  "tester",
  "documenter",
] as const;
export const PLAYBOOK_RUN_STATUSES = [
  "created",
  "preflighting",
  "ready",
  "running",
  "waiting_for_input",
  "paused_budget",
  "blocked_provider",
  "reconciling",
  "needs_attention",
  "completing",
  "completed",
  "failed",
  "cancelled",
] as const;
export const PLAYBOOK_WAVE_STATUSES = [
  "pending",
  "eligible",
  "reserving",
  "dispatching",
  "running",
  "collecting",
  "passed",
  "failed",
  "blocked",
  "skipped",
] as const;
export const PLAYBOOK_STEP_STATUSES = [
  "pending",
  "reserved",
  "queued",
  "running",
  "waiting_for_input",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "skipped",
] as const;

export type PlaybookCategory = (typeof PLAYBOOK_CATEGORIES)[number];
export type PlaybookDifficulty = (typeof PLAYBOOK_DIFFICULTIES)[number];
export type PlaybookRole = (typeof PLAYBOOK_ROLES)[number];
export type PlaybookRunStatus = (typeof PLAYBOOK_RUN_STATUSES)[number];
export type PlaybookWaveStatus = (typeof PLAYBOOK_WAVE_STATUSES)[number];
export type PlaybookStepStatus = (typeof PLAYBOOK_STEP_STATUSES)[number];
export type PlaybookSource = "builtin" | "generated" | "custom";
export type PlaybookApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "revoked"
  | "consumed";
export type PlaybookSynthesisStatus =
  | "created"
  | "candidates_running"
  | "critics_running"
  | "reconciling"
  | "review_ready"
  | "failed"
  | "cancelled";

const boundedId = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z][a-z0-9._-]*$/);
const providerOptionSchema = z
  .object({
    provider: z.enum(PROVIDERS),
    model: z.string().min(1).max(256),
    effort: z.string().min(1).max(32),
  })
  .strict();
export const playbookLimitsSchema = z
  .object({
    maxTasks: z.number().int().min(1).max(128),
    maxWaves: z.number().int().min(1).max(32),
    maxConcurrentTasks: z.number().int().min(1).max(32),
    maxAttemptsPerStep: z.number().int().min(1).max(5),
    maxRunWallMs: z.number().int().min(1_000).max(7 * 24 * 60 * 60 * 1_000),
    maxTaskWallMs: z.number().int().min(1_000).max(24 * 60 * 60 * 1_000),
    maxPromptBytes: z.number().int().min(1_024).max(2 * 1024 * 1024),
    maxResultBytes: z.number().int().min(1_024).max(16 * 1024 * 1024),
    maxArtifactBytes: z.number().int().min(1_024).max(512 * 1024 * 1024),
  })
  .strict();
const playbookStepSchema = z
  .object({
    id: boundedId,
    role: z.enum(PLAYBOOK_ROLES),
    taskMode: z.enum(TASK_MODES),
    capabilityProfile: z.enum(MCP_PROFILES),
    providerOptions: z.array(providerOptionSchema).min(1).max(PROVIDERS.length),
    prompt: z.string().min(1).max(64_000),
    condition: z.enum(["always", "on_findings", "manual"]).default("always"),
    requiredReport: z.boolean().default(true),
  })
  .strict();
const playbookWaveSchema = z
  .object({
    id: boundedId,
    dependsOn: z.array(boundedId).max(16),
    completion: z.enum(["all_required", "first_success"]),
    steps: z.array(playbookStepSchema).min(1).max(32),
    gate: z
      .object({
        type: z.enum([
          "all_succeeded",
          "all_required_reports",
          "independent_reports",
          "tests_passed",
          "no_open_findings",
          "friction_evidence",
          "manual",
        ]),
      })
      .strict(),
  })
  .strict();
export const playbookDefinitionSchema = z
  .object({
    schema: z.literal(PLAYBOOK_SCHEMA_VERSION),
    id: z
      .string()
      .min(1)
      .max(160)
      .regex(/^(?:builtin|custom|generated)\/[a-z][a-z0-9-]*$/),
    version: z.number().int().min(1).max(1_000_000),
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(4_000),
    category: z.enum(PLAYBOOK_CATEGORIES),
    difficulty: z.enum(PLAYBOOK_DIFFICULTIES),
    autoRunEligible: z.boolean(),
    workspace: z
      .object({
        strategy: z.enum([
          "shared_readonly",
          "single_writer_initiative",
          "competing_worktrees",
        ]),
      })
      .strict(),
    limits: playbookLimitsSchema,
    waves: z.array(playbookWaveSchema).min(1).max(32),
  })
  .strict();

export type ProviderOption = z.infer<typeof providerOptionSchema>;
export type PlaybookLimits = z.infer<typeof playbookLimitsSchema>;
export type PlaybookStep = z.infer<typeof playbookStepSchema>;
export type PlaybookWave = z.infer<typeof playbookWaveSchema>;
export type PlaybookDefinition = z.infer<typeof playbookDefinitionSchema>;

export interface GoalRevision {
  id: string;
  goalId: string;
  version: number;
  objective: string;
  constraints: string[];
  successCriteria: string[];
  riskTags: string[];
  createdAt: string;
}

export interface GoalRecord {
  id: string;
  origin: Origin;
  title: string;
  cwd: string;
  baseCommit: string;
  status: "draft" | "submitted" | "superseded";
  version: number;
  currentRevision: GoalRevision;
  createdAt: string;
  updatedAt: string;
}

export interface PlaybookRevisionRecord {
  id: string;
  playbookId: string;
  version: number;
  definition: PlaybookDefinition;
  digest: string;
  author: string;
  summary: string;
  createdAt: string;
}

export interface PlaybookRecord {
  id: string;
  origin: Origin;
  goalId: string | null;
  source: PlaybookSource;
  status: "candidate" | "review_ready" | "approved" | "rejected";
  title: string;
  version: number;
  digest: string;
  autoRunEligible: boolean;
  currentRevision: PlaybookRevisionRecord;
  createdAt: string;
  updatedAt: string;
}

export interface PlaybookApproval {
  id: string;
  origin: Origin;
  playbookId: string;
  revisionVersion: number;
  digest: string;
  goalId: string;
  goalVersion: number;
  goalDigest: string;
  status: PlaybookApprovalStatus;
  method: "human" | "trusted_builtin";
  singleUse: boolean;
  expiresAt: string | null;
  approvedAt: string | null;
  consumedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface ResolvedPlaybookStep extends PlaybookStep {
  provider: Provider;
  model: string;
  effort: string;
}

export interface ExecutionManifest {
  schema: "agent-mesh.manifest/v1";
  runPolicyVersion: typeof PLAYBOOK_POLICY_VERSION;
  goalId: string;
  goalVersion: number;
  goalDigest: string;
  playbookId: string;
  playbookVersion: number;
  playbookDigest: string;
  baseCommit: string;
  cwd: string;
  workspace: { strategy: WorkspaceStrategy };
  limits: PlaybookLimits;
  waves: Array<Omit<PlaybookWave, "steps"> & { steps: ResolvedPlaybookStep[] }>;
}

export interface PlaybookStepReport {
  outcome: "passed" | "failed" | "blocked";
  summary: string;
  findings: Array<{
    id: string;
    severity: "low" | "medium" | "high" | "critical";
    status: "open" | "resolved" | "accepted";
    summary: string;
    resolutionOf?: string;
  }>;
  tests: Array<{
    name: string;
    status: "passed" | "failed" | "skipped";
  }>;
  artifacts: Array<{
    kind: "patch" | "report" | "log" | "benchmark" | "documentation";
    path: string;
    sha256?: string;
  }>;
  metrics: Record<string, number>;
  proposals: Array<{
    target: InstructionProposalTarget;
    proposedContent: string;
    rationale: string;
    frictionEvidence: InstructionFrictionEvidence;
  }>;
}

export interface PlaybookRunStep {
  id: string;
  runId: string;
  waveId: string;
  stepId: string;
  ordinal: number;
  status: PlaybookStepStatus;
  provider: Provider;
  model: string;
  effort: string;
  mode: TaskMode;
  mcpProfile: McpProfile;
  prompt: string;
  condition: PlaybookStep["condition"];
  requiredReport: boolean;
  memberId: string | null;
  taskId: string | null;
  attempt: number;
  report: PlaybookStepReport | null;
  error: string | null;
  updatedAt: string;
}

export interface PlaybookRunWave {
  id: string;
  runId: string;
  waveId: string;
  ordinal: number;
  status: PlaybookWaveStatus;
  completion: PlaybookWave["completion"];
  gate: PlaybookWave["gate"];
  dependsOn: string[];
  attempt: number;
  leaseOwnerPid: number | null;
  leaseGeneration: number;
  startedAt: string | null;
  completedAt: string | null;
  steps: PlaybookRunStep[];
}

export interface PlaybookRun {
  id: string;
  origin: Origin;
  version: number;
  goalId: string;
  goalVersion: number;
  playbookId: string;
  playbookVersion: number;
  digest: string;
  status: PlaybookRunStatus;
  manifest: ExecutionManifest;
  approvalId: string | null;
  swarmId: string | null;
  initiativeId: string | null;
  planId: string | null;
  tasksStarted: number;
  attemptsUsed: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  waves: PlaybookRunWave[];
}

export interface PlaybookSynthesis {
  id: string;
  origin: Origin;
  version: number;
  goalId: string;
  goalVersion: number;
  status: PlaybookSynthesisStatus;
  phase: string;
  candidateTaskIds: string[];
  criticTaskIds: string[];
  reconcilerTaskId: string | null;
  candidates: string[];
  critiques: string[];
  playbookId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlaybookAuditEvent {
  id: string;
  sequence: number;
  origin: Origin;
  runId: string | null;
  entityType: string;
  entityId: string;
  event: string;
  fromStatus: string | null;
  toStatus: string | null;
  data: unknown;
  previousHash: string | null;
  hash: string;
  createdAt: string;
}

type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "");
const nullable = (value: unknown) =>
  value === null || value === undefined ? null : String(value);

function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON cannot contain non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Canonical JSON cannot contain undefined, functions, or symbols.");
}

export function digestJson(value: unknown): string {
  return createHash("sha256").update(canonicalizeJson(value)).digest("hex");
}

function assertAcyclic(definition: PlaybookDefinition): void {
  const ids = new Set(definition.waves.map((wave) => wave.id));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(definition.waves.map((wave) => [wave.id, wave]));
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("Playbook wave graph must be acyclic.");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        throw new Error(`Unknown wave dependency: ${dependency}`);
      }
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}

function dependsTransitively(
  definition: PlaybookDefinition,
  waveId: string,
  target: string,
  seen = new Set<string>(),
): boolean {
  if (waveId === target) return true;
  if (seen.has(waveId)) return false;
  seen.add(waveId);
  const wave = definition.waves.find((candidate) => candidate.id === waveId);
  return Boolean(
    wave?.dependsOn.some((dependency) =>
      dependsTransitively(definition, dependency, target, seen),
    ),
  );
}

export function validatePlaybookDefinition(value: unknown): {
  definition: PlaybookDefinition;
  digest: string;
  taskCount: number;
} {
  const definition = playbookDefinitionSchema.parse(value);
  assertAcyclic(definition);
  const waveIds = new Set<string>();
  const stepIds = new Set<string>();
  const implementationWaves: string[] = [];
  let taskCount = 0;
  for (const wave of definition.waves) {
    if (waveIds.has(wave.id)) throw new Error(`Duplicate wave ID: ${wave.id}`);
    waveIds.add(wave.id);
    const writers = wave.steps.filter((step) => step.taskMode === "implement");
    if (wave.steps.length > definition.limits.maxConcurrentTasks) {
      throw new Error(
        `Wave ${wave.id} exceeds the playbook concurrency limit.`,
      );
    }
    if (
      ["tests_passed", "no_open_findings", "independent_reports"].includes(
        wave.gate.type,
      ) &&
      (wave.completion !== "all_required" ||
        wave.steps.length < 2 ||
        wave.steps.some((step) => !step.requiredReport))
    ) {
      throw new Error(
        `Gate ${wave.gate.type} requires at least two all-required independent steps.`,
      );
    }
    if (
      wave.gate.type === "friction_evidence" &&
      (wave.completion !== "all_required" ||
        wave.steps.some((step) => !step.requiredReport))
    ) {
      throw new Error(
        "Gate friction_evidence requires all-required typed reports.",
      );
    }
    if (writers.length > 1) {
      throw new Error(`Wave ${wave.id} has more than one implementation writer.`);
    }
    if (writers.length === 1) implementationWaves.push(wave.id);
    for (const step of wave.steps) {
      if (stepIds.has(step.id)) throw new Error(`Duplicate step ID: ${step.id}`);
      stepIds.add(step.id);
      if (step.providerOptions.some((option) => !PROVIDERS.includes(option.provider))) {
        throw new Error(`Step ${step.id} contains an unsupported provider.`);
      }
      taskCount += definition.limits.maxAttemptsPerStep;
    }
  }
  if (definition.waves.length > definition.limits.maxWaves) {
    throw new Error("Playbook declares more waves than its limit.");
  }
  if (taskCount > definition.limits.maxTasks) {
    throw new Error("Playbook worst-case attempts exceed maxTasks.");
  }
  for (let index = 1; index < implementationWaves.length; index += 1) {
    if (
      !dependsTransitively(
        definition,
        implementationWaves[index]!,
        implementationWaves[index - 1]!,
      )
    ) {
      throw new Error("Implementation waves must be linearly dependency-ordered.");
    }
  }
  if (
    implementationWaves.length > 0 &&
    definition.workspace.strategy !== "single_writer_initiative"
  ) {
    throw new Error(
      "Playbooks with implementation steps require single_writer_initiative.",
    );
  }
  return {
    definition,
    digest: digestJson(definition),
    taskCount,
  };
}

const option = (
  provider: Provider,
  model: string,
  effort: string,
): ProviderOption => ({ provider, model, effort });

const plannerOptions = (): ProviderOption[] => [
  option("codex", "gpt-5.6-sol", "ultra"),
  option("claude", "claude-opus-5", "max"),
  option("claude", "claude-fable-5", "max"),
  option("antigravity", "gemini-3.6-flash-high", "high"),
  option("grok", "grok-4.5", "high"),
];
const reviewerOptions = (): ProviderOption[] => [
  option("claude", "claude-opus-5", "max"),
  option("claude", "claude-fable-5", "max"),
  option("codex", "gpt-5.6-sol", "ultra"),
  option("grok", "grok-4.5", "high"),
  option("antigravity", "gemini-3.6-flash-high", "high"),
];
const builderOptions = (): ProviderOption[] => [
  option("codex", "gpt-5.6-sol", "ultra"),
  option("claude", "claude-opus-5", "max"),
  option("claude", "claude-fable-5", "max"),
  option("antigravity", "gemini-3.6-flash-high", "high"),
  option("grok", "grok-4.5", "high"),
];

function reverseProviderOptions(options: ProviderOption[]): ProviderOption[] {
  const reversed = options.slice().reverse();
  const opus = reversed.findIndex(
    (candidate) =>
      candidate.provider === "claude" &&
      candidate.model === "claude-opus-5",
  );
  const fable = reversed.findIndex(
    (candidate) =>
      candidate.provider === "claude" &&
      candidate.model === "claude-fable-5",
  );
  if (opus >= 0 && fable >= 0 && fable < opus) {
    [reversed[opus], reversed[fable]] = [reversed[fable]!, reversed[opus]!];
  }
  return reversed;
}

const defaultLimits = (difficulty: PlaybookDifficulty): PlaybookLimits => {
  const scale = {
    small: { tasks: 8, waves: 4, concurrent: 2, attempts: 1, runHours: 2, taskHours: 1 },
    standard: { tasks: 20, waves: 8, concurrent: 4, attempts: 2, runHours: 8, taskHours: 2 },
    complex: { tasks: 40, waves: 12, concurrent: 4, attempts: 2, runHours: 24, taskHours: 4 },
    critical: { tasks: 64, waves: 16, concurrent: 4, attempts: 3, runHours: 72, taskHours: 8 },
  }[difficulty];
  return {
    maxTasks: scale.tasks,
    maxWaves: scale.waves,
    maxConcurrentTasks: scale.concurrent,
    maxAttemptsPerStep: scale.attempts,
    maxRunWallMs: scale.runHours * 60 * 60 * 1_000,
    maxTaskWallMs: scale.taskHours * 60 * 60 * 1_000,
    maxPromptBytes: 128 * 1024,
    maxResultBytes: 4 * 1024 * 1024,
    maxArtifactBytes: 256 * 1024 * 1024,
  };
};

const step = (
  id: string,
  role: PlaybookRole,
  taskMode: TaskMode,
  prompt: string,
  providerOptions: ProviderOption[],
  input: Partial<Pick<PlaybookStep, "capabilityProfile" | "condition" | "requiredReport">> = {},
): PlaybookStep => ({
  id,
  role,
  taskMode,
  capabilityProfile: input.capabilityProfile ?? "research",
  providerOptions,
  prompt,
  condition: input.condition ?? "always",
  requiredReport: input.requiredReport ?? true,
});

function definition(
  id: string,
  title: string,
  description: string,
  category: PlaybookCategory,
  difficulty: PlaybookDifficulty,
  strategy: WorkspaceStrategy,
  waves: PlaybookWave[],
): PlaybookDefinition {
  return validatePlaybookDefinition({
    schema: PLAYBOOK_SCHEMA_VERSION,
    id,
    version: 1,
    title,
    description,
    category,
    difficulty,
    autoRunEligible: true,
    workspace: { strategy },
    limits: defaultLimits(difficulty),
    waves,
  }).definition;
}

export const BUILTIN_PLAYBOOKS: readonly PlaybookDefinition[] = Object.freeze([
  definition(
    "builtin/long-running",
    "Long-running delivery",
    "Milestone-based implementation with checkpoints, bounded retries, verification, and final audit.",
    "long_running",
    "complex",
    "single_writer_initiative",
    [
      {
        id: "architecture",
        dependsOn: [],
        completion: "all_required",
        steps: [
          step("architecture-a", "planner", "plan", "Develop milestone architecture, risks, checkpoints, and rollback boundaries.", plannerOptions()),
          step("architecture-b", "planner", "plan", "Independently challenge scope, sequencing, and long-running failure recovery.", reverseProviderOptions(plannerOptions())),
        ],
        gate: { type: "all_required_reports" },
      },
      {
        id: "build",
        dependsOn: ["architecture"],
        completion: "all_required",
        steps: [
          step("milestone-builder", "builder", "implement", "Implement the approved milestones in bounded increments. Verify each checkpoint before proceeding.", builderOptions()),
        ],
        gate: { type: "all_succeeded" },
      },
      {
        id: "review",
        dependsOn: ["build"],
        completion: "all_required",
        steps: [
          step("long-review-a", "reviewer", "review", "Adversarially inspect milestone correctness, regressions, and incomplete requirements.", reviewerOptions()),
          step("long-review-b", "reviewer", "review", "Independently verify operational recovery, test evidence, and maintainability.", reverseProviderOptions(reviewerOptions())),
        ],
        gate: { type: "no_open_findings" },
      },
      {
        id: "final-audit",
        dependsOn: ["review"],
        completion: "all_required",
        steps: [
          step("long-final-audit", "tester", "review", "Run the final validation matrix and report release readiness.", reviewerOptions()),
          step("long-final-audit-b", "tester", "review", "Independently rerun critical validation and challenge release readiness.", reverseProviderOptions(reviewerOptions())),
        ],
        gate: { type: "tests_passed" },
      },
    ],
  ),
  definition(
    "builtin/full-sdlc",
    "Full SDLC",
    "Requirements, threat model, design, implementation, blind review, fixes, tests, documentation, and release readiness.",
    "full_sdlc",
    "critical",
    "single_writer_initiative",
    [
      {
        id: "requirements",
        dependsOn: [],
        completion: "all_required",
        steps: [
          step("requirements-analyst", "planner", "plan", "Extract requirements, constraints, success criteria, threat model, and test obligations.", plannerOptions()),
          step("requirements-adversary", "reviewer", "review", "Challenge ambiguity, hidden risks, compatibility, and missing acceptance criteria.", reviewerOptions()),
        ],
        gate: { type: "all_required_reports" },
      },
      {
        id: "design",
        dependsOn: ["requirements"],
        completion: "all_required",
        steps: [
          step("design-a", "planner", "plan", "Produce a concrete architecture and implementation sequence grounded in repository evidence.", plannerOptions()),
          step("design-b", "planner", "plan", "Produce an independent alternative design and migration/rollback analysis.", reverseProviderOptions(plannerOptions())),
        ],
        gate: { type: "all_required_reports" },
      },
      {
        id: "implementation",
        dependsOn: ["design"],
        completion: "all_required",
        steps: [
          step("sdlc-builder", "builder", "implement", "Implement the selected design, tests, migration safeguards, and observability.", builderOptions()),
        ],
        gate: { type: "all_succeeded" },
      },
      {
        id: "adversarial-review",
        dependsOn: ["implementation"],
        completion: "all_required",
        steps: [
          step("sdlc-review-a", "reviewer", "review", "Perform a blind correctness, security, and regression review with concrete findings.", reviewerOptions()),
          step("sdlc-review-b", "reviewer", "review", "Independently audit edge cases, failure modes, maintainability, and tests.", reverseProviderOptions(reviewerOptions())),
        ],
        gate: { type: "all_required_reports" },
      },
      {
        id: "fix",
        dependsOn: ["adversarial-review"],
        completion: "all_required",
        steps: [
          step("sdlc-fixer", "builder", "implement", "Address every accepted open finding and add regression coverage.", builderOptions(), { condition: "on_findings" }),
        ],
        gate: { type: "all_succeeded" },
      },
      {
        id: "integration-test",
        dependsOn: ["fix"],
        completion: "all_required",
        steps: [
          step("sdlc-tester", "tester", "review", "Execute the required unit, integration, failure, migration, and regression test matrix.", reviewerOptions()),
          step("sdlc-tester-b", "tester", "review", "Independently verify critical integration, failure, migration, and regression evidence.", reverseProviderOptions(reviewerOptions())),
        ],
        gate: { type: "tests_passed" },
      },
      {
        id: "documentation",
        dependsOn: ["integration-test"],
        completion: "all_required",
        steps: [
          step("sdlc-documenter", "documenter", "implement", "Update source-grounded user, operator, architecture, and migration documentation.", builderOptions()),
        ],
        gate: { type: "all_succeeded" },
      },
      {
        id: "release-readiness",
        dependsOn: ["documentation"],
        completion: "all_required",
        steps: [
          step("release-auditor", "reviewer", "review", "Verify success criteria, test evidence, documentation, rollback, and release readiness.", reviewerOptions()),
          step("release-auditor-b", "reviewer", "review", "Independently challenge release readiness and unresolved risk claims.", reverseProviderOptions(reviewerOptions())),
        ],
        gate: { type: "no_open_findings" },
      },
    ],
  ),
  definition(
    "builtin/bug-hunting",
    "Bug hunting",
    "Evidence-first reproduction, independent hypotheses, adjudication, one fix writer, regression tests, and adversarial verification.",
    "bug_hunting",
    "complex",
    "single_writer_initiative",
    [
      {
        id: "reproduce",
        dependsOn: [],
        completion: "all_required",
        steps: [
          step("reproducer", "tester", "review", "Reproduce the defect with runtime evidence and define the minimal failing case.", reviewerOptions()),
        ],
        gate: { type: "all_required_reports" },
      },
      {
        id: "hypotheses",
        dependsOn: ["reproduce"],
        completion: "all_required",
        steps: [
          step("hypothesis-a", "planner", "plan", "Develop an evidence-ranked root-cause hypothesis and disproof tests.", plannerOptions()),
          step("hypothesis-b", "planner", "plan", "Independently develop competing root-cause hypotheses and discriminating probes.", reverseProviderOptions(plannerOptions())),
        ],
        gate: { type: "all_required_reports" },
      },
      {
        id: "fix",
        dependsOn: ["hypotheses"],
        completion: "all_required",
        steps: [
          step("bug-fixer", "builder", "implement", "Implement the smallest root-cause fix and regression test without adjacent cleanup.", builderOptions()),
        ],
        gate: { type: "all_succeeded" },
      },
      {
        id: "verify",
        dependsOn: ["fix"],
        completion: "all_required",
        steps: [
          step("bug-verifier", "reviewer", "review", "Adversarially verify the reproduction fails before, passes after, and no regressions were introduced.", reviewerOptions()),
          step("bug-verifier-b", "tester", "review", "Independently rerun regression evidence and challenge the root-cause fix.", reverseProviderOptions(reviewerOptions())),
        ],
        gate: { type: "tests_passed" },
      },
    ],
  ),
  definition(
    "builtin/integration-tests",
    "Integration testing",
    "Contract inventory, test matrix, harness implementation, isolated execution, flake analysis, and coverage reporting.",
    "integration_tests",
    "standard",
    "single_writer_initiative",
    [
      {
        id: "contracts",
        dependsOn: [],
        completion: "all_required",
        steps: [
          step("contract-analyst", "planner", "plan", "Inventory component contracts, boundaries, fixtures, environments, and failure cases.", plannerOptions()),
          step("matrix-reviewer", "reviewer", "review", "Challenge the integration matrix for missing boundaries, races, and destructive cases.", reviewerOptions()),
        ],
        gate: { type: "all_required_reports" },
      },
      {
        id: "harness",
        dependsOn: ["contracts"],
        completion: "all_required",
        steps: [
          step("integration-builder", "builder", "implement", "Implement or extend the isolated integration harness and deterministic fixtures.", builderOptions()),
        ],
        gate: { type: "all_succeeded" },
      },
      {
        id: "execute",
        dependsOn: ["harness"],
        completion: "all_required",
        steps: [
          step("integration-runner", "tester", "review", "Run the full integration and failure matrix, identify flakes, and report coverage gaps.", reviewerOptions()),
          step("integration-runner-b", "tester", "review", "Independently rerun critical contracts and validate flake and coverage claims.", reverseProviderOptions(reviewerOptions())),
        ],
        gate: { type: "tests_passed" },
      },
    ],
  ),
  definition(
    "builtin/data-structures",
    "Data structure analysis",
    "Invariant, API, and complexity design followed by implementation, property/fuzz/benchmark verification, and performance review.",
    "data_structures",
    "complex",
    "single_writer_initiative",
    [
      {
        id: "invariants",
        dependsOn: [],
        completion: "all_required",
        steps: [
          step("ds-designer-a", "planner", "plan", "Specify representation invariants, API contracts, complexity targets, and edge cases.", plannerOptions()),
          step("ds-designer-b", "planner", "plan", "Develop a competing representation and compare correctness and complexity tradeoffs.", reverseProviderOptions(plannerOptions())),
        ],
        gate: { type: "all_required_reports" },
      },
      {
        id: "implementation",
        dependsOn: ["invariants"],
        completion: "all_required",
        steps: [
          step("ds-builder", "builder", "implement", "Implement the selected data structure with unit and property tests.", builderOptions()),
        ],
        gate: { type: "all_succeeded" },
      },
      {
        id: "verification",
        dependsOn: ["implementation"],
        completion: "all_required",
        steps: [
          step("ds-verifier", "tester", "review", "Run property, fuzz, adversarial, and benchmark verification against stated invariants.", reviewerOptions()),
          step("ds-performance-review", "reviewer", "review", "Audit asymptotic and observed complexity, memory behavior, and API correctness.", reverseProviderOptions(reviewerOptions())),
        ],
        gate: { type: "tests_passed" },
      },
    ],
  ),
  definition(
    "builtin/retrospective",
    "Coordination retrospective",
    "Independent friction-ledger analysis, evidence reconciliation, and human-gated instruction proposals without repository edits.",
    "custom",
    "standard",
    "shared_readonly",
    [
      {
        id: "independent-analysis",
        dependsOn: [],
        completion: "all_required",
        steps: [
          step(
            "retrospective-analyst-a",
            "reviewer",
            "research",
            `Independently analyze a bounded window of at most 500 friction ledger
events plus its aggregate summary, run reports, and audit metadata. Do not read
another analyst's conclusions before submitting. Answer with recorded event IDs:
who tripped over what, which instruction was ambiguous or missing, and which
harness needs a sharper rule. Repository access is read-only.`,
            reviewerOptions(),
          ),
          step(
            "retrospective-analyst-b",
            "reviewer",
            "research",
            `Independently analyze the same bounded friction, run-report, and audit
window without seeing another analyst's conclusions. Answer with recorded event
IDs: who tripped over what, which instruction was ambiguous or missing, and
which harness needs a sharper rule. Repository access is read-only.`,
            reverseProviderOptions(reviewerOptions()),
          ),
        ],
        gate: { type: "independent_reports" },
      },
      {
        id: "reconciliation",
        dependsOn: ["independent-analysis"],
        completion: "all_required",
        steps: [
          step(
            "retrospective-reconciler",
            "judge",
            "plan",
            `Cluster the independent findings, discard every claim not supported by
a recorded friction event, and rank surviving patterns by recurrence and
severity. A single anecdote is not a pattern and must not become an instruction
proposal.`,
            plannerOptions(),
          ),
        ],
        gate: { type: "all_required_reports" },
      },
      {
        id: "instruction-proposals",
        dependsOn: ["reconciliation"],
        completion: "all_required",
        steps: [
          step(
            "retrospective-proposer",
            "documenter",
            "plan",
            `Emit concrete typed instruction proposals for recurrent, evidence-backed
patterns only. Every proposal must name exactly one mesh_skill,
harness_instructions, or repository_ruleset target, provide the complete
replacement content and rationale, cite at least one recorded friction event,
and include its aggregate friction summary. Submit proposals in the typed step
report; the proposal store records them for separate exact digest-bound human
approval. Do not edit the repository or instruction assets.`,
            plannerOptions(),
          ),
        ],
        gate: { type: "friction_evidence" },
      },
    ],
  ),
  definition(
    "builtin/docs",
    "Documentation",
    "Source-grounded fact extraction, outline, drafting, accuracy review, and link/example validation.",
    "docs",
    "standard",
    "single_writer_initiative",
    [
      {
        id: "facts",
        dependsOn: [],
        completion: "all_required",
        steps: [
          step("docs-facts", "planner", "research", "Extract source-grounded behavior, APIs, examples, compatibility, and operator facts.", plannerOptions()),
          step("docs-outline", "planner", "plan", "Design a reader-oriented outline and explicit validation checklist.", reverseProviderOptions(plannerOptions())),
        ],
        gate: { type: "all_required_reports" },
      },
      {
        id: "draft",
        dependsOn: ["facts"],
        completion: "all_required",
        steps: [
          step("docs-writer", "documenter", "implement", "Write or update only the required documentation using verified repository facts.", builderOptions()),
        ],
        gate: { type: "all_succeeded" },
      },
      {
        id: "accuracy",
        dependsOn: ["draft"],
        completion: "all_required",
        steps: [
          step("docs-reviewer", "reviewer", "review", "Verify technical accuracy, examples, links, omissions, and reader usability.", reviewerOptions()),
          step("docs-reviewer-b", "reviewer", "review", "Independently verify examples, links, technical claims, and missing reader context.", reverseProviderOptions(reviewerOptions())),
        ],
        gate: { type: "no_open_findings" },
      },
    ],
  ),
]);

for (const builtin of BUILTIN_PLAYBOOKS) validatePlaybookDefinition(builtin);

export function listBuiltinPlaybooks(): PlaybookDefinition[] {
  return BUILTIN_PLAYBOOKS.map((playbook) => structuredClone(playbook));
}

export function getBuiltinPlaybook(ref: string): PlaybookDefinition {
  const [id, rawVersion] = ref.split("@");
  const playbook = BUILTIN_PLAYBOOKS.find(
    (candidate) =>
      candidate.id === id &&
      (rawVersion === undefined || Number(rawVersion) === candidate.version),
  );
  if (!playbook) throw new Error(`Unknown built-in playbook: ${ref}`);
  return structuredClone(playbook);
}

export class PlaybookRegistry {
  private readonly db: DatabaseSync;

  constructor(
    readonly origin: Origin,
    readonly path = join(stateDirectory(), "playbooks.db"),
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY, origin TEXT NOT NULL, title TEXT NOT NULL,
        cwd TEXT NOT NULL, base_commit TEXT NOT NULL, status TEXT NOT NULL,
        version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS goal_revisions (
        id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, version INTEGER NOT NULL,
        objective TEXT NOT NULL, constraints_json TEXT NOT NULL,
        success_json TEXT NOT NULL, risk_json TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(goal_id, version), FOREIGN KEY(goal_id) REFERENCES goals(id)
      );
      CREATE TABLE IF NOT EXISTS playbooks (
        id TEXT PRIMARY KEY, origin TEXT NOT NULL, goal_id TEXT,
        source TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL,
        version INTEGER NOT NULL, digest TEXT NOT NULL,
        auto_run_eligible INTEGER NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS playbook_revisions (
        id TEXT PRIMARY KEY, playbook_id TEXT NOT NULL, version INTEGER NOT NULL,
        definition_json TEXT NOT NULL, digest TEXT NOT NULL, author TEXT NOT NULL,
        summary TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(playbook_id, version),
        FOREIGN KEY(playbook_id) REFERENCES playbooks(id)
      );
      CREATE TABLE IF NOT EXISTS playbook_approvals (
        id TEXT PRIMARY KEY, origin TEXT NOT NULL, playbook_id TEXT NOT NULL,
        revision_version INTEGER NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL,
        goal_id TEXT NOT NULL DEFAULT '', goal_version INTEGER NOT NULL DEFAULT 0,
        goal_digest TEXT NOT NULL DEFAULT '',
        method TEXT NOT NULL, single_use INTEGER NOT NULL, expires_at TEXT,
        approved_at TEXT, consumed_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL,
        FOREIGN KEY(playbook_id) REFERENCES playbooks(id)
      );
      CREATE TABLE IF NOT EXISTS playbook_syntheses (
        id TEXT PRIMARY KEY, origin TEXT NOT NULL, goal_id TEXT NOT NULL,
        goal_version INTEGER NOT NULL, status TEXT NOT NULL, phase TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        candidate_task_ids_json TEXT NOT NULL, critic_task_ids_json TEXT NOT NULL,
        reconciler_task_id TEXT, candidates_json TEXT NOT NULL,
        critiques_json TEXT NOT NULL, playbook_id TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS playbook_runs (
        id TEXT PRIMARY KEY, origin TEXT NOT NULL, goal_id TEXT NOT NULL,
        goal_version INTEGER NOT NULL, playbook_id TEXT NOT NULL,
        playbook_version INTEGER NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        manifest_json TEXT NOT NULL, approval_id TEXT, swarm_id TEXT,
        initiative_id TEXT, plan_id TEXT, provisioning_owner_pid INTEGER,
        tasks_started INTEGER NOT NULL DEFAULT 0,
        attempts_used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, started_at TEXT, completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS playbook_run_waves (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, wave_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL, status TEXT NOT NULL, completion TEXT NOT NULL,
        gate_json TEXT NOT NULL, depends_on_json TEXT NOT NULL, attempt INTEGER NOT NULL,
        lease_owner_pid INTEGER, lease_generation INTEGER NOT NULL DEFAULT 0,
        started_at TEXT, completed_at TEXT, UNIQUE(run_id, wave_id),
        FOREIGN KEY(run_id) REFERENCES playbook_runs(id)
      );
      CREATE TABLE IF NOT EXISTS playbook_run_steps (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, wave_id TEXT NOT NULL,
        step_id TEXT NOT NULL, ordinal INTEGER NOT NULL, status TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL,
        mode TEXT NOT NULL, mcp_profile TEXT NOT NULL, prompt TEXT NOT NULL,
        condition TEXT NOT NULL, required_report INTEGER NOT NULL,
        member_id TEXT, task_id TEXT, attempt INTEGER NOT NULL DEFAULT 0,
        report_json TEXT, error TEXT, updated_at TEXT NOT NULL,
        UNIQUE(run_id, step_id), FOREIGN KEY(run_id) REFERENCES playbook_runs(id)
      );
      CREATE TABLE IF NOT EXISTS playbook_audit_events (
        id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE,
        origin TEXT NOT NULL DEFAULT '', run_id TEXT,
        entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, event TEXT NOT NULL,
        from_status TEXT, to_status TEXT, data_json TEXT NOT NULL,
        previous_hash TEXT, hash TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS playbook_idempotency (
        origin TEXT NOT NULL, operation TEXT NOT NULL, key TEXT NOT NULL,
        request_hash TEXT NOT NULL DEFAULT '', result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(origin, operation, key)
      );
      CREATE INDEX IF NOT EXISTS idx_goals_origin ON goals(origin, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_playbooks_origin ON playbooks(origin, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_origin ON playbook_runs(origin, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_steps_task ON playbook_run_steps(task_id);
      CREATE INDEX IF NOT EXISTS idx_runs_swarm ON playbook_runs(swarm_id);
    `);
    const runColumns = this.db.prepare("PRAGMA table_info(playbook_runs)").all() as Row[];
    if (!runColumns.some((column) => column.name === "version")) {
      this.db.exec(
        "ALTER TABLE playbook_runs ADD COLUMN version INTEGER NOT NULL DEFAULT 1",
      );
    }
    if (!runColumns.some((column) => column.name === "provisioning_owner_pid")) {
      this.db.exec(
        "ALTER TABLE playbook_runs ADD COLUMN provisioning_owner_pid INTEGER",
      );
    }
    const synthesisColumns = this.db
      .prepare("PRAGMA table_info(playbook_syntheses)")
      .all() as Row[];
    if (!synthesisColumns.some((column) => column.name === "version")) {
      this.db.exec(
        "ALTER TABLE playbook_syntheses ADD COLUMN version INTEGER NOT NULL DEFAULT 1",
      );
    }
    const approvalColumns = this.db
      .prepare("PRAGMA table_info(playbook_approvals)")
      .all() as Row[];
    if (!approvalColumns.some((column) => column.name === "goal_id")) {
      this.db.exec(
        "ALTER TABLE playbook_approvals ADD COLUMN goal_id TEXT NOT NULL DEFAULT ''",
      );
      this.db.exec(
        "ALTER TABLE playbook_approvals ADD COLUMN goal_version INTEGER NOT NULL DEFAULT 0",
      );
      this.db.exec(
        "ALTER TABLE playbook_approvals ADD COLUMN goal_digest TEXT NOT NULL DEFAULT ''",
      );
    }
    const idempotencyColumns = this.db
      .prepare("PRAGMA table_info(playbook_idempotency)")
      .all() as Row[];
    if (!idempotencyColumns.some((column) => column.name === "request_hash")) {
      this.db.exec(
        "ALTER TABLE playbook_idempotency ADD COLUMN request_hash TEXT NOT NULL DEFAULT ''",
      );
    }
    const auditColumns = this.db
      .prepare("PRAGMA table_info(playbook_audit_events)")
      .all() as Row[];
    if (!auditColumns.some((column) => column.name === "origin")) {
      this.db.exec(
        "ALTER TABLE playbook_audit_events ADD COLUMN origin TEXT NOT NULL DEFAULT ''",
      );
    }
  }

  close(): void {
    this.db.close();
  }

  createGoal(input: {
    title: string;
    cwd: string;
    baseCommit: string;
    objective: string;
    constraints?: string[];
    successCriteria?: string[];
    riskTags?: string[];
  }): GoalRecord {
    const id = randomUUID();
    const revisionId = randomUUID();
    const now = new Date().toISOString();
    const title = redactSecrets(input.title.trim()).slice(0, 200);
    const objective = redactSecrets(input.objective.trim()).slice(0, 8_000);
    if (!title || !objective) throw new Error("Goal title and objective are required.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db
        .prepare(
          `INSERT INTO goals
           (id, origin, title, cwd, base_commit, status, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'draft', 1, ?, ?)`,
        )
        .run(id, this.origin, title, input.cwd, input.baseCommit, now, now);
      this.db
        .prepare(
          `INSERT INTO goal_revisions
           (id, goal_id, version, objective, constraints_json, success_json, risk_json, created_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
        )
        .run(
          revisionId,
          id,
          objective,
          JSON.stringify((input.constraints ?? []).map((item) => redactSecrets(item).slice(0, 2_000))),
          JSON.stringify((input.successCriteria ?? []).map((item) => redactSecrets(item).slice(0, 2_000))),
          JSON.stringify((input.riskTags ?? []).map((item) => redactSecrets(item).slice(0, 120))),
          now,
        );
      this.appendAuditInternal({
        entityType: "goal",
        entityId: id,
        event: "goal_created",
        fromStatus: null,
        toStatus: "draft",
        data: { version: 1, baseCommit: input.baseCommit },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getGoal(id);
  }

  reviseGoal(
    id: string,
    input: {
      objective: string;
      constraints?: string[];
      successCriteria?: string[];
      riskTags?: string[];
      expectedVersion: number;
    },
  ): GoalRecord {
    const goal = this.getGoal(id);
    if (goal.version !== input.expectedVersion) throw new Error("Goal version conflict.");
    if (goal.status !== "draft") {
      throw new Error("Only draft goals can be revised; submitted goals are immutable.");
    }
    const version = goal.version + 1;
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO goal_revisions
           (id, goal_id, version, objective, constraints_json, success_json, risk_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          id,
          version,
          redactSecrets(input.objective).slice(0, 8_000),
          JSON.stringify((input.constraints ?? []).map((item) => redactSecrets(item).slice(0, 2_000))),
          JSON.stringify((input.successCriteria ?? []).map((item) => redactSecrets(item).slice(0, 2_000))),
          JSON.stringify((input.riskTags ?? []).map((item) => redactSecrets(item).slice(0, 120))),
          now,
        );
      const changed = this.db
        .prepare(
          `UPDATE goals SET version = ?, status = 'draft', updated_at = ?
           WHERE id = ? AND origin = ? AND version = ? AND status = 'draft'`,
        )
        .run(version, now, id, this.origin, input.expectedVersion);
      if (changed.changes !== 1) throw new Error("Goal changed concurrently.");
      this.appendAuditInternal({
        entityType: "goal",
        entityId: id,
        event: "goal_revised",
        fromStatus: "draft",
        toStatus: "draft",
        data: { fromVersion: goal.version, toVersion: version },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getGoal(id);
  }

  submitGoal(id: string, expectedVersion: number): GoalRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `UPDATE goals SET status = 'submitted', updated_at = ?
           WHERE id = ? AND origin = ? AND version = ? AND status = 'draft'`,
        )
        .run(new Date().toISOString(), id, this.origin, expectedVersion);
      if (result.changes !== 1) {
        throw new Error("Only the current draft goal can be submitted.");
      }
      this.appendAuditInternal({
        entityType: "goal",
        entityId: id,
        event: "goal_submitted",
        fromStatus: "draft",
        toStatus: "submitted",
        data: { version: expectedVersion },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getGoal(id);
  }

  getGoal(id: string): GoalRecord {
    const row = this.db
      .prepare("SELECT * FROM goals WHERE id = ? AND origin = ?")
      .get(id, this.origin) as Row | undefined;
    if (!row) throw new Error(`Unknown goal: ${id}`);
    const revision = this.db
      .prepare("SELECT * FROM goal_revisions WHERE goal_id = ? AND version = ?")
      .get(id, Number(row.version)) as Row;
    return {
      id,
      origin: this.origin,
      title: text(row.title),
      cwd: text(row.cwd),
      baseCommit: text(row.base_commit),
      status: text(row.status) as GoalRecord["status"],
      version: Number(row.version),
      currentRevision: {
        id: text(revision.id),
        goalId: id,
        version: Number(revision.version),
        objective: text(revision.objective),
        constraints: safeJsonParse<string[]>(revision.constraints_json, []),
        successCriteria: safeJsonParse<string[]>(revision.success_json, []),
        riskTags: safeJsonParse<string[]>(revision.risk_json, []),
        createdAt: text(revision.created_at),
      },
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
    };
  }

  listGoals(limit = 100): GoalRecord[] {
    return (
      this.db
        .prepare("SELECT id FROM goals WHERE origin = ? ORDER BY updated_at DESC LIMIT ?")
        .all(this.origin, Math.min(Math.max(limit, 1), 1_000)) as Row[]
    ).map((row) => this.getGoal(text(row.id)));
  }

  createPlaybook(input: {
    definition: unknown;
    source: Exclude<PlaybookSource, "builtin">;
    goalId?: string;
    author: string;
    summary?: string;
  }): PlaybookRecord {
    const validated = validatePlaybookDefinition(input.definition);
    if (validated.definition.id.startsWith("builtin/")) {
      throw new Error("Generated/custom playbooks cannot use the builtin namespace.");
    }
    if (input.goalId) this.getGoal(input.goalId);
    if (input.source === "generated" && input.goalId) {
      const existing = this.db
        .prepare(
          `SELECT id FROM playbooks
           WHERE origin = ? AND source = 'generated' AND goal_id = ? AND digest = ?
           ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(this.origin, input.goalId, validated.digest) as Row | undefined;
      if (existing) return this.getPlaybook(text(existing.id));
    }
    const id = randomUUID();
    const revisionId = randomUUID();
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO playbooks
           (id, origin, goal_id, source, status, title, version, digest,
            auto_run_eligible, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'candidate', ?, 1, ?, 0, ?, ?)`,
        )
        .run(
          id,
          this.origin,
          input.goalId ?? null,
          input.source,
          validated.definition.title,
          validated.digest,
          now,
          now,
        );
      this.db
        .prepare(
          `INSERT INTO playbook_revisions
           (id, playbook_id, version, definition_json, digest, author, summary, created_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
        )
        .run(
          revisionId,
          id,
          canonicalizeJson(validated.definition),
          validated.digest,
          redactSecrets(input.author).slice(0, 200),
          redactSecrets(input.summary ?? "Initial candidate").slice(0, 4_000),
          now,
        );
      this.appendAuditInternal({
        entityType: "playbook",
        entityId: id,
        event: "playbook_created",
        fromStatus: null,
        toStatus: "candidate",
        data: {
          source: input.source,
          version: 1,
          digest: validated.digest,
          goalId: input.goalId ?? null,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getPlaybook(id);
  }

  materializeBuiltin(ref: string, goalId?: string): PlaybookRecord {
    const definition = getBuiltinPlaybook(ref);
    if (goalId) this.getGoal(goalId);
    const existing = this.db
      .prepare(
        `SELECT id FROM playbooks
         WHERE origin = ? AND source = 'builtin' AND goal_id IS ?
           AND digest = ? ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(this.origin, goalId ?? null, digestJson(definition)) as Row | undefined;
    if (existing) return this.getPlaybook(text(existing.id));
    const id = randomUUID();
    const now = new Date().toISOString();
    const digest = digestJson(definition);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO playbooks
           (id, origin, goal_id, source, status, title, version, digest,
            auto_run_eligible, created_at, updated_at)
           VALUES (?, ?, ?, 'builtin', 'review_ready', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          this.origin,
          goalId ?? null,
          definition.title,
          definition.version,
          digest,
          definition.autoRunEligible ? 1 : 0,
          now,
          now,
        );
      this.db
        .prepare(
          `INSERT INTO playbook_revisions
           (id, playbook_id, version, definition_json, digest, author, summary, created_at)
           VALUES (?, ?, ?, ?, ?, 'agent-mesh', 'Materialized built-in', ?)`,
        )
        .run(
          randomUUID(),
          id,
          definition.version,
          canonicalizeJson(definition),
          digest,
          now,
        );
      this.appendAuditInternal({
        entityType: "playbook",
        entityId: id,
        event: "builtin_materialized",
        fromStatus: null,
        toStatus: "review_ready",
        data: {
          builtinRef: ref,
          version: definition.version,
          digest,
          goalId: goalId ?? null,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getPlaybook(id);
  }

  revisePlaybook(
    id: string,
    input: {
      definition: unknown;
      author: string;
      summary: string;
      expectedVersion: number;
    },
  ): PlaybookRecord {
    const playbook = this.getPlaybook(id);
    if (playbook.version !== input.expectedVersion) throw new Error("Playbook version conflict.");
    if (playbook.source === "builtin") throw new Error("Built-ins cannot be revised.");
    const validated = validatePlaybookDefinition(input.definition);
    const version = playbook.version + 1;
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO playbook_revisions
           (id, playbook_id, version, definition_json, digest, author, summary, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          id,
          version,
          canonicalizeJson(validated.definition),
          validated.digest,
          redactSecrets(input.author).slice(0, 200),
          redactSecrets(input.summary).slice(0, 4_000),
          now,
        );
      const changed = this.db
        .prepare(
          `UPDATE playbooks SET status = 'candidate', version = ?, digest = ?,
           title = ?, auto_run_eligible = 0, updated_at = ?
           WHERE id = ? AND origin = ? AND version = ?`,
        )
        .run(
          version,
          validated.digest,
          validated.definition.title,
          now,
          id,
          this.origin,
          input.expectedVersion,
        );
      if (changed.changes !== 1) throw new Error("Playbook changed concurrently.");
      this.db
        .prepare(
          `UPDATE playbook_approvals SET status = 'revoked', revoked_at = ?
           WHERE playbook_id = ? AND status = 'approved'`,
        )
        .run(now, id);
      this.appendAuditInternal({
        entityType: "playbook",
        entityId: id,
        event: "playbook_revised",
        fromStatus: playbook.status,
        toStatus: "candidate",
        data: {
          fromVersion: playbook.version,
          toVersion: version,
          digest: validated.digest,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getPlaybook(id);
  }

  markReviewReady(id: string, expectedVersion: number): PlaybookRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `UPDATE playbooks SET status = 'review_ready', updated_at = ?
           WHERE id = ? AND origin = ? AND version = ? AND status = 'candidate'`,
        )
        .run(new Date().toISOString(), id, this.origin, expectedVersion);
      if (result.changes !== 1) {
        throw new Error("Only the current candidate can enter review.");
      }
      this.appendAuditInternal({
        entityType: "playbook",
        entityId: id,
        event: "playbook_review_ready",
        fromStatus: "candidate",
        toStatus: "review_ready",
        data: { version: expectedVersion },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getPlaybook(id);
  }

  rejectPlaybook(id: string, expectedVersion: number): PlaybookRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getPlaybook(id);
      const result = this.db
        .prepare(
          `UPDATE playbooks SET status = 'rejected', updated_at = ?
           WHERE id = ? AND origin = ? AND version = ?
             AND status IN ('candidate', 'review_ready')`,
        )
        .run(new Date().toISOString(), id, this.origin, expectedVersion);
      if (result.changes !== 1) {
        throw new Error("Playbook cannot be rejected from its current state.");
      }
      this.appendAuditInternal({
        entityType: "playbook",
        entityId: id,
        event: "playbook_rejected",
        fromStatus: current.status,
        toStatus: "rejected",
        data: { version: expectedVersion },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getPlaybook(id);
  }

  getPlaybook(id: string): PlaybookRecord {
    const row = this.db
      .prepare("SELECT * FROM playbooks WHERE id = ? AND origin = ?")
      .get(id, this.origin) as Row | undefined;
    if (!row) throw new Error(`Unknown playbook: ${id}`);
    const revision = this.db
      .prepare("SELECT * FROM playbook_revisions WHERE playbook_id = ? AND version = ?")
      .get(id, Number(row.version)) as Row;
    const definition = playbookDefinitionSchema.parse(
      safeJsonParse(revision.definition_json, {}),
    );
    const computedDigest = digestJson(definition);
    if (
      computedDigest !== text(revision.digest) ||
      computedDigest !== text(row.digest)
    ) {
      throw new Error(`Playbook ${id} failed digest verification.`);
    }
    return {
      id,
      origin: this.origin,
      goalId: nullable(row.goal_id),
      source: text(row.source) as PlaybookSource,
      status: text(row.status) as PlaybookRecord["status"],
      title: text(row.title),
      version: Number(row.version),
      digest: text(row.digest),
      autoRunEligible: Boolean(row.auto_run_eligible),
      currentRevision: {
        id: text(revision.id),
        playbookId: id,
        version: Number(revision.version),
        definition,
        digest: text(revision.digest),
        author: text(revision.author),
        summary: text(revision.summary),
        createdAt: text(revision.created_at),
      },
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
    };
  }

  listPlaybooks(limit = 100): PlaybookRecord[] {
    return (
      this.db
        .prepare("SELECT id FROM playbooks WHERE origin = ? ORDER BY updated_at DESC LIMIT ?")
        .all(this.origin, Math.min(Math.max(limit, 1), 1_000)) as Row[]
    ).map((row) => this.getPlaybook(text(row.id)));
  }

  playbookRevisions(id: string): PlaybookRevisionRecord[] {
    this.getPlaybook(id);
    return (
      this.db
        .prepare(
          `SELECT * FROM playbook_revisions
           WHERE playbook_id = ? ORDER BY version DESC`,
        )
        .all(id) as Row[]
    ).map((revision) => {
      const definition = playbookDefinitionSchema.parse(
        safeJsonParse(revision.definition_json, {}),
      );
      if (digestJson(definition) !== text(revision.digest)) {
        throw new Error(
          `Playbook ${id} revision ${Number(revision.version)} failed digest verification.`,
        );
      }
      return {
        id: text(revision.id),
        playbookId: id,
        version: Number(revision.version),
        definition,
        digest: text(revision.digest),
        author: text(revision.author),
        summary: text(revision.summary),
        createdAt: text(revision.created_at),
      };
    });
  }

  reviewPacket(input: {
    playbookId?: string;
    builtinRef?: string;
    goalId: string;
  }): {
    goal: GoalRecord;
    definition: PlaybookDefinition;
    digest: string;
    source: PlaybookSource;
    limits: PlaybookLimits;
    summary: string;
  } {
    const goal = this.getGoal(input.goalId);
    const persisted = input.builtinRef
      ? undefined
      : this.getPlaybook(input.playbookId!);
    if (persisted?.goalId && persisted.goalId !== goal.id) {
      throw new Error("Playbook is bound to a different goal.");
    }
    const playbook = input.builtinRef
      ? getBuiltinPlaybook(input.builtinRef)
      : persisted!.currentRevision.definition;
    const digest = digestJson(playbook);
    return {
      goal,
      definition: playbook,
      digest,
      source: input.builtinRef ? "builtin" : persisted!.source,
      limits: playbook.limits,
      summary: `${playbook.title}: ${playbook.waves.length} waves, ${playbook.waves.reduce(
        (sum, wave) => sum + wave.steps.length,
        0,
      )} steps, difficulty ${playbook.difficulty}.`,
    };
  }

  approvePlaybook(input: {
    playbookId: string;
    expectedVersion: number;
    expectedDigest: string;
    goalId: string;
    expectedGoalVersion: number;
    expectedGoalDigest: string;
    method: PlaybookApproval["method"];
    expiresAt?: string;
    singleUse?: boolean;
  }): PlaybookApproval {
    const playbook = this.getPlaybook(input.playbookId);
    if (
      playbook.version !== input.expectedVersion ||
      playbook.digest !== input.expectedDigest
    ) {
      throw new Error("Approval digest or revision mismatch.");
    }
    const goal = this.getGoal(input.goalId);
    if (playbook.goalId && playbook.goalId !== goal.id) {
      throw new Error("Playbook is bound to a different goal.");
    }
    if (
      goal.version !== input.expectedGoalVersion ||
      goalDigest(goal) !== input.expectedGoalDigest
    ) {
      throw new Error("Approval goal digest or revision mismatch.");
    }
    if (!["candidate", "review_ready", "approved"].includes(playbook.status)) {
      throw new Error("Playbook cannot be approved from its current state.");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO playbook_approvals
           (id, origin, playbook_id, revision_version, digest,
            goal_id, goal_version, goal_digest, status, method,
            single_use, expires_at, approved_at, consumed_at, revoked_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, NULL, NULL, ?)`,
        )
        .run(
          id,
          this.origin,
          playbook.id,
          playbook.version,
          playbook.digest,
          goal.id,
          goal.version,
          input.expectedGoalDigest,
          input.method,
          input.singleUse === false ? 0 : 1,
          input.expiresAt ?? null,
          now,
          now,
        );
      const approved = this.db
        .prepare(
          `UPDATE playbooks SET status = 'approved', updated_at = ?
           WHERE id = ? AND origin = ? AND version = ? AND digest = ?
             AND status IN ('review_ready', 'approved')`,
        )
        .run(now, playbook.id, this.origin, playbook.version, playbook.digest);
      if (approved.changes !== 1) {
        throw new Error("Playbook approval status changed concurrently.");
      }
      this.appendAuditInternal({
        entityType: "approval",
        entityId: id,
        event: "approval_granted",
        fromStatus: "pending",
        toStatus: "approved",
        data: {
          playbookId: playbook.id,
          playbookVersion: playbook.version,
          playbookDigest: playbook.digest,
          goalId: goal.id,
          goalVersion: goal.version,
          goalDigest: input.expectedGoalDigest,
          method: input.method,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getApproval(id);
  }

  getApproval(id: string): PlaybookApproval {
    const row = this.db
      .prepare("SELECT * FROM playbook_approvals WHERE id = ? AND origin = ?")
      .get(id, this.origin) as Row | undefined;
    if (!row) throw new Error(`Unknown playbook approval: ${id}`);
    return {
      id,
      origin: this.origin,
      playbookId: text(row.playbook_id),
      revisionVersion: Number(row.revision_version),
      digest: text(row.digest),
      goalId: text(row.goal_id),
      goalVersion: Number(row.goal_version),
      goalDigest: text(row.goal_digest),
      status: text(row.status) as PlaybookApprovalStatus,
      method: text(row.method) as PlaybookApproval["method"],
      singleUse: Boolean(row.single_use),
      expiresAt: nullable(row.expires_at),
      approvedAt: nullable(row.approved_at),
      consumedAt: nullable(row.consumed_at),
      revokedAt: nullable(row.revoked_at),
      createdAt: text(row.created_at),
    };
  }

  listApprovals(playbookId?: string, limit = 100): PlaybookApproval[] {
    const rows = playbookId
      ? (this.db
          .prepare(
            `SELECT id FROM playbook_approvals
             WHERE origin = ? AND playbook_id = ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(
            this.origin,
            playbookId,
            Math.min(Math.max(limit, 1), 1_000),
          ) as Row[])
      : (this.db
          .prepare(
            `SELECT id FROM playbook_approvals
             WHERE origin = ? ORDER BY created_at DESC LIMIT ?`,
          )
          .all(this.origin, Math.min(Math.max(limit, 1), 1_000)) as Row[]);
    return rows.map((row) => this.getApproval(text(row.id)));
  }

  revokeApproval(id: string): PlaybookApproval {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `UPDATE playbook_approvals SET status = 'revoked', revoked_at = ?
           WHERE id = ? AND origin = ? AND status = 'approved'`,
        )
        .run(new Date().toISOString(), id, this.origin);
      if (result.changes !== 1) {
        throw new Error("Only active approvals can be revoked.");
      }
      this.appendAuditInternal({
        entityType: "approval",
        entityId: id,
        event: "approval_revoked",
        fromStatus: "approved",
        toStatus: "revoked",
        data: {},
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getApproval(id);
  }

  consumeApproval(
    id: string,
    playbookId: string,
    version: number,
    digest: string,
    goalId: string,
    goalVersion: number,
    boundGoalDigest: string,
  ): PlaybookApproval {
    const approval = this.getApproval(id);
    if (
      approval.playbookId !== playbookId ||
      approval.revisionVersion !== version ||
      approval.digest !== digest ||
      approval.goalId !== goalId ||
      approval.goalVersion !== goalVersion ||
      approval.goalDigest !== boundGoalDigest
    ) {
      throw new Error("Approval is not bound to this playbook manifest.");
    }
    if (approval.status !== "approved") throw new Error("Approval is not active.");
    if (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now()) {
      this.db
        .prepare(
          "UPDATE playbook_approvals SET status = 'expired' WHERE id = ? AND origin = ?",
        )
        .run(id, this.origin);
      throw new Error("Approval has expired.");
    }
    if (approval.singleUse) {
      const result = this.db
        .prepare(
          `UPDATE playbook_approvals SET status = 'consumed', consumed_at = ?
           WHERE id = ? AND origin = ? AND status = 'approved'`,
        )
        .run(new Date().toISOString(), id, this.origin);
      if (result.changes !== 1) throw new Error("Approval was consumed concurrently.");
      this.appendAuditInternal({
        entityType: "approval",
        entityId: id,
        event: "approval_consumed",
        fromStatus: "approved",
        toStatus: "consumed",
        data: { playbookId, goalId },
      });
    }
    return this.getApproval(id);
  }

  createSynthesis(goalId: string): PlaybookSynthesis {
    const goal = this.getGoal(goalId);
    if (goal.status !== "submitted") throw new Error("Goal must be submitted before synthesis.");
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO playbook_syntheses
           (id, origin, goal_id, goal_version, status, phase,
            candidate_task_ids_json, critic_task_ids_json, reconciler_task_id,
            candidates_json, critiques_json, playbook_id, error, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'created', 'candidates', '[]', '[]', NULL, '[]', '[]',
                   NULL, NULL, ?, ?)`,
        )
        .run(id, this.origin, goal.id, goal.version, now, now);
      this.appendAuditInternal({
        entityType: "synthesis",
        entityId: id,
        event: "synthesis_created",
        fromStatus: null,
        toStatus: "created",
        data: { goalId: goal.id, goalVersion: goal.version },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getSynthesis(id);
  }

  updateSynthesis(
    id: string,
    patch: Partial<{
      status: PlaybookSynthesisStatus;
      phase: string;
      candidateTaskIds: string[];
      criticTaskIds: string[];
      reconcilerTaskId: string | null;
      candidates: string[];
      critiques: string[];
      playbookId: string | null;
      error: string | null;
    }>,
    expectedVersion?: number,
  ): PlaybookSynthesis {
    const current = this.getSynthesis(id);
    if (
      expectedVersion !== undefined &&
      current.version !== expectedVersion
    ) {
      throw new Error("Synthesis version conflict.");
    }
    const next = {
      status: patch.status ?? current.status,
      phase: patch.phase ?? current.phase,
      candidateTaskIds: patch.candidateTaskIds ?? current.candidateTaskIds,
      criticTaskIds: patch.criticTaskIds ?? current.criticTaskIds,
      reconcilerTaskId:
        patch.reconcilerTaskId === undefined
          ? current.reconcilerTaskId
          : patch.reconcilerTaskId,
      candidates: patch.candidates ?? current.candidates,
      critiques: patch.critiques ?? current.critiques,
      playbookId:
        patch.playbookId === undefined ? current.playbookId : patch.playbookId,
      error: patch.error === undefined ? current.error : patch.error,
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db
        .prepare(
          `UPDATE playbook_syntheses SET status = ?, phase = ?,
           version = version + 1,
           candidate_task_ids_json = ?, critic_task_ids_json = ?,
           reconciler_task_id = ?, candidates_json = ?, critiques_json = ?,
           playbook_id = ?, error = ?, updated_at = ?
           WHERE id = ? AND origin = ? AND version = ?`,
        )
        .run(
          next.status,
          next.phase,
          JSON.stringify(next.candidateTaskIds),
          JSON.stringify(next.criticTaskIds),
          next.reconcilerTaskId,
          JSON.stringify(next.candidates),
          JSON.stringify(next.critiques),
          next.playbookId,
          next.error ? redactSecrets(next.error).slice(0, 4_000) : null,
          new Date().toISOString(),
          id,
          this.origin,
          current.version,
        );
      if (changed.changes !== 1) {
        throw new Error("Synthesis changed concurrently.");
      }
      this.appendAuditInternal({
        entityType: "synthesis",
        entityId: id,
        event: "synthesis_transition",
        fromStatus: current.status,
        toStatus: next.status,
        data: {
          fromPhase: current.phase,
          toPhase: next.phase,
          version: current.version + 1,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getSynthesis(id);
  }

  getSynthesis(id: string): PlaybookSynthesis {
    const row = this.db
      .prepare("SELECT * FROM playbook_syntheses WHERE id = ? AND origin = ?")
      .get(id, this.origin) as Row | undefined;
    if (!row) throw new Error(`Unknown playbook synthesis: ${id}`);
    return {
      id,
      origin: this.origin,
      version: Number(row.version),
      goalId: text(row.goal_id),
      goalVersion: Number(row.goal_version),
      status: text(row.status) as PlaybookSynthesisStatus,
      phase: text(row.phase),
      candidateTaskIds: safeJsonParse<string[]>(row.candidate_task_ids_json, []),
      criticTaskIds: safeJsonParse<string[]>(row.critic_task_ids_json, []),
      reconcilerTaskId: nullable(row.reconciler_task_id),
      candidates: safeJsonParse<string[]>(row.candidates_json, []),
      critiques: safeJsonParse<string[]>(row.critiques_json, []),
      playbookId: nullable(row.playbook_id),
      error: nullable(row.error),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
    };
  }

  createRun(input: {
    manifest: ExecutionManifest;
    approvalId?: string;
    trustedBuiltin: boolean;
    autoStart?: boolean;
    idempotencyRequest?: unknown;
    idempotencyKey: string;
  }): PlaybookRun {
    const manifestDigest = digestJson(input.manifest);
    const reservation = this.reserveIdempotency<PlaybookRun>(
      "playbook_run_start",
      input.idempotencyKey,
      input.idempotencyRequest ?? {
        manifestDigest,
        approvalId: input.approvalId ?? null,
        trustedBuiltin: input.trustedBuiltin,
        autoStart: Boolean(input.autoStart),
      },
    );
    if (!reservation.reserved) return reservation.result;
    if (!input.trustedBuiltin && input.approvalId) {
      const approval = this.getApproval(input.approvalId);
      if (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now()) {
        this.db
          .prepare(
            `UPDATE playbook_approvals SET status = 'expired'
             WHERE id = ? AND origin = ? AND status = 'approved'`,
          )
          .run(input.approvalId, this.origin);
        this.releaseIdempotency(
          "playbook_run_start",
          input.idempotencyKey,
        );
        throw new Error("Approval has expired.");
      }
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!input.trustedBuiltin) {
        if (!input.approvalId) throw new Error("Custom playbook runs require approval.");
        this.consumeApproval(
          input.approvalId,
          input.manifest.playbookId,
          input.manifest.playbookVersion,
          input.manifest.playbookDigest,
          input.manifest.goalId,
          input.manifest.goalVersion,
          input.manifest.goalDigest,
        );
      }
      this.db
        .prepare(
          `INSERT INTO playbook_runs
           (id, origin, goal_id, goal_version, playbook_id, playbook_version,
            digest, status, manifest_json, approval_id, swarm_id, initiative_id,
            plan_id, tasks_started, attempts_used, created_at, updated_at,
            started_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, NULL, NULL, NULL, 0, 0,
                   ?, ?, NULL, NULL)`,
        )
        .run(
          id,
          this.origin,
          input.manifest.goalId,
          input.manifest.goalVersion,
          input.manifest.playbookId,
          input.manifest.playbookVersion,
          manifestDigest,
          canonicalizeJson(input.manifest),
          input.approvalId ?? null,
          now,
          now,
        );
      input.manifest.waves.forEach((wave, waveIndex) => {
        this.db
          .prepare(
            `INSERT INTO playbook_run_waves
             (id, run_id, wave_id, ordinal, status, completion, gate_json,
              depends_on_json, attempt, lease_owner_pid, lease_generation,
              started_at, completed_at)
             VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, 0, NULL, 0, NULL, NULL)`,
          )
          .run(
            randomUUID(),
            id,
            wave.id,
            waveIndex,
            wave.completion,
            JSON.stringify(wave.gate),
            JSON.stringify(wave.dependsOn),
          );
        wave.steps.forEach((runStep, stepIndex) => {
          this.db
            .prepare(
              `INSERT INTO playbook_run_steps
               (id, run_id, wave_id, step_id, ordinal, status, provider, model,
                effort, mode, mcp_profile, prompt, condition, required_report,
                member_id, task_id, attempt, report_json, error, updated_at)
               VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?,
                       NULL, NULL, 0, NULL, NULL, ?)`,
            )
            .run(
              randomUUID(),
              id,
              wave.id,
              runStep.id,
              stepIndex,
              runStep.provider,
              runStep.model,
              runStep.effort,
              runStep.taskMode,
              runStep.capabilityProfile,
              redactSecrets(runStep.prompt).slice(0, input.manifest.limits.maxPromptBytes),
              runStep.condition,
              runStep.requiredReport ? 1 : 0,
              now,
            );
        });
      });
      this.appendAuditInternal({
        runId: id,
        entityType: "run",
        entityId: id,
        event: "run_created",
        fromStatus: null,
        toStatus: "created",
        data: { manifestDigest, trustedBuiltin: input.trustedBuiltin },
      });
      const run = this.getRun(id);
      this.completeIdempotency(
        "playbook_run_start",
        input.idempotencyKey,
        run,
      );
      this.db.exec("COMMIT");
      return run;
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.releaseIdempotency(
        "playbook_run_start",
        input.idempotencyKey,
      );
      throw error;
    }
  }

  claimRunProvisioning(
    id: string,
    expectedVersion: number,
    ownerPid = process.pid,
  ): PlaybookRun {
    const row = this.db
      .prepare(
        `SELECT provisioning_owner_pid FROM playbook_runs
         WHERE id = ? AND origin = ?`,
      )
      .get(id, this.origin) as Row | undefined;
    if (!row) throw new Error(`Unknown playbook run: ${id}`);
    const currentOwner = row.provisioning_owner_pid
      ? Number(row.provisioning_owner_pid)
      : null;
    if (currentOwner && isProcessAlive(currentOwner)) {
      throw new Error("Run resource provisioning is already active.");
    }
    const changed = this.db
      .prepare(
        `UPDATE playbook_runs SET provisioning_owner_pid = ?,
         version = version + 1, updated_at = ?
         WHERE id = ? AND origin = ? AND version = ?
           AND status IN ('created', 'preflighting')`,
      )
      .run(
        ownerPid,
        new Date().toISOString(),
        id,
        this.origin,
        expectedVersion,
      );
    if (changed.changes !== 1) {
      throw new Error("Run provisioning claim version conflict.");
    }
    return this.getRun(id);
  }

  releaseRunProvisioning(id: string, ownerPid = process.pid): void {
    this.db
      .prepare(
        `UPDATE playbook_runs SET provisioning_owner_pid = NULL, updated_at = ?
         WHERE id = ? AND origin = ? AND provisioning_owner_pid = ?`,
      )
      .run(new Date().toISOString(), id, this.origin, ownerPid);
  }

  linkRunResources(
    id: string,
    input: {
      swarmId: string;
      initiativeId?: string;
      planId?: string;
      expectedVersion?: number;
    },
  ): PlaybookRun {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `UPDATE playbook_runs SET swarm_id = ?, initiative_id = ?, plan_id = ?,
           status = 'ready', provisioning_owner_pid = NULL,
           version = version + 1, updated_at = ?
           WHERE id = ? AND origin = ? AND status IN ('created', 'preflighting')
             AND (? IS NULL OR version = ?)`,
        )
        .run(
          input.swarmId,
          input.initiativeId ?? null,
          input.planId ?? null,
          new Date().toISOString(),
          id,
          this.origin,
          input.expectedVersion ?? null,
          input.expectedVersion ?? null,
        );
      if (result.changes !== 1) throw new Error("Run resources cannot be linked.");
      this.appendAuditInternal({
        runId: id,
        entityType: "run",
        entityId: id,
        event: "resources_linked",
        fromStatus: "created",
        toStatus: "ready",
        data: input,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getRun(id);
  }

  stageRunResources(
    id: string,
    input: {
      swarmId?: string;
      initiativeId?: string;
      expectedVersion?: number;
    },
  ): PlaybookRun {
    const run = this.getRun(id);
    if (!["created", "preflighting"].includes(run.status)) {
      throw new Error("Run resources can only be staged before readiness.");
    }
    if (
      (run.swarmId && input.swarmId && run.swarmId !== input.swarmId) ||
      (run.initiativeId &&
        input.initiativeId &&
        run.initiativeId !== input.initiativeId)
    ) {
      throw new Error("Run resource staging conflict.");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db
        .prepare(
          `UPDATE playbook_runs SET swarm_id = COALESCE(swarm_id, ?),
           initiative_id = COALESCE(initiative_id, ?),
           version = version + 1, updated_at = ?
           WHERE id = ? AND origin = ? AND status IN ('created', 'preflighting')
             AND (? IS NULL OR version = ?)`,
        )
        .run(
          input.swarmId ?? null,
          input.initiativeId ?? null,
          new Date().toISOString(),
          id,
          this.origin,
          input.expectedVersion ?? null,
          input.expectedVersion ?? null,
        );
      if (changed.changes !== 1) {
        throw new Error("Run resource staging version conflict.");
      }
      this.appendAuditInternal({
        runId: id,
        entityType: "run",
        entityId: id,
        event: "resources_staged",
        fromStatus: run.status,
        toStatus: run.status,
        data: input,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getRun(id);
  }

  transitionRun(
    id: string,
    from: PlaybookRunStatus[],
    to: PlaybookRunStatus,
    data: unknown = {},
  ): PlaybookRun {
    const now = new Date().toISOString();
    const placeholders = from.map(() => "?").join(",");
    const terminal = ["completed", "failed", "cancelled"].includes(to);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `UPDATE playbook_runs SET status = ?, version = version + 1, updated_at = ?,
           started_at = CASE WHEN started_at IS NULL AND ? = 'running' THEN ? ELSE started_at END,
           completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END
           WHERE id = ? AND origin = ? AND status IN (${placeholders})`,
        )
        .run(to, now, to, now, terminal ? 1 : 0, now, id, this.origin, ...from);
      if (result.changes !== 1) throw new Error(`Run cannot transition to ${to}.`);
      this.appendAuditInternal({
        runId: id,
        entityType: "run",
        entityId: id,
        event: "run_transition",
        fromStatus: from.join("|"),
        toStatus: to,
        data,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getRun(id);
  }

  amendRunLimits(
    id: string,
    expectedVersion: number,
    limits: PlaybookLimits,
  ): PlaybookRun {
    const run = this.getRun(id);
    if (run.version !== expectedVersion) throw new Error("Run version conflict.");
    if (!["paused_budget", "blocked_provider", "needs_attention"].includes(run.status)) {
      throw new Error("Only a paused or blocked run can amend limits.");
    }
    const nextLimits = playbookLimitsSchema.parse(limits);
    for (const key of Object.keys(run.manifest.limits) as Array<keyof PlaybookLimits>) {
      if (nextLimits[key] < run.manifest.limits[key]) {
        throw new Error("Run amendments cannot reduce an already-approved limit.");
      }
    }
    const manifest = structuredClone(run.manifest);
    manifest.limits = nextLimits;
    const nextDigest = digestJson(manifest);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db
        .prepare(
          `UPDATE playbook_runs SET manifest_json = ?, digest = ?,
           version = version + 1, status = 'ready', updated_at = ?
           WHERE id = ? AND origin = ? AND version = ?`,
        )
        .run(
          canonicalizeJson(manifest),
          nextDigest,
          new Date().toISOString(),
          id,
          this.origin,
          expectedVersion,
        );
      if (changed.changes !== 1) throw new Error("Run changed concurrently.");
      this.appendAuditInternal({
        runId: id,
        entityType: "run",
        entityId: id,
        event: "run_limits_amended",
        fromStatus: run.status,
        toStatus: "ready",
        data: {
          oldDigest: run.digest,
          newDigest: nextDigest,
          oldLimits: run.manifest.limits,
          newLimits: nextLimits,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getRun(id);
  }

  recoverRunLeases(runId: string): PlaybookRun {
    const rows = this.db
      .prepare(
        `SELECT wave_id, status, lease_owner_pid FROM playbook_run_waves
         WHERE run_id = ? AND status IN ('reserving', 'dispatching')`,
      )
      .all(runId) as Row[];
    for (const row of rows) {
      const ownerPid = row.lease_owner_pid
        ? Number(row.lease_owner_pid)
        : null;
      if (ownerPid && isProcessAlive(ownerPid)) continue;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const changed = this.db
          .prepare(
            `UPDATE playbook_run_waves SET status = 'blocked',
             lease_owner_pid = NULL, completed_at = NULL
             WHERE run_id = ? AND wave_id = ?
               AND status IN ('reserving', 'dispatching')`,
          )
          .run(runId, text(row.wave_id));
        if (changed.changes === 1) {
          this.db
            .prepare(
              "UPDATE playbook_runs SET version = version + 1, status = 'reconciling', updated_at = ? WHERE id = ?",
            )
            .run(new Date().toISOString(), runId);
          this.appendAuditInternal({
            runId,
            entityType: "wave",
            entityId: text(row.wave_id),
            event: "wave_lease_recovered",
            fromStatus: text(row.status),
            toStatus: "blocked",
            data: { ownerPid },
          });
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    return this.getRun(runId);
  }

  claimWave(runId: string, waveId: string, ownerPid = process.pid): PlaybookRunWave {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `UPDATE playbook_run_waves SET status = 'reserving', lease_owner_pid = ?,
           lease_generation = lease_generation + 1, attempt = attempt + 1,
           started_at = COALESCE(started_at, ?)
           WHERE run_id = ? AND wave_id = ? AND status IN ('pending', 'eligible', 'blocked')`,
        )
        .run(ownerPid, new Date().toISOString(), runId, waveId);
      if (result.changes !== 1) throw new Error("Wave is not claimable.");
      this.db
        .prepare(
          "UPDATE playbook_runs SET version = version + 1, updated_at = ? WHERE id = ?",
        )
        .run(new Date().toISOString(), runId);
      this.appendAuditInternal({
        runId,
        entityType: "wave",
        entityId: waveId,
        event: "wave_claimed",
        fromStatus: "pending|eligible|blocked",
        toStatus: "reserving",
        data: { ownerPid },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getRun(runId).waves.find((wave) => wave.waveId === waveId)!;
  }

  transitionWave(
    runId: string,
    waveId: string,
    from: PlaybookWaveStatus[],
    to: PlaybookWaveStatus,
  ): PlaybookRunWave {
    const placeholders = from.map(() => "?").join(",");
    const terminal = ["passed", "failed", "blocked", "skipped"].includes(to);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `UPDATE playbook_run_waves SET status = ?,
           lease_owner_pid = CASE WHEN ? = 1 THEN NULL ELSE lease_owner_pid END,
           completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END
           WHERE run_id = ? AND wave_id = ? AND status IN (${placeholders})`,
        )
        .run(
          to,
          terminal ? 1 : 0,
          terminal ? 1 : 0,
          new Date().toISOString(),
          runId,
          waveId,
          ...from,
        );
      if (result.changes !== 1) throw new Error(`Wave ${waveId} cannot transition to ${to}.`);
      this.db
        .prepare(
          "UPDATE playbook_runs SET version = version + 1, updated_at = ? WHERE id = ?",
        )
        .run(new Date().toISOString(), runId);
      this.appendAuditInternal({
        runId,
        entityType: "wave",
        entityId: waveId,
        event: "wave_transition",
        fromStatus: from.join("|"),
        toStatus: to,
        data: {},
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getRun(runId).waves.find((wave) => wave.waveId === waveId)!;
  }

  reserveStep(
    runId: string,
    stepId: string,
    input: { memberId: string; taskId: string },
  ): PlaybookRunStep {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `UPDATE playbook_run_steps SET status = 'queued', member_id = ?, task_id = ?,
           attempt = attempt + 1, report_json = NULL, error = NULL, updated_at = ?
           WHERE run_id = ? AND step_id = ?
             AND status IN ('pending', 'failed', 'interrupted', 'cancelled')`,
        )
        .run(
          input.memberId,
          input.taskId,
          new Date().toISOString(),
          runId,
          stepId,
        );
      if (result.changes !== 1) throw new Error(`Step ${stepId} is not reservable.`);
      this.db
        .prepare(
          `UPDATE playbook_runs SET tasks_started = tasks_started + 1,
           attempts_used = attempts_used + 1, version = version + 1,
           updated_at = ? WHERE id = ? AND origin = ?`,
        )
        .run(new Date().toISOString(), runId, this.origin);
      this.appendAuditInternal({
        runId,
        entityType: "step",
        entityId: stepId,
        event: "step_reserved",
        fromStatus: "pending|failed|interrupted|cancelled",
        toStatus: "queued",
        data: input,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getRun(runId).waves.flatMap((wave) => wave.steps).find((step) => step.stepId === stepId)!;
  }

  failStepAttempt(
    runId: string,
    stepId: string,
    error: string,
  ): PlaybookRunStep {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db
        .prepare(
          `UPDATE playbook_run_steps SET status = 'failed', attempt = attempt + 1,
           error = ?, updated_at = ?
           WHERE run_id = ? AND step_id = ?
             AND status IN ('pending', 'failed', 'interrupted', 'cancelled')`,
        )
        .run(
          redactSecrets(error).slice(0, 4_000),
          new Date().toISOString(),
          runId,
          stepId,
        );
      if (changed.changes !== 1) {
        throw new Error(`Step ${stepId} cannot record a failed attempt.`);
      }
      this.db
        .prepare(
          `UPDATE playbook_runs SET attempts_used = attempts_used + 1,
           version = version + 1, updated_at = ? WHERE id = ? AND origin = ?`,
        )
        .run(new Date().toISOString(), runId, this.origin);
      this.appendAuditInternal({
        runId,
        entityType: "step",
        entityId: stepId,
        event: "step_attempt_failed_before_launch",
        fromStatus: "pending|failed|interrupted|cancelled",
        toStatus: "failed",
        data: { error: redactSecrets(error).slice(0, 4_000) },
      });
      this.db.exec("COMMIT");
    } catch (transactionError) {
      this.db.exec("ROLLBACK");
      throw transactionError;
    }
    return this.getRun(runId).waves
      .flatMap((wave) => wave.steps)
      .find((step) => step.stepId === stepId)!;
  }

  transferStepTask(
    runId: string,
    stepId: string,
    fromTaskId: string,
    toTaskId: string,
  ): PlaybookRunStep {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `UPDATE playbook_run_steps SET task_id = ?, status = 'running', updated_at = ?
           WHERE run_id = ? AND step_id = ? AND task_id = ?`,
        )
        .run(
          toTaskId,
          new Date().toISOString(),
          runId,
          stepId,
          fromTaskId,
        );
      if (result.changes !== 1) {
        throw new Error("Playbook step task transfer failed.");
      }
      this.db
        .prepare(
          "UPDATE playbook_runs SET version = version + 1, updated_at = ? WHERE id = ?",
        )
        .run(new Date().toISOString(), runId);
      this.appendAuditInternal({
        runId,
        entityType: "step",
        entityId: stepId,
        event: "step_task_transferred",
        fromStatus: "waiting_for_input",
        toStatus: "running",
        data: { fromTaskId, toTaskId },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getRun(runId).waves
      .flatMap((wave) => wave.steps)
      .find((step) => step.stepId === stepId)!;
  }

  updateStepStatus(
    runId: string,
    stepId: string,
    status: PlaybookStepStatus,
    error?: string,
  ): PlaybookRunStep {
    const current = this.getRun(runId).waves
      .flatMap((wave) => wave.steps)
      .find((step) => step.stepId === stepId);
    if (!current) throw new Error(`Unknown run step: ${stepId}`);
    const normalizedError = error
      ? redactSecrets(error).slice(0, 4_000)
      : null;
    if (current.status === status && (current.error ?? null) === normalizedError) {
      return current;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `UPDATE playbook_run_steps SET status = ?, error = ?, updated_at = ?
           WHERE run_id = ? AND step_id = ? AND status = ?`,
        )
        .run(
          status,
          normalizedError,
          new Date().toISOString(),
          runId,
          stepId,
          current.status,
        );
      if (result.changes !== 1) throw new Error(`Step ${stepId} changed concurrently.`);
      this.db
        .prepare(
          "UPDATE playbook_runs SET version = version + 1, updated_at = ? WHERE id = ?",
        )
        .run(new Date().toISOString(), runId);
      this.appendAuditInternal({
        runId,
        entityType: "step",
        entityId: stepId,
        event: "step_transition",
        fromStatus: current.status,
        toStatus: status,
        data: { error: normalizedError },
      });
      this.db.exec("COMMIT");
    } catch (transactionError) {
      this.db.exec("ROLLBACK");
      throw transactionError;
    }
    return this.getRun(runId).waves.flatMap((wave) => wave.steps).find((step) => step.stepId === stepId)!;
  }

  submitStepReportByMember(
    swarmId: string,
    memberId: string,
    report: PlaybookStepReport,
  ): PlaybookRunStep {
    const runRow = this.db
      .prepare(
        `SELECT id FROM playbook_runs WHERE swarm_id = ? AND origin = ?
         AND status IN ('ready', 'running', 'waiting_for_input', 'reconciling',
                        'blocked_provider', 'paused_budget', 'needs_attention')`,
      )
      .get(swarmId, this.origin) as Row | undefined;
    if (!runRow) throw new Error("Coordination swarm is not linked to an active playbook run.");
    const runId = text(runRow.id);
    const parsed = parseStepReport(report);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `UPDATE playbook_run_steps SET report_json = ?, updated_at = ?
           WHERE run_id = ? AND member_id = ? AND report_json IS NULL
             AND status IN ('queued', 'running', 'waiting_for_input', 'completed', 'failed')
             AND EXISTS (
               SELECT 1 FROM playbook_run_waves w
               WHERE w.run_id = playbook_run_steps.run_id
                 AND w.wave_id = playbook_run_steps.wave_id
                 AND w.status IN ('dispatching', 'running', 'collecting', 'blocked')
             )`,
        )
        .run(
          canonicalizeJson(parsed),
          new Date().toISOString(),
          runId,
          memberId,
        );
      if (result.changes !== 1) {
        throw new Error("No active unreported playbook step belongs to this member.");
      }
      this.db
        .prepare(
          "UPDATE playbook_runs SET version = version + 1, updated_at = ? WHERE id = ?",
        )
        .run(new Date().toISOString(), runId);
      const step = this.getRun(runId).waves
        .flatMap((wave) => wave.steps)
        .find((candidate) => candidate.memberId === memberId)!;
      this.appendAuditInternal({
        runId,
        entityType: "step",
        entityId: step.stepId,
        event: "step_report_submitted",
        fromStatus: step.status,
        toStatus: step.status,
        data: {
          outcome: parsed.outcome,
          reportDigest: digestJson(parsed),
          findingCount: parsed.findings.length,
          testCount: parsed.tests.length,
        },
      });
      this.db.exec("COMMIT");
      return step;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getRun(id: string): PlaybookRun {
    const row = this.db
      .prepare("SELECT * FROM playbook_runs WHERE id = ? AND origin = ?")
      .get(id, this.origin) as Row | undefined;
    if (!row) throw new Error(`Unknown playbook run: ${id}`);
    const manifest = safeJsonParse<ExecutionManifest>(row.manifest_json, {} as ExecutionManifest);
    if (digestJson(manifest) !== text(row.digest)) {
      throw new Error(`Playbook run ${id} failed manifest digest verification.`);
    }
    const waveRows = this.db
      .prepare("SELECT * FROM playbook_run_waves WHERE run_id = ? ORDER BY ordinal")
      .all(id) as Row[];
    const stepRows = this.db
      .prepare("SELECT * FROM playbook_run_steps WHERE run_id = ? ORDER BY wave_id, ordinal")
      .all(id) as Row[];
    const waves = waveRows.map((wave): PlaybookRunWave => ({
      id: text(wave.id),
      runId: id,
      waveId: text(wave.wave_id),
      ordinal: Number(wave.ordinal),
      status: text(wave.status) as PlaybookWaveStatus,
      completion: text(wave.completion) as PlaybookWave["completion"],
      gate: safeJsonParse<PlaybookWave["gate"]>(wave.gate_json, { type: "all_succeeded" }),
      dependsOn: safeJsonParse<string[]>(wave.depends_on_json, []),
      attempt: Number(wave.attempt),
      leaseOwnerPid: wave.lease_owner_pid ? Number(wave.lease_owner_pid) : null,
      leaseGeneration: Number(wave.lease_generation),
      startedAt: nullable(wave.started_at),
      completedAt: nullable(wave.completed_at),
      steps: stepRows
        .filter((stepRow) => text(stepRow.wave_id) === text(wave.wave_id))
        .map((stepRow): PlaybookRunStep => ({
          id: text(stepRow.id),
          runId: id,
          waveId: text(stepRow.wave_id),
          stepId: text(stepRow.step_id),
          ordinal: Number(stepRow.ordinal),
          status: text(stepRow.status) as PlaybookStepStatus,
          provider: text(stepRow.provider) as Provider,
          model: text(stepRow.model),
          effort: text(stepRow.effort),
          mode: text(stepRow.mode) as TaskMode,
          mcpProfile: text(stepRow.mcp_profile) as McpProfile,
          prompt: text(stepRow.prompt),
          condition: text(stepRow.condition) as PlaybookStep["condition"],
          requiredReport: Boolean(stepRow.required_report),
          memberId: nullable(stepRow.member_id),
          taskId: nullable(stepRow.task_id),
          attempt: Number(stepRow.attempt),
          report: stepRow.report_json
            ? safeJsonParse<PlaybookStepReport>(stepRow.report_json, null as never)
            : null,
          error: nullable(stepRow.error),
          updatedAt: text(stepRow.updated_at),
        })),
    }));
    return {
      id,
      origin: this.origin,
      version: Number(row.version),
      goalId: text(row.goal_id),
      goalVersion: Number(row.goal_version),
      playbookId: text(row.playbook_id),
      playbookVersion: Number(row.playbook_version),
      digest: text(row.digest),
      status: text(row.status) as PlaybookRunStatus,
      manifest,
      approvalId: nullable(row.approval_id),
      swarmId: nullable(row.swarm_id),
      initiativeId: nullable(row.initiative_id),
      planId: nullable(row.plan_id),
      tasksStarted: Number(row.tasks_started),
      attemptsUsed: Number(row.attempts_used),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
      startedAt: nullable(row.started_at),
      completedAt: nullable(row.completed_at),
      waves,
    };
  }

  listRuns(limit = 100): PlaybookRun[] {
    return (
      this.db
        .prepare("SELECT id FROM playbook_runs WHERE origin = ? ORDER BY updated_at DESC LIMIT ?")
        .all(this.origin, Math.min(Math.max(limit, 1), 1_000)) as Row[]
    ).map((row) => this.getRun(text(row.id)));
  }

  findRunBySwarm(swarmId: string): PlaybookRun | undefined {
    const row = this.db
      .prepare("SELECT id FROM playbook_runs WHERE swarm_id = ? AND origin = ?")
      .get(swarmId, this.origin) as Row | undefined;
    return row ? this.getRun(text(row.id)) : undefined;
  }

  priorReportsForMember(
    swarmId: string,
    memberId: string,
  ): Array<{
    stepId: string;
    outcome: PlaybookStepReport["outcome"];
    summary: string;
    findings: PlaybookStepReport["findings"];
    tests: PlaybookStepReport["tests"];
    artifacts: PlaybookStepReport["artifacts"];
  }> {
    const run = this.findRunBySwarm(swarmId);
    if (!run) throw new Error("Swarm is not linked to a playbook run.");
    const current = run.waves
      .flatMap((wave) => wave.steps)
      .find((step) => step.memberId === memberId);
    if (!current) throw new Error("Member is not linked to a playbook step.");
    const wave = run.waves.find(
      (candidate) => candidate.waveId === current.waveId,
    )!;
    const dependencies = new Set(wave.dependsOn);
    return run.waves
      .filter((candidate) => dependencies.has(candidate.waveId))
      .flatMap((candidate) => candidate.steps)
      .filter((step) => step.report)
      .map((step) => ({
        stepId: step.stepId,
        outcome: step.report!.outcome,
        summary: step.report!.summary,
        findings: step.report!.findings,
        tests: step.report!.tests,
        artifacts: step.report!.artifacts,
      }));
  }

  openFindingsForMember(
    swarmId: string,
    memberId: string,
  ): PlaybookStepReport["findings"] {
    const run = this.findRunBySwarm(swarmId);
    if (!run) throw new Error("Swarm is not linked to a playbook run.");
    if (
      !run.waves
        .flatMap((wave) => wave.steps)
        .some((step) => step.memberId === memberId)
    ) {
      throw new Error("Member is not linked to a playbook step.");
    }
    return openFindings(run);
  }

  auditEvents(runId?: string, limit = 1_000): PlaybookAuditEvent[] {
    const rows = runId
      ? (this.db
          .prepare(
            `SELECT * FROM playbook_audit_events WHERE run_id = ? AND origin = ?
             ORDER BY sequence DESC LIMIT ?`,
          )
          .all(
            runId,
            this.origin,
            Math.min(Math.max(limit, 1), 10_000),
          ) as Row[])
      : (this.db
          .prepare(
            `SELECT * FROM playbook_audit_events WHERE origin = ?
             ORDER BY sequence DESC LIMIT ?`,
          )
          .all(
            this.origin,
            Math.min(Math.max(limit, 1), 10_000),
          ) as Row[]);
    return rows.reverse().map((row) => {
      const event: PlaybookAuditEvent = {
        id: text(row.id),
        sequence: Number(row.sequence),
        origin: text(row.origin) as Origin,
        runId: nullable(row.run_id),
        entityType: text(row.entity_type),
        entityId: text(row.entity_id),
        event: text(row.event),
        fromStatus: nullable(row.from_status),
        toStatus: nullable(row.to_status),
        data: safeJsonParse(row.data_json, {}),
        previousHash: nullable(row.previous_hash),
        hash: text(row.hash),
        createdAt: text(row.created_at),
      };
      const predecessor = this.db
        .prepare(
          `SELECT hash FROM playbook_audit_events
           WHERE origin = ? AND sequence < ? ORDER BY sequence DESC LIMIT 1`,
        )
        .get(event.origin, event.sequence) as Row | undefined;
      const expectedPrevious = predecessor ? text(predecessor.hash) : null;
      if (event.previousHash !== expectedPrevious) {
        throw new Error(
          `Playbook audit event ${event.sequence} has a broken predecessor link.`,
        );
      }
      const expected = agentMeshHmac(
        "playbook-audit",
        `${event.previousHash ?? ""}\0${canonicalizeJson({
            sequence: event.sequence,
            origin: event.origin,
            runId: event.runId,
            entityType: event.entityType,
            entityId: event.entityId,
            event: event.event,
            fromStatus: event.fromStatus,
            toStatus: event.toStatus,
            data: event.data,
            previousHash: event.previousHash,
            createdAt: event.createdAt,
          })}`,
      );
      if (expected !== event.hash) {
        throw new Error(`Playbook audit event ${event.sequence} failed hash verification.`);
      }
      return event;
    });
  }

  idempotencyResult<T>(operation: string, key: string): T | undefined {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) {
      throw new Error("Invalid idempotency key.");
    }
    const row = this.db
      .prepare(
        `SELECT result_json FROM playbook_idempotency
         WHERE origin = ? AND operation = ? AND key = ?`,
      )
      .get(this.origin, operation, key) as Row | undefined;
    if (
      !row ||
      text(row.result_json) === "{}" ||
      text(row.result_json) === "__PENDING__"
    ) {
      return undefined;
    }
    return safeJsonParse<T>(row.result_json, undefined as T);
  }

  idempotencyResultForRequest<T>(
    operation: string,
    key: string,
    request: unknown,
  ): T | undefined {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) {
      throw new Error("Invalid idempotency key.");
    }
    const row = this.db
      .prepare(
        `SELECT request_hash, result_json FROM playbook_idempotency
         WHERE origin = ? AND operation = ? AND key = ?`,
      )
      .get(this.origin, operation, key) as Row | undefined;
    if (!row) return undefined;
    if (text(row.request_hash) !== digestJson(request)) {
      throw new Error("Idempotency key was reused with a different request.");
    }
    if (
      text(row.result_json) === "__PENDING__" ||
      text(row.result_json) === "{}"
    ) {
      throw new Error("An operation with this idempotency key is already in progress.");
    }
    return safeJsonParse<T>(row.result_json, undefined as T);
  }

  reserveIdempotency<T>(
    operation: string,
    key: string,
    request: unknown,
  ): { reserved: true } | { reserved: false; result: T } {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) {
      throw new Error("Invalid idempotency key.");
    }
    const requestHash = digestJson(request);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare(
          `SELECT request_hash, result_json, created_at FROM playbook_idempotency
           WHERE origin = ? AND operation = ? AND key = ?`,
        )
        .get(this.origin, operation, key) as Row | undefined;
      if (existing) {
        const storedHash = text(existing.request_hash);
        if (storedHash && storedHash !== requestHash) {
          throw new Error("Idempotency key was reused with a different request.");
        }
        const resultJson = text(existing.result_json);
        if (resultJson === "__PENDING__" || resultJson === "{}") {
          const ttl = Number(
            process.env.AGENT_MESH_IDEMPOTENCY_PENDING_TTL_MS || 10 * 60_000,
          );
          const stale =
            Number.isFinite(ttl) &&
            Date.now() - Date.parse(text(existing.created_at)) > ttl;
          throw new Error(
            stale
              ? "A stale idempotency reservation requires operator reconciliation; automatic replay is refused."
              : "An operation with this idempotency key is already in progress.",
          );
        } else {
          const result = safeJsonParse<T>(resultJson, undefined as T);
          this.db.exec("COMMIT");
          return { reserved: false, result };
        }
      }
      this.db
        .prepare(
          `INSERT INTO playbook_idempotency
           (origin, operation, key, request_hash, result_json, created_at)
           VALUES (?, ?, ?, ?, '__PENDING__', ?)`,
        )
        .run(
          this.origin,
          operation,
          key,
          requestHash,
          new Date().toISOString(),
        );
      this.db.exec("COMMIT");
      return { reserved: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeIdempotency(
    operation: string,
    key: string,
    result: unknown,
  ): void {
    const changed = this.db
      .prepare(
        `UPDATE playbook_idempotency SET result_json = ?
         WHERE origin = ? AND operation = ? AND key = ?
           AND result_json = '__PENDING__'`,
      )
      .run(canonicalizeJson(result), this.origin, operation, key);
    if (changed.changes !== 1) {
      throw new Error("Idempotency reservation is not pending.");
    }
  }

  releaseIdempotency(operation: string, key: string): void {
    this.db
      .prepare(
        `DELETE FROM playbook_idempotency
         WHERE origin = ? AND operation = ? AND key = ?
           AND result_json = '__PENDING__'`,
      )
      .run(this.origin, operation, key);
  }

  rememberIdempotency(
    operation: string,
    key: string,
    result: unknown,
  ): void {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) {
      throw new Error("Invalid idempotency key.");
    }
    this.db
      .prepare(
        `INSERT INTO playbook_idempotency
         (origin, operation, key, request_hash, result_json, created_at)
         VALUES (?, ?, ?, '', ?, ?)
         ON CONFLICT(origin, operation, key) DO NOTHING`,
      )
      .run(
        this.origin,
        operation,
        key,
        canonicalizeJson(result),
        new Date().toISOString(),
      );
  }

  private appendAudit(input: {
    runId?: string;
    entityType: string;
    entityId: string;
    event: string;
    fromStatus?: string | null;
    toStatus?: string | null;
    data: unknown;
  }): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.appendAuditInternal(input);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private appendAuditInternal(input: {
    runId?: string;
    entityType: string;
    entityId: string;
    event: string;
    fromStatus?: string | null;
    toStatus?: string | null;
    data: unknown;
  }): void {
    const previous = this.db
      .prepare(
        `SELECT sequence, hash FROM playbook_audit_events
         WHERE origin = ? ORDER BY sequence DESC LIMIT 1`,
      )
      .get(this.origin) as Row | undefined;
    const globalSequence = this.db
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM playbook_audit_events",
      )
      .get() as Row;
    const sequence = Number(globalSequence.sequence);
    const previousHash = previous ? text(previous.hash) : null;
    const createdAt = new Date().toISOString();
    const payload = {
      sequence,
      origin: this.origin,
      runId: input.runId ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      event: input.event,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      data: input.data,
      previousHash,
      createdAt,
    };
    const hash = agentMeshHmac(
      "playbook-audit",
      `${previousHash ?? ""}\0${canonicalizeJson(payload)}`,
    );
    this.db
      .prepare(
        `INSERT INTO playbook_audit_events
         (id, sequence, origin, run_id, entity_type, entity_id, event, from_status,
          to_status, data_json, previous_hash, hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        sequence,
        this.origin,
        input.runId ?? null,
        input.entityType,
        input.entityId,
        input.event,
        input.fromStatus ?? null,
        input.toStatus ?? null,
        canonicalizeJson(input.data),
        previousHash,
        hash,
        createdAt,
      );
  }
}

export const playbookStepReportSchema = z
  .object({
    outcome: z.enum(["passed", "failed", "blocked"]),
    summary: z.string().min(1).max(16_000),
    findings: z
      .array(
        z
          .object({
            id: boundedId,
            severity: z.enum(["low", "medium", "high", "critical"]),
            status: z.enum(["open", "resolved", "accepted"]),
            summary: z.string().min(1).max(4_000),
            resolutionOf: z
              .string()
              .regex(/^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/)
              .max(241)
              .optional(),
          })
          .strict(),
      )
      .max(200),
    tests: z
      .array(
        z
          .object({
            name: z.string().min(1).max(500),
            status: z.enum(["passed", "failed", "skipped"]),
          })
          .strict(),
      )
      .max(500),
    artifacts: z
      .array(
        z
          .object({
            kind: z.enum(["patch", "report", "log", "benchmark", "documentation"]),
            path: z.string().min(1).max(2_000),
            sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
          })
          .strict(),
      )
      .max(200),
    metrics: z.record(z.string(), z.number().finite()).default({}),
    proposals: z
      .array(
        z
          .object({
            target: z
              .object({
                kind: z.enum(INSTRUCTION_PROPOSAL_TARGET_KINDS),
                identifier: z.string().min(1).max(512),
                relativePath: z.string().min(1).max(2_000).optional(),
              })
              .strict(),
            proposedContent: z.string().min(1).max(1024 * 1024),
            rationale: z.string().min(1).max(16_000),
            frictionEvidence: z
              .object({
                eventIds: z.array(z.string().min(1).max(512)).min(1).max(500),
                summary: z
                  .object({
                    total: z.number().int().min(1).max(1_000_000),
                    byKind: z
                      .array(
                        z
                          .object({
                            kind: z.enum(PEER_FRICTION_KINDS),
                            count: z.number().int().min(1).max(1_000_000),
                          })
                          .strict(),
                      )
                      .max(PEER_FRICTION_KINDS.length),
                    byProvider: z
                      .array(
                        z
                          .object({
                            provider: z.enum(PROVIDERS).nullable(),
                            count: z.number().int().min(1).max(1_000_000),
                          })
                          .strict(),
                      )
                      .max(PROVIDERS.length + 1),
                  })
                  .strict(),
              })
              .strict(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict();

export function parseStepReport(value: unknown): PlaybookStepReport {
  const report = playbookStepReportSchema.parse(value);
  return {
    ...report,
    summary: redactSecrets(report.summary),
    findings: report.findings.map((finding) => ({
      ...finding,
      summary: redactSecrets(finding.summary),
    })),
  };
}

export function goalDigest(goal: GoalRecord): string {
  return digestJson({
    id: goal.id,
    version: goal.version,
    cwd: goal.cwd,
    baseCommit: goal.baseCommit,
    revision: goal.currentRevision,
  });
}

export function compileExecutionManifest(input: {
  goal: GoalRecord;
  definition: PlaybookDefinition;
  resolvedProviders: Map<string, ProviderOption>;
  playbookIdentity?: {
    id: string;
    version: number;
    digest: string;
  };
}): ExecutionManifest {
  const validated = validatePlaybookDefinition(input.definition).definition;
  const waves = validated.waves.map((wave) => ({
    ...wave,
    steps: wave.steps.map((runStep) => {
      const resolved = input.resolvedProviders.get(runStep.id);
      if (!resolved) throw new Error(`No provider resolved for step ${runStep.id}.`);
      if (!runStep.providerOptions.some((option) => canonicalizeJson(option) === canonicalizeJson(resolved))) {
        throw new Error(`Resolved provider is not approved for step ${runStep.id}.`);
      }
      return {
        ...runStep,
        provider: resolved.provider,
        model: resolved.model,
        effort: resolved.effort,
      };
    }),
  }));
  for (const wave of waves) {
    if (
      ["tests_passed", "no_open_findings", "independent_reports"].includes(
        wave.gate.type,
      ) &&
      new Set(wave.steps.map((step) => step.provider)).size < 2
    ) {
      throw new Error(
        `Sensitive gate ${wave.id} requires at least two distinct providers.`,
      );
    }
  }
  return {
    schema: "agent-mesh.manifest/v1",
    runPolicyVersion: PLAYBOOK_POLICY_VERSION,
    goalId: input.goal.id,
    goalVersion: input.goal.version,
    goalDigest: goalDigest(input.goal),
    playbookId: input.playbookIdentity?.id ?? validated.id,
    playbookVersion: input.playbookIdentity?.version ?? validated.version,
    playbookDigest: input.playbookIdentity?.digest ?? digestJson(validated),
    baseCommit: input.goal.baseCommit,
    cwd: input.goal.cwd,
    workspace: validated.workspace,
    limits: validated.limits,
    waves,
  };
}

export function openFindings(run: PlaybookRun): PlaybookStepReport["findings"] {
  const originals = new Map<
    string,
    PlaybookStepReport["findings"][number]
  >();
  const resolutionVotes = new Map<string, Set<Provider>>();
  const roles = new Map(
    run.manifest.waves.flatMap((wave) =>
      wave.steps.map((step) => [step.id, step.role] as const),
    ),
  );
  for (const wave of run.waves.slice().sort((left, right) => left.ordinal - right.ordinal)) {
    for (const step of wave.steps.slice().sort((left, right) => left.ordinal - right.ordinal)) {
      for (const finding of step.report?.findings ?? []) {
        if (finding.resolutionOf) {
          const originStep = finding.resolutionOf.split(":", 1)[0];
          if (
            step.status === "completed" &&
            step.report?.outcome === "passed" &&
            ["reviewer", "tester"].includes(roles.get(step.stepId) ?? "") &&
            originStep !== step.stepId &&
            originals.has(finding.resolutionOf) &&
            ["resolved", "accepted"].includes(finding.status)
          ) {
            const voters =
              resolutionVotes.get(finding.resolutionOf) ?? new Set<Provider>();
            voters.add(step.provider);
            resolutionVotes.set(finding.resolutionOf, voters);
          }
          continue;
        }
        const key = `${step.stepId}:${finding.id}`;
        if (
          step.status === "completed" &&
          step.report?.outcome === "passed" &&
          finding.status === "open"
        ) {
          originals.set(key, finding);
        }
      }
    }
  }
  return [...originals.entries()]
    .filter(([key]) => (resolutionVotes.get(key)?.size ?? 0) < 2)
    .map(([key, finding]) => ({ ...finding, id: key }));
}

export function evaluateWaveGate(
  run: PlaybookRun,
  wave: PlaybookRunWave,
): { passed: boolean; reason: string } {
  const relevant = wave.steps.filter((step) => step.status !== "skipped");
  const successful = relevant.filter(
    (step) =>
      step.status === "completed" &&
      (step.report
        ? step.report.outcome === "passed"
        : !step.requiredReport),
  );
  const taskSuccess =
    wave.completion === "first_success"
      ? successful.length > 0
      : relevant.every((step) => step.status === "completed");
  if (!taskSuccess) return { passed: false, reason: "Required tasks did not complete." };
  const gateSteps =
    wave.completion === "first_success"
      ? successful
      : relevant;
  const reports = gateSteps.filter((step) => step.requiredReport);
  if (reports.some((step) => !step.report)) {
    return { passed: false, reason: "Required step reports are missing." };
  }
  if (
    ["tests_passed", "no_open_findings", "independent_reports"].includes(
      wave.gate.type,
    ) &&
    new Set(gateSteps.map((step) => step.provider)).size < 2
  ) {
    return {
      passed: false,
      reason: "Sensitive gate lacks two distinct provider attestations.",
    };
  }
  switch (wave.gate.type) {
    case "all_succeeded":
      return {
        passed:
          taskSuccess &&
          gateSteps.every(
            (step) => !step.report || step.report.outcome === "passed",
          ),
        reason: "All required tasks and submitted outcomes must pass.",
      };
    case "all_required_reports":
      return {
        passed: reports.every((step) => step.report?.outcome === "passed"),
        reason: "Required reports must pass.",
      };
    case "independent_reports":
      return {
        passed:
          new Set(gateSteps.map((step) => step.provider)).size >= 2 &&
          reports.every((step) => step.report?.outcome === "passed"),
        reason:
          "Independent reports from at least two distinct providers must pass.",
      };
    case "tests_passed": {
      const tests = reports.flatMap((step) => step.report?.tests ?? []);
      return {
        passed:
          reports.every((step) => step.report?.outcome === "passed") &&
          tests.length > 0 &&
          tests.every((test) => test.status === "passed"),
        reason: "Every reported test must pass.",
      };
    }
    case "no_open_findings":
      return {
        passed:
          reports.every((step) => step.report?.outcome === "passed") &&
          openFindings(run).length === 0,
        reason: "No unresolved finding may remain across the run.",
      };
    case "friction_evidence": {
      const proposals = reports.flatMap(
        (step) => step.report?.proposals ?? [],
      );
      return {
        passed:
          reports.every((step) => step.report?.outcome === "passed") &&
          proposals.length > 0 &&
          proposals.every(
            (proposal) => proposal.frictionEvidence.eventIds.length > 0,
          ),
        reason:
          "Every instruction proposal must cite at least one recorded friction event.",
      };
    }
    case "manual":
      return { passed: false, reason: "Manual gate requires explicit advance." };
  }
}
