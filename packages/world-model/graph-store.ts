/**
 * @file graph-store.ts
 * Phase 2 In-Memory World-Model Store behind the `GraphStore` port
 * (PLAN_WORLD_MODEL_STORE_2026-10-31 §5.1 & §5.2).
 *
 * Replaces Neo4j status, analytics, natural-language search, type/stale queries,
 * and 2-hop neighborhood expansion with zero raw Cypher passthrough.
 *
 * Key invariants (§5.2):
 *   1. Vocabulary loads as a lookup index (`VocabularyIndex`), used by the linker and for `topic_num`.
 *      A topic becomes a graph node only when an event or entity-rule link references it.
 *   2. Topics with `generic = true` are excluded from spreading activation.
 *   3. Entity-rule links load as `HAS_TOPIC` edges (`observedAt = 0`).
 *   4. Decay is computed lazily at read time from stored weight/activation and last event time;
 *      decayed values are never written back during reads.
 */

import type {
  EntityType,
  GraphEdge,
  GraphEntity,
  LivingLifeGraph,
} from "./life-graph.js";
import type {
  RuleLinksArtifact,
  VocabularyArtifact,
  VocabularyTopicEntry,
} from "./curation-artifacts.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ENTITY_HALF_LIFE_DAYS = 7;
const DEFAULT_EDGE_HALF_LIFE_DAYS = 30;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function safeLimit(k: number | undefined, fallback = 25, max = 200): number {
  const n = typeof k === "number" && Number.isFinite(k) ? Math.floor(k) : fallback;
  return Math.max(1, Math.min(max, n));
}

export interface GraphHub {
  id: string;
  label: string;
  type: string;
  degree: number;
}

export interface StaleEntity {
  id: string;
  label: string;
  type: string;
  lastActive: number | null;
}

export interface TypeDistribution {
  type: string;
  count: number;
}

export interface EdgeDistribution {
  relType: string;
  count: number;
}

export interface GraphAnalyticsResult {
  nodeCount: number;
  edgeCount: number;
  hubs: GraphHub[];
  staleEntities: StaleEntity[];
  typeDistribution: TypeDistribution[];
  edgeDistribution: EdgeDistribution[];
  analyzedAt: string;
}

export interface GraphStoreStatus {
  enabled: boolean;
  connected: boolean;
  serving: boolean;
  lastSyncAt: string | null;
  nodeCount: number;
  edgeCount: number;
  vocabularyCount: number;
  entityRuleLinkCount: number;
  lastError: string | null;
}

export interface GraphStoreSearchRow {
  id: string;
  label: string;
  type: string;
  degree: number;
}

export interface GraphStoreNeighborResult {
  entities: GraphEntity[];
  edges: GraphEdge[];
}

export interface GraphQueryResult {
  mode: "nl";
  cypher: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  matchedEntityIds: string[];
}

/**
 * Port interface for the World-Model Graph Store (§5.1).
 * Zero raw query / Cypher passthrough.
 */
export interface GraphStore {
  status(): GraphStoreStatus;
  analytics(nowMs?: number): GraphAnalyticsResult;
  search(q: string, k?: number): GraphStoreSearchRow[];
  byType(type: EntityType | string, k?: number): GraphStoreSearchRow[];
  stale(k?: number): StaleEntity[];
  neighbors(id: string, hops?: number, limit?: number, nowMs?: number): GraphStoreNeighborResult;
  queryNaturalLanguage(query: string, k?: number): GraphQueryResult;
}

/**
 * Compute read-time decayed entity activation without mutating the stored entity (§5.2).
 * Entities stamped at `lastActive <= 0` (structural/curation seeds) do not decay from 1970.
 */
export function computeDecayedActivation(entity: GraphEntity, asOfMs: number): number {
  if (!Number.isFinite(entity.lastActive) || entity.lastActive <= 0) {
    return entity.activation;
  }
  const elapsedDays = (asOfMs - entity.lastActive) / MS_PER_DAY;
  if (elapsedDays <= 0) return entity.activation;
  const decayFactor = Math.pow(0.5, elapsedDays / ENTITY_HALF_LIFE_DAYS);
  return Math.min(entity.activation, Math.max(0.01, entity.activation * decayFactor));
}

/**
 * Compute read-time decayed edge weight without mutating the stored edge (§5.2).
 * Edges stamped at `lastObserved <= 0` (structural/curation seeds) do not decay from 1970.
 */
export function computeDecayedEdgeWeight(edge: GraphEdge, asOfMs: number): number {
  if (!Number.isFinite(edge.lastObserved) || edge.lastObserved <= 0) {
    return edge.weight;
  }
  const elapsedDays = (asOfMs - edge.lastObserved) / MS_PER_DAY;
  if (elapsedDays <= 0) return edge.weight;
  const halfLife = edge.halfLifeDays && edge.halfLifeDays > 0 ? edge.halfLifeDays : DEFAULT_EDGE_HALF_LIFE_DAYS;
  const decayFactor = Math.pow(0.5, elapsedDays / halfLife);
  return Math.min(edge.weight, Math.max(0.01, edge.weight * decayFactor));
}

/**
 * Lookup index for the curated vocabulary artifact (§5.2).
 * Keeps 8,000+ unused vocabulary topics out of `LivingLifeGraph` until referenced.
 */
export class VocabularyIndex {
  private byId = new Map<string, VocabularyTopicEntry>();
  private byNum = new Map<number, VocabularyTopicEntry>();
  private byExactLower = new Map<string, VocabularyTopicEntry>();
  private byAliasLower = new Map<string, VocabularyTopicEntry>();

  constructor(artifact?: VocabularyArtifact | null) {
    if (artifact) {
      this.load(artifact);
    }
  }

  public load(artifact: VocabularyArtifact): void {
    const nextById = new Map<string, VocabularyTopicEntry>();
    const nextByNum = new Map<number, VocabularyTopicEntry>();
    const nextByExactLower = new Map<string, VocabularyTopicEntry>();
    const nextByAliasLower = new Map<string, VocabularyTopicEntry>();

    const sortedTopics = [...(artifact.topics ?? [])].sort((a, b) => cmp(String(a?.id ?? ""), String(b?.id ?? "")));
    for (const raw of sortedTopics) {
      if (!raw || typeof raw.id !== "string" || !raw.id) continue;
      const aliases = Array.isArray(raw.aliases) ? raw.aliases.filter((a): a is string => typeof a === "string") : [];
      const entry: VocabularyTopicEntry = {
        id: raw.id,
        name: typeof raw.name === "string" && raw.name ? raw.name : raw.id,
        aliases,
        generic: raw.generic === true,
        topic_num: typeof raw.topic_num === "number" && Number.isSafeInteger(raw.topic_num) ? raw.topic_num : 0,
      };
      nextById.set(entry.id, entry);
      nextByNum.set(entry.topic_num, entry);
      nextByExactLower.set(entry.id.toLowerCase(), entry);
      nextByExactLower.set(entry.name.toLowerCase(), entry);
      if (entry.id.startsWith("topic_")) {
        const bare = entry.id.slice("topic_".length).toLowerCase();
        if (!nextByExactLower.has(bare)) nextByExactLower.set(bare, entry);
      }
      for (const alias of aliases) {
        const lower = alias.toLowerCase();
        if (!nextByAliasLower.has(lower)) {
          nextByAliasLower.set(lower, entry);
        }
      }
    }

    this.byId = nextById;
    this.byNum = nextByNum;
    this.byExactLower = nextByExactLower;
    this.byAliasLower = nextByAliasLower;
  }

  public get size(): number {
    return this.byId.size;
  }

  public getById(id: string): VocabularyTopicEntry | undefined {
    return this.byId.get(id);
  }

  public getByTopicNum(topicNum: number): VocabularyTopicEntry | undefined {
    return this.byNum.get(topicNum);
  }

  public resolve(token: string): VocabularyTopicEntry | undefined {
    const clean = token.trim();
    if (!clean) return undefined;
    const lower = clean.toLowerCase();
    return this.byId.get(clean) ?? this.byExactLower.get(lower) ?? this.byAliasLower.get(lower);
  }

  public allEntries(): VocabularyTopicEntry[] {
    return [...this.byId.values()];
  }

  /**
   * Re-stamp curated metadata (`name`, `generic`, `topic_num`, `aliases`, `vocab: true`)
   * onto any already-materialized `TOPIC` nodes in `graph` so replay order never affects state.
   */
  public syncExistingGraphTopics(graph: LivingLifeGraph): void {
    for (const ent of graph.snapshot().entities) {
      if (ent.type !== "TOPIC") continue;
      const entry = this.byId.get(ent.id) ?? this.byExactLower.get(ent.id.toLowerCase());
      if (!entry) continue;
      graph.addEntity({
        id: ent.id,
        type: "TOPIC",
        name: entry.name,
        properties: {
          ...(ent.properties ?? {}),
          vocab: true,
          generic: entry.generic,
          topic_num: entry.topic_num,
          aliases: entry.aliases,
        },
        activation: ent.activation,
        lastActive: ent.lastActive,
      });
    }
  }

  /**
   * Materialize a vocabulary topic into `LivingLifeGraph` only when referenced by an event or rule link.
   */
  public materializeTopic(
    graph: LivingLifeGraph,
    idOrToken: string,
    observedAt: number = 0,
  ): GraphEntity | undefined {
    const entry = this.resolve(idOrToken);
    if (!entry) return undefined;
    const existing = graph.getEntity(entry.id);
    const lastActive = existing ? Math.max(existing.lastActive, observedAt) : observedAt;
    return graph.addEntity({
      id: entry.id,
      type: "TOPIC",
      name: entry.name,
      properties: {
        ...(existing?.properties ?? {}),
        vocab: true,
        generic: entry.generic,
        topic_num: entry.topic_num,
        aliases: entry.aliases,
      },
      activation: existing?.activation ?? 1.0,
      lastActive,
    });
  }
}

function inferEntityTypeFromId(id: string): EntityType {
  if (id.startsWith("project_")) return "PROJECT";
  if (id.startsWith("person_")) return "PERSON";
  if (id.startsWith("device_")) return "DEVICE";
  if (id.startsWith("goal_")) return "GOAL";
  if (id.startsWith("routine_")) return "ROUTINE";
  if (id.startsWith("state_")) return "CONTEXT_STATE";
  if (id.startsWith("doc_")) return "DOC";
  if (id.startsWith("task_")) return "TASK";
  if (id.startsWith("intent_")) return "INTENT";
  if (id.startsWith("loc_")) return "LOCATION";
  return "TOPIC";
}

/**
 * Load curated `entity-rule` links into `LivingLifeGraph` as `HAS_TOPIC` edges (§5.2).
 * Materializes referenced vocabulary topics on demand and skips already-applied rule links idempotently.
 */
export function loadEntityRuleLinks(
  graph: LivingLifeGraph,
  entityRules: RuleLinksArtifact,
  vocabIndex?: VocabularyIndex,
  appliedKeys?: Set<string>,
): number {
  let loaded = 0;
  for (const link of entityRules.links) {
    if (!link.source_id || !link.target_id) continue;
    const src =
      graph.getEntity(link.source_id) ??
      vocabIndex?.materializeTopic(graph, link.source_id, 0) ??
      graph.addEntity({
        id: link.source_id,
        type: inferEntityTypeFromId(link.source_id),
        name: link.source_id,
        properties: { source: link.rule_source },
        activation: 1.0,
        lastActive: 0,
      });

    const tgt =
      vocabIndex?.materializeTopic(graph, link.target_id, 0) ??
      graph.getEntity(link.target_id) ??
      graph.addEntity({
        id: link.target_id,
        type: "TOPIC",
        name: link.target_id,
        properties: { vocab: true, source: link.rule_source },
        activation: 1.0,
        lastActive: 0,
      });

    const edgeKey = `${src.id}:HAS_TOPIC:${tgt.id}`;
    if (appliedKeys?.has(edgeKey)) continue;
    appliedKeys?.add(edgeKey);
    graph.addEdge(src.id, tgt.id, "HAS_TOPIC", link.weight, DEFAULT_EDGE_HALF_LIFE_DAYS, 0);
    loaded++;
  }
  return loaded;
}

export interface InMemoryGraphStoreOptions {
  graph: LivingLifeGraph;
  vocabIndex?: VocabularyIndex;
  isServing?: () => boolean;
  lastError?: () => string | null;
  now?: () => number;
}

/**
 * Default in-memory `GraphStore` adapter backed by `LivingLifeGraph` + `VocabularyIndex` (§5.2).
 */
export class InMemoryGraphStore implements GraphStore {
  private readonly graph: LivingLifeGraph;
  public readonly vocabIndex: VocabularyIndex;
  private readonly isServingFn: () => boolean;
  private readonly lastErrorFn: () => string | null;
  private readonly nowFn: () => number;
  private readonly appliedRuleKeys = new Set<string>();
  private lastHydratedIso: string | null = null;

  constructor(options: InMemoryGraphStoreOptions) {
    this.graph = options.graph;
    this.vocabIndex = options.vocabIndex ?? new VocabularyIndex();
    this.isServingFn = options.isServing ?? (() => true);
    this.lastErrorFn = options.lastError ?? (() => null);
    this.nowFn = options.now ?? (() => Date.now());
  }

  public applyCurationArtifacts(
    vocab?: VocabularyArtifact | null,
    entityRules?: RuleLinksArtifact | null,
    hydratedAtIso?: string,
  ): void {
    if (vocab) {
      this.vocabIndex.load(vocab);
      this.vocabIndex.syncExistingGraphTopics(this.graph);
    }
    if (entityRules) {
      loadEntityRuleLinks(this.graph, entityRules, this.vocabIndex, this.appliedRuleKeys);
    }
    if (hydratedAtIso !== undefined) {
      this.lastHydratedIso = hydratedAtIso;
    }
  }

  public markHydrated(isoTimestamp?: string): void {
    this.lastHydratedIso = isoTimestamp ?? new Date(this.nowFn()).toISOString();
  }

  public status(): GraphStoreStatus {
    const serving = this.isServingFn();
    return {
      enabled: true,
      connected: serving,
      serving,
      lastSyncAt: this.lastHydratedIso,
      nodeCount: this.graph.entityCount,
      edgeCount: this.graph.edgeCount,
      vocabularyCount: this.vocabIndex.size,
      entityRuleLinkCount: this.appliedRuleKeys.size,
      lastError: this.lastErrorFn(),
    };
  }

  private computeDegrees(edges: GraphEdge[]): Map<string, number> {
    const degrees = new Map<string, number>();
    for (const edge of edges) {
      degrees.set(edge.sourceId, (degrees.get(edge.sourceId) ?? 0) + 1);
      degrees.set(edge.targetId, (degrees.get(edge.targetId) ?? 0) + 1);
    }
    return degrees;
  }

  public analytics(nowMs: number = this.nowFn()): GraphAnalyticsResult {
    const snap = this.graph.snapshot();
    const degrees = this.computeDegrees(snap.edges);

    const hubs: GraphHub[] = snap.entities
      .map((e) => ({
        id: e.id,
        label: e.name || e.id,
        type: e.type,
        degree: degrees.get(e.id) ?? 0,
      }))
      .sort((a, b) => b.degree - a.degree || cmp(a.id, b.id))
      .slice(0, 10);

    const staleEntities: StaleEntity[] = snap.entities
      .filter((e) => typeof e.lastActive === "number" && Number.isFinite(e.lastActive) && e.lastActive > 0)
      .sort((a, b) => a.lastActive - b.lastActive || cmp(a.id, b.id))
      .slice(0, 10)
      .map((e) => ({
        id: e.id,
        label: e.name || e.id,
        type: e.type,
        lastActive: e.lastActive,
      }));

    const typeCounts = new Map<string, number>();
    for (const e of snap.entities) {
      typeCounts.set(e.type, (typeCounts.get(e.type) ?? 1 - 1) + 1);
    }
    const typeDistribution: TypeDistribution[] = [...typeCounts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || cmp(a.type, b.type))
      .slice(0, 15);

    const edgeCounts = new Map<string, number>();
    for (const edge of snap.edges) {
      edgeCounts.set(edge.relation, (edgeCounts.get(edge.relation) ?? 0) + 1);
    }
    const edgeDistribution: EdgeDistribution[] = [...edgeCounts.entries()]
      .map(([relType, count]) => ({ relType, count }))
      .sort((a, b) => b.count - a.count || cmp(a.relType, b.relType))
      .slice(0, 15);

    return {
      nodeCount: snap.entities.length,
      edgeCount: snap.edges.length,
      hubs,
      staleEntities,
      typeDistribution,
      edgeDistribution,
      analyzedAt: new Date(nowMs).toISOString(),
    };
  }

  public search(q: string, k?: number): GraphStoreSearchRow[] {
    const clean = q.trim().toLowerCase();
    const limit = safeLimit(k, 25, 200);
    if (!clean) return [];

    const snap = this.graph.snapshot();
    const degrees = this.computeDegrees(snap.edges);

    return snap.entities
      .filter((e) => {
        if (e.name.toLowerCase().includes(clean) || e.id.toLowerCase().includes(clean) || e.type.toLowerCase().includes(clean)) {
          return true;
        }
        const aliases = Array.isArray(e.properties?.aliases) ? e.properties.aliases : [];
        return aliases.some((a) => typeof a === "string" && a.toLowerCase().includes(clean));
      })
      .map((e) => ({
        id: e.id,
        label: e.name || e.id,
        type: e.type,
        degree: degrees.get(e.id) ?? 0,
      }))
      .sort((a, b) => b.degree - a.degree || cmp(a.id, b.id))
      .slice(0, limit);
  }

  public byType(type: EntityType | string, k?: number): GraphStoreSearchRow[] {
    const targetType = type.trim().toUpperCase();
    const limit = safeLimit(k, 25, 200);
    const snap = this.graph.snapshot();
    const degrees = this.computeDegrees(snap.edges);

    return snap.entities
      .filter((e) => e.type.toUpperCase() === targetType)
      .map((e) => ({
        id: e.id,
        label: e.name || e.id,
        type: e.type,
        degree: degrees.get(e.id) ?? 0,
      }))
      .sort((a, b) => b.degree - a.degree || cmp(a.id, b.id))
      .slice(0, limit);
  }

  public stale(k?: number): StaleEntity[] {
    const limit = safeLimit(k, 25, 200);
    const snap = this.graph.snapshot();
    return snap.entities
      .filter((e) => typeof e.lastActive === "number" && Number.isFinite(e.lastActive) && e.lastActive > 0)
      .sort((a, b) => a.lastActive - b.lastActive || cmp(a.id, b.id))
      .slice(0, limit)
      .map((e) => ({
        id: e.id,
        label: e.name || e.id,
        type: e.type,
        lastActive: e.lastActive,
      }));
  }

  public neighbors(
    id: string,
    hops: number = 1,
    limit: number = 100,
    nowMs: number = this.nowFn(),
  ): GraphStoreNeighborResult {
    const safeHops = Math.max(1, Math.min(2, Math.floor(Number.isFinite(hops) ? hops : 1)));
    const maxNodes = safeLimit(limit, 100, 500);

    const root = this.graph.getEntity(id);
    if (!root) return { entities: [], edges: [] };

    const snap = this.graph.snapshot();
    const byEntityId = new Map<string, GraphEntity>();
    for (const e of snap.entities) byEntityId.set(e.id, e);

    const incidentByNode = new Map<string, GraphEdge[]>();
    for (const edge of snap.edges) {
      let srcList = incidentByNode.get(edge.sourceId);
      if (!srcList) {
        srcList = [];
        incidentByNode.set(edge.sourceId, srcList);
      }
      srcList.push(edge);

      let tgtList = incidentByNode.get(edge.targetId);
      if (!tgtList) {
        tgtList = [];
        incidentByNode.set(edge.targetId, tgtList);
      }
      tgtList.push(edge);
    }

    const visitedNodes = new Set<string>([root.id]);
    const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: root.id, depth: 0 }];

    while (queue.length > 0 && visitedNodes.size < maxNodes) {
      const { nodeId, depth } = queue.shift()!;
      if (depth >= safeHops) continue;
      // Do not expand outward through generic topics (depth > 0) so hub topics don't flood 2-hop neighborhoods
      const curEnt = byEntityId.get(nodeId);
      if (depth > 0 && curEnt?.type === "TOPIC" && curEnt.properties?.generic === true) {
        continue;
      }

      const edges = [...(incidentByNode.get(nodeId) ?? [])].sort((a, b) => b.weight - a.weight || cmp(a.id, b.id));
      for (const edge of edges) {
        const otherId = edge.sourceId === nodeId ? edge.targetId : edge.sourceId;
        if (!byEntityId.has(otherId)) continue;
        if (!visitedNodes.has(otherId) && visitedNodes.size < maxNodes) {
          visitedNodes.add(otherId);
          queue.push({ nodeId: otherId, depth: depth + 1 });
        }
      }
    }

    const entities: GraphEntity[] = [...visitedNodes]
      .sort(cmp)
      .map((nodeId) => {
        const ent = byEntityId.get(nodeId)!;
        return {
          ...ent,
          activation: computeDecayedActivation(ent, nowMs),
        };
      });

    // Collect induced subgraph over visitedNodes
    const edges: GraphEdge[] = snap.edges
      .filter((e) => visitedNodes.has(e.sourceId) && visitedNodes.has(e.targetId))
      .map((e) => ({
        ...e,
        weight: computeDecayedEdgeWeight(e, nowMs),
      }))
      .sort((a, b) => cmp(a.id, b.id));

    return { entities, edges };
  }

  public queryNaturalLanguage(query: string, k?: number): GraphQueryResult {
    const raw = query.trim();
    const limit = safeLimit(k, 25, 200);
    if (!raw) {
      return { mode: "nl", cypher: "", columns: [], rows: [], matchedEntityIds: [] };
    }
    if (/\b(stale|neglected|idle)\b/i.test(raw)) {
      const staleRows = this.stale(limit);
      return {
        mode: "nl",
        cypher: "GraphStore.stale",
        columns: ["id", "label", "type", "lastActive"],
        rows: staleRows.map((r) => ({ ...r })),
        matchedEntityIds: staleRows.map((r) => r.id),
      };
    }

    let rows: GraphStoreSearchRow[];
    let descriptor: string;
    if (/\bprojects?\b/i.test(raw)) {
      rows = this.byType("PROJECT", limit);
      descriptor = "GraphStore.byType(PROJECT)";
    } else if (/\b(persons?|people)\b/i.test(raw)) {
      rows = this.byType("PERSON", limit);
      descriptor = "GraphStore.byType(PERSON)";
    } else if (/\b(devices?|hardware|phones?)\b/i.test(raw)) {
      rows = this.byType("DEVICE", limit);
      descriptor = "GraphStore.byType(DEVICE)";
    } else if (/\btopics?\b/i.test(raw)) {
      rows = this.byType("TOPIC", limit);
      descriptor = "GraphStore.byType(TOPIC)";
    } else {
      rows = this.search(raw, limit);
      descriptor = `GraphStore.search(${raw})`;
    }

    return {
      mode: "nl",
      cypher: descriptor,
      columns: ["id", "label", "type", "degree"],
      rows: rows.map((r) => ({ ...r })),
      matchedEntityIds: rows.map((r) => r.id),
    };
  }
}
