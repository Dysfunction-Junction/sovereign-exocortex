import { test, expect } from 'vitest';
import { LivingLifeGraph } from './life-graph.js';
import { seedFromComms, type CommsSeedEvent } from './comms-seed.js';

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 12);

const many = (person: string, n: number, daysAgo: number, labels: string[] = []): CommsSeedEvent[] =>
  Array.from({ length: n }, (_, i) => ({ ts: now - (daysAgo + i) * DAY, person, labels }));

function seeded() {
  const g = new LivingLifeGraph();
  g.addEntity({ id: 'person_michael', name: 'Michael', type: 'PERSON' });
  const r = seedFromComms(
    g,
    [
      ...many('person_mom', 40, 1, ['family']),
      ...many('person_sam_vendor', 8, 60, ['vendors']),
      ...many('person_rare', 2, 3),
      ...many('anon_abc123', 50, 1),
    ],
    { now },
  );
  return { g, r };
}

test('adds frequent saved contacts only', () => {
  const { g, r } = seeded();
  expect(r.people).toBe(2);
  expect(g.getEntity('person_mom')?.name).toBe('Mom');
  expect(g.getEntity('person_sam_vendor')?.name).toBe('Sam Vendor');
  expect(g.getEntity('person_rare')).toBeUndefined();
  expect(g.getEntity('anon_abc123')).toBeUndefined();
});

test('recent and frequent contacts are weighted higher', () => {
  const { g } = seeded();
  expect(g.getEntity('person_mom')!.activation).toBeGreaterThan(g.getEntity('person_sam_vendor')!.activation);
  const next = g.predictNextState('person_michael');
  expect(next[0]!.predictedId).toBe('person_mom');
});

test('keeps labels but no contact details, and is repeatable', () => {
  const { g } = seeded();
  expect(g.getEntity('person_mom')!.properties).toMatchObject({ contacts: 40, labels: ['family'] });
  const before = g.entityCount;
  seedFromComms(g, many('person_mom', 40, 1, ['family']), { now });
  expect(g.entityCount).toBe(before);
});
