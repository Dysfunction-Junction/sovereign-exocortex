import { handleHumanReview, handleNightlySweep, handleObservation } from './stateMachine';
import { LifecycleTier, PatternKind, PatternObservation, TaskCategory, WorkflowPattern } from './types';

describe('State Machine & Full Lifecycle Transitions', () => {
  const basePattern: WorkflowPattern = {
    id: 'p-1',
    name: 'Logcat Filter',
    description: 'Filters terminal logs',
    kind: PatternKind.ShortcutCandidate,
    taskCategory: TaskCategory.Coding,
    tier: LifecycleTier.Keep,
    tierEnteredAt: '2026-01-01T00:00:00Z',
    keepClockExpiresAt: '2026-01-15T00:00:00Z',
    reusabilityCount: 3,
    promotionScore: 10,
    lastObservedAt: '2026-01-05T00:00:00Z',
    lastExecutedAt: '2026-01-05T00:00:00Z',
    timesPrompted: 4,
    timesAccepted: 3,
    timesDismissed: 1,
    triggerSignature: { sourceApps: ['com.termux'] },
    createdBy: 'user-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  describe('handleObservation', () => {
    it('resets 14-day clock and increments reusabilityCount upon verified execution', () => {
      const now = new Date('2026-01-10T12:00:00Z');
      const obs: PatternObservation = {
        id: 'obs-1',
        patternId: 'p-1',
        source: 'manual',
        actionType: 'shortcut_executed',
        durationMs: 1200,
        observedAt: now.toISOString(),
        createdBy: 'user-1',
      };

      const updated = handleObservation(basePattern, obs, now);

      expect(updated.reusabilityCount).toBe(4);
      expect(updated.lastExecutedAt).toBe(now.toISOString());
      // Check that keepClockExpiresAt was extended to now + 14 days
      const expiryDate = new Date(updated.keepClockExpiresAt!);
      const diffDays = (expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBe(14);
    });

    it('restores a demoted Review item back to Keep when executed', () => {
      const demotedPattern: WorkflowPattern = {
        ...basePattern,
        tier: LifecycleTier.Review,
        reviewReason: 'dormant',
      };

      const now = new Date('2026-01-20T00:00:00Z');
      const obs: PatternObservation = {
        id: 'obs-2',
        patternId: 'p-1',
        source: 'accessibility_dwell',
        actionType: 'shortcut_executed',
        durationMs: 500,
        observedAt: now.toISOString(),
        createdBy: 'user-1',
      };

      const restored = handleObservation(demotedPattern, obs, now);

      expect(restored.tier).toBe(LifecycleTier.Keep);
      expect(restored.reviewReason).toBeNull();
      expect(restored.keepClockExpiresAt).not.toBeNull();
    });

    it('does not double-count prompt denominator on acceptance or dismissal', () => {
      const now = new Date('2026-01-20T00:00:00Z');
      const startPattern: WorkflowPattern = {
        ...basePattern,
        timesPrompted: 0,
        timesAccepted: 0,
        timesDismissed: 0,
      };

      // 1. Prompt is displayed
      const displayed = handleObservation(
        startPattern,
        { id: 'obs-d', patternId: 'p-1', source: 'coach', actionType: 'prompt_displayed', durationMs: 0, observedAt: now.toISOString(), createdBy: 'u-1' },
        now
      );
      expect(displayed.timesPrompted).toBe(1);
      expect(displayed.timesAccepted).toBe(0);

      // 2. Prompt is accepted
      const accepted = handleObservation(
        displayed,
        { id: 'obs-a', patternId: 'p-1', source: 'coach', actionType: 'prompt_accepted', durationMs: 0, observedAt: now.toISOString(), createdBy: 'u-1' },
        now
      );
      expect(accepted.timesPrompted).toBe(1); // Still 1, NOT double-counted to 2
      expect(accepted.timesAccepted).toBe(1);

      // 3. Next prompt displayed and dismissed
      const secondDisplay = handleObservation(
        accepted,
        { id: 'obs-d2', patternId: 'p-1', source: 'coach', actionType: 'prompt_displayed', durationMs: 0, observedAt: now.toISOString(), createdBy: 'u-1' },
        now
      );
      const dismissed = handleObservation(
        secondDisplay,
        { id: 'obs-dis', patternId: 'p-1', source: 'coach', actionType: 'prompt_dismissed', durationMs: 0, observedAt: now.toISOString(), createdBy: 'u-1' },
        now
      );
      expect(dismissed.timesPrompted).toBe(2); // Exactly 2 impressions
      expect(dismissed.timesAccepted).toBe(1);
      expect(dismissed.timesDismissed).toBe(1);
    });
  });

  describe('handleNightlySweep', () => {
    it('demotes expired Keep items and collects them for monthly review', () => {
      const expiredPattern: WorkflowPattern = {
        ...basePattern,
        keepClockExpiresAt: '2026-01-15T00:00:00Z',
      };

      const now = new Date('2026-01-16T00:00:00Z');
      const sweep = handleNightlySweep([expiredPattern], now);

      expect(sweep.updatedPatterns[0].tier).toBe(LifecycleTier.Review);
      expect(sweep.updatedPatterns[0].reviewReason).toBe('dormant');
      expect(sweep.monthlyReviewItems).toHaveLength(1);
      expect(sweep.monthlyReviewItems[0].id).toBe('p-1');
    });

    it('demotes items with high prompt friction to Review', () => {
      const highFrictionPattern: WorkflowPattern = {
        ...basePattern,
        keepClockExpiresAt: '2026-01-25T00:00:00Z', // clock is still valid
        timesPrompted: 10,
        timesAccepted: 1, // 10% acceptance (< 20%)
        timesDismissed: 9,
      };

      const now = new Date('2026-01-10T00:00:00Z');
      const sweep = handleNightlySweep([highFrictionPattern], now);

      expect(sweep.updatedPatterns[0].tier).toBe(LifecycleTier.Review);
      expect(sweep.updatedPatterns[0].reviewReason).toBe('high_friction');
    });
  });

  describe('handleHumanReview', () => {
    const reviewPattern: WorkflowPattern = {
      ...basePattern,
      tier: LifecycleTier.Review,
      reviewReason: 'dormant',
    };

    it('restores pattern to Keep and resets clock when user chooses "keep"', () => {
      const now = new Date('2026-02-01T00:00:00Z');
      const result = handleHumanReview(reviewPattern, 'keep', now);

      expect(result.tier).toBe(LifecycleTier.Keep);
      expect(result.reviewReason).toBeNull();
      const expiry = new Date(result.keepClockExpiresAt!);
      expect((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)).toBe(14);
    });

    it('transitions pattern to Cut when user chooses "cut"', () => {
      const now = new Date('2026-02-01T00:00:00Z');
      const result = handleHumanReview(reviewPattern, 'cut', now);

      expect(result.tier).toBe(LifecycleTier.Cut);
      expect(result.keepClockExpiresAt).toBeNull();
    });
  });
});
