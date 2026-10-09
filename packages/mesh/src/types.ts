import type { ChildProcess } from "node:child_process";
import type { McpProfile } from "./mcp-profiles.js";

export const PROVIDERS = ["cursor", "codex", "claude", "grok", "antigravity"] as const;
export type Provider = (typeof PROVIDERS)[number];
export type Origin = Provider;

export interface CoordinationContext {
  origin: Origin;
  swarmId: string;
  memberId: string;
}

export interface ManagedPeerContext {
  origin: Origin;
  agentId: string;
  memberId: string;
  membershipGeneration: number;
  taskId?: string;
  runId?: string;
  causalRoot?: string;
  causalPath?: string[];
}

export const TASK_MODES = ["ask", "plan", "review", "research", "implement"] as const;
export type TaskMode = (typeof TASK_MODES)[number];

export const TASK_STATUSES = [
  "queued",
  "running",
  "cancelling",
  "waiting_for_input",
  "resuming",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface StartTaskInput {
  provider: Provider;
  prompt: string;
  description: string;
  cwd: string;
  mode: TaskMode;
  model?: string;
  effort?: string;
  mcpProfile: McpProfile;
  isolation: "auto" | "none" | "worktree";
  timeoutMs: number;
  baseRef?: string;
  resumeSessionId?: string;
  forkSession?: boolean;
  coordination?: CoordinationContext;
}

export interface ProviderRunRequest {
  taskId: string;
  prompt: string;
  cwd: string;
  mode: TaskMode;
  model?: string;
  effort?: string;
  mcpProfile: McpProfile;
  timeoutMs: number;
  sessionId?: string;
  forkSession?: boolean;
  taskDir: string;
  coordination?: CoordinationContext;
  peer?: ManagedPeerContext;
}

export interface ProviderRunHooks {
  onStarted: (handle: ProviderRunHandle) => void;
  onSession: (sessionId: string) => void;
  onEvent?: (event: unknown) => void;
  onQuestion?: (question: NativeProviderQuestion) => Promise<NativeQuestionResolution>;
}

export interface ProviderRunHandle {
  pid?: number;
  cancel: () => Promise<void>;
  child?: ChildProcess;
}

export interface NativeProviderQuestion {
  requestId: string;
  questionId: string;
  question: string;
  context?: string;
  options: string[];
  timeoutMs: number;
}

export interface NativeQuestionResolution {
  answer: string;
  delivered: () => Promise<void>;
  deliveryFailed: () => Promise<void>;
}

export interface ProviderResult {
  output: string;
  sessionId: string;
  usage?: unknown;
  metadata?: Record<string, unknown>;
}

export interface ProviderModel {
  id: string;
  displayName?: string;
  isDefault?: boolean;
  reasoningEfforts?: string[];
  metadata?: Record<string, unknown>;
}

export interface ProviderCapabilities {
  provider: Provider;
  dynamicModelDiscovery: boolean;
  resume: boolean;
  fork: boolean;
  nativeSessionSearch: boolean;
  nativeCancellation: boolean;
  notes: string[];
}

export interface NativeSession {
  provider: Provider;
  sessionId: string;
  name?: string;
  preview?: string;
  cwd?: string;
  status?: unknown;
  createdAt?: number;
  updatedAt?: number;
  native: true;
}

export interface ProviderAdapter {
  readonly provider: Provider;
  capabilities(): ProviderCapabilities;
  listModels(): Promise<ProviderModel[]>;
  run(request: ProviderRunRequest, hooks: ProviderRunHooks): Promise<ProviderResult>;
  searchNativeSessions?(query: string, limit: number): Promise<NativeSession[]>;
  close?(): Promise<void>;
}

export interface TaskRecord {
  id: string;
  origin: Origin;
  provider: Provider;
  description: string;
  mode: TaskMode;
  status: TaskStatus;
  cwd: string;
  effectiveCwd: string;
  repoRoot: string | null;
  worktreePath: string | null;
  baseCommit: string | null;
  model: string | null;
  effort: string | null;
  actualModel?: string | null;
  actualEffort?: string | null;
  fallbackCount?: number;
  fallbackReason?: string | null;
  mcpProfile: McpProfile;
  sessionId: string | null;
  parentTaskId: string | null;
  initiativeId: string | null;
  swarmId: string | null;
  swarmMemberId: string | null;
  peerCausalRoot: string | null;
  peerCausalPath: string[];
  ownerPid: number;
  pid: number | null;
  resultPath: string | null;
  eventsPath: string | null;
  transcriptPath: string | null;
  pendingQuestionId: string | null;
  patchPath: string | null;
  changedFiles: string[];
  artifactStatus:
    | "not_applicable"
    | "pending"
    | "clean"
    | "captured"
    | "live_snapshot"
    | "failed";
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TaskArtifacts {
  changedFiles: string[];
  patchPath?: string;
  worktreePath?: string;
  // Live-workspace runs produce an observational snapshot rather than a
  // promotable patch, so promotion must be able to tell the two apart.
  kind?: "live_diff_snapshot";
  snapshotPath?: string;
}

export interface TaskResultEnvelope {
  task: TaskRecord;
  result?: ProviderResult;
  artifacts?: TaskArtifacts;
  questions?: QuestionRecord[];
}

export const QUESTION_STATUSES = ["pending", "answered", "dismissed"] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];
export const QUESTION_DELIVERIES = ["resume", "native"] as const;
export type QuestionDelivery = (typeof QUESTION_DELIVERIES)[number];

export interface QuestionRecord {
  id: string;
  taskId: string;
  origin: Origin;
  provider: Provider;
  sessionId: string | null;
  delivery: QuestionDelivery;
  nativeRequestId: string | null;
  question: string;
  context: string | null;
  options: string[];
  status: QuestionStatus;
  answer: string | null;
  createdAt: string;
  answeredAt: string | null;
}

export interface ActiveRun {
  handle?: ProviderRunHandle;
  completion: Promise<TaskResultEnvelope>;
}
