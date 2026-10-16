import { exportCandidatePool } from './pool.js';
import { LifecycleTier, PatternKind, TaskCategory, WorkflowPattern } from './types.js';

export interface RankedCandidate {
  id: string;
  promotionScore: number;
}

export interface RankResult {
  totalCandidates: number;
  returned: number;
  order: RankedCandidate[];
}

const MAX_PATTERNS = 50;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toPattern(value: unknown, nowIso: string): WorkflowPattern | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.id !== 'string' || record.id.length < 1 || record.id.length > 80) return null;
  const score = typeof record.promotionScore === 'number' && Number.isFinite(record.promotionScore)
    ? Math.max(0, Math.min(record.promotionScore, 1_000_000))
    : 0;
  const seen = typeof record.lastObservedAt === 'string' && !Number.isNaN(Date.parse(record.lastObservedAt))
    ? new Date(record.lastObservedAt).toISOString()
    : new Date(0).toISOString();
  return {
    id: record.id,
    name: typeof record.name === 'string' ? record.name.slice(0, 120) : record.id,
    description: '',
    kind: PatternKind.ShortcutCandidate,
    taskCategory: TaskCategory.Productivity,
    tier: LifecycleTier.Candidate,
    tierEnteredAt: nowIso,
    keepClockExpiresAt: null,
    reusabilityCount: 0,
    promotionScore: score,
    lastObservedAt: seen,
    lastExecutedAt: null,
    timesPrompted: 0,
    timesAccepted: 0,
    timesDismissed: 0,
    triggerSignature: { sourceApps: [] },
    createdBy: 'mishmash',
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export function clusterEventsToPatterns(events: unknown[], nowIso: string = new Date().toISOString()): WorkflowPattern[] {
  const clusters = new Map<string, { count: number; lastObservedAt: string; name: string }>();
  for (const item of events) {
    const rec = asRecord(item);
    if (!rec) continue;
    const key = (typeof rec.package === 'string' && rec.package.trim())
      || (typeof rec.packageName === 'string' && rec.packageName.trim())
      || (typeof rec.app === 'string' && rec.app.trim())
      || (typeof rec.screen === 'string' && rec.screen.trim())
      || 'unknown';
    const label = (typeof rec.app_label === 'string' && rec.app_label.trim())
      || (typeof rec.title === 'string' && rec.title.trim())
      || key;
    const ts = typeof rec.timestamp === 'string' && !Number.isNaN(Date.parse(rec.timestamp))
      ? new Date(rec.timestamp).toISOString()
      : typeof rec.timestamp === 'number' && Number.isFinite(rec.timestamp) && Math.abs(rec.timestamp) <= 8.64e15
        ? new Date(rec.timestamp).toISOString()
        : nowIso;
    const existing = clusters.get(key);
    if (existing) {
      existing.count += 1;
      if (ts > existing.lastObservedAt) {
        existing.lastObservedAt = ts;
      }
    } else {
      clusters.set(key, { count: 1, lastObservedAt: ts, name: label });
    }
  }

  const result: WorkflowPattern[] = [];
  for (const [key, cluster] of clusters.entries()) {
    result.push({
      id: `cluster-${key}`,
      name: cluster.name,
      description: `Ambient telemetry cluster for ${key}`,
      kind: PatternKind.ShortcutCandidate,
      taskCategory: TaskCategory.Productivity,
      tier: LifecycleTier.Candidate,
      tierEnteredAt: nowIso,
      keepClockExpiresAt: null,
      reusabilityCount: 0,
      promotionScore: cluster.count * 10,
      lastObservedAt: cluster.lastObservedAt,
      lastExecutedAt: null,
      timesPrompted: 0,
      timesAccepted: 0,
      timesDismissed: 0,
      triggerSignature: { sourceApps: [key] },
      createdBy: 'mishmash-telemetry',
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }
  return result;
}

/**
 * Rank caller-supplied rows with the same decay and capacity rules the
 * Registry candidate export uses. Rows are treated as candidates; this does
 * not read Firestore or execute anything in the payload.
 */
export function rankSuppliedCandidates(payload: unknown, now: Date = new Date()): RankResult | { error: string } {
  const record = asRecord(payload);
  if (!record) return { error: 'rank requires a payload object' };

  const nowIso = now.toISOString();
  let patterns: WorkflowPattern[] = [];
  if (Array.isArray(record.patterns)) {
    if (record.patterns.length > MAX_PATTERNS) return { error: 'rank accepts at most 50 patterns' };
    for (const item of record.patterns) {
      const built = toPattern(item, nowIso);
      if (!built) return { error: 'each pattern needs a string id' };
      patterns.push(built);
    }
  } else if (Array.isArray(record.events)) {
    patterns = clusterEventsToPatterns(record.events, nowIso);
  } else {
    return { error: 'rank requires payload.patterns or payload.events' };
  }

  let capacity = Math.max(patterns.length, 1);
  if (typeof record.capacity === 'number' && Number.isFinite(record.capacity)) {
    capacity = Math.max(1, Math.min(MAX_PATTERNS, Math.floor(record.capacity)));
  }

  const exported = exportCandidatePool(patterns, capacity, now);
  return {
    totalCandidates: exported.totalCandidates,
    returned: exported.returned,
    order: exported.candidates.map((item) => ({
      id: item.id,
      promotionScore: item.promotionScore,
    })),
  };
}

export function isRankError(value: RankResult | { error: string }): value is { error: string } {
  return 'error' in value && !('order' in value);
}

export interface SurprisalFeedbackResult {
  feedbackId: string;
  candidateId: string;
  outcome: string;
  actionType: string;
  surprisalScore: number;
  surprisal: number;
  weightMultiplier: number;
  multiplier: number;
  demoteRecommended: boolean;
  timestamp: string;
}

export function computeSurprisalFeedback(payload: unknown): SurprisalFeedbackResult | { error: string } {
  const record = asRecord(payload);
  if (!record) return { error: 'feedback requires a payload object' };
  const candidateId = typeof record.candidateId === 'string' && record.candidateId.trim()
    ? record.candidateId.trim()
    : '';
  if (!candidateId) return { error: 'candidateId is required' };
  if (candidateId.length > 128) return { error: 'candidateId must be at most 128 characters' };

  const rawOutcome = typeof record.outcome === 'string' ? record.outcome.trim() : undefined;
  const rawActionType = typeof record.actionType === 'string' ? record.actionType.trim() : undefined;

  if (!rawOutcome && !rawActionType) {
    return { error: 'outcome or actionType is required' };
  }

  const ALIAS: Record<string, string> = {
    approve: 'approved',
    reject: 'rejected',
    undo: 'undone',
    dismiss: 'dismissed',
  };

  const normOutcome = rawOutcome ? (ALIAS[rawOutcome.toLowerCase()] ?? rawOutcome.toLowerCase()) : undefined;
  const normActionType = rawActionType ? (ALIAS[rawActionType.toLowerCase()] ?? rawActionType.toLowerCase()) : undefined;

  if (normOutcome && normActionType && normOutcome !== normActionType) {
    return { error: `conflicting outcome (${rawOutcome}) and actionType (${rawActionType})` };
  }

  const normalized = normOutcome ?? normActionType!;

  let probability = 0.85;
  let multiplier = 1.25;
  let demote = false;

  const userConf = typeof record.priorConfidence === 'number' && Number.isFinite(record.priorConfidence)
    ? record.priorConfidence
    : undefined;

  if (normalized === 'approved') {
    probability = userConf !== undefined && userConf > 0 && userConf < 1 ? userConf : 0.85;
    multiplier = userConf !== undefined && Math.abs(userConf - 0.85) > 0.05
      ? Math.min(3.0, Math.max(1.05, 1.0 + (1.0 - probability) * 0.5))
      : 1.25;
    demote = false;
  } else if (normalized === 'dismissed') {
    probability = userConf !== undefined && userConf > 0 && userConf < 1 ? userConf : 0.25;
    multiplier = 0.70;
    demote = false;
  } else if (normalized === 'undone' || normalized === 'diverged' || normalized === 'rejected') {
    probability = userConf !== undefined && userConf > 0 && userConf < 1 ? userConf : 0.05;
    multiplier = 0.40;
    demote = true;
  } else {
    return { error: `unrecognized outcome: ${normalized}` };
  }

  // S = -log2(P)
  const surprisal = Math.round(-Math.log2(probability) * 100) / 100;
  const clampedMultiplier = Math.round(Math.min(3.0, Math.max(0.1, multiplier)) * 100) / 100;

  const feedbackId = typeof record.feedbackId === 'string' && record.feedbackId.trim()
    ? record.feedbackId.trim()
    : `fbk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return {
    feedbackId,
    candidateId,
    outcome: normalized,
    actionType: normalized,
    surprisalScore: surprisal,
    surprisal,
    weightMultiplier: clampedMultiplier,
    multiplier: clampedMultiplier,
    demoteRecommended: demote,
    timestamp: new Date().toISOString(),
  };
}

