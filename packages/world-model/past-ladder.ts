/**
 * @file past-ladder.ts
 * Coarse-to-fine prediction ladder over past sessions.
 *
 * Starts with the broadest questions (weekday vs weekend, time of day) and narrows to day of week, gap to
 * the previous session, theme and finally the exact main topic. Each rung predicts a session's label from
 * the previous session's label (first-order, with back-off to the overall mode) and is scored against the
 * "always guess the commonest label" baseline on a later, time-ordered slice.
 *
 * A rung counts as having signal only if the model beats BOTH the commonest-label baseline and the persistence
 * baseline (repeat the previous label) in a paired exact sign test against the stronger of them (p < 0.05).
 * Persistence matters because sessions cluster in time, so "same day / same part of week as last time" looks
 * predictive without being a habit.
 * Time-based rungs use only sessions dated by real activity (timeBasis = range_start), in local time.
 */

import type { PastSession } from './past-seed.js';

export interface LadderRow {
  level: string;
  classes: number;
  n: number;
  model: number;
  /** Always guess the commonest training label. */
  baseline: number;
  /** Guess the previous session's label again. */
  persistence: number;
  /** Sign-test p against the stronger of the two baselines. */
  p: number;
  verdict: 'signal' | 'no signal' | 'too few cases';
}

interface Fit {
  topTags: Set<string>;
  tagCounts: Map<string, number>;
}
interface Level {
  name: string;
  timeBased: boolean;
  label: (s: PastSession, prev: PastSession | undefined, fit: Fit) => string | null;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const HOUR = 3_600_000;
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const LEVELS: Level[] = [
  { name: '1 weekday vs weekend', timeBased: true, label: (s) => ([0, 6].includes(new Date(s.ts).getDay()) ? 'weekend' : 'weekday') },
  {
    name: '2 time of day (4 parts)',
    timeBased: true,
    label: (s) => {
      const h = new Date(s.ts).getHours();
      return h < 6 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
    },
  },
  { name: '3 day of week', timeBased: true, label: (s) => DOW[new Date(s.ts).getDay()]! },
  {
    name: '4 gap since previous session',
    timeBased: true,
    label: (s, prev) => {
      if (!prev) return null;
      const g = (s.ts - prev.ts) / HOUR;
      return g < 2 ? '<2h' : g < 12 ? '2-12h' : g < 36 ? '12-36h' : '>36h';
    },
  },
  {
    name: '5 theme (8 commonest tags + other)',
    timeBased: false,
    label: (s, _p, fit) => {
      const ids = [...new Set(s.tags.map(slug).filter(Boolean))].filter((t) => fit.topTags.has(t));
      return ids.sort((a, b) => fit.tagCounts.get(b)! - fit.tagCounts.get(a)! || a.localeCompare(b))[0] ?? 'other';
    },
  },
  {
    name: '6 exact main topic',
    timeBased: false,
    label: (s, _p, fit) => {
      const ids = [...new Set(s.tags.map(slug).filter(Boolean))].filter((t) => (fit.tagCounts.get(t) ?? 0) >= 2);
      return ids.sort((a, b) => fit.tagCounts.get(b)! - fit.tagCounts.get(a)! || a.localeCompare(b))[0] ?? null;
    },
  },
];

/** Exact two-sided sign test: probability of a split at least this lopsided among discordant cases. */
function signTest(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let cdf = 0;
  let term = Math.pow(0.5, n);
  for (let i = 0; i <= k; i++) {
    cdf += term;
    term = (term * (n - i)) / (i + 1);
  }
  return Math.min(1, 2 * cdf);
}

const argmax = (m: Map<string, number> | undefined): string | undefined =>
  m && [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];

export function backtestLadder(sessions: PastSession[], opts: { trainFraction?: number; minCases?: number } = {}): LadderRow[] {
  if (sessions.length < 2) throw new Error('backtest needs at least 2 sessions');
  const ordered = [...sessions].sort((a, b) => a.ts - b.ts);
  const trainTs = ordered[Math.max(0, Math.floor(ordered.length * (opts.trainFraction ?? 0.7)) - 1)]!.ts;
  const minCases = opts.minCases ?? 10;

  const tagCounts = new Map<string, number>();
  for (const s of ordered.filter((x) => x.ts <= trainTs)) {
    for (const t of new Set(s.tags.map(slug).filter(Boolean))) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  }
  const topTags = new Set([...tagCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([t]) => t));
  const fit: Fit = { tagCounts, topTags };

  return LEVELS.map((lvl): LadderRow => {
    const pool = lvl.timeBased ? ordered.filter((s) => s.timeBasis === 'range_start') : ordered;
    const labelled = pool
      .map((s, i) => ({ s, y: lvl.label(s, pool[i - 1], fit) }))
      .filter((x): x is { s: PastSession; y: string } => x.y !== null);
    const train = labelled.filter((x) => x.s.ts <= trainTs);
    const test = labelled.filter((x) => x.s.ts > trainTs);

    const marginal = new Map<string, number>();
    const cond = new Map<string, Map<string, number>>();
    train.forEach((x, i) => {
      marginal.set(x.y, (marginal.get(x.y) ?? 0) + 1);
      const prev = train[i - 1];
      if (prev) {
        const row = cond.get(prev.y) ?? new Map<string, number>();
        row.set(x.y, (row.get(x.y) ?? 0) + 1);
        cond.set(prev.y, row);
      }
    });
    const mode = argmax(marginal);

    const results = test.map((x, i) => {
      const prev = i === 0 ? train[train.length - 1] : test[i - 1];
      const pred = (prev && argmax(cond.get(prev.y))) || mode;
      return { m: pred === x.y, b: mode === x.y, q: prev?.y === x.y };
    });
    const n = results.length;
    const sum = (f: (r: (typeof results)[number]) => boolean) => results.filter(f).length;
    const model = sum((r) => r.m), base = sum((r) => r.b), persist = sum((r) => r.q);
    const strong: 'b' | 'q' = persist > base ? 'q' : 'b';
    const p = signTest(sum((r) => r.m && !r[strong]), sum((r) => r[strong] && !r.m));
    return {
      level: lvl.name,
      classes: marginal.size,
      n,
      model: n ? model / n : 0,
      baseline: n ? base / n : 0,
      persistence: n ? persist / n : 0,
      p,
      verdict: n < minCases ? 'too few cases' : p < 0.05 && model > Math.max(base, persist) ? 'signal' : 'no signal',
    };
  });
}
