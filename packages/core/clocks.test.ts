import { calculateKeepExpiry, daysUntilExpiry, evaluateClockTransitions, isClockExpired } from './clocks';
import { LifecycleTier, PatternKind, TaskCategory, WorkflowPattern } from './types';

describe('Decay Clocks & Expiry', () => {
  const basePattern: WorkflowPattern = {
    id: 'pattern-1',
    name: 'Export to Sheet',
    description: 'Quick export shortcut',
    kind: PatternKind.ShortcutCandidate,
    taskCategory: TaskCategory.Productivity,
    tier: LifecycleTier.Keep,
    tierEnteredAt: '2026-01-01T00:00:00Z',
    keepClockExpiresAt: '2026-01-15T00:00:00Z',
    reusabilityCount: 5,
    promotionScore: 10,
    lastObservedAt: '2026-01-01T00:00:00Z',
    lastExecutedAt: '2026-01-01T00:00:00Z',
    timesPrompted: 5,
    timesAccepted: 4,
    timesDismissed: 1,
    triggerSignature: { sourceApps: ['com.example.app'] },
    createdBy: 'user-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  it('calculates 14-day expiry accurately', () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    const expiry = calculateKeepExpiry(t0);
    const diffDays = (expiry.getTime() - t0.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBe(14);
  });

  it('correctly reports expired and unexpired timestamps', () => {
    const expiry = new Date('2026-01-15T00:00:00Z');
    expect(isClockExpired(expiry, new Date('2026-01-14T23:59:59Z'))).toBe(false);
    expect(isClockExpired(expiry, new Date('2026-01-15T00:00:01Z'))).toBe(true);
  });

  it('calculates remaining days until expiry', () => {
    const expiry = new Date('2026-01-15T00:00:00Z');
    const now = new Date('2026-01-11T00:00:00Z');
    expect(daysUntilExpiry(expiry, now)).toBe(4);
  });

  it('transitions Keep item to Review when 14-day clock expires', () => {
    const now = new Date('2026-01-16T00:00:00Z'); // 1 day past 2026-01-15
    const result = evaluateClockTransitions(basePattern, now);

    expect(result.changed).toBe(true);
    expect(result.nextTier).toBe(LifecycleTier.Review);
    expect(result.reviewReason).toBe('dormant');
  });

  it('maintains Keep tier when clock is unexpired', () => {
    const now = new Date('2026-01-10T00:00:00Z');
    const result = evaluateClockTransitions(basePattern, now);

    expect(result.changed).toBe(false);
    expect(result.nextTier).toBe(LifecycleTier.Keep);
  });

  it('transitions Review item to Archive when 14 additional days elapse', () => {
    const reviewPattern: WorkflowPattern = {
      ...basePattern,
      tier: LifecycleTier.Review,
      tierEnteredAt: '2026-01-15T00:00:00Z',
    };

    const day13InReview = new Date('2026-01-28T00:00:00Z');
    expect(evaluateClockTransitions(reviewPattern, day13InReview).changed).toBe(false);

    const day15InReview = new Date('2026-01-30T00:00:00Z');
    const result = evaluateClockTransitions(reviewPattern, day15InReview);
    expect(result.changed).toBe(true);
    expect(result.nextTier).toBe(LifecycleTier.Archive);
    expect(result.reviewReason).toBe('dormant');
  });
});
