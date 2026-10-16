/**
 * @file comms-ladder.ts
 * Coarse-to-fine walk-forward backtest over past call/text events (Fi history joined to contacts).
 *
 * Rungs go from broad (call vs text, direction, time of day) to narrow (contact category, exact person). Each rung
 * predicts the next contact's attribute from a context, trained on the oldest slice and scored on the newer slice.
 * Consecutive events with the same person inside a short window are collapsed into one "conversation" first,
 * otherwise "same person as the last event" wins trivially from texting bursts.
 *
 * A rung has signal only if the model beats BOTH the commonest-label baseline and the persistence baseline
 * (repeat the previous label) in a paired exact sign test against the stronger one (p < 0.05).
 */

export interface CommsEvent {
  ts: number;
  type: 'call' | 'text';
  direction: 'in' | 'out' | 'missed';
  /** First participant: `person_*` for a saved contact, `anon_*` for an unsaved number. */
  person: string;
  labels: string[];
  hour: number; // local 0-23
  dow: number; // local 0-6, Sunday = 0
}

export interface CommsRow {
  level: string;
  classes: number;
  n: number;
  top1: number;
  top3: number;
  /** Top-3 of the commonest-three baseline, for a fair comparison with top3. */
  baseline3: number;
  baseline: number;
  persistence: number;
  p: number;
  verdict: 'signal' | 'no signal' | 'too few cases';
}

const daypart = (h: number): string => (h < 6 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening');
const known = (e: CommsEvent): boolean => e.person.startsWith('person_');
const category = (e: CommsEvent): string => (e.labels.includes('family') ? 'family' : (e.labels[0] ?? 'unlabeled'));

/** Merge runs of events with the same person that follow each other within `minutes`. Keeps the first event. */
export function collapseConversations(events: CommsEvent[], minutes = 30): CommsEvent[] {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const out: CommsEvent[] = [];
  const lastTs = new Map<string, number>();
  for (const e of sorted) {
    const prev = lastTs.get(e.person);
    lastTs.set(e.person, e.ts);
    const sameRun = prev !== undefined && e.ts - prev <= minutes * 60_000;
    if (!sameRun) out.push(e);
  }
  return out;
}

interface Rung {
  name: string;
  pool: (e: CommsEvent) => boolean;
  y: (e: CommsEvent) => string;
  ctx: (e: CommsEvent, prev: CommsEvent | undefined) => string | null;
}

const RUNGS: Rung[] = [
  { name: '1 call vs text', pool: () => true, y: (e) => e.type, ctx: (_e, p) => p?.type ?? null },
  { name: '2 direction (in/out/missed)', pool: () => true, y: (e) => e.direction, ctx: (_e, p) => p?.direction ?? null },
  { name: '3 time of day', pool: () => true, y: (e) => daypart(e.hour), ctx: (_e, p) => (p ? daypart(p.hour) : null) },
  { name: '4 contact category | previous category', pool: known, y: category, ctx: (_e, p) => (p ? category(p) : null) },
  { name: '5a who | previous person', pool: known, y: (e) => e.person, ctx: (_e, p) => p?.person ?? null },
  { name: '5b who | weekday + time of day', pool: known, y: (e) => e.person, ctx: (e) => `${e.dow}-${daypart(e.hour)}` },
];

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

const ranked = (m: Map<string, number> | undefined): string[] =>
  m ? [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k) : [];

export function backtestComms(
  events: CommsEvent[],
  opts: { trainFraction?: number; collapseMinutes?: number; minCases?: number } = {},
): { events: number; conversations: number; rows: CommsRow[] } {
  if (events.length < 20) throw new Error('backtest needs at least 20 events');
  const convo = collapseConversations(events, opts.collapseMinutes ?? 30);
  const trainTs = convo[Math.max(0, Math.floor(convo.length * (opts.trainFraction ?? 0.7)) - 1)]!.ts;
  const minCases = opts.minCases ?? 30;

  const rows = RUNGS.map((rung): CommsRow => {
    const pool = convo.filter(rung.pool);
    const items = pool.map((e, i) => ({ ts: e.ts, y: rung.y(e), ctx: rung.ctx(e, pool[i - 1]), prevY: pool[i - 1] ? rung.y(pool[i - 1]!) : null }));
    const train = items.filter((x) => x.ts <= trainTs);
    const test = items.filter((x) => x.ts > trainTs);

    const marginal = new Map<string, number>();
    const cond = new Map<string, Map<string, number>>();
    for (const x of train) {
      marginal.set(x.y, (marginal.get(x.y) ?? 0) + 1);
      if (x.ctx !== null) {
        const row = cond.get(x.ctx) ?? new Map<string, number>();
        row.set(x.y, (row.get(x.y) ?? 0) + 1);
        cond.set(x.ctx, row);
      }
    }
    const base = ranked(marginal);

    let m1 = 0, m3 = 0, b1 = 0, b3 = 0, q1 = 0, onlyM = 0, onlyB = 0;
    const res = test.map((x) => {
      const rk = [...ranked(x.ctx !== null ? cond.get(x.ctx) : undefined)];
      for (const k of base) if (!rk.includes(k)) rk.push(k);
      return { m1: rk[0] === x.y, m3: rk.slice(0, 3).includes(x.y), b1: base[0] === x.y, b3: base.slice(0, 3).includes(x.y), q1: x.prevY === x.y };
    });
    for (const r of res) {
      if (r.m1) m1++;
      if (r.m3) m3++;
      if (r.b1) b1++;
      if (r.b3) b3++;
      if (r.q1) q1++;
    }
    const strong: 'b1' | 'q1' = q1 > b1 ? 'q1' : 'b1';
    for (const r of res) {
      if (r.m1 && !r[strong]) onlyM++;
      if (r[strong] && !r.m1) onlyB++;
    }
    const n = res.length;
    const p = signTest(onlyM, onlyB);
    return {
      level: rung.name,
      classes: marginal.size,
      n,
      top1: n ? m1 / n : 0,
      top3: n ? m3 / n : 0,
      baseline3: n ? b3 / n : 0,
      baseline: n ? b1 / n : 0,
      persistence: n ? q1 / n : 0,
      p,
      verdict: n < minCases ? 'too few cases' : p < 0.05 && m1 > Math.max(b1, q1) ? 'signal' : 'no signal',
    };
  });
  return { events: events.length, conversations: convo.length, rows };
}
