import { describe, it, expect, beforeEach } from 'vitest';
import { CognitiveModeGate, contextToSignals, type ProposalEnvelope } from './cognitive-gate.js';

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

  it('gates audio mode interruptions when on a phone call or VoIP meeting', () => {
    const proposal: ProposalEnvelope = {
      id: 'prop_meeting_interruption',
      candidateId: 'cand_meet',
      summary: 'Suggest checking email',
      urgency: 0.6,
      confidence: 0.8,
      estimatedRisk: 0.1,
    };

    // In a phone or VoIP call -> non-emergency proposals suppressed and queued
    const callDecision = gate.evaluateProposal(proposal, { inCall: true });
    expect(callDecision.action).toBe('SUPPRESS_AND_QUEUE');
    expect(callDecision.targetDelivery).toBe('BACKGROUND_QUEUE');
    expect(callDecision.reason).toContain('In-call/meeting active');

    // Emergency urgency >= 0.95 breaches call gate
    const emergencyProposal: ProposalEnvelope = {
      ...proposal,
      urgency: 0.96,
    };
    const emergencyDecision = gate.evaluateProposal(emergencyProposal, { inCall: true });
    expect(emergencyDecision.action).toBe('ALLOW_PROMPT');
    expect(emergencyDecision.targetDelivery).toBe('GLASS_MODAL');

    // Safe routine auto-execute runs silently without interrupting the call
    const safeProposal: ProposalEnvelope = {
      id: 'prop_safe_probe',
      candidateId: 'cand_safe',
      summary: 'Diagnostic probe',
      urgency: 0.2,
      confidence: 0.95,
      estimatedRisk: 0.05,
      suggestedAction: { command: 'diagnostic_probe' },
    };
    const safeDecision = gate.evaluateProposal(safeProposal, { inCall: true });
    expect(safeDecision.action).toBe('SILENT_AUTO_EXECUTE');
    expect(safeDecision.targetDelivery).toBe('SILENT_EXECUTE');
  });

  it('suppresses visual modals when motion state is in_vehicle for driving safety', () => {
    const proposal: ProposalEnvelope = {
      id: 'prop_driving',
      candidateId: 'cand_drive',
      summary: 'Suggest organizing notes',
      urgency: 0.5,
      confidence: 0.85,
      estimatedRisk: 0.1,
    };

    const decision = gate.evaluateProposal(proposal, { motionState: 'in_vehicle' });
    expect(decision.action).toBe('SUPPRESS_AND_QUEUE');
    expect(decision.targetDelivery).toBe('BACKGROUND_QUEUE');
    expect(decision.reason).toContain('In-vehicle motion detected');

    // Critical emergency breaches in-vehicle gate
    const emergencyDecision = gate.evaluateProposal({ ...proposal, urgency: 0.98 }, { motionState: 'in_vehicle' });
    expect(emergencyDecision.action).toBe('ALLOW_PROMPT');
    expect(emergencyDecision.targetDelivery).toBe('GLASS_MODAL');
  });

  it('throttles speculative execution and stages proposals when device is under thermal exhaustion', () => {
    const safeProposal: ProposalEnvelope = {
      id: 'prop_safe_hot',
      candidateId: 'cand_hot',
      summary: 'Diagnostic probe',
      urgency: 0.4,
      confidence: 0.95,
      estimatedRisk: 0.05,
      suggestedAction: { command: 'diagnostic_probe' },
    };

    // Under thermal throttling (headroom >= 1.0), auto-execution is disabled and queued for cooldown
    const decision = gate.evaluateProposal(safeProposal, { thermalHeadroom: 1.1, thermalStatus: 'throttling' });
    expect(decision.action).toBe('SUPPRESS_AND_QUEUE');
    expect(decision.targetDelivery).toBe('BACKGROUND_QUEUE');
    expect(decision.reason).toContain('Thermal exhaustion: device throttling');
  });

  it('correctly maps PredictionContext to ContextualSignals via contextToSignals adapter', () => {
    const signals = contextToSignals({
      time: { ts: 1729000000, hour: 14, minute: 30, dow: 2, is_weekend: false, daypart: 'afternoon', tz_offset_min: -300 },
      app: { package: 'com.android.chrome', screen: 'SearchScreen', label: 'Chrome' },
      device: { screen_state: 'ON', idle_ms: 1200 },
      audio: { in_call: true, output_type: 'bluetooth_headset' },
      thermal: { headroom: 0.75, status: 'nominal' },
      motion: { state: 'in_vehicle', confidence: 0.9 },
    });

    expect(signals.foregroundApp).toBe('com.android.chrome');
    expect(signals.windowTitle).toBe('SearchScreen');
    expect(signals.hourOfDay).toBe(14);
    expect(signals.screenState).toBe('ON');
    expect(signals.inCall).toBe(true);
    expect(signals.audioOutput).toBe('bluetooth_headset');
    expect(signals.thermalHeadroom).toBe(0.75);
    expect(signals.thermalStatus).toBe('nominal');
    expect(signals.motionState).toBe('in_vehicle');
  });

  it('merges lastSignals when partial signals are supplied to evaluateProposal', () => {
    // First classify with inCall: true
    gate.classifyMode({ inCall: true });

    // Then evaluate proposal passing only motionState: 'still'
    const proposal: ProposalEnvelope = {
      id: 'prop_merged',
      candidateId: 'cand_m',
      summary: 'Normal proposal',
      urgency: 0.5,
      confidence: 0.8,
      estimatedRisk: 0.2,
    };

    // Because lastSignals had inCall: true, the effectiveSignals should retain inCall: true
    const decision = gate.evaluateProposal(proposal, { motionState: 'still' });
    expect(decision.action).toBe('SUPPRESS_AND_QUEUE');
    expect(decision.reason).toContain('In-call/meeting active');
  });

  it('handles NaN or missing urgency safely without breaching gates', () => {
    gate.classifyMode({ inCall: true });

    const nanUrgencyProposal: ProposalEnvelope = {
      id: 'prop_nan',
      candidateId: 'cand_nan',
      summary: 'Proposal with NaN urgency',
      urgency: NaN,
      confidence: 0.5,
      estimatedRisk: 0.5,
    };

    const decision = gate.evaluateProposal(nanUrgencyProposal);
    expect(decision.action).toBe('SUPPRESS_AND_QUEUE');
    expect(decision.targetDelivery).toBe('BACKGROUND_QUEUE');
  });

  it('resets mode and does not retain sticky inCall when classifyMode is called with empty signals', () => {
    gate.classifyMode({ inCall: true });
    expect(gate.mode).toBe('DEEP_FOCUS');

    // Calling classifyMode with new clean signals resets mode away from DEEP_FOCUS
    const newMode = gate.classifyMode({ hourOfDay: 12 });
    expect(newMode).toBe('HIGH_VELOCITY_EXECUTION');
    expect(gate.mode).toBe('HIGH_VELOCITY_EXECUTION');
  });

  it('deduplicates proposals in the queue by proposal.id', () => {
    const proposal: ProposalEnvelope = {
      id: 'prop_duplicate_test',
      candidateId: 'cand_dup',
      summary: 'Duplicate queue proposal',
      urgency: 0.4,
      confidence: 0.6,
      estimatedRisk: 0.2,
    };

    gate.classifyMode({ inCall: true });
    gate.evaluateProposal(proposal);
    gate.evaluateProposal(proposal);
    expect(gate.queueSize).toBe(1);
  });
});
