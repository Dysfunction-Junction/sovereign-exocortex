import { test } from 'vitest';
import assert from 'node:assert/strict';
import { LivingLifeGraph } from './life-graph.js';
import { seedFromPastSessions } from './past-seed.js';

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 12);
const s = (daysAgo: number, tags: string[], persons: string[] = []) => ({ ts: now - daysAgo * DAY, tags, persons });

function seeded() {
  const g = new LivingLifeGraph();
  g.addEntity({ id: 'person_michael', name: 'Michael', type: 'PERSON' });
  const sessions = [
    s(9, ['Android', 'proxy']), s(8, ['Android', 'proxy']), s(7, ['bearhouse']),
    s(6, ['Android']), s(5, ['bearhouse']), s(4, ['one-off']), s(3, ['Android'], ['Sam']),
  ];
  return { g, r: seedFromPastSessions(g, sessions, { now }) };
}

test('drops one-off tags, keeps recurring topics', () => {
  const { g, r } = seeded();
  assert.equal(g.getEntity('topic_one_off'), undefined);
  assert.ok(g.getEntity('topic_android'));
  assert.equal(r.topics, 3);
  assert.equal(r.persons, 1);
});

test('recent topics are more active than old ones', () => {
  const { g } = seeded();
  assert.ok(g.getEntity('topic_android')!.activation > g.getEntity('topic_proxy')!.activation);
});

test('transition edges give a next-topic distribution', () => {
  const { g } = seeded();
  const next = g.predictNextState('topic_android');
  assert.ok(next.length > 0);
  assert.equal(next[0]!.predictedId, 'topic_bearhouse');
});

test('seeding is repeatable without changing entity count', () => {
  const { g } = seeded();
  const before = g.entityCount;
  seedFromPastSessions(g, [s(1, ['Android']), s(2, ['Android'])], { now });
  assert.equal(g.entityCount, before);
});
