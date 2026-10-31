import type { LivingLifeGraph } from './life-graph.js';

export const CANONICAL_PROJECTS = [
  { id: 'project_sovereign_exocortex', name: 'Sovereign Exocortex', aliases: ['sovereign-exocortex', 'sovereign exocortex', 'exocortex'] },
  { id: 'project_autonomous_triad', name: 'Autonomous Triad', aliases: ['autonomous-triad', 'autonomous triad'] },
  { id: 'project_agent_mesh_mcp', name: 'Agent Mesh MCP', aliases: ['agent-mesh-mcp', 'agent mesh mcp'] },
  { id: 'project_pieces_android', name: 'Pieces Android Companion', aliases: ['pieces-android', 'pieces android', 'pieces-android-shizuku-fix'] },
  { id: 'project_pieces_for_all', name: 'Pieces for All', aliases: ['pieces-for-all', 'pieces for all'] },
  { id: 'project_gut_instinct', name: 'Gut-Instinct', aliases: ['gut-instinct', 'gut instinct'] },
  { id: 'project_registry_app', name: 'SecondGuess Registry App', aliases: ['registry-app', 'secondguess', 'second guess'] },
  { id: 'project_bear_house_classic', name: 'Bear House Classic', aliases: ['bear-house-classic', 'bear house classic', 'familyos'] },
  { id: 'project_oakridge_smokehouse', name: 'Oakridge Smokehouse System', aliases: ['oakridge-smokehouse', 'oakridge-procurement', 'cafeteria-menu-manager', '2nd-helpings', 'second-helpings'] },
] as const;

const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const aliasIndex = new Map(CANONICAL_PROJECTS.flatMap((p) => [p.id, ...p.aliases].map((a) => [slug(a), p] as const)));

/** Classifies only explicit project names/paths; generic tags stay document metadata. */
export function classifyProjectIds(values: unknown[]): string[] {
  const found = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.toLowerCase().replace(/\\/g, '/');
    const candidates = [slug(normalized), ...normalized.split(/[\/#]/).map(slug)];
    for (const candidate of candidates) {
      const project = aliasIndex.get(candidate);
      if (project) found.add(project.id);
    }
  }
  return [...found];
}

export function seedCanonicalProjects(graph: LivingLifeGraph, lastActive: number = 0): void {
  for (const project of CANONICAL_PROJECTS) graph.addEntity({ id: project.id, type: 'PROJECT', name: project.name, lastActive: graph.getEntity(project.id)?.lastActive ?? lastActive });
}

/** File one document under exactly one owner: its canonical project, otherwise the operator. */
export function attachDocumentToOwner(
  graph: LivingLifeGraph,
  entity: { id: string; name: string; properties?: Record<string, unknown> },
  operatorId: string,
): void {
  const tags = Array.isArray(entity.properties?.tags) ? entity.properties.tags : [];
  const projectIds = classifyProjectIds([entity.id, entity.name, entity.properties?.sourcePath as string, ...tags]);
  for (const id of projectIds) {
    if (graph.getEntity(id)) graph.addEdge(entity.id, id, 'REFERENCES', 0.9, 30, 0);
  }
  const mentionsOperator = tags.some((tag) => typeof tag === 'string' && /^(?:#?)(?:operator|michael[ _-]?hebert)$/i.test(tag.trim()));
  if ((mentionsOperator || projectIds.length === 0) && graph.getEntity(operatorId)) {
    graph.addEdge(operatorId, entity.id, 'MENTIONS', 0.9, 30, 0);
  }
}

/**
 * Remove tag clouds and file every document under exactly one owner. Projects hang off the operator, so the only
 * hubs are the operator and projects.
 */
export function normalizeProjectCategories(graph: LivingLifeGraph, operatorId: string): void {
  for (const entity of graph.snapshot().entities) {
    if (entity.type === 'DOC') attachDocumentToOwner(graph, entity, operatorId);
  }
  for (const entity of graph.snapshot().entities) {
    if (entity.type === 'TOPIC' || /^person_michael_hebert$/i.test(entity.id)) graph.removeEntity(entity.id);
  }
  if (graph.getEntity(operatorId)) {
    for (const project of CANONICAL_PROJECTS) {
      if (graph.getEntity(project.id)) graph.addEdge(operatorId, project.id, 'WORKS_ON', 0.8, 30, 0);
    }
  }
}
