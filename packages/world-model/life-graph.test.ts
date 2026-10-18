import { describe, it, expect, beforeEach } from 'vitest';
import { LivingLifeGraph } from './life-graph.js';

describe('LivingLifeGraph (Pillar 1)', () => {
  let graph: LivingLifeGraph;

  beforeEach(() => {
    graph = new LivingLifeGraph();
  });

  it('bounds spreading work on broad cyclic context without changing unbudgeted callers', () => {
    graph.addEntity({ id: "source", name: "Source", type: "PROJECT" });
    for (let i = 0; i < 200; i++) {
      const id = `context:${i}`;
      graph.addEntity({ id, name: id, type: "TOPIC" });
      graph.addEdge("source", id, "DEPENDS_ON", 1);
      graph.addEdge(id, "source", "DEPENDS_ON", 1);
    }
    expect(graph.spreadActivation(["source"], 0.5, 0.6, 2, 32).size).toBe(33);
    expect(graph.spreadActivation(["source"], 0.5, 0.6, 2).size).toBe(201);
    expect(graph.spreadActivation(["source"], 0.5, 0.6, 2, 0).size).toBe(1);
  });

  it('anchors stimulation to observation time rather than construction wall time', () => {
    const entity = graph.addEntity({ id: "historic", name: "Historic", type: "PROJECT", activation: 0.2 });
    graph.decay(100);
    graph.stimulate(entity.id, 0.3, 100);
    expect(entity.lastActive).toBe(100);
    graph.decay(100 + 7 * 86_400_000);
    expect(entity.activation).toBeCloseTo(0.25);
    const decayedAt = 100 + 7 * 86_400_000;
    graph.stimulate(entity.id, 0.1, 99); // late delivery cannot rewind applied decay
    expect(entity.lastActive).toBe(decayedAt);
    graph.decay(decayedAt);
    expect(entity.activation).toBeCloseTo(0.35);
  });

  it('adds entities and tracks activation and timestamps', () => {
    const entity = graph.addEntity({
      id: 'person_frank',
      name: 'Frank',
      type: 'PERSON',
    });

    expect(entity.id).toBe('person_frank');
    expect(entity.activation).toBe(1.0);
    expect(graph.entityCount).toBe(1);
    expect(graph.getEntity('person_frank')).toBeDefined();
  });

  it('adds relational edges and updates observation counts and weights', () => {
    graph.addEntity({ id: 'project_bearhouse', name: 'Bear House', type: 'PROJECT' });
    graph.addEntity({ id: 'repo_gh', name: 'GitHub Repo', type: 'PROJECT' });

    const edge1 = graph.addEdge('project_bearhouse', 'repo_gh', 'DEPENDS_ON', 0.8);
    expect(edge1.weight).toBe(0.8);
    expect(edge1.observedCount).toBe(1);
    expect(graph.edgeCount).toBe(1);

    // Repeated observation reinforces edge weight
    const edge2 = graph.addEdge('project_bearhouse', 'repo_gh', 'DEPENDS_ON', 0.9);
    expect(edge2.observedCount).toBe(2);
    expect(edge2.weight).toBeGreaterThan(0.8);
  });

  it('applies exponential decay over simulated time', () => {
    const entity = graph.addEntity({ id: 'dev_phone', name: 'Galaxy S26', type: 'DEVICE' });
    const edge = graph.addEdge('dev_phone', 'dev_phone', 'INTERACTS_WITH', 1.0);

    const now = Date.now();
    // Decay by 7 days (one entity half life)
    const sevenDaysLater = now + 7 * 24 * 60 * 60 * 1000;
    graph.decay(sevenDaysLater);

    const decayedEntity = graph.getEntity('dev_phone')!;
    expect(decayedEntity.activation).toBeCloseTo(0.5, 1);
  });

  it('propagates spreading activation across weighted associative edges', () => {
    graph.addEntity({ id: 'n1', name: 'Node 1', type: 'TOPIC' });
    graph.addEntity({ id: 'n2', name: 'Node 2', type: 'TOPIC' });
    graph.addEntity({ id: 'n3', name: 'Node 3', type: 'TOPIC' });

    graph.addEdge('n1', 'n2', 'TRIGGERS', 0.9);
    graph.addEdge('n2', 'n3', 'TRIGGERS', 0.8);

    const activations = graph.spreadActivation(['n1'], 1.0, 0.5, 3);
    expect(activations.get('n1')).toBe(1.0);
    expect(activations.get('n2')).toBeGreaterThan(0.4);
    expect(activations.get('n3')).toBeGreaterThan(0.1);
  });

  it('extracts contextual subgraphs around seed entities', () => {
    graph.addEntity({ id: 'michael', name: 'Michael', type: 'PERSON' });
    graph.addEntity({ id: 'p1', name: 'Triad Orchestrator', type: 'PROJECT' });
    graph.addEntity({ id: 'p2', name: 'Mesh MCP', type: 'PROJECT' });

    graph.addEdge('michael', 'p1', 'WORKS_ON', 1.0);
    graph.addEdge('p1', 'p2', 'DEPENDS_ON', 0.9);

    const subgraph = graph.queryContextSubgraph(['michael'], 2);
    expect(subgraph.entities.length).toBe(3);
    expect(subgraph.edges.length).toBe(2);
  });

  it('predicts generative Markov state transitions', () => {
    graph.addEntity({ id: 'state_coding', name: 'Coding Session', type: 'CONTEXT_STATE' });
    graph.addEntity({ id: 'task_typecheck', name: 'Run Typecheck', type: 'ROUTINE' });
    graph.addEntity({ id: 'task_commit', name: 'Git Commit', type: 'ROUTINE' });

    graph.addEdge('state_coding', 'task_typecheck', 'TRANSITIONS_TO', 0.9);
    graph.addEdge('state_coding', 'task_typecheck', 'TRANSITIONS_TO', 0.9); // increment count
    graph.addEdge('state_coding', 'task_commit', 'TRANSITIONS_TO', 0.4);

    const predictions = graph.predictNextState('state_coding');
    expect(predictions.length).toBe(2);
    expect(predictions[0].predictedId).toBe('task_typecheck');
    expect(predictions[0].probability).toBeGreaterThan(predictions[1].probability);
  });

  it('sanitizes NaN and non-finite values in entity activation, stimulation, and spreading', () => {
    // 1. Existing entity at 0.2 falls back to existing activation when upserted with NaN
    const initial = graph.addEntity({ id: 'nan_test', name: 'NaN Entity', type: 'TOPIC', activation: 0.2 });
    expect(initial.activation).toBeCloseTo(0.2);

    const reAdd = graph.addEntity({ id: 'nan_test', name: 'NaN Entity', type: 'TOPIC', activation: NaN });
    expect(reAdd.activation).toBeCloseTo(0.2);

    // 2. Stimulate with NaN falls back to default amount (0.5), boosting 0.2 -> 0.7
    graph.stimulate('nan_test', NaN);
    expect(graph.getEntity('nan_test')!.activation).toBeCloseTo(0.7);

    graph.addEntity({ id: 'target_node', name: 'Target', type: 'TOPIC', activation: 0.5 });
    graph.addEdge('nan_test', 'target_node', 'TRIGGERS', 0.8);

    // 3. depthLimit = 0 preserves the source entity only (no traversal)
    const zeroDepth = graph.spreadActivation(['nan_test'], 1.0, 0.6, 0);
    expect(zeroDepth.size).toBe(1);
    expect(zeroDepth.get('nan_test')).toBe(1.0);

    // 4. initialEnergy = 0 is a valid non-spreading level
    const zeroEnergy = graph.spreadActivation(['nan_test'], 0, 0.6, 2);
    expect(zeroEnergy.get('nan_test')).toBe(0);

    // 5. edgeVisitBudget = NaN safely defaults without throwing or dropping
    const nanBudget = graph.spreadActivation(['nan_test'], 1.0, 0.6, 2, NaN);
    expect(nanBudget.size).toBe(2);

    const predictions = graph.predictNextState('nan_test');
    expect(predictions.length).toBe(1);
    expect(Number.isFinite(predictions[0].probability)).toBe(true);
  });
});

