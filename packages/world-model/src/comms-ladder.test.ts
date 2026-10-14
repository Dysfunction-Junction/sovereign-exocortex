import { test, expect } from 'vitest';
import { backtestComms, collapseConversations, type CommsEvent } from './comms-ladder.js';

const H = 3_600_000;
const D = 24 * H;
const t0 = Date.UTC(2026, 0, 5); // a Monday, 00:00 UTC

const ev = (i: number, person: string, hour: number, extra: Partial<CommsEvent> = {}): CommsEvent => ({
  ts: t0 + i * D + hour * H,
  type: 'call',
  direction: 'in',
  person,
  labels: [],
  hour,
  dow: new Date(t0 + i * D).getUTCDay(),
  ...extra,
});

test('collapseConversations merges bursts with the same person only', () => {
  const burst = [0, 1, 2, 3].map((m) => ({ ...ev(0, 'person_a', 9), ts: t0 + 9 * H + m * 60_000 }));
  const other = { ...ev(0, 'person_b', 9), ts: t0 + 9 * H + 90_000 };
  const out = collapseConversations([...burst, other], 30);
  expect(out.map((e) => e.person).sort()).toEqual(['person_a', 'person_b']);
});

test('finds signal when a person always contacts at the same weekday/time', () => {
  // person_a every morning, person_b every evening, strictly alternating by time of day.
  const events: CommsEvent[] = [];
  for (let d = 0; d < 80; d++) {
    events.push(ev(d, 'person_a', 9));
    events.push(ev(d, 'person_b', 19));
  }
  const r = backtestComms(events);
  const who = r.rows.find((x) => x.level.startsWith('5b'))!;
  expect(who.top1).toBe(1);
  expect(who.verdict).toBe('signal');
});

test('pure noise is not called signal', () => {
  let x = 11;
  const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  const people = ['person_a', 'person_b', 'person_c', 'person_d'];
  const events = Array.from({ length: 400 }, (_, i) =>
    ev(Math.floor(i / 4), people[Math.floor(rnd() * 4)]!, Math.floor(rnd() * 24), { type: rnd() < 0.5 ? 'call' : 'text' }),
  );
  const r = backtestComms(events);
  expect(r.rows.filter((row) => row.verdict === 'signal').length).toBeLessThanOrEqual(1);
});

test('refuses tiny input', () => {
  expect(() => backtestComms([ev(0, 'person_a', 9)])).toThrow(/at least 20/);
});
