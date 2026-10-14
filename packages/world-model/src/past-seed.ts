/**
 * @file past-seed.ts
 * Seeds the Living Life Graph from past work sessions (the Pieces backfill).
 *
 * Pure function over plain data so the graph package never depends on the event log. Produces:
 *   - TOPIC entities for recurring tags, activated by how recently they were last seen
 *   - person -> topic CARES_ABOUT edges weighted by relative frequency
 *   - topic <-> topic INTERACTS_WITH edges for tags that co-occur in a session
 *   - topic -> topic TRANSITIONS_TO edges: what the next session's main topic was, as a distribution
 * Edge `lastObserved` is stamped by the graph at seed time, so edge decay starts from now; entity
 * activation uses the real last-seen time.
 */

import type { LivingLifeGraph } from './life-graph.js';

export interface PastSession {
  ts: number; // epoch ms
  tags: string[];
  persons: string[];
  /** How `ts` was obtained; only "range_start" is a real activity time. */
  timeBasis?: 'range_start' | 'record_created';
}

export interface PastSeedOptions {
  now?: number;
  selfId?: string;
  /** Tags seen in fewer sessions than this are ignored as noise. */
  minTopicCount?: number;
  maxCooccurrencePairs?: number;
}

export interface PastSeedResult {
  sessions: number;
  topics: number;
  persons: number;
  edges: number;
}

const MS_PER_DAY = 86_400_000;
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

export function seedFromPastSessions(
  graph: LivingLifeGraph,
  sessions: PastSession[],
  opts: PastSeedOptions = {},
): PastSeedResult {
  const now = opts.now ?? Date.now();
  const selfId = opts.selfId ?? 'person_michael';
  const minCount = opts.minTopicCount ?? 2;
  const maxPairs = opts.maxCooccurrencePairs ?? 300;
  const ordered = [...sessions].sort((a, b) => a.ts - b.ts);

  const topicStats = new Map<string, { name: string; count: number; last: number }>();
  const personStats = new Map<string, { name: string; count: number; last: number }>();
  const bump = (m: typeof topicStats, id: string, name: string, ts: number) => {
    const cur = m.get(id) ?? { name, count: 0, last: 0 };
    cur.count++;
    cur.last = Math.max(cur.last, ts);
    m.set(id, cur);
  };
  const sessionTopics: string[][] = ordered.map((s) => {
    const ids = [...new Set(s.tags.map(slug).filter(Boolean))].map((x) => `topic_${x}`);
    ids.forEach((id, i) => bump(topicStats, id, s.tags.find((t) => `topic_${slug(t)}` === id) ?? id, s.ts));
    for (const p of new Set(s.persons.map(slug).filter(Boolean))) {
      bump(personStats, `person_${p}`, s.persons.find((x) => slug(x) === p) ?? p, s.ts);
    }
    return ids;
  });

  const kept = new Set([...topicStats].filter(([, v]) => v.count >= minCount).map(([id]) => id));
  const maxCount = Math.max(1, ...[...topicStats.values()].map((v) => v.count));
  const hasSelf = graph.getEntity(selfId) !== undefined;
  let edges = 0;

  for (const id of kept) {
    const t = topicStats.get(id)!;
    const ageDays = Math.max(0, (now - t.last) / MS_PER_DAY);
    graph.addEntity({
      id, type: 'TOPIC', name: t.name,
      properties: { pastSessions: t.count, origin: 'pieces-backfill' },
      activation: Math.max(0.01, Math.pow(0.5, ageDays / 7)),
      lastActive: t.last,
    });
    if (hasSelf) { graph.addEdge(selfId, id, 'CARES_ABOUT', t.count / maxCount); edges++; }
  }

  for (const [id, p] of personStats) {
    graph.addEntity({
      id, type: 'PERSON', name: p.name,
      properties: { pastSessions: p.count, origin: 'pieces-backfill' },
      activation: Math.max(0.01, Math.pow(0.5, Math.max(0, now - p.last) / MS_PER_DAY / 7)),
      lastActive: p.last,
    });
    if (hasSelf) { graph.addEdge(selfId, id, 'INTERACTS_WITH', Math.min(1, p.count / maxCount)); edges++; }
  }

  // Co-occurrence within a session.
  const pairs = new Map<string, number>();
  for (const ids of sessionTopics) {
    const k = ids.filter((i) => kept.has(i)).sort();
    for (let i = 0; i < k.length; i++) for (let j = i + 1; j < k.length; j++) {
      const key = `${k[i]}|${k[j]}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
  }
  const topPairs = [...pairs].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, maxPairs);
  const maxPair = Math.max(1, ...topPairs.map(([, c]) => c));
  for (const [key, c] of topPairs) {
    const [a, b] = key.split('|') as [string, string];
    graph.addEdge(a, b, 'INTERACTS_WITH', c / maxPair);
    graph.addEdge(b, a, 'INTERACTS_WITH', c / maxPair);
    edges += 2;
  }

  // Transitions: main topic (most frequent kept tag) of each session -> main topic of the next.
  const main = sessionTopics.map((ids) =>
    ids.filter((i) => kept.has(i)).sort((a, b) => topicStats.get(b)!.count - topicStats.get(a)!.count || a.localeCompare(b))[0],
  );
  const trans = new Map<string, Map<string, number>>();
  for (let i = 0; i + 1 < main.length; i++) {
    const a = main[i], b = main[i + 1];
    if (!a || !b || a === b) continue;
    const row = trans.get(a) ?? new Map<string, number>();
    row.set(b, (row.get(b) ?? 0) + 1);
    trans.set(a, row);
  }
  for (const [a, row] of trans) {
    const total = [...row.values()].reduce((x, y) => x + y, 0);
    for (const [b, c] of row) { graph.addEdge(a, b, 'TRANSITIONS_TO', c / total); edges++; }
  }

  return { sessions: ordered.length, topics: kept.size, persons: personStats.size, edges };
}
