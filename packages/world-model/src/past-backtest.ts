/**
 * @file past-backtest.ts
 * Walk-forward backtest of the life graph's "what topic comes next" prediction on past sessions.
 *
 * Split by time (never shuffled): the graph is seeded from the oldest `trainFraction` of sessions, then for
 * each later session we predict its main topic from the previous session's main topic and score the ranking.
 * The graph is static during the test (no peeking, no online updating), which is the conservative setting.
 * Baselines: always the most common training topic, and "same topic as last session".
 */

import { LivingLifeGraph } from './life-graph.js';
import { seedFromPastSessions, type PastSession } from './past-seed.js';

export interface BacktestOptions {
  trainFraction?: number;
  minTopicCount?: number;
}

export interface Score {
  top1: number;
  top3: number;
  mrr: number;
  /** Fraction of test cases where the method produced any ranking. */
  coverage: number;
}

export interface BacktestReport {
  train: number;
  test: number;
  evaluated: number;
  model: Score;
  mostCommon: Score;
  repeatLast: Score;
  /** 95% Wilson interval for model top-1 and top-3 hit rates. */
  ci95: { top1: [number, number]; top3: [number, number] };
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const topicIds = (s: PastSession): string[] => [...new Set(s.tags.map(slug).filter(Boolean))].map((x) => `topic_${x}`);

function wilson(hits: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96, p = hits / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

export function backtestNextTopic(sessions: PastSession[], opts: BacktestOptions = {}): BacktestReport {
  const minCount = opts.minTopicCount ?? 2;
  if (sessions.length < 2) throw new Error('backtest needs at least 2 sessions');
  const ordered = [...sessions].sort((a, b) => a.ts - b.ts);
  const split = Math.max(1, Math.min(ordered.length - 1, Math.floor(ordered.length * (opts.trainFraction ?? 0.7))));
  const train = ordered.slice(0, split);

  const counts = new Map<string, number>();
  for (const s of train) for (const id of topicIds(s)) counts.set(id, (counts.get(id) ?? 0) + 1);
  const kept = new Set([...counts].filter(([, c]) => c >= minCount).map(([id]) => id));
  const main = (s: PastSession): string | undefined =>
    topicIds(s).filter((i) => kept.has(i)).sort((a, b) => counts.get(b)! - counts.get(a)! || a.localeCompare(b))[0];

  const graph = new LivingLifeGraph();
  seedFromPastSessions(graph, train, { now: train[train.length - 1]!.ts, minTopicCount: minCount });
  const common = [...kept].sort((a, b) => counts.get(b)! - counts.get(a)! || a.localeCompare(b));

  const tally = () => ({ n: 0, ranked: 0, top1: 0, top3: 0, rr: 0 });
  const acc = { model: tally(), mostCommon: tally(), repeatLast: tally() };
  const score = (t: ReturnType<typeof tally>, ranking: string[], truth: string) => {
    t.n++;
    if (ranking.length === 0) return;
    t.ranked++;
    const r = ranking.indexOf(truth);
    if (r === 0) t.top1++;
    if (r >= 0 && r < 3) t.top3++;
    if (r >= 0) t.rr += 1 / (r + 1);
  };

  let evaluated = 0;
  for (let i = split; i < ordered.length; i++) {
    const truth = main(ordered[i]!);
    const prev = main(ordered[i - 1]!);
    if (!truth) continue; // nothing recurring to predict
    evaluated++;
    score(acc.model, prev ? graph.predictNextState(prev).map((p) => p.predictedId) : [], truth);
    score(acc.mostCommon, common, truth);
    score(acc.repeatLast, prev ? [prev] : [], truth);
  }

  const fin = (t: ReturnType<typeof tally>): Score => ({
    top1: t.n ? t.top1 / t.n : 0,
    top3: t.n ? t.top3 / t.n : 0,
    mrr: t.n ? t.rr / t.n : 0,
    coverage: t.n ? t.ranked / t.n : 0,
  });
  return {
    train: train.length,
    test: ordered.length - split,
    evaluated,
    model: fin(acc.model),
    mostCommon: fin(acc.mostCommon),
    repeatLast: fin(acc.repeatLast),
    ci95: { top1: wilson(acc.model.top1, acc.model.n), top3: wilson(acc.model.top3, acc.model.n) },
  };
}
