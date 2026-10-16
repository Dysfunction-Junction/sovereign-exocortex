import { describe, it, expect, beforeEach } from 'vitest';
import { CognitiveModeGate, type ProposalEnvelope } from './cognitive-gate.js';

describe('CognitiveModeGate (Pillar 2)', () => {
  let gate: CognitiveModeGate;

  beforeEach(() => {
    gate = new CognitiveModeGate();
  });

  it('classifies DEEP_FOCUS when IDE or terminal is active', () => {
    const mode = gate.classifyMode({
      foregroundApp: 'com.microsoft.VSCode',
      windowTitle: 'life-graph.ts - sovereign-exocortex',
    });
    expect(mode).toBe('DEEP_FOCUS');
    expect(gate.mode).toBe('DEEP_FOCUS');
  });

  it('classifies REST_RECOVERY during late night quiet hours', () => {
    const mode = gate.classifyMode({
      hourOfDay: 23,
      screenState: 'OFF',
    });
    expect(mode).toBe('REST_RECOVERY');
  });

  it('classifies EXPLORATORY_LEARNING when reading research or documentation', () => {
    const mode = gate.classifyMode({
      foregroundApp: 'com.android.chrome',
      windowTitle: 'Karl Friston Free Energy Principle arXiv paper',
      hourOfDay: 14,
    });
    expect(mode).toBe('EXPLORATORY_LEARNING');
  });

  it('honors explicit manual override mode', () => {
    const mode = gate.classifyMode({
      foregroundApp: 'com.microsoft.VSCode',
      manualOverrideMode: 'MAINTENANCE_SURFACING',
    });
    expect(mode).toBe('MAINTENANCE_SURFACING');
  });

  it('executes high-confidence low-risk dry runs silently in DEEP_FOCUS', () => {
    gate.classifyMode({ foregroundApp: 'Code.exe' });

    const safeProposal: ProposalEnvelope = {
      id: 'prop_typecheck',
      candidateId: 'cand_1',
      summary: 'Pre-compile dry-run typecheck',
      urgency: 0.4,
      confidence: 0.95, // >= 0.88
      estimatedRisk: 0.05, // <= 0.15
    };

    const decision = gate.evaluateProposal(safeProposal);
    expect(decision.action).toBe('SILENT_AUTO_EXECUTE');
    expect(decision.targetDelivery).toBe('SILENT_EXECUTE');
    expect(gate.queueSize).toBe(0);
  });

  it('suppresses and queues non-critical proposals in DEEP_FOCUS', () => {
    gate.classifyMode({ foregroundApp: 'Code.exe' });

    const mediumProposal: ProposalEnvelope = {
      id: 'prop_review',
      candidateId: 'cand_2',
      summary: 'Review dormant note',
      urgency: 0.4,
      confidence: 0.7,
      estimatedRisk: 0.1,
    };

    const decision = gate.evaluateProposal(mediumProposal);
    expect(decision.action).toBe('SUPPRESS_AND_QUEUE');
    expect(decision.targetDelivery).toBe('BACKGROUND_QUEUE');
    expect(gate.queueSize).toBe(1);

    const pending = gate.getPendingQueue();
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe('prop_review');

    // Draining clears the queue
    const drained = gate.drainQueue();
    expect(drained.length).toBe(1);
    expect(gate.queueSize).toBe(0);
  });

  it('breaches DEEP_FOCUS gate when urgency exceeds critical threshold', () => {
    gate.classifyMode({ foregroundApp: 'Code.exe' });

    const criticalProposal: ProposalEnvelope = {
      id: 'prop_prod_alert',
      candidateId: 'cand_alert',
      summary: 'Critical server outage',
      urgency: 0.98, // >= 0.85
      confidence: 0.9,
      estimatedRisk: 0.5,
    };

    const decision = gate.evaluateProposal(criticalProposal);
    expect(decision.action).toBe('ALLOW_PROMPT');
    expect(decision.targetDelivery).toBe('GLASS_MODAL');
  });

  it('suppresses all non-emergency interruptions during REST_RECOVERY', () => {
    gate.classifyMode({ hourOfDay: 1, screenState: 'OFF' });

    const normalProposal: ProposalEnvelope = {
      id: 'prop_normal',
      candidateId: 'cand_n',
      summary: 'Suggest code refactor',
      urgency: 0.7,
      confidence: 0.9,
      estimatedRisk: 0.1,
    };

    const decision = gate.evaluateProposal(normalProposal);
    expect(decision.action).toBe('SUPPRESS_AND_QUEUE');
    expect(decision.targetDelivery).toBe('BACKGROUND_QUEUE');
  });
});
