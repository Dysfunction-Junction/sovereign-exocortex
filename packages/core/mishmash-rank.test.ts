import { isRankError, rankSuppliedCandidates, computeSurprisalFeedback } from './mishmash-rank';

describe('mishmash rank', () => {
  const now = new Date('2026-10-08T00:00:00.000Z');
  const patterns = [
    { id: 'low', promotionScore: 1, lastObservedAt: '2026-10-01T00:00:00.000Z' },
    { id: 'high', promotionScore: 10, lastObservedAt: '2026-10-01T00:00:00.000Z' },
  ];

  it('orders candidates by decayed score', () => {
    const ranked = rankSuppliedCandidates({ patterns }, now);
    expect(isRankError(ranked)).toBe(false);
    if (isRankError(ranked)) return;
    expect(ranked.order.map((item) => item.id)).toEqual(['high', 'low']);
    expect(ranked.returned).toBe(2);
  });

  it('rejects a payload that is not a pattern list or event list', () => {
    const ranked = rankSuppliedCandidates({ patterns: [{ promotionScore: 1 }] }, now);
    expect(isRankError(ranked)).toBe(true);
  });

  it('clusters ambient telemetry events by package and ranks them', () => {
    const events = [
      { package: 'com.android.chrome', app_label: 'Chrome', timestamp: '2026-10-07T12:00:00.000Z' },
      { package: 'com.android.chrome', app_label: 'Chrome', timestamp: '2026-10-07T13:00:00.000Z' },
      { package: 'com.google.android.keep', app_label: 'Keep', timestamp: '2026-10-07T11:00:00.000Z' },
    ];
    const ranked = rankSuppliedCandidates({ events }, now);
    expect(isRankError(ranked)).toBe(false);
    if (isRankError(ranked)) return;
    expect(ranked.returned).toBe(2);
    expect(ranked.order[0].id).toBe('cluster-com.android.chrome');
    expect(ranked.order[1].id).toBe('cluster-com.google.android.keep');
  });

  it('computes low surprisal and positive reinforcement on approved feedback', () => {
    const result = computeSurprisalFeedback({
      candidateId: 'cluster-com.android.chrome',
      outcome: 'approved',
    });
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.surprisalScore).toBeLessThan(1.0);
    expect(result.weightMultiplier).toBeGreaterThan(1.0);
    expect(result.demoteRecommended).toBe(false);
    expect(result.feedbackId.startsWith('fbk_')).toBe(true);
  });

  it('computes high surprisal and recommends demotion on undone/rejected feedback', () => {
    const result = computeSurprisalFeedback({
      candidateId: 'cluster-com.android.chrome',
      outcome: 'undone',
    });
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.surprisalScore).toBeGreaterThan(3.0);
    expect(result.weightMultiplier).toBeLessThan(0.5);
    expect(result.demoteRecommended).toBe(true);
  });

  it('normalizes aliases and handles dismissed outcome', () => {
    const aliasApprove = computeSurprisalFeedback({
      candidateId: 'cluster-com.android.chrome',
      actionType: 'approve',
    });
    expect('error' in aliasApprove).toBe(false);
    if (!('error' in aliasApprove)) {
      expect(aliasApprove.outcome).toBe('approved');
      expect(aliasApprove.weightMultiplier).toBe(1.25);
    }

    const dismissed = computeSurprisalFeedback({
      candidateId: 'cluster-com.android.chrome',
      outcome: 'dismissed',
    });
    expect('error' in dismissed).toBe(false);
    if (!('error' in dismissed)) {
      expect(dismissed.outcome).toBe('dismissed');
      expect(dismissed.weightMultiplier).toBe(0.7);
      expect(dismissed.demoteRecommended).toBe(false);
    }
  });

  it('fails closed when outcome is missing or conflicting', () => {
    const noOutcome = computeSurprisalFeedback({
      candidateId: 'cluster-com.android.chrome',
    });
    expect('error' in noOutcome).toBe(true);

    const conflicting = computeSurprisalFeedback({
      candidateId: 'cluster-com.android.chrome',
      outcome: 'approved',
      actionType: 'undone',
    });
    expect('error' in conflicting).toBe(true);

    const unknownOutcome = computeSurprisalFeedback({
      candidateId: 'cluster-com.android.chrome',
      outcome: 'exploding_fireball',
    });
    expect('error' in unknownOutcome).toBe(true);

    const missingCandidate = computeSurprisalFeedback({
      outcome: 'approved',
    });
    expect('error' in missingCandidate).toBe(true);
  });
});
