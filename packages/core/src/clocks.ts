import { CONSTANTS, LifecycleTier, WorkflowPattern } from './types.js';

/**
 * Returns a new expiration timestamp for an active Keep automation (now + 14 days).
 */
export function calculateKeepExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + CONSTANTS.KEEP_DECAY_CLOCK_MS);
}

/**
 * Checks whether a given expiration timestamp is in the past.
 */
export function isClockExpired(
  expiryTimestamp: string | Date | null,
  now: Date = new Date()
): boolean {
  if (!expiryTimestamp) return true;
  const expiry = typeof expiryTimestamp === 'string' ? new Date(expiryTimestamp) : expiryTimestamp;
  // Fail closed: an unparseable timestamp is treated as expired (like null), never as "never expires"
  if (isNaN(expiry.getTime())) return true;
  return now.getTime() >= expiry.getTime();
}

/**
 * Calculates remaining days on a clock (fractional). Returns 0 if expired.
 */
export function daysUntilExpiry(
  expiryTimestamp: string | Date | null,
  now: Date = new Date()
): number {
  if (!expiryTimestamp) return 0;
  const expiry = typeof expiryTimestamp === 'string' ? new Date(expiryTimestamp) : expiryTimestamp;
  const diffMs = expiry.getTime() - now.getTime();
  return Math.max(0, diffMs / (1000 * 60 * 60 * 24));
}

export interface ClockTransitionResult {
  nextTier: LifecycleTier;
  reviewReason?: 'dormant' | null;
  changed: boolean;
}

/**
 * Evaluates decay clocks for an item in Keep or Review.
 * - Keep -> Review: 14 days without execution (clock expired).
 * - Review -> Archive: 14 additional days in Review without execution.
 */
export function evaluateClockTransitions(
  pattern: WorkflowPattern,
  now: Date = new Date()
): ClockTransitionResult {
  // Keep tier evaluation
  if (pattern.tier === LifecycleTier.Keep) {
    if (isClockExpired(pattern.keepClockExpiresAt, now)) {
      return {
        nextTier: LifecycleTier.Review,
        reviewReason: 'dormant',
        changed: true,
      };
    }
    return { nextTier: LifecycleTier.Keep, changed: false };
  }

  // Review tier evaluation (14 days in review -> Archive)
  if (pattern.tier === LifecycleTier.Review) {
    const reviewEnteredAt = new Date(pattern.tierEnteredAt);
    const msInReview = now.getTime() - reviewEnteredAt.getTime();
    if (msInReview >= CONSTANTS.REVIEW_TO_ARCHIVE_MS) {
      return {
        nextTier: LifecycleTier.Archive,
        reviewReason: 'dormant',
        changed: true,
      };
    }
    return { nextTier: LifecycleTier.Review, changed: false };
  }

  return { nextTier: pattern.tier, changed: false };
}
