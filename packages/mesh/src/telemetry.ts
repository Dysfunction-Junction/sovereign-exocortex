import type { TaskRecord, TaskStatus } from "./types.js";

export interface TaskTransition {
  sequence: number;
  taskId: string;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus;
  occurredAt: string;
}

export interface TaskTimingMetrics {
  taskId: string;
  provider: string;
  requestedModel: string | null;
  requestedEffort: string | null;
  actualModel: string | null;
  actualEffort: string | null;
  fallbackCount: number;
  fallbackReason: string | null;
  currentStatus: TaskStatus;
  createdAt: string;
  startedAt: string | null;
  firstOutputAt: string | null;
  completedAt: string | null;
  queueMs: number;
  timeToFirstOutputMs: number | null;
  activeMs: number;
  waitingForInputMs: number;
  cancellingMs: number;
  totalWallMs: number;
  statusDurationsMs: Partial<Record<TaskStatus, number>>;
  transitions: TaskTransition[];
}

export function isProviderOutputEvent(event: Record<string, unknown>): boolean {
  if (event.type === "assistant") return true;
  if (
    event.method === "item/agentMessage/delta" ||
    event.method === "item/reasoning/summaryTextDelta"
  ) {
    return true;
  }
  const item =
    event.item && typeof event.item === "object" && !Array.isArray(event.item)
      ? (event.item as Record<string, unknown>)
      : undefined;
  return item?.type === "agentMessage";
}

const ACTIVE = new Set<TaskStatus>(["running", "resuming"]);

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid timestamp: ${value}`);
  return parsed;
}

export function deriveTaskTimingMetrics(
  task: TaskRecord,
  transitions: TaskTransition[],
  firstOutputAt: string | null,
  now = Date.now(),
): TaskTimingMetrics {
  const ordered = [...transitions].sort(
    (a, b) => timestamp(a.occurredAt) - timestamp(b.occurredAt) || a.sequence - b.sequence,
  );
  const end = task.completedAt ? timestamp(task.completedAt) : now;
  const durations: Partial<Record<TaskStatus, number>> = {};
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index]!;
    const start = timestamp(current.occurredAt);
    const next = ordered[index + 1];
    const stop = Math.max(start, next ? timestamp(next.occurredAt) : end);
    durations[current.toStatus] = (durations[current.toStatus] ?? 0) + (stop - start);
  }
  const created = timestamp(task.createdAt);
  const started = ordered.find((entry) => entry.toStatus === "running")?.occurredAt ?? null;
  const startedMs = started ? timestamp(started) : null;
  const activeMs = [...ACTIVE].reduce(
    (sum, status) => sum + (durations[status] ?? 0),
    0,
  );
  return {
    taskId: task.id,
    provider: task.provider,
    requestedModel: task.model,
    requestedEffort: task.effort,
    actualModel: task.actualModel ?? null,
    actualEffort: task.actualEffort ?? null,
    fallbackCount: task.fallbackCount ?? 0,
    fallbackReason: task.fallbackReason ?? null,
    currentStatus: task.status,
    createdAt: task.createdAt,
    startedAt: started,
    firstOutputAt,
    completedAt: task.completedAt,
    queueMs: startedMs === null ? Math.max(0, end - created) : Math.max(0, startedMs - created),
    timeToFirstOutputMs:
      firstOutputAt === null ? null : Math.max(0, timestamp(firstOutputAt) - created),
    activeMs,
    waitingForInputMs: durations.waiting_for_input ?? 0,
    cancellingMs: durations.cancelling ?? 0,
    totalWallMs: Math.max(0, end - created),
    statusDurationsMs: durations,
    transitions: ordered,
  };
}

export function aggregateTimingMetrics(metrics: TaskTimingMetrics[]) {
  const byProvider = metrics.reduce<Record<string, TaskTimingMetrics[]>>(
    (groups, item) => {
      (groups[item.provider] ??= []).push(item);
      return groups;
    },
    {},
  );
  return {
    taskCount: metrics.length,
    completedCount: metrics.filter((item) => item.currentStatus === "completed").length,
    settledCount: metrics.filter((item) =>
      ["completed", "failed", "cancelled", "interrupted"].includes(item.currentStatus),
    ).length,
    totalWallMs: metrics.reduce((sum, item) => sum + item.totalWallMs, 0),
    totalActiveMs: metrics.reduce((sum, item) => sum + item.activeMs, 0),
    totalWaitingForInputMs: metrics.reduce(
      (sum, item) => sum + item.waitingForInputMs,
      0,
    ),
    averageQueueMs:
      metrics.length === 0
        ? 0
        : Math.round(metrics.reduce((sum, item) => sum + item.queueMs, 0) / metrics.length),
    averageTimeToFirstOutputMs: (() => {
      const values = metrics
        .map((item) => item.timeToFirstOutputMs)
        .filter((value): value is number => value !== null);
      return values.length === 0
        ? null
        : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
    })(),
    byProvider,
  };
}
