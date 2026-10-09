import { CONSTANTS, WorkflowPattern } from './types.js';

export interface Stage1Result {
  passes: boolean;
  daysSinceLastActivity: number;
}

export interface Stage2Result {
  passes: boolean;
  adoptionRate: number;
  utilityScore: number;
  flag: 'high_utility' | 'high_friction' | 'neutral';
  recommendation: 'retain' | 'demote_to_review' | 'promote_to_keep';
}

/**
 * Stage 1: Activity & Recency Gate (Binary).
 * Checks whether the pattern has verified user interactions within the active window.
 */
export function evaluateStage1Recency(
  pattern: WorkflowPattern,
  windowDays: number = 14,
  now: Date = new Date()
): Stage1Result {
  const lastActiveDate = new Date(pattern.lastExecutedAt || pattern.lastObservedAt);
  const diffMs = Math.max(0, now.getTime() - lastActiveDate.getTime());
  const daysSinceLastActivity = diffMs / (1000 * 60 * 60 * 24);

  return {
    passes: daysSinceLastActivity <= windowDays,
    daysSinceLastActivity,
  };
}

/**
 * Stage 2: Utility & Adoption Ratio.
 * Evaluates whether an automation produces net value or prompt friction.
 */
export function evaluateStage2Utility(
  pattern: WorkflowPattern,
  promptThreshold: number = 5
): Stage2Result {
  const prompted = pattern.timesPrompted;
  const accepted = pattern.timesAccepted;
  const dismissed = pattern.timesDismissed;
  const estimatedSeconds = pattern.suggestedAction?.estimatedSecondsSaved || 30;

  if (prompted === 0) {
    return {
      passes: true,
      adoptionRate: 1.0,
      utilityScore: estimatedSeconds,
      flag: 'neutral',
      recommendation: 'retain',
    };
  }

  const adoptionRate = accepted / prompted;
  const dismissalRate = dismissed / prompted;

  // Utility Score: positive time saved weighted by acceptance, penalized by dismissals
  const utilityScore = (adoptionRate * estimatedSeconds) - (dismissalRate * 15);

  // High friction check: prompted frequently but rarely accepted
  if (prompted >= promptThreshold && adoptionRate < CONSTANTS.STAGE2_FRICTION_THRESHOLD) {
    return {
      passes: false,
      adoptionRate,
      utilityScore,
      flag: 'high_friction',
      recommendation: 'demote_to_review',
    };
  }

  // High utility check
  if (adoptionRate >= CONSTANTS.STAGE2_ADOPTION_THRESHOLD) {
    return {
      passes: true,
      adoptionRate,
      utilityScore,
      flag: 'high_utility',
      recommendation: 'promote_to_keep',
    };
  }

  return {
    passes: true,
    adoptionRate,
    utilityScore,
    flag: 'neutral',
    recommendation: 'retain',
  };
}
