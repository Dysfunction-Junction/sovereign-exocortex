import { describe, it, expect, beforeEach } from 'vitest';
import { LivingLifeGraph } from './life-graph.js';

describe('LivingLifeGraph (Pillar 1)', () => {
  let graph: LivingLifeGraph;

  beforeEach(() => {
    graph = new LivingLifeGraph();
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
});
