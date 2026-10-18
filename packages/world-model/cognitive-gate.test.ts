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
    expect(decision.reason).toContain('driving safety');

    // Critical emergency breaches in-vehicle gate
    const emergencyDecision = gate.evaluateProposal({ ...proposal, urgency: 0.98 }, { motionState: 'in_vehicle' });
    expect(emergencyDecision.action).toBe('ALLOW_PROMPT');
    expect(emergencyDecision.targetDelivery).toBe('GLASS_MODAL');
  });

  it('triggers zero-latency driving safety gating when car audio is connected', () => {
    const proposal: ProposalEnvelope = {
      id: 'prop_car_audio',
      candidateId: 'cand_car',
      summary: 'Prompt to clean up downloads',
      urgency: 0.4,
      confidence: 0.8,
      estimatedRisk: 0.1,
    };

    // 1. Direct carAudioConnected flag
    const decision = gate.evaluateProposal(proposal, { carAudioConnected: true });
    expect(decision.action).toBe('SUPPRESS_AND_QUEUE');
    expect(decision.targetDelivery).toBe('BACKGROUND_QUEUE');
    expect(decision.reason).toContain('Car Audio connected');

    // 2. Audio output routed to car_audio
    const decisionRouting = gate.evaluateProposal(proposal, { audioOutput: 'car_audio' });
    expect(decisionRouting.action).toBe('SUPPRESS_AND_QUEUE');
    expect(decisionRouting.targetDelivery).toBe('BACKGROUND_QUEUE');

    // 3. Mode classification infers in_vehicle immediately when not stationary
    const mode = gate.classifyMode({ carAudioConnected: true, hourOfDay: 14 });
    expect(mode).toBe('HIGH_VELOCITY_EXECUTION');
    expect(gate.getLastSignals().motionState).toBe('in_vehicle');

    // 4. Stationary car audio does not override motion to in_vehicle
    gate.classifyMode({ carAudioConnected: true, motionState: 'stationary', hourOfDay: 14 });
    expect(gate.getLastSignals().motionState).toBe('stationary');
  });

  it('suppresses non-emergency proposals when Zen / DND mode is active', () => {
    const proposal: ProposalEnvelope = {
      id: 'prop_dnd',
      candidateId: 'cand_dnd',
      summary: 'Non-urgent suggestion',
      urgency: 0.6,
      confidence: 0.85,
      estimatedRisk: 0.1,
    };

    // DND active via interruptionFilter PRIORITY
    const decisionFilter = gate.evaluateProposal(proposal, { interruptionFilter: 'PRIORITY' });
    expect(decisionFilter.action).toBe('SUPPRESS_AND_QUEUE');
    expect(decisionFilter.targetDelivery).toBe('BACKGROUND_QUEUE');
    expect(decisionFilter.reason).toContain('Zen/DND active');

    // DND active via boolean flag
    const decisionBool = gate.evaluateProposal(proposal, { dndActive: true });
    expect(decisionBool.action).toBe('SUPPRESS_AND_QUEUE');
    expect(decisionBool.targetDelivery).toBe('BACKGROUND_QUEUE');

    // Emergency urgency breaches PRIORITY DND
    const emergencyDnd = gate.evaluateProposal({ ...proposal, urgency: 0.96 }, { dndActive: true });
    expect(emergencyDnd.action).toBe('ALLOW_PROMPT');
    expect(emergencyDnd.targetDelivery).toBe('GLASS_MODAL');

    // Under NONE filter (total silence), even emergency urgency is suppressed
    const totalSilence = gate.evaluateProposal({ ...proposal, urgency: 0.98 }, { interruptionFilter: 'NONE' });
    expect(totalSilence.action).toBe('SUPPRESS_AND_QUEUE');
    expect(totalSilence.targetDelivery).toBe('BACKGROUND_QUEUE');
    expect(totalSilence.reason).toContain('total silence');
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

  it('gates intrusive modals when phone is in pocket or face down', () => {
    const proposal: ProposalEnvelope = {
      id: 'prop_pocket_distract',
      candidateId: 'cand_p',
      summary: 'Suggest opening browser',
      urgency: 0.5,
      confidence: 0.8,
      estimatedRisk: 0.1,
    };

    // When in pocket -> visual modals suppressed and queued
    const pocketDecision = gate.evaluateProposal(proposal, { physicalState: 'in_pocket' });
    expect(pocketDecision.action).toBe('SUPPRESS_AND_QUEUE');
    expect(pocketDecision.targetDelivery).toBe('BACKGROUND_QUEUE');
    expect(pocketDecision.reason).toContain('in pocket');

    // When face down -> visual modals suppressed and queued
    const faceDownDecision = gate.evaluateProposal(proposal, { physicalState: 'face_down' });
    expect(faceDownDecision.action).toBe('SUPPRESS_AND_QUEUE');
    expect(faceDownDecision.targetDelivery).toBe('BACKGROUND_QUEUE');
    expect(faceDownDecision.reason).toContain('face down');

    // Safe routine auto-executable proposal executes silently without activating screen
    const safeProposal: ProposalEnvelope = {
      id: 'prop_pocket_safe',
      candidateId: 'cand_ps',
      summary: 'Background diagnostic probe',
      urgency: 0.3,
      confidence: 0.92,
      estimatedRisk: 0.05,
      suggestedAction: { command: 'diagnostic_probe' },
    };
    const silentDecision = gate.evaluateProposal(safeProposal, { physicalState: 'in_pocket' });
    expect(silentDecision.action).toBe('SILENT_AUTO_EXECUTE');
    expect(silentDecision.targetDelivery).toBe('SILENT_EXECUTE');

    // Critical emergency urgency >= 0.95 breaches pocket gate
    const emergencyDecision = gate.evaluateProposal({ ...proposal, urgency: 0.98 }, { physicalState: 'in_pocket' });
    expect(emergencyDecision.action).toBe('ALLOW_PROMPT');
    expect(emergencyDecision.targetDelivery).toBe('GLASS_MODAL');
  });

  it('correctly maps PredictionContext to ContextualSignals via contextToSignals adapter', () => {
    const signals = contextToSignals({
      time: { ts: 1729000000, hour: 14, minute: 30, dow: 2, is_weekend: false, daypart: 'afternoon', tz_offset_min: -300 },
      app: { package: 'com.android.chrome', screen: 'SearchScreen', label: 'Chrome' },
      device: { screen_state: 'ON', idle_ms: 1200 },
      audio: { in_call: true, output_type: 'bluetooth_headset' },
      thermal: { headroom: 0.75, status: 'nominal' },
      motion: { state: 'in_vehicle', confidence: 0.9 },
      physical_surface: { state: 'desk_ambient', proximity_cm: 5.0, lux: 150 },
      network_telemetry: { transport: 'wifi', metered: false },
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
    expect(signals.physicalState).toBe('desk_ambient');
    expect(signals.networkMetered).toBe(false);
  });

  it('correctly maps carAudioConnected, interruptionFilter, and dndActive via contextToSignals', () => {
    // 1. Android NativeHardwareTelemetry format (root level properties and focus object)
    const nativeSignals = contextToSignals({
      audio: { output_type: 'speaker', car_audio_connected: true } as any,
      car_audio_connected: true,
      focus: { interruption_filter: 'PRIORITY', dnd_active: true },
      dnd_active: true,
      interruption_filter: 'PRIORITY',
    } as any);

    expect(nativeSignals.carAudioConnected).toBe(true);
    expect(nativeSignals.interruptionFilter).toBe('PRIORITY');
    expect(nativeSignals.dndActive).toBe(true);

    // 2. Numeric and prefixed interruptionFilter mapping
    const numericSignals = contextToSignals({
      interruption_filter: 2,
    } as any);
    expect(numericSignals.interruptionFilter).toBe('PRIORITY');
    expect(numericSignals.dndActive).toBe(true);

    const prefixSignals = contextToSignals({
      interruption_filter: 'INTERRUPTION_FILTER_PRIORITY',
    } as any);
    expect(prefixSignals.interruptionFilter).toBe('PRIORITY');
    expect(prefixSignals.dndActive).toBe(true);

    // 3. INTERRUPTION_FILTER_ALL derives dndActive: false when not explicitly set
    const allFilterSignals = contextToSignals({
      interruption_filter: 'INTERRUPTION_FILTER_ALL',
    } as any);
    expect(allFilterSignals.interruptionFilter).toBe('ALL');
    expect(allFilterSignals.dndActive).toBe(false);

    // 4. Strict boolean parsing: "false" does not coerce to true, null remains undefined
    const strictBoolSignals = contextToSignals({
      dnd_active: 'false',
      car_audio_connected: null,
    } as any);
    expect(strictBoolSignals.dndActive).toBe(false);
    expect(strictBoolSignals.carAudioConnected).toBeUndefined();

    // 5. Unrecognized filter string safely produces undefined
    const invalidFilterSignals = contextToSignals({
      interruption_filter: 'BOGUS_FILTER',
    } as any);
    expect(invalidFilterSignals.interruptionFilter).toBeUndefined();

    // 6. Absence preserves undefined without coercing to false
    const emptySignals = contextToSignals({});
    expect(emptySignals.carAudioConnected).toBeUndefined();
    expect(emptySignals.interruptionFilter).toBeUndefined();
    expect(emptySignals.dndActive).toBeUndefined();
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

  it('executes auto-executable proposals silently in pocket/call/vehicle, and prompts for urgent non-auto proposals', () => {
    const emergencyAutoProposal: ProposalEnvelope = {
      id: 'prop_urgent_probe',
      candidateId: 'cand_up',
      summary: 'Critical emergency system self-heal probe',
      urgency: 0.98,
      confidence: 0.95,
      estimatedRisk: 0.05,
      suggestedAction: { command: 'diagnostic_probe' },
    };

    // Auto-executable proposals run silently without turning on screen in pocket or during call
    const pocketAuto = gate.evaluateProposal(emergencyAutoProposal, { physicalState: 'in_pocket' });
    expect(pocketAuto.action).toBe('SILENT_AUTO_EXECUTE');
    expect(pocketAuto.targetDelivery).toBe('SILENT_EXECUTE');

    const callAuto = gate.evaluateProposal(emergencyAutoProposal, { inCall: true });
    expect(callAuto.action).toBe('SILENT_AUTO_EXECUTE');
    expect(callAuto.targetDelivery).toBe('SILENT_EXECUTE');

    // Non-auto emergency proposal prompts the user via GLASS_MODAL
    const emergencyPromptProposal: ProposalEnvelope = {
      id: 'prop_urgent_alert',
      candidateId: 'cand_alert',
      summary: 'Critical emergency alert requiring user confirmation',
      urgency: 0.98,
      confidence: 0.95,
      estimatedRisk: 0.8, // high risk -> requires prompt
    };
    const pocketPrompt = gate.evaluateProposal(emergencyPromptProposal, { physicalState: 'in_pocket' });
    expect(pocketPrompt.action).toBe('ALLOW_PROMPT');
    expect(pocketPrompt.targetDelivery).toBe('GLASS_MODAL');
  });

  it('gates heavy network sync proposals when network is metered', () => {
    const syncProposal: ProposalEnvelope = {
      id: 'prop_heavy_sync',
      candidateId: 'cand_sync',
      summary: 'Heavy graph sync with remote exocortex',
      category: 'sync',
      urgency: 0.4,
      confidence: 0.92,
      estimatedRisk: 0.05,
      suggestedAction: { command: 'diagnostic_probe', heavyNetwork: true },
    };

    // On unmetered network -> auto executes
    const unmeteredDecision = gate.evaluateProposal(syncProposal, { networkMetered: false, hourOfDay: 14 });
    expect(unmeteredDecision.action).toBe('SILENT_AUTO_EXECUTE');

    // On metered network -> suppressed and queued to preserve cellular bandwidth
    const meteredDecision = gate.evaluateProposal(syncProposal, { networkMetered: true, hourOfDay: 14 });
    expect(meteredDecision.action).toBe('SUPPRESS_AND_QUEUE');
    expect(meteredDecision.targetDelivery).toBe('BACKGROUND_QUEUE');
    expect(meteredDecision.reason).toContain('Metered network connection');

    // In pocket + metered network -> metered gate takes precedence over pocket auto-execute
    const pocketMeteredDecision = gate.evaluateProposal(syncProposal, { physicalState: 'in_pocket', networkMetered: true, hourOfDay: 14 });
    expect(pocketMeteredDecision.action).toBe('SUPPRESS_AND_QUEUE');
    expect(pocketMeteredDecision.targetDelivery).toBe('BACKGROUND_QUEUE');
    expect(pocketMeteredDecision.reason).toContain('Metered network connection');
  });

  it('bypasses pocket suppression when screen is active and ON', () => {
    const proposal: ProposalEnvelope = {
      id: 'prop_screen_on',
      candidateId: 'cand_so',
      summary: 'Prompt with screen active',
      urgency: 0.5,
      confidence: 0.8,
      estimatedRisk: 0.1,
    };

    // When screen is ON, user is actively holding/interacting with device -> prompt allowed
    const decision = gate.evaluateProposal(proposal, { physicalState: 'in_pocket', screenState: 'ON', hourOfDay: 14 });
    expect(decision.action).toBe('ALLOW_PROMPT');
    expect(decision.targetDelivery).toBe('GLASS_MODAL');
  });

  it('clears pocket suppression when physicalState transitions to undefined', () => {
    const proposal: ProposalEnvelope = {
      id: 'prop_latch_test',
      candidateId: 'cand_lt',
      summary: 'Prompt for latching test',
      urgency: 0.5,
      confidence: 0.8,
      estimatedRisk: 0.1,
    };

    // Step 1: In pocket -> suppressed
    const pocketDecision = gate.evaluateProposal(proposal, { physicalState: 'in_pocket', hourOfDay: 14 });
    expect(pocketDecision.action).toBe('SUPPRESS_AND_QUEUE');

    // Step 2: ContextTracker TTL expires, emitting physicalState: undefined -> no longer suppressed
    const expiredDecision = gate.evaluateProposal(proposal, { physicalState: undefined, hourOfDay: 14 });
    expect(expiredDecision.action).toBe('ALLOW_PROMPT');
  });

  it('correctly maps contextToSignals ignoring unknown state and offline network', () => {
    const signals = contextToSignals({
      physical_surface: { state: 'unknown' },
      ambient: { physical_state: 'desk_ambient' },
      network_telemetry: { connected: false, metered: false },
    });
    // Falls through 'unknown' to 'desk_ambient'
    expect(signals.physicalState).toBe('desk_ambient');
    // Offline network does not emit metered: false
    expect(signals.networkMetered).toBeUndefined();
  });

  it('classifies HIGH_VELOCITY_EXECUTION when rapid app transitions occur', () => {
    const now = Date.now();
    // With prolonged idle (60s), normally MAINTENANCE_SURFACING; rapid transitions trigger HIGH_VELOCITY
    const mode = gate.classifyMode({
      screenState: 'ON',
      idleDurationMs: 60_000,
      hourOfDay: 14,
      timestamp: now,
      appTransitions: [
        { from: 'com.slack', to: 'com.chrome', dwell_ms: 3000, ts: now - 5000 },
        { from: 'com.chrome', to: 'com.github.android', dwell_ms: 4000, ts: now - 2000 },
        { from: 'com.github.android', to: 'com.slack', dwell_ms: 12000, ts: now },
      ],
    });
    expect(mode).toBe('HIGH_VELOCITY_EXECUTION');

    // Negative case 1: only 2 transitions (below 3-switch threshold)
    const mode2 = gate.classifyMode({
      screenState: 'ON',
      idleDurationMs: 60_000,
      timestamp: now,
      appTransitions: [
        { from: 'com.slack', to: 'com.chrome', dwell_ms: 3000, ts: now - 5000 },
        { from: 'com.chrome', to: 'com.github.android', dwell_ms: 4000, ts: now - 2000 },
      ],
    });
    expect(mode2).toBe('MAINTENANCE_SURFACING');

    // Negative case 2: slow switches (dwells > 10s)
    const mode3 = gate.classifyMode({
      screenState: 'ON',
      idleDurationMs: 60_000,
      timestamp: now,
      appTransitions: [
        { from: 'com.slack', to: 'com.chrome', dwell_ms: 15000, ts: now - 35000 },
        { from: 'com.chrome', to: 'com.github.android', dwell_ms: 20000, ts: now - 15000 },
        { from: 'com.github.android', to: 'com.slack', dwell_ms: 12000, ts: now },
      ],
    });
    expect(mode3).toBe('MAINTENANCE_SURFACING');

    // Negative case 3: stale transitions (>15 mins old)
    const mode4 = gate.classifyMode({
      screenState: 'ON',
      idleDurationMs: 60_000,
      timestamp: now,
      appTransitions: [
        { from: 'com.slack', to: 'com.chrome', dwell_ms: 3000, ts: now - 20 * 60 * 1000 },
        { from: 'com.chrome', to: 'com.github.android', dwell_ms: 4000, ts: now - 18 * 60 * 1000 },
        { from: 'com.github.android', to: 'com.slack', dwell_ms: 5000, ts: now - 16 * 60 * 1000 },
      ],
    });
    expect(mode4).toBe('MAINTENANCE_SURFACING');
  });

  it('prioritizes immediate GLASS_MODAL delivery when proposal matches active clipboard intent', () => {
    const now = Date.now();
    const proposal: ProposalEnvelope = {
      id: 'prop_track_pkg',
      candidateId: 'cand_track_package',
      summary: 'Track package UPS 1Z999',
      urgency: 0.3, // casual urgency
      confidence: 0.85,
      estimatedRisk: 0.1,
      suggestedAction: {
        command: 'track_package',
      },
    };

    const decision = gate.evaluateProposal(proposal, {
      screenState: 'ON',
      timestamp: now,
      clipboardIntent: {
        entity_type: 'tracking_number',
        value: '1Z9999999999999999',
        action: 'track_package',
        ts: now - 10_000, // 10s ago
      },
    });

    expect(decision.action).toBe('ALLOW_PROMPT');
    expect(decision.targetDelivery).toBe('GLASS_MODAL');
    expect(decision.confidence).toBe(0.85); // Preserves calibrated confidence
    expect(decision.reason).toContain('Clipboard Intent Surface');

    // Negative case: stale clipboard intent (>60s old) does not bypass normal mode routing
    gate.classifyMode({ foregroundApp: 'Code.exe' }); // Put in DEEP_FOCUS
    const staleDecision = gate.evaluateProposal(proposal, {
      screenState: 'ON',
      timestamp: now,
      clipboardIntent: {
        entity_type: 'tracking_number',
        value: '1Z9999999999999999',
        action: 'track_package',
        ts: now - 120_000, // 2 minutes old (stale)
      },
    });
    // In DEEP_FOCUS with urgency 0.3, it should be suppressed and queued, not allowed
    expect(staleDecision.action).toBe('SUPPRESS_AND_QUEUE');
  });
});

