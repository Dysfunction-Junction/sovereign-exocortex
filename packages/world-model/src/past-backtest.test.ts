import { test, expect } from 'vitest';
import { backtestNextTopic } from './past-backtest.js';

const DAY = 86_400_000;
// A strict cycle A -> B -> C repeating: the graph should learn it, "repeat last" never can.
const cycle = ['alpha', 'beta', 'gamma'];
const sessions = Array.from({ length: 30 }, (_, i) => ({ ts: i * DAY, tags: [cycle[i % 3]!], persons: [] }));

test('learns a deterministic cycle and beats the repeat baseline', () => {
  const r = backtestNextTopic(sessions, { trainFraction: 0.7 });
  expect(r.train).toBe(21);
  expect(r.test).toBe(9);
  expect(r.model.top1).toBe(1);
  expect(r.repeatLast.top1).toBe(0);
  expect(r.mostCommon.top1).toBeLessThan(1);
  expect(r.ci95.top1[0]).toBeGreaterThan(0.6);
});

test('splits by time even when input is shuffled', () => {
  const shuffled = [...sessions].reverse();
  expect(backtestNextTopic(shuffled).model.top1).toBe(1);
});

test('refuses fewer than 2 sessions with a clear error', () => {
  expect(() => backtestNextTopic([])).toThrow(/at least 2/);
});

test('coarse overlap target also learns the cycle', async () => {
  const { backtestAnyTopic } = await import('./past-backtest.js');
  const r = backtestAnyTopic(sessions, [1]);
  expect(r.graph[1]).toBe(1);
  expect(r.repeatLast[1]).toBe(0);
});
