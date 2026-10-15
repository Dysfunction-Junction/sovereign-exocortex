/**
 * @file graph-linker.ts
 * Connects event activity records (such as Pieces backfill and live telemetry events)
 * to LivingLifeGraph entity nodes (DOC, TOPIC, PERSON, PROJECT).
 *
 * Provides bidirectional resolution, spreading activation context hydration,
 * neighbor inspection, and predictive action recommendations.
 */

import type {
  GraphEdge,
  GraphEntity,
  LivingLifeGraph,
  StatePrediction,
} from './life-graph.js';

export interface LinkableEvent {
  event_id?: string;
  kind?: string;
  ts_device?: number;
  ts_server?: number;
  payload?: Record<string, unknown> | string;
  summary_id?: string;
  doc_id?: string;
  tags?: string[];
  persons?: string[];
}

export interface ActivatedEntityScore {
  entity: GraphEntity;
  score: number;
}

export interface RecommendedAction {
  actionType: string;
  targetId: string;
  reason: string;
  confidence: number;
}

export interface EventGraphContext {
  eventId?: string;
  timestamp: number;
  matchedEntities: GraphEntity[];
  activatedEntities: ActivatedEntityScore[];
  subgraph: { entities: GraphEntity[]; edges: GraphEdge[] };
  neighbors: Map<string, GraphEntity[]>;
  predictedNextStates: StatePrediction[];
  recommendedActions: RecommendedAction[];
}

export interface GraphLinkerOptions {
  autoCreate?: boolean;
  createMissingTopics?: boolean;
  stimulationAmount?: number;
  initialEnergy?: number;
  retentionRate?: number;
  depthLimit?: number;
  maxHops?: number;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parsePayload(event: LinkableEvent): Record<string, unknown> {
  if (event.payload) {
    if (typeof event.payload === 'string') {
      try {
        const parsed = JSON.parse(event.payload);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return {};
      }
    } else if (typeof event.payload === 'object' && !Array.isArray(event.payload)) {
      return event.payload;
    }
  }
  return {};
}

function toStringArray(val: unknown): string[] {
  if (Array.isArray(val)) {
    return val.filter((x): x is string => typeof x === 'string' && Boolean(x.trim()));
  }
  return [];
}

export class GraphEventLinker {
  constructor(
    private graph: LivingLifeGraph,
    private defaultOptions: GraphLinkerOptions = {},
  ) {}

  public linkEvent(
    event: LinkableEvent,
    overrides?: GraphLinkerOptions,
  ): EventGraphContext {
    return linkEventToGraph(event, this.graph, {
      ...this.defaultOptions,
      ...overrides,
    });
  }

  public static link(
    event: LinkableEvent,
    graph: LivingLifeGraph,
    options?: GraphLinkerOptions,
  ): EventGraphContext {
    return linkEventToGraph(event, graph, options);
  }
}

export function linkEventToGraph(
  event: LinkableEvent,
  graph: LivingLifeGraph,
  options: GraphLinkerOptions = {},
): EventGraphContext {
  const autoCreate = options.autoCreate ?? true;
  const createMissingTopics = options.createMissingTopics ?? false;
  const stimulationAmount = options.stimulationAmount ?? 0.5;
  const initialEnergy = options.initialEnergy ?? 1.0;
  const retentionRate = options.retentionRate ?? 0.6;
  const depthLimit = options.depthLimit ?? 3;
  const maxHops = options.maxHops ?? 2;

  const payload = parsePayload(event);
  const timestamp =
    event.ts_device ??
    event.ts_server ??
    (typeof payload.created === 'string' && !Number.isNaN(Date.parse(payload.created))
      ? Date.parse(payload.created)
      : Date.now());

  // 1. Extract candidate identifiers
  const rawSummaryId =
    event.summary_id ??
    (typeof payload.summary_id === 'string' ? payload.summary_id : null) ??
    event.doc_id ??
    (typeof payload.doc_id === 'string' ? payload.doc_id : null) ??
    (typeof payload.hash === 'string' ? payload.hash : null);

  const tags = [
    ...toStringArray(event.tags),
    ...toStringArray(payload.tags),
    ...toStringArray(payload.topics),
  ];
  const uniqueTags = [...new Set(tags)];

  const persons = [
    ...toStringArray(event.persons),
    ...toStringArray(payload.persons),
    ...toStringArray(payload.people),
  ];
  const uniquePersons = [...new Set(persons)];

  const matchedEntities: GraphEntity[] = [];
  const matchedIds = new Set<string>();

  const recordMatch = (entity: GraphEntity | undefined) => {
    if (entity && !matchedIds.has(entity.id)) {
      matchedIds.add(entity.id);
      matchedEntities.push(entity);
    }
  };

  // 2. Resolve document entity
  let docEntity: GraphEntity | undefined;
  if (rawSummaryId) {
    const candidates = [
      `doc_${rawSummaryId}`,
      rawSummaryId,
      `doc_${slugify(rawSummaryId)}`,
    ];
    for (const c of candidates) {
      const ent = graph.getEntity(c);
      if (ent && ent.type === 'DOC') {
        docEntity = ent;
        break;
      }
    }

    if (!docEntity && autoCreate) {
      const docName =
        (typeof payload.name === 'string' && payload.name.trim()) ||
        `Doc ${rawSummaryId.slice(0, 8)}`;
      docEntity = graph.addEntity({
        id: `doc_${rawSummaryId}`,
        type: 'DOC',
        name: docName,
        properties: {
          summary_id: rawSummaryId,
          origin: payload.origin ?? 'event-linker',
        },
        activation: 1.0,
        lastActive: timestamp,
      });
    }

    recordMatch(docEntity);
  }

  // 3. Resolve topic entities
  const topicEntities: GraphEntity[] = [];
  for (const tag of uniqueTags) {
    const s = slugify(tag);
    if (!s) continue;
    const topicCandidates = [`topic_${s}`, s, tag];
    let tEntity: GraphEntity | undefined;
    for (const c of topicCandidates) {
      const ent = graph.getEntity(c);
      if (ent && ent.type === 'TOPIC') {
        tEntity = ent;
        break;
      }
    }

    if (!tEntity && autoCreate && createMissingTopics) {
      tEntity = graph.addEntity({
        id: `topic_${s}`,
        type: 'TOPIC',
        name: tag,
        properties: { origin: 'event-linker' },
        activation: 1.0,
        lastActive: timestamp,
      });
    }

    if (tEntity) {
      topicEntities.push(tEntity);
      recordMatch(tEntity);
      if (docEntity) {
        graph.addEdge(docEntity.id, tEntity.id, 'HAS_TOPIC', 0.8);
      }
    }
  }

  // 4. Resolve person entities
  const personEntities: GraphEntity[] = [];
  for (const p of uniquePersons) {
    const s = slugify(p);
    if (!s) continue;
    const personCandidates = [`person_${s}`, s, p];
    let pEntity: GraphEntity | undefined;
    for (const c of personCandidates) {
      const ent = graph.getEntity(c);
      if (ent && ent.type === 'PERSON') {
        pEntity = ent;
        break;
      }
    }

    if (pEntity) {
      personEntities.push(pEntity);
      recordMatch(pEntity);
      if (docEntity) {
        graph.addEdge(pEntity.id, docEntity.id, 'WORKS_ON', 0.8);
      }
    }
  }

  // 5. Stimulate matched entities
  for (const entity of matchedEntities) {
    entity.lastActive = Math.max(entity.lastActive ?? 0, timestamp);
    graph.stimulate(entity.id, stimulationAmount, timestamp);
  }

  // 6. Spreading activation
  const seedIds = matchedEntities.map((e) => e.id);
  const activations =
    seedIds.length > 0
      ? graph.spreadingActivation(seedIds, initialEnergy, retentionRate, depthLimit)
      : new Map<string, number>();

  const activatedEntities: ActivatedEntityScore[] = [...activations.entries()]
    .map(([id, score]) => {
      const ent = graph.getEntity(id);
      return ent ? { entity: ent, score } : null;
    })
    .filter((x): x is ActivatedEntityScore => x !== null)
    .sort((a, b) => b.score - a.score);

  // 7. Context subgraph and neighbors
  const subgraph =
    seedIds.length > 0
      ? graph.queryContextSubgraph(seedIds, maxHops)
      : { entities: [], edges: [] };

  const neighbors = new Map<string, GraphEntity[]>();
  for (const seedId of seedIds) {
    neighbors.set(seedId, graph.getNeighbors(seedId));
  }

  // 8. Predict next states
  const predictedMap = new Map<string, StatePrediction>();
  for (const seedId of seedIds) {
    const preds = graph.predictNextState(seedId);
    for (const p of preds) {
      const prev = predictedMap.get(p.predictedId);
      if (!prev || p.probability > prev.probability) {
        predictedMap.set(p.predictedId, p);
      }
    }
  }
  const predictedNextStates = [...predictedMap.values()].sort(
    (a, b) => b.probability - a.probability,
  );

  // 9. Recommended actions
  const recommendedActions: RecommendedAction[] = [];

  for (const pred of predictedNextStates.slice(0, 3)) {
    recommendedActions.push({
      actionType: 'TRANSITION',
      targetId: pred.predictedId,
      reason: `High transition probability (${Math.round(pred.probability * 100)}%) via ${pred.relation}`,
      confidence: pred.probability,
    });
  }

  const associativeEntities = activatedEntities.filter(
    (a) => !matchedIds.has(a.entity.id),
  );
  for (const item of associativeEntities.slice(0, 2)) {
    recommendedActions.push({
      actionType: 'RECALL_CONTEXT',
      targetId: item.entity.id,
      reason: `Spreading activation reached ${item.entity.name} (score ${item.score.toFixed(2)})`,
      confidence: item.score,
    });
  }

  return {
    eventId: event.event_id,
    timestamp,
    matchedEntities,
    activatedEntities,
    subgraph,
    neighbors,
    predictedNextStates,
    recommendedActions,
  };
}
