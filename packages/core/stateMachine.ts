import { calculateKeepExpiry, evaluateClockTransitions } from './clocks.js';
import { evaluateStage2Utility } from './triage.js';
import { LifecycleTier, PatternObservation, WorkflowPattern } from './types.js';

export interface SweepResult {
  updatedPatterns: WorkflowPattern[];
  monthlyReviewItems: WorkflowPattern[];
}

/**
 * Handles incoming interaction events and updates pattern state and clocks accordingly.
 */
export function handleObservation(
  pattern: WorkflowPattern,
  obs: PatternObservation,
  now: Date = new Date()
): WorkflowPattern {
  const nowIso = now.toISOString();
  const updated: WorkflowPattern = {
    ...pattern,
    lastObservedAt: nowIso,
    updatedAt: nowIso,
  };

  switch (obs.actionType) {
    case 'shortcut_executed': {
      updated.reusabilityCount = (pattern.reusabilityCount || 0) + 1;
      updated.lastExecutedAt = nowIso;

      // Restores demoted items and resets the 14-day clock in full
      if (pattern.tier === LifecycleTier.Keep || pattern.tier === LifecycleTier.Review || pattern.tier === LifecycleTier.Archive) {
        updated.tier = LifecycleTier.Keep;
        updated.tierEnteredAt = pattern.tier === LifecycleTier.Keep ? pattern.tierEnteredAt : nowIso;
        updated.keepClockExpiresAt = calculateKeepExpiry(now).toISOString();
        updated.reviewReason = null;
      }
      break;
    }

    case 'prompt_accepted': {
      updated.timesAccepted = (pattern.timesAccepted || 0) + 1;
      break;
    }

    case 'prompt_dismissed': {
      updated.timesDismissed = (pattern.timesDismissed || 0) + 1;
      break;
    }

    case 'prompt_displayed': {
      updated.timesPrompted = (pattern.timesPrompted || 0) + 1;
      break;
    }

    default:
      break;
  }

  return updated;
}

/**
 * Executes the scheduled nightly sweep:
 * 1. Checks decay clocks on Keep and Review items.
 * 2. Runs Stage 2 Utility & Adoption ratio checks.
 * 3. Collects items in Review or Archive for monthly review checkpointing.
 */
export function handleNightlySweep(
  patterns: WorkflowPattern[],
  now: Date = new Date()
): SweepResult {
  const updatedPatterns: WorkflowPattern[] = [];
  const monthlyReviewItems: WorkflowPattern[] = [];

  for (const pattern of patterns) {
    let current = { ...pattern };
    const nowIso = now.toISOString();

    // 1. Evaluate decay clocks
    const clockResult = evaluateClockTransitions(current, now);
    if (clockResult.changed) {
      current.tier = clockResult.nextTier;
      current.tierEnteredAt = nowIso;
      current.reviewReason = clockResult.reviewReason || current.reviewReason;
      current.updatedAt = nowIso;
    }

    // 2. Stage 2 Utility check for Keep items
    if (current.tier === LifecycleTier.Keep) {
      const stage2 = evaluateStage2Utility(current);
      if (stage2.flag === 'high_friction' && stage2.recommendation === 'demote_to_review') {
        current.tier = LifecycleTier.Review;
        current.tierEnteredAt = nowIso;
        current.reviewReason = 'high_friction';
        current.updatedAt = nowIso;
      }
    }

    // 3. Collect items awaiting the monthly human checkpoint
    if (current.tier === LifecycleTier.Review || current.tier === LifecycleTier.Archive) {
      monthlyReviewItems.push(current);
    }

    updatedPatterns.push(current);
  }

  return {
    updatedPatterns,
    monthlyReviewItems,
  };
}

/**
 * Handles the decisive human checkpoint action from Second Guess.
 */
export function handleHumanReview(
  pattern: WorkflowPattern,
  decision: 'keep' | 'cut',
  now: Date = new Date()
): WorkflowPattern {
  const nowIso = now.toISOString();

  if (decision === 'keep') {
    return {
      ...pattern,
      tier: LifecycleTier.Keep,
      tierEnteredAt: nowIso,
      keepClockExpiresAt: calculateKeepExpiry(now).toISOString(),
      reviewReason: null,
      updatedAt: nowIso,
    };
  }

  return {
    ...pattern,
    tier: LifecycleTier.Cut,
    tierEnteredAt: nowIso,
    keepClockExpiresAt: null,
    updatedAt: nowIso,
  };
}
