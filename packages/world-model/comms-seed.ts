/**
 * @file comms-seed.ts
 * Seeds the Living Life Graph with real people from the call/text history.
 *
 * Pure function over plain data. Produces:
 *   - a PERSON entity per saved contact seen at least `minContacts` times, activated by how recently they were
 *     in touch (30-day half-life: relationships fade slower than topics)
 *   - owner -> person INTERACTS_WITH edges weighted by how often you are in touch, on a log scale
 * Unsaved numbers (anon_*) are never added. Entities carry only counts, labels and the last-contact time; no phone
 * numbers or contact details exist in the data this reads.
 */

import type { LivingLifeGraph } from './life-graph.js';

export interface CommsSeedEvent {
  ts: number;
  /** First participant: `person_*` for a saved contact, `anon_*` for an unsaved number. */
  person: string;
  labels: string[];
}

export interface CommsSeedOptions {
  now?: number;
  selfId?: string;
  minContacts?: number;
}

export interface CommsSeedResult {
  events: number;
  people: number;
  edges: number;
}

const MS_PER_DAY = 86_400_000;

const humanize = (id: string): string =>
  id.replace(/^person_/, '').replace(/_\d+$/, '').split('_').filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');

export function seedFromComms(graph: LivingLifeGraph, events: CommsSeedEvent[], opts: CommsSeedOptions = {}): CommsSeedResult {
  const now = opts.now ?? Date.now();
  const selfId = opts.selfId ?? (typeof process !== 'undefined' ? process.env?.EXOCORTEX_OPERATOR_ID : undefined) ?? 'person_operator';
  const minContacts = opts.minContacts ?? 5;

  const stats = new Map<string, { count: number; last: number; labels: Set<string> }>();
  for (const e of events) {
    if (!e.person.startsWith('person_')) continue;
    const s = stats.get(e.person) ?? { count: 0, last: 0, labels: new Set<string>() };
    s.count++;
    s.last = Math.max(s.last, e.ts);
    for (const l of e.labels) s.labels.add(l);
    stats.set(e.person, s);
  }

  const kept = [...stats].filter(([id, s]) => s.count >= minContacts && id !== selfId);
  const maxCount = Math.max(1, ...kept.map(([, s]) => s.count));
  const hasSelf = graph.getEntity(selfId) !== undefined;
  let edges = 0;

  for (const [id, s] of kept) {
    const ageDays = Math.max(0, (now - s.last) / MS_PER_DAY);
    graph.addEntity({
      id,
      type: 'PERSON',
      name: humanize(id),
      properties: { contacts: s.count, labels: [...s.labels].sort(), lastContact: s.last, origin: 'comms-backfill' },
      activation: Math.max(0.05, Math.pow(0.5, ageDays / 30)),
      lastActive: s.last,
    });
    if (hasSelf) {
      graph.addEdge(selfId, id, 'INTERACTS_WITH', Math.log1p(s.count) / Math.log1p(maxCount), 90);
      edges++;
    }
  }
  return { events: events.length, people: kept.length, edges };
}
