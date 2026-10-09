import { evaluateStage1Recency, evaluateStage2Utility } from './triage';
import { LifecycleTier, PatternKind, TaskCategory, WorkflowPattern } from './types';

describe('Two-Stage Triage Gate', () => {
  const basePattern: WorkflowPattern = {
    id: 'p-1',
    name: 'Auto-Format',
    description: 'Formats clipboard data',
    kind: PatternKind.ShortcutCandidate,
    taskCategory: TaskCategory.Writing,
    tier: LifecycleTier.Keep,
    tierEnteredAt: '2026-01-01T00:00:00Z',
    keepClockExpiresAt: '2026-01-15T00:00:00Z',
    reusabilityCount: 10,
    promotionScore: 12,
    lastObservedAt: '2026-01-10T00:00:00Z',
    lastExecutedAt: '2026-01-10T00:00:00Z',
    timesPrompted: 10,
    timesAccepted: 8,
    timesDismissed: 2,
    triggerSignature: { sourceApps: ['com.android.chrome'] },
    suggestedAction: {
      type: 'shortcut',
      payload: 'intent://action',
      estimatedSecondsSaved: 45,
    },
    createdBy: 'user-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  describe('Stage 1: Recency & Activity Gate', () => {
    it('passes when activity occurred within the 14-day window', () => {
      const now = new Date('2026-01-15T00:00:00Z'); // 5 days after 2026-01-10
      const result = evaluateStage1Recency(basePattern, 14, now);
      expect(result.passes).toBe(true);
      expect(result.daysSinceLastActivity).toBe(5);
    });

    it('fails when activity is older than the window', () => {
      const now = new Date('2026-01-30T00:00:00Z'); // 20 days after 2026-01-10
      const result = evaluateStage1Recency(basePattern, 14, now);
      expect(result.passes).toBe(false);
      expect(result.daysSinceLastActivity).toBe(20);
    });
  });

  describe('Stage 2: Utility & Adoption Ratio Gate', () => {
    it('recognizes high utility when adoption is >= 60%', () => {
      const highUtilityPattern: WorkflowPattern = {
        ...basePattern,
        timesPrompted: 10,
        timesAccepted: 8, // 80% adoption
        timesDismissed: 2,
      };

      const result = evaluateStage2Utility(highUtilityPattern);
      expect(result.passes).toBe(true);
      expect(result.flag).toBe('high_utility');
      expect(result.recommendation).toBe('promote_to_keep');
      expect(result.utilityScore).toBeGreaterThan(0);
    });

    it('flags high friction when prompted >= 5 times with < 20% acceptance', () => {
      const noisyPattern: WorkflowPattern = {
        ...basePattern,
        timesPrompted: 10,
        timesAccepted: 1, // 10% adoption
        timesDismissed: 9,
      };

      const result = evaluateStage2Utility(noisyPattern);
      expect(result.passes).toBe(false);
      expect(result.flag).toBe('high_friction');
      expect(result.recommendation).toBe('demote_to_review');
    });

    it('retains neutral pattern when prompts are below threshold', () => {
      const newPattern: WorkflowPattern = {
        ...basePattern,
        timesPrompted: 2,
        timesAccepted: 0,
        timesDismissed: 2,
      };

      const result = evaluateStage2Utility(newPattern);
      expect(result.passes).toBe(true);
      expect(result.recommendation).toBe('retain');
    });
  });
});
