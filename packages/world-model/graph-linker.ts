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

export interface ExtractedEntityInput {
  type: string;
  value: string;
  confidence?: number;
}

export interface ClipboardIntentInput {
  entity_type: string;
  value: string;
  snippet?: string;
  action?: string;
}

export interface AppTransitionInput {
  from: string;
  to: string;
  dwell_ms?: number;
  ts?: number;
  hour?: number;
}

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
  extracted_entities?: ExtractedEntityInput[];
  contextual_suggestions?: string[];
  notification_actions?: Array<{ action_id: string; title: string }>;
  physical_surface?: Record<string, unknown>;
  network_telemetry?: Record<string, unknown>;
  hardware_telemetry?: Record<string, unknown>;
  clipboard_intent?: ClipboardIntentInput;
  app_transitions?: AppTransitionInput[];
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

export function hashValue(val: string): string {
  let hash = 2166136261;
  for (let i = 0; i < val.length; i++) {
    hash ^= val.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
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
  const finiteTs = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const deviceTs = finiteTs(event.ts_device);
  const serverTs = finiteTs(event.ts_server);
  // Device time keeps backfilled history at its original time; capping it at the stored server time stops a skewed
  // device clock from pinning graph time in the future while staying deterministic on replay.
  const timestamp =
    deviceTs !== undefined
      ? Math.min(deviceTs, serverTs ?? deviceTs)
      : serverTs ??
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
        graph.addEdge(docEntity.id, tEntity.id, 'HAS_TOPIC', 0.8, undefined, timestamp);
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
        graph.addEdge(pEntity.id, docEntity.id, 'WORKS_ON', 0.8, undefined, timestamp);
      }
    }
  }

  // 4b. Resolve on-device TextClassifier extracted entities (addresses, dates, tracking numbers, flight numbers, URLs, contacts)
  if (docEntity) {
    const rawExtracted: unknown[] = [
      ...(Array.isArray(event.extracted_entities) ? event.extracted_entities : []),
      ...(Array.isArray(payload.extracted_entities) ? payload.extracted_entities : []),
    ];

    const seenEntityKeys = new Set<string>();
    let extractedCount = 0;
    const MAX_EXTRACTED_ENTITIES = 10;

    for (const item of rawExtracted) {
      if (extractedCount >= MAX_EXTRACTED_ENTITIES) break;
      if (!item || typeof item !== 'object') continue;
      const ent = item as Record<string, unknown>;
      const entType = typeof ent.type === 'string' ? ent.type.toLowerCase() : '';
      const entValue = typeof ent.value === 'string' ? ent.value.trim() : '';
      if (!entValue) continue;

      const conf = typeof ent.confidence === 'number' ? ent.confidence : 0.7;
      if (conf < 0.6) continue; // Enforce confidence floor

      const dedupKey = `${entType}:${entValue.toLowerCase()}`;
      if (seenEntityKeys.has(dedupKey)) continue;
      seenEntityKeys.add(dedupKey);

      const s = slugify(entValue);
      if (!s) continue;

      let targetEntity: GraphEntity | undefined;
      if (entType === 'address' || entType === 'location') {
        const id = `location_${s}`;
        targetEntity = graph.getEntity(id);
        if (!targetEntity && autoCreate) {
          targetEntity = graph.addEntity({
            id,
            type: 'LOCATION',
            name: entValue,
            properties: {
              origin: 'android_text_classifier',
              entity_type: 'address',
              confidence: conf,
            },
            activation: 1.0,
            lastActive: timestamp,
          });
        }
        if (targetEntity) {
          graph.addEdge(docEntity.id, targetEntity.id, 'LOCATED_AT', 0.85, undefined, timestamp);
        }
      } else if (entType === 'date' || entType === 'date_time' || entType === 'datetime') {
        const id = `time_${s}`;
        targetEntity = graph.getEntity(id);
        if (!targetEntity && autoCreate) {
          targetEntity = graph.addEntity({
            id,
            type: 'CONTEXT_STATE',
            name: entValue,
            properties: {
              origin: 'android_text_classifier',
              entity_type: 'date_time',
              confidence: conf,
            },
            activation: 1.0,
            lastActive: timestamp,
          });
        }
        if (targetEntity) {
          graph.addEdge(docEntity.id, targetEntity.id, 'REFERENCES', 0.8, undefined, timestamp);
        }
      } else if (entType === 'phone' || entType === 'email') {
        const id = `contact_${s}`;
        targetEntity = graph.getEntity(id);
        if (!targetEntity && autoCreate) {
          targetEntity = graph.addEntity({
            id,
            type: 'CONTEXT_STATE',
            name: entValue,
            properties: {
              origin: 'android_text_classifier',
              entity_type: entType,
              confidence: conf,
            },
            activation: 1.0,
            lastActive: timestamp,
          });
        }
        if (targetEntity) {
          graph.addEdge(docEntity.id, targetEntity.id, 'REFERENCES', 0.85, undefined, timestamp);
        }
      } else {
        // url, flight_number, tracking_number, or general extracted entities
        const id = `entity_${s}`;
        targetEntity = graph.getEntity(id);
        if (!targetEntity && autoCreate) {
          targetEntity = graph.addEntity({
            id,
            type: 'CONTEXT_STATE',
            name: entValue,
            properties: {
              origin: 'android_text_classifier',
              entity_type: entType || 'entity',
              confidence: conf,
            },
            activation: 1.0,
            lastActive: timestamp,
          });
        }
        if (targetEntity) {
          graph.addEdge(docEntity.id, targetEntity.id, 'REFERENCES', 0.8, undefined, timestamp);
        }
      }

      if (targetEntity) {
        recordMatch(targetEntity);
        extractedCount++;
      }
    }

    // 4c. Attach contextual suggestions to document properties (link to existing GOALs without creating global hubs)
    const rawSuggestions: unknown[] = [
      ...(Array.isArray(event.contextual_suggestions) ? event.contextual_suggestions : []),
      ...(Array.isArray(payload.contextual_suggestions) ? payload.contextual_suggestions : []),
    ];

    const actions: string[] = [];
    for (const item of rawSuggestions) {
      const act =
        typeof item === 'string'
          ? item.trim()
          : item && typeof item === 'object' && typeof (item as Record<string, unknown>).action === 'string'
            ? ((item as Record<string, unknown>).action as string).trim()
            : '';
      if (!act || actions.includes(act)) continue;
      actions.push(act);

      // Only link if an existing GOAL entity for this action was already defined in the life graph
      const s = slugify(act);
      const existingGoal = graph.getEntity(`goal_${s}`) ?? graph.getEntity(s);
      if (existingGoal && existingGoal.type === 'GOAL') {
        recordMatch(existingGoal);
        graph.addEdge(docEntity.id, existingGoal.id, 'TRIGGERS', 0.75, undefined, timestamp);
      }
    }

    if (actions.length > 0) {
      docEntity.properties = {
        ...docEntity.properties,
        contextual_suggestions: actions,
      };
    }

    // 4d. Record native notification actions on document properties
    const rawNotificationActions: unknown[] = [
      ...(Array.isArray(event.notification_actions) ? event.notification_actions : []),
      ...(Array.isArray(payload.notification_actions) ? (payload.notification_actions as unknown[]) : []),
    ];
    if (rawNotificationActions.length > 0) {
      const parsedActions = rawNotificationActions
        .filter((a): a is Record<string, unknown> => Boolean(a && typeof a === 'object'))
        .map((a) => {
          const action_id = typeof a.action_id === 'string' ? a.action_id.trim() : '';
          const title = typeof a.title === 'string' ? a.title.trim().slice(0, 64) : '';
          return { action_id, title };
        })
        .filter((a) => a.action_id.length > 0 && a.title.length > 0)
        .slice(0, 8);
      if (parsedActions.length > 0) {
        docEntity.properties = {
          ...docEntity.properties,
          notification_actions: parsedActions,
          notification_actions_expires_at: timestamp + 120_000,
        };
      }
    }

    // 4e. Record physical surface & network telemetry properties on document
    const isRecord = (x: unknown): x is Record<string, unknown> =>
      Boolean(x && typeof x === 'object' && !Array.isArray(x));

    const rawHw = isRecord(event.hardware_telemetry)
      ? event.hardware_telemetry
      : isRecord(payload.hardware_telemetry)
        ? payload.hardware_telemetry
        : null;
    const surfaceObj = isRecord(event.physical_surface)
      ? event.physical_surface
      : isRecord(payload.physical_surface)
        ? payload.physical_surface
        : isRecord(rawHw?.physical_surface)
          ? (rawHw!.physical_surface as Record<string, unknown>)
          : null;
    const netObj = isRecord(event.network_telemetry)
      ? event.network_telemetry
      : isRecord(payload.network_telemetry)
        ? payload.network_telemetry
        : isRecord(rawHw?.network)
          ? (rawHw!.network as Record<string, unknown>)
          : null;

    if (surfaceObj && typeof surfaceObj.state === 'string' && surfaceObj.state !== 'unknown') {
      docEntity.properties = {
        ...docEntity.properties,
        physical_state: surfaceObj.state,
        physical_state_captured_at: timestamp,
        physical_state_expires_at: timestamp + 60_000,
      };
    }
    if (netObj && typeof netObj.metered === 'boolean') {
      docEntity.properties = {
        ...docEntity.properties,
        network_metered: netObj.metered,
      };
    }
  }

  // 4f. Resolve on-device clipboard intent (Track 4)
  const isRecordObj = (x: unknown): x is Record<string, unknown> =>
    Boolean(x && typeof x === 'object' && !Array.isArray(x));

  const clipObj = (event.clipboard_intent ??
    (isRecordObj(payload.clipboard_intent)
      ? (payload.clipboard_intent as Record<string, unknown>)
      : isRecordObj(payload.clipboardIntent)
        ? (payload.clipboardIntent as Record<string, unknown>)
        : null)) as ClipboardIntentInput | null;

  let matchedIntentEntityId: string | undefined;

  if (clipObj && typeof clipObj.entity_type === 'string' && typeof clipObj.value === 'string') {
    const rawVal = clipObj.value.trim();
    const entType = clipObj.entity_type.trim().toLowerCase();
    if (rawVal) {
      const intentHash = hashValue(rawVal);
      const intentSlug = slugify(entType);
      const intentId = `intent_${intentSlug}_${intentHash}`;
      let intentEntity = graph.getEntity(intentId);
      if (!intentEntity && autoCreate) {
        const isSensitive = entType === 'phone' || entType === 'email';
        const safeStoredVal = isSensitive && !rawVal.startsWith('sha256:') ? `sha256:${intentHash}` : rawVal;
        const safeName = typeof clipObj.snippet === 'string' && clipObj.snippet.trim()
          ? clipObj.snippet.trim()
          : `${clipObj.entity_type}: ${rawVal.slice(0, 48)}`;

        intentEntity = graph.addEntity({
          id: intentId,
          type: 'INTENT',
          name: safeName,
          properties: {
            origin: 'android_clipboard',
            entity_type: entType,
            value: safeStoredVal,
            action: typeof clipObj.action === 'string' ? clipObj.action : 'view_intent',
          },
          activation: 1.0,
          lastActive: timestamp,
        });
      }
      if (intentEntity) {
        matchedIntentEntityId = intentEntity.id;
        recordMatch(intentEntity);
        if (docEntity) {
          graph.addEdge(docEntity.id, intentEntity.id, 'REFERENCES', 0.9, undefined, timestamp);
        }
      }
    }
  }

  // 4g. Resolve empirical app transitions (Track 3)
  const rawTransitions = (
    [
      event.app_transitions,
      payload.app_transitions,
      payload.appTransitions,
      payload.transitions,
    ].find(Array.isArray) ?? []
  ) as AppTransitionInput[];

  const seenTransitionsInEvent = new Set<string>();
  const MAX_LINKED_TRANSITIONS = 50;
  let transitionCount = 0;
  for (const tr of rawTransitions) {
    if (transitionCount >= MAX_LINKED_TRANSITIONS) break;
    if (!tr || typeof tr.from !== 'string' || typeof tr.to !== 'string') continue;
    const fromPkg = tr.from.trim();
    const toPkg = tr.to.trim();
    if (!fromPkg || !toPkg || fromPkg === toPkg) continue;

    const pairKey = `${fromPkg}->${toPkg}`;
    if (seenTransitionsInEvent.has(pairKey)) continue;
    seenTransitionsInEvent.add(pairKey);

    const fromId = `app_${slugify(fromPkg)}`;
    const toId = `app_${slugify(toPkg)}`;
    const trTs = typeof tr.ts === 'number' && Number.isFinite(tr.ts) ? Math.min(tr.ts, timestamp) : timestamp;

    let fromEntity = graph.getEntity(fromId);
    if (!fromEntity && autoCreate) {
      fromEntity = graph.addEntity({
        id: fromId,
        type: 'CONTEXT_STATE',
        name: fromPkg,
        properties: { origin: 'android_usage', package: fromPkg },
        activation: 0.8,
        lastActive: trTs,
      });
    }

    let toEntity = graph.getEntity(toId);
    if (!toEntity && autoCreate) {
      toEntity = graph.addEntity({
        id: toId,
        type: 'CONTEXT_STATE',
        name: toPkg,
        properties: { origin: 'android_usage', package: toPkg },
        activation: 0.9,
        lastActive: trTs,
      });
    }

    if (fromEntity && toEntity) {
      recordMatch(fromEntity);
      recordMatch(toEntity);
      const dwellWeight = typeof tr.dwell_ms === 'number' && tr.dwell_ms > 5000 ? 0.85 : 0.65;
      graph.addEdge(fromEntity.id, toEntity.id, 'TRANSITIONS_TO', dwellWeight, undefined, trTs);
      transitionCount++;
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

  if (matchedIntentEntityId && clipObj && typeof clipObj.action === 'string' && clipObj.action.trim()) {
    const entType = typeof clipObj.entity_type === 'string' ? clipObj.entity_type.trim() : 'item';
    recommendedActions.push({
      actionType: 'EXECUTE_INTENT',
      targetId: matchedIntentEntityId,
      reason: `Clipboard intent: ${clipObj.action} for ${entType}`,
      confidence: 0.95,
    });
  }

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
