import { applyDecay, boostScoreOnObservation } from './decay.js';
import { CONSTANTS, LifecycleTier, WorkflowPattern } from './types.js';

export interface PoolUpdateResult {
  pool: WorkflowPattern[];
  insertedOrUpdated: boolean;
  evicted?: WorkflowPattern;
}

/**
 * Manages the bounded Candidate Promotion Pool using LFU-with-decay.
 */
export class CandidatePool {
  private capacity: number;

  constructor(capacity: number = CONSTANTS.CANDIDATE_POOL_CAPACITY) {
    this.capacity = capacity;
  }

  /**
   * Updates existing candidate or inserts a new one if score beats the weakest occupant.
   */
  public addOrUpdate(
    currentPool: WorkflowPattern[],
    candidate: WorkflowPattern,
    weight: number = 1.0,
    now: Date = new Date()
  ): PoolUpdateResult {
    // 1. Decay all existing candidates up to current time
    // lastObservedAt is advanced to `now` for non-touched items so the decay is not
    // re-applied from the stale timestamp on the next call (compounding double-decay).
    const nowValid = now instanceof Date && !isNaN(now.getTime());
    const updatedPool = currentPool.map((item) => {
      const decayed = applyDecay(item.promotionScore, item.lastObservedAt, now);
      return {
        ...item,
        promotionScore: decayed,
        ...(nowValid ? { lastObservedAt: now.toISOString() } : {}),
      };
    });

    const existingIndex = updatedPool.findIndex((item) => item.id === candidate.id);

    // Case A: Existing candidate in pool -> boost score
    if (existingIndex >= 0) {
      const existing = updatedPool[existingIndex];
      const newScore = boostScoreOnObservation(existing.promotionScore, weight);
      updatedPool[existingIndex] = {
        ...existing,
        promotionScore: newScore,
        lastObservedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      return { pool: updatedPool, insertedOrUpdated: true };
    }

    // Prepare new candidate with initial score
    const newCandidateScore = boostScoreOnObservation(candidate.promotionScore || 0, weight);
    const preparedCandidate: WorkflowPattern = {
      ...candidate,
      tier: LifecycleTier.Candidate,
      tierEnteredAt: candidate.tier === LifecycleTier.Candidate ? candidate.tierEnteredAt : now.toISOString(),
      promotionScore: newCandidateScore,
      lastObservedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    // Case B: Pool has available capacity
    if (updatedPool.length < this.capacity) {
      return {
        pool: [...updatedPool, preparedCandidate],
        insertedOrUpdated: true,
      };
    }

    // Case C: Pool is full -> find weakest occupant
    if (updatedPool.length === 0) {
      // Zero/invalid capacity: nothing to evict and nothing may be inserted
      return { pool: updatedPool, insertedOrUpdated: false };
    }
    let minIndex = 0;
    let minScore = updatedPool[0].promotionScore;

    for (let i = 1; i < updatedPool.length; i++) {
      if (updatedPool[i].promotionScore < minScore) {
        minScore = updatedPool[i].promotionScore;
        minIndex = i;
      }
    }

    // Only evict if the new candidate beats the weakest occupant
    if (newCandidateScore > minScore) {
      const evicted = updatedPool[minIndex];
      const newPool = [...updatedPool];
      newPool[minIndex] = preparedCandidate;
      return {
        pool: newPool,
        insertedOrUpdated: true,
        evicted,
      };
    }

    // Rejected: candidate score did not beat minimum
    return {
      pool: updatedPool,
      insertedOrUpdated: false,
    };
  }

  /**
   * Sorts candidates by decayed score descending.
   */
  public rankCandidates(pool: WorkflowPattern[], now: Date = new Date()): WorkflowPattern[] {
    const currentIso = (now instanceof Date ? now : new Date()).toISOString();
    return [...pool]
      .map((item) => ({
        ...item,
        promotionScore: applyDecay(item.promotionScore, item.lastObservedAt, now),
        lastObservedAt: currentIso,
      }))
      .sort((a, b) => b.promotionScore - a.promotionScore);
  }

  /**
   * Exports the bounded candidate pool, applying recency decay, sorting descending,
   * and slicing strictly to the pool capacity.
   */
  public exportPool(pool: WorkflowPattern[], now: Date = new Date()): CandidatePoolExport {
    const validCapacity = Number.isFinite(this.capacity) ? Math.max(0, this.capacity) : CONSTANTS.CANDIDATE_POOL_CAPACITY;
    const candidateOnly = pool.filter((p) => p && p.tier === LifecycleTier.Candidate);

    // Deduplicate by pattern ID, keeping the instance with highest current decayed score
    const deduplicatedMap = new Map<string, WorkflowPattern>();
    for (const item of candidateOnly) {
      if (!item.id) continue;
      const existing = deduplicatedMap.get(item.id);
      if (!existing) {
        deduplicatedMap.set(item.id, item);
      } else {
        const existingScore = applyDecay(existing.promotionScore, existing.lastObservedAt, now);
        const currentScore = applyDecay(item.promotionScore, item.lastObservedAt, now);
        if (currentScore > existingScore) {
          deduplicatedMap.set(item.id, item);
        }
      }
    }

    const uniqueCandidates = Array.from(deduplicatedMap.values());
    const ranked = this.rankCandidates(uniqueCandidates, now);
    const totalCandidates = ranked.length;
    const candidates = ranked.slice(0, validCapacity);

    return {
      capacity: validCapacity,
      totalCandidates,
      returned: candidates.length,
      exportedAt: (now instanceof Date && !isNaN(now.getTime()) ? now : new Date()).toISOString(),
      candidates,
    };
  }
}

export interface CandidatePoolExport {
  capacity: number;
  totalCandidates: number;
  returned: number;
  exportedAt: string;
  candidates: WorkflowPattern[];
}

/**
 * Convenience helper to export and rank a bounded candidate pool up to capacity.
 */
export function exportCandidatePool(
  pool: WorkflowPattern[],
  capacity: number = CONSTANTS.CANDIDATE_POOL_CAPACITY,
  now: Date = new Date()
): CandidatePoolExport {
  const candidatePool = new CandidatePool(capacity);
  return candidatePool.exportPool(pool, now);
}
