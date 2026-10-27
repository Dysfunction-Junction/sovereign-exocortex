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
import type { PastSession } from './past-seed.js';

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

/** Backtests intentionally use transient tag topics; these never enter the production life graph. */
function seedBacktestGraph(graph: LivingLifeGraph, sessions: PastSession[], minCount: number): void {
  const counts = new Map<string, number>();
  for (const session of sessions) for (const id of topicIds(session)) counts.set(id, (counts.get(id) ?? 0) + 1);
  const kept = new Set([...counts].filter(([, count]) => count >= minCount).map(([id]) => id));
  for (const id of kept) graph.addEntity({ id, type: 'TOPIC', name: id.slice(6) });
  const main = sessions.map((session) => topicIds(session).filter((id) => kept.has(id)).sort((a, b) => counts.get(b)! - counts.get(a)! || a.localeCompare(b))[0]);
  for (let i = 0; i + 1 < main.length; i++) if (main[i] && main[i + 1] && main[i] !== main[i + 1]) graph.addEdge(main[i]!, main[i + 1]!, 'TRANSITIONS_TO', 1);
}

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
  seedBacktestGraph(graph, train, minCount);
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

export interface OverlapReport {
  evaluated: number;
  /** Hit rate when ANY of a session's recurring topics is among the top-k predictions. */
  graph: Record<number, number>;
  mostCommon: Record<number, number>;
  /** The previous session's own topics, ranked by training frequency. */
  repeatLast: Record<number, number>;
  ci95Graph: Record<number, [number, number]>;
}

/**
 * Coarser target: does the next session touch any of the top-k predicted topics? The graph ranking sums
 * next-topic probabilities over all of the previous session's recurring topics.
 */
export function backtestAnyTopic(sessions: PastSession[], ks = [1, 3, 5], opts: BacktestOptions = {}): OverlapReport {
  if (sessions.length < 2) throw new Error('backtest needs at least 2 sessions');
  const minCount = opts.minTopicCount ?? 2;
  const ordered = [...sessions].sort((a, b) => a.ts - b.ts);
  const split = Math.max(1, Math.min(ordered.length - 1, Math.floor(ordered.length * (opts.trainFraction ?? 0.7))));
  const train = ordered.slice(0, split);

  const counts = new Map<string, number>();
  for (const s of train) for (const id of topicIds(s)) counts.set(id, (counts.get(id) ?? 0) + 1);
  const kept = new Set([...counts].filter(([, c]) => c >= minCount).map(([id]) => id));
  const byFreq = (a: string, b: string) => counts.get(b)! - counts.get(a)! || a.localeCompare(b);
  const keptOf = (s: PastSession) => topicIds(s).filter((i) => kept.has(i)).sort(byFreq);

  const graph = new LivingLifeGraph();
  seedBacktestGraph(graph, train, minCount);
  const common = [...kept].sort(byFreq);

  const hits = { graph: {} as Record<number, number>, common: {} as Record<number, number>, repeat: {} as Record<number, number> };
  for (const k of ks) hits.graph[k] = hits.common[k] = hits.repeat[k] = 0;
  let evaluated = 0;
  for (let i = split; i < ordered.length; i++) {
    const truth = new Set(keptOf(ordered[i]!));
    const prev = keptOf(ordered[i - 1]!);
    if (truth.size === 0) continue;
    evaluated++;
    const score = new Map<string, number>();
    for (const p of prev) for (const n of graph.predictNextState(p)) score.set(n.predictedId, (score.get(n.predictedId) ?? 0) + n.probability);
    const gRank = [...score].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
    for (const k of ks) {
      if (gRank.slice(0, k).some((t) => truth.has(t))) hits.graph[k]!++;
      if (common.slice(0, k).some((t) => truth.has(t))) hits.common[k]!++;
      if (prev.slice(0, k).some((t) => truth.has(t))) hits.repeat[k]!++;
    }
  }
  const rate = (h: Record<number, number>) => Object.fromEntries(ks.map((k) => [k, evaluated ? h[k]! / evaluated : 0]));
  return {
    evaluated,
    graph: rate(hits.graph),
    mostCommon: rate(hits.common),
    repeatLast: rate(hits.repeat),
    ci95Graph: Object.fromEntries(ks.map((k) => [k, wilson(hits.graph[k]!, evaluated)])) as Record<number, [number, number]>,
  };
}
