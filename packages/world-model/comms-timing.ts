/**
 * @file comms-timing.ts
 * Walk-forward backtest of WHEN recurring contacts reach out, for the top-N contacts.
 *
 * Two questions per contact, both scored on days after the training cut:
 *   T1/T2  Will this contact be in touch today?   (probability from weekday, optionally + yesterday)
 *   T3     If so, at what hour is the first contact? (circular mean of that contact's past first-contact hours)
 *
 * Baselines: the contact's overall daily rate / the pooled hour of all top contacts, and persistence
 * (same as yesterday / same hour as the last active day). A rung has signal only if the model beats the stronger
 * baseline in a paired exact sign test on per-day error (p < 0.05) AND lowers mean error by at least 10%, so a
 * statistically detectable but practically negligible edge is not called signal. Results are pooled across contacts and reported
 * by rank only, never by name.
 */

import type { CommsEvent } from './comms-ladder.js';

const H = 3_600_000;
const D = 24 * H;

export interface TimingRow {
  level: string;
  contacts: number;
  n: number;
  /** Mean error (Brier for T1/T2, hours for T3). Lower is better. */
  model: number;
  baseline: number;
  persistence: number;
  /** Share of days predicted correctly (T1/T2) or first contacts within 2 hours (T3). */
  hit: number;
  p: number;
  verdict: 'signal' | 'no signal' | 'too few cases';
}

interface Located {
  person: string;
  day: number; // local day index
  dow: number;
  hour: number;
}

function locate(e: CommsEvent): Located {
  // Recover the fixed local offset from the stored local hour and the UTC hour.
  const utcHour = new Date(e.ts).getUTCHours();
  const off = ((e.hour - utcHour + 36) % 24) - 12;
  return { person: e.person, day: Math.floor((e.ts + off * H) / D), dow: e.dow, hour: e.hour };
}

const circDist = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 24;
  return Math.min(d, 24 - d);
};

function circMean(hours: number[]): number {
  let s = 0, c = 0;
  for (const h of hours) {
    s += Math.sin((h * 2 * Math.PI) / 24);
    c += Math.cos((h * 2 * Math.PI) / 24);
  }
  const a = Math.atan2(s, c);
  return ((a * 24) / (2 * Math.PI) + 24) % 24;
}

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

interface Acc {
  n: number;
  model: number;
  baseline: number;
  persistence: number;
  hits: number;
  better: number; // days model strictly beats the stronger baseline
  worse: number;
}

export function backtestTiming(
  events: CommsEvent[],
  opts: { trainFraction?: number; topN?: number; minTrainDays?: number; minCases?: number } = {},
): { contacts: number; rows: TimingRow[] } {
  const located = events.filter((e) => e.person.startsWith('person_')).map(locate);
  if (located.length < 50) throw new Error('backtest needs at least 50 events from saved contacts');
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const trainTs = sorted[Math.max(0, Math.floor(sorted.length * (opts.trainFraction ?? 0.7)) - 1)]!.ts;
  const trainEndDay = locate(sorted.find((e) => e.ts >= trainTs)!).day;
  const lastDay = Math.max(...located.map((l) => l.day));
  const minTrainDays = opts.minTrainDays ?? 30;
  const minCases = opts.minCases ?? 30;

  // Active days per contact (and first-contact hour per active day).
  const byPerson = new Map<string, Map<number, Located>>();
  for (const l of located) {
    const days = byPerson.get(l.person) ?? new Map<number, Located>();
    const cur = days.get(l.day);
    if (!cur || l.hour < cur.hour) days.set(l.day, l);
    byPerson.set(l.person, days);
  }
  const trainActive = (days: Map<number, Located>) => [...days.keys()].filter((d) => d <= trainEndDay).length;
  const top = [...byPerson.entries()]
    .map(([person, days]) => ({ person, days, trainDays: trainActive(days) }))
    .filter((x) => x.trainDays >= minTrainDays)
    .sort((a, b) => b.trainDays - a.trainDays)
    .slice(0, opts.topN ?? 10);

  // Pooled hour baseline: circular mean of every top contact's training first-contact hours.
  const pooledHour = circMean(top.flatMap((t) => [...t.days.values()].filter((l) => l.day <= trainEndDay).map((l) => l.hour)));

  const t1: Acc = { n: 0, model: 0, baseline: 0, persistence: 0, hits: 0, better: 0, worse: 0 };
  const t2: Acc = { ...t1 };
  const t3: Acc = { ...t1 };
  let t3hits = 0;

  for (const t of top) {
    const first = Math.min(...t.days.keys());
    const trainSpan: number[] = [];
    for (let d = first; d <= trainEndDay; d++) trainSpan.push(d);
    const dowOf = (d: number) => (new Date(d * D).getUTCDay());
    const act = (d: number) => (t.days.has(d) ? 1 : 0);

    const overall = trainSpan.reduce((s, d) => s + act(d), 0) / trainSpan.length;
    const byDow = new Map<number, { a: number; n: number }>();
    const byDowPrev = new Map<string, { a: number; n: number }>();
    for (const d of trainSpan) {
      const w = byDow.get(dowOf(d)) ?? { a: 0, n: 0 };
      w.a += act(d);
      w.n++;
      byDow.set(dowOf(d), w);
      const k = `${dowOf(d)}|${act(d - 1)}`;
      const w2 = byDowPrev.get(k) ?? { a: 0, n: 0 };
      w2.a += act(d);
      w2.n++;
      byDowPrev.set(k, w2);
    }
    const rate = (w: { a: number; n: number } | undefined, fallback: number) => (w ? (w.a + fallback * 2) / (w.n + 2) : fallback);

    for (let d = trainEndDay + 1; d <= lastDay; d++) {
      const y = act(d);
      const pDow = rate(byDow.get(dowOf(d)), overall);
      const pDowPrev = rate(byDowPrev.get(`${dowOf(d)}|${act(d - 1)}`), pDow);
      const pers = act(d - 1);
      for (const [acc, p] of [[t1, pDow], [t2, pDowPrev]] as const) {
        const me = (p - y) ** 2;
        const be = (overall - y) ** 2;
        const pe = (pers - y) ** 2;
        acc.n++;
        acc.model += me;
        acc.baseline += be;
        acc.persistence += pe;
        if ((p >= 0.5 ? 1 : 0) === y) acc.hits++;
        const strong = Math.min(be, pe);
        if (me < strong - 1e-12) acc.better++;
        else if (strong < me - 1e-12) acc.worse++;
      }
    }

    // T3: first-contact hour on active test days.
    const trainHours = [...t.days.values()].filter((l) => l.day <= trainEndDay).map((l) => l.hour);
    const modelHour = circMean(trainHours);
    let lastHour: number | null = null;
    for (const l of [...t.days.values()].sort((a, b) => a.day - b.day)) {
      if (l.day > trainEndDay && lastHour !== null) {
        const me = circDist(modelHour, l.hour);
        const be = circDist(pooledHour, l.hour);
        const pe = circDist(lastHour, l.hour);
        t3.n++;
        t3.model += me;
        t3.baseline += be;
        t3.persistence += pe;
        if (me <= 2) t3hits++;
        const strong = Math.min(be, pe);
        if (me < strong - 1e-9) t3.better++;
        else if (strong < me - 1e-9) t3.worse++;
      }
      lastHour = l.hour;
    }
  }

  const row = (level: string, a: Acc, hits: number): TimingRow => {
    const n = a.n || 1;
    const p = signTest(a.better, a.worse);
    // Statistical AND practical: at least 10% lower mean error than the stronger baseline.
    const beatsBoth = a.model <= 0.9 * Math.min(a.baseline, a.persistence);
    return {
      level,
      contacts: top.length,
      n: a.n,
      model: a.model / n,
      baseline: a.baseline / n,
      persistence: a.persistence / n,
      hit: hits / n,
      p,
      verdict: a.n < minCases ? 'too few cases' : p < 0.05 && beatsBoth ? 'signal' : 'no signal',
    };
  };
  return {
    contacts: top.length,
    rows: [
      row('T1 contact today? | weekday (Brier)', t1, t1.hits),
      row('T2 contact today? | weekday + yesterday (Brier)', t2, t2.hits),
      row('T3 hour of first contact (hours off)', t3, t3hits),
    ],
  };
}
