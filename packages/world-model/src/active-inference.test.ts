import { describe, it, expect, beforeEach } from 'vitest';
import { LivingLifeGraph } from './life-graph.js';
import { ActiveInferenceEngine, type SystemObservation } from './active-inference.js';

describe('ActiveInferenceEngine (Pillar 3)', () => {
  let graph: LivingLifeGraph;
  let engine: ActiveInferenceEngine;

  beforeEach(() => {
    graph = new LivingLifeGraph();
    graph.addEntity({ id: 'project_sovereign_exocortex', name: 'Exocortex Monorepo', type: 'PROJECT' });
    graph.addEntity({ id: 'device_phone_galaxy_s26', name: 'Galaxy S26 Ultra', type: 'DEVICE' });
    graph.addEntity({ id: 'project_cafeteria_menu', name: '2nd Helpings Menu', type: 'PROJECT' });
    graph.addEntity({ id: 'project_bear_house_classic', name: 'Bear House Classic', type: 'PROJECT' });

    engine = new ActiveInferenceEngine(graph);
  });

  it('initializes with default sovereign invariants', () => {
    expect(engine.registeredInvariants.length).toBeGreaterThanOrEqual(5);
  });

  it('evaluates normal observation with minimal surprisal', () => {
    const obs: SystemObservation = {
      invariantId: 'inv_clean_test_suite',
      observedState: true,
      observedAt: Date.now(),
      confidence: 1.0,
    };

    const metric = engine.evaluateObservation(obs);
    expect(metric.isAnomaly).toBe(false);
    expect(metric.divergence).toBe(0);
    expect(metric.surprisalNats).toBeLessThan(0.05); // -ln(0.99) ~ 0.010
  });

  it('detects anomaly and computes Shannon surprisal on invariant violation', () => {
    const obs: SystemObservation = {
      invariantId: 'inv_clean_test_suite',
      observedState: false, // Broken tests!
      observedAt: Date.now(),
      confidence: 1.0,
    };

    const metric = engine.evaluateObservation(obs);
    expect(metric.isAnomaly).toBe(true);
    expect(metric.divergence).toBe(1.0);
    // Surprisal for 1 - 0.99 = 0.01 is -ln(0.01) = ~4.605 nats
    expect(metric.surprisalNats).toBeGreaterThan(4.0);

    // Living Life Graph node should be stimulated
    const entity = graph.getEntity('project_sovereign_exocortex')!;
    expect(entity.activation).toBeGreaterThan(0.5);
  });

  it('synthesizes dual pragmatic and epistemic policies to minimize free energy', () => {
    const obs: SystemObservation = {
      invariantId: 'inv_cafeteria_synced',
      observedState: false,
      observedAt: Date.now(),
      confidence: 0.95,
    };

    const metric = engine.evaluateObservation(obs);
    const policies = engine.generatePolicies([metric]);

    expect(policies.length).toBe(2);
    const pragmatic = policies.find(p => p.type === 'PRAGMATIC');
    const epistemic = policies.find(p => p.type === 'EPISTEMIC');

    expect(pragmatic).toBeDefined();
    expect(pragmatic!.expectedUtility).toBeGreaterThan(0.8);
    expect(pragmatic!.actionPayload.command).toBe('self_heal_restore');

    expect(epistemic).toBeDefined();
    expect(epistemic!.informationGain).toBeGreaterThan(0.8);
    expect(epistemic!.actionPayload.command).toBe('diagnostic_probe');
  });

  it('converts policy to proposal envelope for cognitive gate routing', () => {
    const obs: SystemObservation = {
      invariantId: 'inv_bridge_connected',
      observedState: false,
      observedAt: Date.now(),
      confidence: 1.0,
    };

    const metric = engine.evaluateObservation(obs);
    const policies = engine.generatePolicies([metric]);
    const proposal = engine.policyToProposal(policies[0]);

    expect(proposal.id).toBe(policies[0].id);
    expect(proposal.candidateId).toBe('inv_bridge_connected');
    expect(proposal.confidence).toBeGreaterThan(0.8);
  });
});
