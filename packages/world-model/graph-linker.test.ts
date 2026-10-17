import { describe, it, expect, beforeEach } from 'vitest';
import { LivingLifeGraph } from './life-graph.js';
import {
  GraphEventLinker,
  linkEventToGraph,
  slugify,
  hashValue,
  type LinkableEvent,
} from './graph-linker.js';

describe('GraphEventLinker (Graph-to-Event Linkage)', () => {
  let graph: LivingLifeGraph;

  beforeEach(() => {
    graph = new LivingLifeGraph();
  });

  describe('slugify', () => {
    it('normalizes spaces and symbols to lowercase underscores', () => {
      expect(slugify('Agent Mesh MCP')).toBe('agent_mesh_mcp');
      expect(slugify('John Doe Jr.')).toBe('john_doe_jr');
      expect(slugify('__Test--Slug__')).toBe('test_slug');
    });
  });

  describe('linkEventToGraph', () => {
    it('matches pre-existing TOPIC, PERSON, and DOC entity nodes', () => {
      graph.addEntity({ id: 'topic_active_inference', name: 'Active Inference', type: 'TOPIC' });
      graph.addEntity({ id: 'person_michael', name: 'Michael', type: 'PERSON' });
      graph.addEntity({ id: 'doc_summary_123', name: 'Workstream 123', type: 'DOC' });

      const event: LinkableEvent = {
        event_id: 'ev_001',
        kind: 'past',
        ts_device: 1_700_000_000_000,
        payload: {
          summary_id: 'summary_123',
          tags: ['Active Inference'],
          persons: ['Michael'],
        },
      };

      const context = linkEventToGraph(event, graph);
      expect(context.matchedEntities).toHaveLength(3);
      const matchedIds = context.matchedEntities.map((e) => e.id);
      expect(matchedIds).toContain('doc_summary_123');
      expect(matchedIds).toContain('topic_active_inference');
      expect(matchedIds).toContain('person_michael');
    });

    it('auto-creates DOC entity and links it to existing TOPIC and PERSON', () => {
      graph.addEntity({ id: 'topic_machine_learning', name: 'Machine Learning', type: 'TOPIC' });
      graph.addEntity({ id: 'person_alice', name: 'Alice', type: 'PERSON' });

      const event: LinkableEvent = {
        event_id: 'pieces:uuid-456',
        kind: 'past',
        payload: JSON.stringify({
          summary_id: 'uuid-456',
          name: 'Sprint Planning Summary',
          tags: ['Machine Learning'],
          persons: ['Alice'],
          origin: 'pieces-backfill',
        }),
      };

      const context = linkEventToGraph(event, graph, { autoCreate: true });
      expect(graph.getEntity('doc_uuid-456')).toBeDefined();
      const doc = graph.getEntity('doc_uuid-456')!;
      expect(doc.name).toBe('Sprint Planning Summary');
      expect(doc.type).toBe('DOC');

      // Check neighbor linkages
      const neighbors = graph.getNeighbors('doc_uuid-456');
      expect(neighbors.map((n) => n.id)).toContain('topic_machine_learning');

      const aliceNeighbors = graph.getNeighbors('person_alice');
      expect(aliceNeighbors.map((n) => n.id)).toContain('doc_uuid-456');
    });

    it('stimulates matched entities and refreshes activation level', () => {
      const topic = graph.addEntity({
        id: 'topic_sovereign_exocortex',
        name: 'Sovereign Exocortex',
        type: 'TOPIC',
        activation: 0.2,
      });

      const event: LinkableEvent = {
        summary_id: 'sum_789',
        tags: ['Sovereign Exocortex'],
        ts_device: 1_750_000_000_000,
      };

      linkEventToGraph(event, graph, { stimulationAmount: 0.6 });
      expect(topic.activation).toBeGreaterThanOrEqual(0.8);
      expect(topic.lastActive).toBe(1_750_000_000_000);
    });

    it('hydrates context via spreading activation and subgraph extraction', () => {
      // Setup graph: doc -> topic -> project
      graph.addEntity({ id: 'doc_rec1', name: 'Doc Rec 1', type: 'DOC' });
      graph.addEntity({ id: 'topic_exocortex', name: 'Exocortex', type: 'TOPIC' });
      graph.addEntity({ id: 'project_daemon', name: 'Exocortex Daemon', type: 'PROJECT' });

      graph.addEdge('doc_rec1', 'topic_exocortex', 'HAS_TOPIC', 0.9);
      graph.addEdge('topic_exocortex', 'project_daemon', 'DEPENDS_ON', 0.85);

      const event: LinkableEvent = {
        summary_id: 'rec1',
      };

      const context = linkEventToGraph(event, graph, { initialEnergy: 1.0, maxHops: 2 });
      expect(context.matchedEntities.map((e) => e.id)).toContain('doc_rec1');

      // Spreading activation should reach project_daemon
      const activatedIds = context.activatedEntities.map((a) => a.entity.id);
      expect(activatedIds).toContain('doc_rec1');
      expect(activatedIds).toContain('topic_exocortex');
      expect(activatedIds).toContain('project_daemon');

      // Subgraph should include all 3 entities and the 2 edges
      expect(context.subgraph.entities).toHaveLength(3);
      expect(context.subgraph.edges).toHaveLength(2);

      // Recommendations should suggest recalling associated project context
      const recallActions = context.recommendedActions.filter((r) =>
        r.actionType === 'RECALL_CONTEXT',
      );
      expect(recallActions.length).toBeGreaterThan(0);
    });

    it('generates state transition predictions and recommended actions', () => {
      graph.addEntity({ id: 'topic_research', name: 'Research', type: 'TOPIC' });
      graph.addEntity({ id: 'routine_synthesis', name: 'Synthesis', type: 'ROUTINE' });

      graph.addEdge('topic_research', 'routine_synthesis', 'TRANSITIONS_TO', 0.9);

      const event: LinkableEvent = {
        tags: ['Research'],
      };

      const context = linkEventToGraph(event, graph);
      expect(context.predictedNextStates).toHaveLength(1);
      expect(context.predictedNextStates[0].predictedId).toBe('routine_synthesis');
      expect(context.predictedNextStates[0].probability).toBeGreaterThan(0);

      const transitionActions = context.recommendedActions.filter((r) =>
        r.actionType === 'TRANSITION',
      );
      expect(transitionActions).toHaveLength(1);
      expect(transitionActions[0].targetId).toBe('routine_synthesis');
    });

    it('does not match a tag against a non-TOPIC entity with the same name', () => {
      // Existing PERSON named "michael"
      graph.addEntity({ id: 'michael', name: 'michael', type: 'PERSON' });

      const event: LinkableEvent = {
        tags: ['michael'],
      };

      const context = linkEventToGraph(event, graph, { autoCreate: false });
      // Should not match 'michael' because it is a PERSON, not a TOPIC
      const matchedTopics = context.matchedEntities.filter((e) => e.type === 'TOPIC');
      expect(matchedTopics).toHaveLength(0);
    });

    it('is idempotent on repeated event links', () => {
      const event: LinkableEvent = {
        summary_id: 'doc_idempotent',
        tags: ['Pillar 1'],
      };

      const ctx1 = linkEventToGraph(event, graph, { autoCreate: true, createMissingTopics: true });
      const edgeCount1 = graph.edgeCount;
      const entityCount1 = graph.entityCount;

      const ctx2 = linkEventToGraph(event, graph, { autoCreate: true, createMissingTopics: true });
      expect(graph.edgeCount).toBe(edgeCount1);
      expect(graph.entityCount).toBe(entityCount1);
    });

    it('supports GraphEventLinker class instantiation and static link method', () => {
      const linker = new GraphEventLinker(graph, { autoCreate: true });
      const event: LinkableEvent = {
        summary_id: 'sess_999',
        tags: ['Pillar 1'],
      };

      const ctx1 = linker.linkEvent(event);
      expect(ctx1.matchedEntities.length).toBeGreaterThanOrEqual(1);

      const ctx2 = GraphEventLinker.link(event, graph);
      expect(ctx2.matchedEntities.length).toBeGreaterThanOrEqual(1);
    });

    it('hydrates on-device TextClassifier extracted entities and suggested actions into LivingLifeGraph', () => {
      // Pre-seed an existing goal to verify that matching action suggestions link to existing goals
      graph.addEntity({
        id: 'goal_view_map',
        type: 'GOAL',
        name: 'View Map Destination',
        activation: 0.5,
        lastActive: 1000,
      });

      const event: LinkableEvent = {
        event_id: 'screen_event_1',
        summary_id: 'screen_order_confirmation',
        extracted_entities: [
          { type: 'address', value: '1600 Amphitheatre Pkwy Mountain View', confidence: 0.95 },
          { type: 'date_time', value: 'Tomorrow at 3pm', confidence: 0.9 },
          { type: 'flight_number', value: 'UA 829', confidence: 0.92 },
          { type: 'phone', value: '+1-555-0199', confidence: 0.88 },
        ],
        contextual_suggestions: ['view_map', 'view_calendar'],
      };

      const ctx = linkEventToGraph(event, graph, { autoCreate: true });

      // Entities should be resolved and added to matchedEntities
      const matchedTypes = ctx.matchedEntities.map((e) => e.type);
      expect(matchedTypes).toContain('DOC'); // Screen doc
      expect(matchedTypes).toContain('LOCATION'); // Address
      expect(matchedTypes).toContain('CONTEXT_STATE'); // Date/time, flight, phone contact
      expect(matchedTypes).toContain('GOAL'); // Pre-existing goal linked via action

      // Verify specific entities in the graph
      const loc = graph.getEntity('location_1600_amphitheatre_pkwy_mountain_view');
      expect(loc).toBeDefined();
      expect(loc?.type).toBe('LOCATION');
      expect(loc?.properties?.origin).toBe('android_text_classifier');

      const dt = graph.getEntity('time_tomorrow_at_3pm');
      expect(dt).toBeDefined();
      expect(dt?.type).toBe('CONTEXT_STATE');

      const flight = graph.getEntity('entity_ua_829');
      expect(flight).toBeDefined();
      expect(flight?.type).toBe('CONTEXT_STATE');

      const contact = graph.getEntity('contact_1_555_0199');
      expect(contact).toBeDefined();
      expect(contact?.type).toBe('CONTEXT_STATE');

      const goal = graph.getEntity('goal_view_map');
      expect(goal).toBeDefined();
      expect(goal?.type).toBe('GOAL');

      // Verify graph relationships
      const doc = graph.getEntity('doc_screen_order_confirmation');
      expect(doc).toBeDefined();
      expect(doc?.properties?.contextual_suggestions).toEqual(['view_map', 'view_calendar']);
      const neighbors = graph.getNeighbors(doc!.id);
      const neighborIds = neighbors.map((n) => n.id);
      expect(neighborIds).toContain(loc!.id);
      expect(neighborIds).toContain(dt!.id);
      expect(neighborIds).toContain(flight!.id);
      expect(neighborIds).toContain(contact!.id);
      expect(neighborIds).toContain(goal!.id);
    });

    it('records native notification actions on document properties', () => {
      const event: LinkableEvent = {
        event_id: 'notif_event_1',
        summary_id: 'notif_slack_dm',
        notification_actions: [
          { action_id: 'act_101', title: 'Reply' },
          { action_id: 'act_102', title: 'Mark as read' },
        ],
      };

      linkEventToGraph(event, graph, { autoCreate: true });

      const doc = graph.getEntity('doc_notif_slack_dm');
      expect(doc).toBeDefined();
      expect(doc?.properties?.notification_actions).toEqual([
        { action_id: 'act_101', title: 'Reply' },
        { action_id: 'act_102', title: 'Mark as read' },
      ]);
    });

    it('records physical surface and network telemetry properties on document entity', () => {
      const event: LinkableEvent = {
        event_id: 'screen_event_hw',
        summary_id: 'screen_ambient_read',
        physical_surface: {
          state: 'desk_ambient',
          proximity_cm: 5.0,
          lux: 100,
        },
        network_telemetry: {
          transport: 'wifi',
          metered: false,
        },
      };

      linkEventToGraph(event, graph, { autoCreate: true });

      const doc = graph.getEntity('doc_screen_ambient_read');
      expect(doc).toBeDefined();
      expect(doc?.properties?.physical_state).toBe('desk_ambient');
      expect(doc?.properties?.network_metered).toBe(false);
      expect(typeof doc?.properties?.physical_state_expires_at).toBe('number');
    });

    it('resolves on-device clipboard intent into INTENT entity and recommends action', () => {
      const event: LinkableEvent = {
        event_id: 'clip_ev_99',
        clipboard_intent: {
          entity_type: 'tracking_number',
          value: '1Z9999999999999999',
          snippet: 'UPS 1Z9999999999999999',
          action: 'track_package',
        },
      };

      const context = linkEventToGraph(event, graph, { autoCreate: true });

      const expectedIntentId = `intent_tracking_number_${hashValue('1Z9999999999999999')}`;
      const intentEntity = graph.getEntity(expectedIntentId);
      expect(intentEntity).toBeDefined();
      expect(intentEntity?.type).toBe('INTENT');
      expect(intentEntity?.properties?.action).toBe('track_package');
      expect(intentEntity?.activation).toBe(1.0);

      expect(context.matchedEntities.map((e) => e.id)).toContain(expectedIntentId);
      expect(context.recommendedActions[0]).toEqual({
        actionType: 'EXECUTE_INTENT',
        targetId: expectedIntentId,
        reason: 'Clipboard intent: track_package for tracking_number',
        confidence: 0.95,
      });
    });

    it('resolves empirical app transitions into CONTEXT_STATE entities with TRANSITIONS_TO edge', () => {
      const event: LinkableEvent = {
        event_id: 'usage_trans_01',
        app_transitions: [
          {
            from: 'com.slack',
            to: 'com.github.android',
            dwell_ms: 15000,
            ts: 1_700_000_000_000,
          },
        ],
      };

      const context = linkEventToGraph(event, graph, { autoCreate: true });

      const fromNode = graph.getEntity('app_com_slack');
      const toNode = graph.getEntity('app_com_github_android');
      expect(fromNode).toBeDefined();
      expect(toNode).toBeDefined();
      expect(fromNode?.type).toBe('CONTEXT_STATE');
      expect(toNode?.type).toBe('CONTEXT_STATE');

      const edge = graph.getEdge('app_com_slack:TRANSITIONS_TO:app_com_github_android');
      expect(edge).toBeDefined();
      expect(edge?.relation).toBe('TRANSITIONS_TO');
      expect(edge?.observedCount).toBe(1);
    });
  });
});
