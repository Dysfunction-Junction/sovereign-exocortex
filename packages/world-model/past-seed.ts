/** Seed the graph from historical sessions without turning raw tags into hub nodes. */
import type { LivingLifeGraph } from './life-graph.js';
import { CANONICAL_PROJECTS, classifyProjectIds, seedCanonicalProjects } from './project-categories.js';

export interface PastSession {
  ts: number;
  tags: string[];
  persons: string[];
  timeBasis?: 'range_start' | 'record_created';
}
export interface PastSeedOptions { now?: number; selfId?: string; minTopicCount?: number; maxCooccurrencePairs?: number }
export interface PastSeedResult { sessions: number; projects: number; edges: number }

const MS_PER_DAY = 86_400_000;

export function seedFromPastSessions(graph: LivingLifeGraph, sessions: PastSession[], opts: PastSeedOptions = {}): PastSeedResult {
  const now = opts.now ?? sessions.reduce((max, s) => Math.max(max, s.ts), 0);
  const selfId = opts.selfId ?? (typeof process !== 'undefined' ? process.env?.EXOCORTEX_OPERATOR_ID : undefined) ?? 'person_operator';
  const ordered = [...sessions].sort((a, b) => a.ts - b.ts);
  seedCanonicalProjects(graph);
  const lastSeen = new Map<string, number>();
  for (const session of ordered) {
    for (const id of classifyProjectIds(session.tags)) lastSeen.set(id, Math.max(lastSeen.get(id) ?? 0, session.ts));
  }
  let edges = 0;
  for (const project of CANONICAL_PROJECTS) {
    const last = lastSeen.get(project.id);
    if (!last) continue;
    const ageDays = Math.max(0, (now - last) / MS_PER_DAY);
    graph.addEntity({ id: project.id, type: 'PROJECT', name: project.name,
      properties: { origin: 'pieces-backfill' }, activation: Math.max(0.01, Math.pow(0.5, ageDays / 7)), lastActive: last });
    if (graph.getEntity(selfId)) { graph.addEdge(selfId, project.id, 'WORKS_ON', 0.9, 30, last); edges++; }
  }
  return { sessions: ordered.length, projects: lastSeen.size, edges };
}
