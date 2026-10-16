import { test, expect } from 'vitest';
import { backtestTiming } from './comms-timing.js';
import type { CommsEvent } from './comms-ladder.js';

const H = 3_600_000;
const D = 24 * H;
const t0 = Date.UTC(2026, 0, 5, 5); // Monday 00:00 at -05:00

function ev(day: number, person: string, hour: number): CommsEvent {
  const ts = t0 + day * D + hour * H;
  const local = new Date(ts - 5 * H);
  return { ts, type: 'call', direction: 'in', person, labels: [], hour: local.getUTCHours(), dow: local.getUTCDay() };
}

let seed = 5;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

test('finds signal for a contact who reaches out on a fixed weekday around the same hour', () => {
  const events: CommsEvent[] = [];
  for (let d = 0; d < 400; d++) {
    if (d % 7 === 0) events.push(ev(d, 'person_weekly', 8 + Math.floor(rnd() * 3))); // Mondays 8-10h
    if (rnd() < 0.5) events.push(ev(d, 'person_noise', Math.floor(rnd() * 24)));
  }
  const r = backtestTiming(events, { topN: 2, minTrainDays: 20 });
  const t1 = r.rows.find((x) => x.level.startsWith('T1'))!;
  expect(t1.model).toBeLessThan(t1.baseline);
  expect(t1.verdict).toBe('signal');
});

test('random contacts are not called signal', () => {
  const events: CommsEvent[] = [];
  for (let d = 0; d < 400; d++) {
    for (const p of ['person_a', 'person_b', 'person_c']) if (rnd() < 0.4) events.push(ev(d, p, Math.floor(rnd() * 24)));
  }
  const r = backtestTiming(events, { topN: 3, minTrainDays: 20 });
  expect(r.rows.filter((x) => x.verdict === 'signal').length).toBeLessThanOrEqual(1);
});

test('refuses tiny input', () => {
  expect(() => backtestTiming([ev(0, 'person_a', 9)])).toThrow(/at least 50/);
});
