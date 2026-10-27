import { test } from 'vitest';
import assert from 'node:assert/strict';
import { LivingLifeGraph } from './life-graph.js';
import { seedFromPastSessions } from './past-seed.js';
import { classifyProjectIds, normalizeProjectCategories } from './project-categories.js';

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 12);
const s = (daysAgo: number, tags: string[]) => ({ ts: now - daysAgo * DAY, tags, persons: [] });

test('only explicit project labels become project categories; vault tags stay metadata', () => {
  const g = new LivingLifeGraph();
  g.addEntity({ id: 'person_operator', name: 'Operator', type: 'PERSON' });
  const r = seedFromPastSessions(g, [
    s(2, ['Sovereign Exocortex', '#timeline', '#workstream_summaries', '#markdown', 'Pieces']),
  ], { now });
  assert.deepEqual(classifyProjectIds(['Sovereign Exocortex', '#timeline', 'Pieces']), ['project_sovereign_exocortex']);
  assert.equal(r.projects, 1);
  assert.equal(g.getEntity('topic_timeline'), undefined);
  assert.equal(g.getEntity('topic_pieces'), undefined);
  assert.equal(g.getEntity('project_sovereign_exocortex')?.type, 'PROJECT');
  assert.ok(g.getNeighbors('person_operator').some((e) => e.id === 'project_sovereign_exocortex'));
});

test('documents are linked directly to projects and legacy topic/person hubs are removed', () => {
  const g = new LivingLifeGraph();
  g.addEntity({ id: 'person_operator', name: 'Operator', type: 'PERSON' });
  g.addEntity({ id: 'topic_michael_hebert', name: 'Michael Hebert', type: 'TOPIC' });
  g.addEntity({ id: 'topic_timeline', name: '#timeline', type: 'TOPIC' });
  g.addEntity({ id: 'doc:obsidian:Projects/Bear House Classic/Plan.md', name: 'Plan', type: 'DOC', properties: { tags: ['timeline', 'FamilyOS'] } });
  seedFromPastSessions(g, [], { now });
  normalizeProjectCategories(g, 'person_operator');
  assert.equal(g.getEntity('topic_michael_hebert'), undefined);
  assert.equal(g.getEntity('topic_timeline'), undefined);
  assert.ok(g.getNeighbors('doc:obsidian:Projects/Bear House Classic/Plan.md').some((e) => e.id === 'project_bear_house_classic'));
});

test('re-seeding preserves project count', () => {
  const g = new LivingLifeGraph();
  const input = [s(1, ['agent-mesh-mcp'])];
  seedFromPastSessions(g, input, { now });
  const before = g.entityCount;
  seedFromPastSessions(g, input, { now });
  assert.equal(g.entityCount, before);
});

test('no document is orphaned: Pieces exports go to the Pieces project, other vault notes to the operator', () => {
  const g = new LivingLifeGraph();
  g.addEntity({ id: 'person_operator', name: 'Operator', type: 'PERSON' });
  g.addEntity({ id: 'doc:obsidian:Pieces/markdown/a.md', name: 'a', type: 'DOC', properties: { tags: ['pieces', 'markdown'], sourcePath: 'Pieces/markdown/a.md' } });
  g.addEntity({ id: 'doc:obsidian:Daily/Today.md', name: 'Today', type: 'DOC', properties: { tags: [], sourcePath: 'Daily/Today.md' } });
  seedFromPastSessions(g, [], { now });
  normalizeProjectCategories(g, 'person_operator');
  assert.ok(g.getNeighbors('doc:obsidian:Pieces/markdown/a.md').some((e) => e.id === 'project_pieces_os'));
  assert.ok(g.getNeighbors('person_operator').some((e) => e.id === 'doc:obsidian:Daily/Today.md'));
  assert.ok(g.getNeighbors('person_operator').some((e) => e.id === 'project_pieces_os'));
});
