import { test, expect } from 'vitest';
import { backtestLadder } from './past-ladder.js';

const H = 3_600_000;
const base = new Date(2026, 8, 1, 0, 0, 0).getTime(); // local midnight
// Alternating morning / evening sessions: time of day is perfectly predictable from the previous session.
const alt = Array.from({ length: 60 }, (_, i) => ({
  ts: base + Math.floor(i / 2) * 24 * H + (i % 2 === 0 ? 9 : 20) * H,
  tags: [i % 2 === 0 ? 'a' : 'b'],
  persons: [],
  timeBasis: 'range_start' as const,
}));

test('finds signal at the time-of-day rung when it exists', () => {
  const tod = backtestLadder(alt).find((r) => r.level.startsWith('2'))!;
  expect(tod.model).toBe(1);
  expect(tod.baseline).toBeLessThan(0.6);
  expect(tod.verdict).toBe('signal');
});

test('created-time sessions are excluded from time rungs but kept for topic rungs', () => {
  const created = alt.map((s) => ({ ...s, timeBasis: 'record_created' as const }));
  const rows = backtestLadder(created);
  expect(rows.find((r) => r.level.startsWith('2'))!.n).toBe(0);
  expect(rows.find((r) => r.level.startsWith('6'))!.n).toBeGreaterThan(0);
});

test('pure noise is not called signal', () => {
  let x = 7;
  const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  const noise = Array.from({ length: 80 }, (_, i) => ({
    ts: base + i * 7 * H + Math.floor(rnd() * 5) * H,
    tags: ['t' + Math.floor(rnd() * 3)],
    persons: [],
    timeBasis: 'range_start' as const,
  }));
  expect(backtestLadder(noise).filter((r) => r.verdict === 'signal').length).toBeLessThanOrEqual(1);
});
