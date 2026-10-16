import { CandidatePool } from './pool';
import { LifecycleTier, PatternKind, TaskCategory, WorkflowPattern } from './types';

describe('Candidate Promotion Pool (LFU-with-decay)', () => {
  const makePattern = (id: string, score: number, observedAt: string = '2026-01-01T00:00:00Z'): WorkflowPattern => ({
    id,
    name: `Pattern ${id}`,
    description: 'Test pattern',
    kind: PatternKind.Sequence,
    taskCategory: TaskCategory.Coding,
    tier: LifecycleTier.Candidate,
    tierEnteredAt: observedAt,
    keepClockExpiresAt: null,
    reusabilityCount: 0,
    promotionScore: score,
    lastObservedAt: observedAt,
    lastExecutedAt: null,
    timesPrompted: 0,
    timesAccepted: 0,
    timesDismissed: 0,
    triggerSignature: { sourceApps: ['com.test'] },
    createdBy: 'user-1',
    createdAt: observedAt,
    updatedAt: observedAt,
  });

  it('adds candidate when pool is below capacity', () => {
    const pool = new CandidatePool(3);
    const p1 = makePattern('p1', 5);
    const result = pool.addOrUpdate([], p1);

    expect(result.insertedOrUpdated).toBe(true);
    expect(result.pool).toHaveLength(1);
    expect(result.evicted).toBeUndefined();
  });

  it('updates score of existing candidate in pool', () => {
    const pool = new CandidatePool(3);
    const p1 = makePattern('p1', 5);
    const step1 = pool.addOrUpdate([], p1, 1.0);
    const step2 = pool.addOrUpdate(step1.pool, p1, 3.0);

    expect(step2.pool).toHaveLength(1);
    expect(step2.pool[0].promotionScore).toBeGreaterThan(5);
  });

  it('evicts the lowest-scoring decaying occupant when capacity is exceeded by a stronger candidate', () => {
    const pool = new CandidatePool(2);
    const now = new Date('2026-01-01T00:00:00Z');
    const p1 = makePattern('p1', 10, '2026-01-01T00:00:00Z');
    const p2 = makePattern('p2', 20, '2026-01-01T00:00:00Z');
    const initialPool = [p1, p2];

    const strongCandidate = makePattern('p3', 15, '2026-01-01T00:00:00Z');
    const result = pool.addOrUpdate(initialPool, strongCandidate, 1.0, now);

    expect(result.insertedOrUpdated).toBe(true);
    expect(result.evicted?.id).toBe('p1'); // p1 has score 10, p2 has score 20
    expect(result.pool.map((p) => p.id)).toContain('p3');
    expect(result.pool.map((p) => p.id)).toContain('p2');
    expect(result.pool.map((p) => p.id)).not.toContain('p1');
  });

  it('rejects candidate if its score cannot beat the weakest occupant', () => {
    const pool = new CandidatePool(2);
    const now = new Date('2026-01-01T00:00:00Z');
    const p1 = makePattern('p1', 10, '2026-01-01T00:00:00Z');
    const p2 = makePattern('p2', 20, '2026-01-01T00:00:00Z');
    const initialPool = [p1, p2];

    const weakCandidate = makePattern('p3', 2, '2026-01-01T00:00:00Z');
    const result = pool.addOrUpdate(initialPool, weakCandidate, 1.0, now);

    expect(result.insertedOrUpdated).toBe(false);
    expect(result.evicted).toBeUndefined();
    expect(result.pool.map((p) => p.id)).not.toContain('p3');
  });

  it('ranks candidates by decayed score descending', () => {
    const pool = new CandidatePool(5);
    const now = new Date('2026-01-31T00:00:00Z'); // 30 days later

    // p1 was observed 30 days ago with score 20 -> decays to ~10
    const p1 = makePattern('p1', 20, '2026-01-01T00:00:00Z');
    // p2 was observed recently (today) with score 15 -> stays ~15
    const p2 = makePattern('p2', 15, '2026-01-31T00:00:00Z');

    const ranked = pool.rankCandidates([p1, p2], now);
    expect(ranked[0].id).toBe('p2'); // p2 ranks higher because p1 decayed
    expect(ranked[1].id).toBe('p1');
    expect(ranked[0].lastObservedAt).toBe(now.toISOString());
    expect(ranked[1].lastObservedAt).toBe(now.toISOString());
  });

  it('updates lastObservedAt when decaying score to prevent compounding double-decay downstream', () => {
    const pool = new CandidatePool(5);
    const t0 = '2026-01-01T00:00:00Z';
    const t1 = new Date('2026-01-31T00:00:00Z');
    const p1 = makePattern('p1', 20, t0);

    const firstRank = pool.rankCandidates([p1], t1);
    const scoreAfterFirstRank = firstRank[0].promotionScore;
    expect(firstRank[0].lastObservedAt).toBe(t1.toISOString());

    // Second evaluation at the same timestamp t1 should NOT decay again
    const secondRank = pool.rankCandidates(firstRank, t1);
    expect(secondRank[0].promotionScore).toBeCloseTo(scoreAfterFirstRank, 5);
    expect(secondRank[0].lastObservedAt).toBe(t1.toISOString());
  });

  it('defaults to current timestamp if now is omitted in rankCandidates', () => {
    const pool = new CandidatePool(5);
    const p1 = makePattern('p1', 20, '2026-01-01T00:00:00Z');
    const ranked = pool.rankCandidates([p1]);
    expect(ranked[0].lastObservedAt).toBeDefined();
    expect(new Date(ranked[0].lastObservedAt).getTime()).not.toBeNaN();
  });

  it('exports bounded candidate pool with capacity enforcement and metadata', () => {
    const pool = new CandidatePool(2);
    const now = new Date('2026-01-01T00:00:00Z');
    const p1 = makePattern('p1', 10, '2026-01-01T00:00:00Z');
    const p2 = makePattern('p2', 20, '2026-01-01T00:00:00Z');
    const p3 = makePattern('p3', 30, '2026-01-01T00:00:00Z');
    // Non-candidate item should be filtered out
    const pNonCandidate = { ...makePattern('p4', 40, '2026-01-01T00:00:00Z'), tier: LifecycleTier.Keep };

    const exported = pool.exportPool([p1, p2, p3, pNonCandidate], now);
    expect(exported.capacity).toBe(2);
    expect(exported.totalCandidates).toBe(3);
    expect(exported.returned).toBe(2);
    expect(exported.candidates).toHaveLength(2);
    expect(exported.candidates[0].id).toBe('p3'); // highest score
    expect(exported.candidates[1].id).toBe('p2');
    expect(exported.exportedAt).toBe(now.toISOString());
  });

  it('deduplicates multiple candidates with the same ID, keeping the highest decayed score', () => {
    const pool = new CandidatePool(5);
    const now = new Date('2026-01-01T00:00:00Z');
    const p1Low = makePattern('p1', 5, '2026-01-01T00:00:00Z');
    const p1High = makePattern('p1', 25, '2026-01-01T00:00:00Z');
    const p2 = makePattern('p2', 15, '2026-01-01T00:00:00Z');

    const exported = pool.exportPool([p1Low, p1High, p2], now);
    expect(exported.totalCandidates).toBe(2);
    expect(exported.returned).toBe(2);
    expect(exported.candidates).toHaveLength(2);
    expect(exported.candidates[0].id).toBe('p1');
    expect(exported.candidates[0].promotionScore).toBe(25);
    expect(exported.candidates[1].id).toBe('p2');
  });
});
