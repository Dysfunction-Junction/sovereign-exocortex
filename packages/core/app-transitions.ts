/**
 * @file app-transitions.ts
 * Empirical app transition matrix & Markov model based on Android UsageStatsManager telemetry.
 *
 * Models P(to | from) transition probabilities with Laplace smoothing, computes dwell time statistics,
 * detects quick bounces (e.g. accidental opens or quick auth verification), and predicts next likely apps.
 */

export interface AppTransitionRecord {
  from: string;
  to: string;
  dwell_ms?: number;
  ts?: number;
  hour?: number;
}

export interface TransitionProbability {
  to: string;
  count: number;
  /** Maximum likelihood probability count / totalOut */
  mleProbability: number;
  /** Laplace-smoothed probability accounting for unseen state transitions */
  smoothedProbability: number;
  /** Legacy alias for mleProbability */
  probability: number;
  avgDwellMs: number;
}

export interface MarkovStateSummary {
  from: string;
  totalTransitions: number;
  topNextApps: TransitionProbability[];
  quickBounceRate: number;
}

export interface AppTransitionMarkovOptions {
  /** Dwell time threshold below which a transition is considered a quick bounce. Default 5000ms. */
  quickBounceThresholdMs?: number;
  /** Laplace add-alpha smoothing parameter. Default 1.0. */
  laplaceAlpha?: number;
  /** Max history of dwell samples preserved per pair. Default 200. */
  maxDwellSamples?: number;
}

export class AppTransitionMarkov {
  private readonly quickBounceThresholdMs: number;
  private readonly laplaceAlpha: number;
  private readonly maxDwellSamples: number;

  /** Counts of transitions from source app -> target app -> count */
  private readonly counts = new Map<string, Map<string, number>>();
  /** Total transitions leaving from each source app */
  private readonly outTotals = new Map<string, number>();
  /** Quick bounce count leaving from each source app */
  private readonly bounceCounts = new Map<string, number>();
  /** Total transitions leaving each source app where dwell time was recorded */
  private readonly dwellObservedTotals = new Map<string, number>();
  /** Dwell time samples for from -> to */
  private readonly dwellSamples = new Map<string, Map<string, number[]>>();
  /** Set of all observed application package IDs */
  private readonly vocabulary = new Set<string>();

  constructor(options: AppTransitionMarkovOptions = {}) {
    this.quickBounceThresholdMs = options.quickBounceThresholdMs ?? 5000;
    this.laplaceAlpha = options.laplaceAlpha ?? 1.0;
    this.maxDwellSamples = options.maxDwellSamples ?? 200;
  }

  /**
   * Internal helper to add transition counts without redundant loop iteration.
   */
  private addCount(from: string, to: string, count: number): void {
    const n = Math.min(Math.floor(count), 1_000_000);
    if (n <= 0) return;

    this.vocabulary.add(from);
    this.vocabulary.add(to);

    let targetMap = this.counts.get(from);
    if (!targetMap) {
      targetMap = new Map();
      this.counts.set(from, targetMap);
    }
    targetMap.set(to, (targetMap.get(to) ?? 0) + n);
    this.outTotals.set(from, (this.outTotals.get(from) ?? 0) + n);
  }

  /**
   * Records a single app transition.
   */
  public recordTransition(record: AppTransitionRecord): void {
    if (!record || typeof record.from !== 'string' || typeof record.to !== 'string') return;
    const from = record.from.trim();
    const to = record.to.trim();
    if (!from || !to || from === to) return;

    this.addCount(from, to, 1);

    // Dwell samples and quick bounce tracking
    const dwell =
      typeof record.dwell_ms === 'number' && Number.isFinite(record.dwell_ms)
        ? Math.max(0, record.dwell_ms)
        : undefined;
    if (dwell !== undefined) {
      this.dwellObservedTotals.set(from, (this.dwellObservedTotals.get(from) ?? 0) + 1);
      if (dwell < this.quickBounceThresholdMs) {
        this.bounceCounts.set(from, (this.bounceCounts.get(from) ?? 0) + 1);
      }
      let dwellTargetMap = this.dwellSamples.get(from);
      if (!dwellTargetMap) {
        dwellTargetMap = new Map();
        this.dwellSamples.set(from, dwellTargetMap);
      }
      let samples = dwellTargetMap.get(to);
      if (!samples) {
        samples = [];
        dwellTargetMap.set(to, samples);
      }
      samples.push(dwell);
      if (samples.length > this.maxDwellSamples) {
        samples.shift();
      }
    }
  }

  /**
   * Records a batch of app transitions in sequence.
   */
  public recordBatch(records: AppTransitionRecord[]): void {
    if (!Array.isArray(records)) return;
    for (const rec of records) {
      this.recordTransition(rec);
    }
  }

  /**
   * Retrieves the raw observed transition count from -> to.
   */
  public getTransitionCount(from: string, to: string): number {
    return this.counts.get(from.trim())?.get(to.trim()) ?? 0;
  }

  /**
   * Total observed transitions originating from `from`.
   */
  public getTotalTransitionsFrom(from: string): number {
    return this.outTotals.get(from.trim()) ?? 0;
  }

  /**
   * Returns whether a transition was a quick bounce.
   */
  public isQuickBounce(record: AppTransitionRecord): boolean {
    return typeof record.dwell_ms === 'number' && record.dwell_ms < this.quickBounceThresholdMs;
  }

  /**
   * Returns the bounce rate (fraction of dwell-recorded departures that lasted < quickBounceThresholdMs) for `from`.
   */
  public getQuickBounceRate(from: string): number {
    const totalDwellObserved = this.dwellObservedTotals.get(from.trim()) ?? 0;
    if (totalDwellObserved === 0) return 0;
    const bounces = this.bounceCounts.get(from.trim()) ?? 0;
    return bounces / totalDwellObserved;
  }

  /**
   * Average dwell time (ms) in `from` before transitioning to `to`.
   */
  public getAverageDwellMs(from: string, to: string): number {
    const samples = this.dwellSamples.get(from.trim())?.get(to.trim());
    if (!samples || samples.length === 0) return 0;
    const sum = samples.reduce((acc, v) => acc + v, 0);
    return Math.round(sum / samples.length);
  }

  /**
   * Calculates the Laplace-smoothed transition probability P(to | from).
   * Since self-transitions are excluded, destination domain size is |V| - 1.
   */
  public getTransitionProbability(from: string, to: string): number {
    const fromClean = from.trim();
    const toClean = to.trim();
    const count = this.getTransitionCount(fromClean, toClean);
    const totalOut = this.getTotalTransitionsFrom(fromClean);
    const validTargetVocabSize = Math.max(1, this.vocabulary.size - 1);

    // Laplace smoothing: (count + alpha) / (totalOut + alpha * (|V| - 1))
    return (count + this.laplaceAlpha) / (totalOut + this.laplaceAlpha * validTargetVocabSize);
  }

  /**
   * Predicts the most probable next applications given the current `from` package.
   */
  public predictNextApp(from: string, topK: number = 3): TransitionProbability[] {
    const fromClean = from.trim();
    const targetMap = this.counts.get(fromClean);
    if (!targetMap || targetMap.size === 0) {
      return [];
    }

    const totalOut = this.getTotalTransitionsFrom(fromClean);
    const results: TransitionProbability[] = [];

    for (const [to, count] of targetMap.entries()) {
      const mle = count / totalOut;
      const smoothed = this.getTransitionProbability(fromClean, to);
      results.push({
        to,
        count,
        mleProbability: mle,
        smoothedProbability: smoothed,
        probability: mle,
        avgDwellMs: this.getAverageDwellMs(fromClean, to),
      });
    }

    // Deterministic ordering: highest count -> highest dwell -> alphabetical
    results.sort((a, b) => b.count - a.count || b.avgDwellMs - a.avgDwellMs || a.to.localeCompare(b.to));
    return results.slice(0, Math.max(1, topK));
  }

  /**
   * Returns summary metrics for a given source app.
   */
  public getStateSummary(from: string): MarkovStateSummary {
    const fromClean = from.trim();
    return {
      from: fromClean,
      totalTransitions: this.getTotalTransitionsFrom(fromClean),
      topNextApps: this.predictNextApp(fromClean, 5),
      quickBounceRate: this.getQuickBounceRate(fromClean),
    };
  }

  /**
   * Returns all observed application package identifiers.
   */
  public getVocabulary(): string[] {
    return Array.from(this.vocabulary);
  }

  /**
   * Export the transition matrix as a prototype-pollution-safe JSON object.
   */
  public exportMatrix(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = Object.create(null);
    for (const [from, targetMap] of this.counts.entries()) {
      out[from] = Object.create(null);
      for (const [to, count] of targetMap.entries()) {
        out[from][to] = count;
      }
    }
    return out;
  }

  /**
   * Imports or merges a transition matrix safely.
   */
  public importMatrix(matrix: Record<string, Record<string, number>>): void {
    if (!matrix || typeof matrix !== 'object') return;
    for (const [from, targetMap] of Object.entries(matrix)) {
      if (!targetMap || typeof targetMap !== 'object') continue;
      for (const [to, count] of Object.entries(targetMap)) {
        if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
          this.addCount(from, to, count);
        }
      }
    }
  }

  /**
   * Resets all internal statistics.
   */
  public clear(): void {
    this.counts.clear();
    this.outTotals.clear();
    this.bounceCounts.clear();
    this.dwellObservedTotals.clear();
    this.dwellSamples.clear();
    this.vocabulary.clear();
  }
}
