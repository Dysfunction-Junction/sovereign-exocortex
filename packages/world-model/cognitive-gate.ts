/**
 * @file cognitive-gate.ts
 * Pillar 2 of the Magic Piece: The Cognitive Mode Gate.
 * 
 * Attentional filtering engine that classifies the user's cognitive bandwidth
 * and flow-state in real time, routing speculative actions and alerts:
 * - DEEP_FOCUS: Code debugging, terminal active -> Silently executes low-risk dry-runs; suppresses trivial interruptions.
 * - HIGH_VELOCITY_EXECUTION: Active multi-tool switching -> Pre-stages high probability actions for 1-tap glass modal.
 * - EXPLORATORY_LEARNING: Research, reading, browsing -> Surfaces rich context and related notes.
 * - MAINTENANCE_SURFACING: Chores, idle screen, transit -> Condenses proposals into 1-sentence binary yes/no glass modals.
 * - REST_RECOVERY: Evening, screen-off, quiet hours -> Zero intrusive modals; silently queues tasks for morning review.
 */

import type { PredictionContext } from '@exocortex/core';

export type CognitiveMode =
  | 'DEEP_FOCUS'
  | 'HIGH_VELOCITY_EXECUTION'
  | 'EXPLORATORY_LEARNING'
  | 'MAINTENANCE_SURFACING'
  | 'REST_RECOVERY';

export interface ContextualSignals {
  foregroundApp?: string;
  windowTitle?: string;
  timestamp?: number;
  hourOfDay?: number; // 0 - 23
  isWeekend?: boolean;
  screenState?: 'ON' | 'OFF' | 'UNLOCKED';
  idleDurationMs?: number;
  recentInteractionVelocity?: number; // actions per minute
  userDwellMs?: number;
  hesitationScore?: number; // 0.0 to 1.0 (from neuromuscular micro-telemetry)
  manualOverrideMode?: CognitiveMode | null;
  // Native hardware signals
  inCall?: boolean;
  audioOutput?: 'speaker' | 'bluetooth_headset' | 'wired_headset' | string;
  motionState?: 'still' | 'walking' | 'running' | 'in_vehicle' | 'unknown' | string;
  thermalHeadroom?: number;
  thermalStatus?: 'nominal' | 'elevated' | 'throttling' | string;
  physicalState?: 'in_pocket' | 'face_down' | 'desk_ambient' | 'handheld' | 'at_ear' | 'unknown' | string;
  networkMetered?: boolean;
  carAudioConnected?: boolean;
  interruptionFilter?: 'ALL' | 'PRIORITY' | 'NONE' | 'ALARMS' | 'UNKNOWN' | string;
  dndActive?: boolean;
  appTransitions?: Array<{ from: string; to: string; dwell_ms?: number; ts?: number; hour?: number }>;
  clipboardIntent?: {
    entity_type: string;
    value: string;
    snippet?: string;
    action?: string;
    ts?: number;
  };
}

export interface ProposalEnvelope {
  id: string;
  candidateId: string;
  summary: string;
  urgency: number; // 0.0 (casual) to 1.0 (emergency)
  confidence: number; // 0.0 to 1.0
  estimatedRisk: number; // 0.0 (safe/read-only) to 1.0 (destructive)
  category?: string;
  suggestedAction?: {
    command?: unknown;
    requiresNetwork?: boolean;
    heavyNetwork?: boolean;
    [key: string]: unknown;
  } | Record<string, unknown> | null;
  stagedAt?: number;
}

export type GateAction =
  | 'ALLOW_PROMPT'
  | 'SUPPRESS_AND_QUEUE'
  | 'SILENT_AUTO_EXECUTE'
  | 'DROP';

export type DeliveryTarget =
  | 'GLASS_MODAL'
  | 'BACKGROUND_QUEUE'
  | 'SILENT_EXECUTE'
  | 'NONE';

export interface GateDecision {
  action: GateAction;
  mode: CognitiveMode;
  reason: string;
  targetDelivery: DeliveryTarget;
  confidence: number;
  evaluatedAt: number;
}

export interface ModeGateConfig {
  autoExecuteMinConfidence: number; // default 0.88
  autoExecuteMaxRisk: number; // default 0.15
  deepFocusUrgencyCutoff: number; // default 0.85
  restRecoveryUrgencyCutoff: number; // default 0.95
  emergencyUrgencyCutoff: number; // default 0.95
  thermalThrottlingCutoff: number; // default 1.0
  queueMaxAgeMs: number; // default 8 hours (28,800,000 ms)
}

const VALID_MODES: readonly CognitiveMode[] = [
  'DEEP_FOCUS',
  'HIGH_VELOCITY_EXECUTION',
  'EXPLORATORY_LEARNING',
  'MAINTENANCE_SURFACING',
  'REST_RECOVERY',
];

/**
 * Action commands that may ever be SILENT_AUTO_EXECUTEd. Everything else is surfaced for approval.
 * Only `diagnostic_probe` (read-only, idempotent, zero-risk graph/telemetry inspection) is listed;
 * state-changing commands such as `self_heal_restore` are deliberately absent.
 */
export const AUTO_EXECUTE_ALLOWLIST: ReadonlySet<string> = new Set(['diagnostic_probe']);

/**
 * True when the proposal may be auto-executed: it carries no action to actuate, or its action
 * command is allowlisted. A malformed/non-string command fails closed.
 */
export function isAutoExecuteAllowlisted(proposal: ProposalEnvelope): boolean {
  const action = proposal.suggestedAction;
  if (action === undefined || action === null) return true;
  const command = (action as Record<string, unknown>).command;
  return typeof command === 'string' && AUTO_EXECUTE_ALLOWLIST.has(command);
}

/** Hard cap on suppressed proposals so a flood cannot grow the queue without bound. */
export const MAX_QUEUED_PROPOSALS = 1000;

const DEFAULT_CONFIG: ModeGateConfig = {
  autoExecuteMinConfidence: 0.88,
  autoExecuteMaxRisk: 0.15,
  deepFocusUrgencyCutoff: 0.85,
  restRecoveryUrgencyCutoff: 0.95,
  emergencyUrgencyCutoff: 0.95,
  thermalThrottlingCutoff: 1.0,
  queueMaxAgeMs: 8 * 60 * 60 * 1000,
};

export class CognitiveModeGate {
  private currentMode: CognitiveMode = 'HIGH_VELOCITY_EXECUTION';
  private config: ModeGateConfig;
  private queuedProposals: ProposalEnvelope[] = [];
  private lastSignals: ContextualSignals = {};

  constructor(config: Partial<ModeGateConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      emergencyUrgencyCutoff: Number.isFinite(config.emergencyUrgencyCutoff) ? config.emergencyUrgencyCutoff! : DEFAULT_CONFIG.emergencyUrgencyCutoff,
      thermalThrottlingCutoff: Number.isFinite(config.thermalThrottlingCutoff) ? config.thermalThrottlingCutoff! : DEFAULT_CONFIG.thermalThrottlingCutoff,
    };
  }

  /**
   * Get the current active cognitive mode.
   */
  public get mode(): CognitiveMode {
    return this.currentMode;
  }

  /**
   * Get a snapshot of the most recently evaluated contextual signals.
   */
  public getLastSignals(): ContextualSignals {
    return { ...this.lastSignals };
  }

  /**
   * Classify the user's cognitive state given environmental, temporal, and behavioural signals.
   */
  public classifyMode(signals: ContextualSignals): CognitiveMode {
    if (!signals || typeof signals !== 'object') {
      return this.currentMode;
    }
    this.lastSignals = { ...signals };
    const effective = this.lastSignals;

    // 1. Manual override takes highest priority
    if (effective.manualOverrideMode && VALID_MODES.includes(effective.manualOverrideMode)) {
      this.currentMode = effective.manualOverrideMode;
      return this.currentMode;
    }

    // Active phone call or VoIP meeting -> DEEP_FOCUS flow protection
    if (effective.inCall) {
      this.currentMode = 'DEEP_FOCUS';
      return this.currentMode;
    }

    // Car audio routing infers in_vehicle motion state when not explicitly stationary
    if ((effective.carAudioConnected || effective.audioOutput === 'car_audio') && effective.motionState !== 'stationary') {
      effective.motionState = 'in_vehicle';
    }

    const now = new Date(effective.timestamp ?? Date.now());
    const hour = effective.hourOfDay ?? now.getHours();

    // Native Do-Not-Disturb / Zen / Priority focus mode
    if (
      effective.dndActive ||
      effective.interruptionFilter === 'PRIORITY' ||
      effective.interruptionFilter === 'NONE' ||
      effective.interruptionFilter === 'ALARMS'
    ) {
      if (effective.screenState === 'OFF' || (hour >= 22 || hour < 7)) {
        this.currentMode = 'REST_RECOVERY';
      } else {
        this.currentMode = 'DEEP_FOCUS';
      }
      return this.currentMode;
    }

    // 2. Explicit screen off or prolonged idle during night hours -> REST_RECOVERY
    if ((effective.screenState === 'OFF' || (effective.idleDurationMs ?? 0) > 300000) && (hour >= 22 || hour < 7)) {
      this.currentMode = 'REST_RECOVERY';
      return this.currentMode;
    }

    const app = (effective.foregroundApp ?? '').toLowerCase();
    const title = (effective.windowTitle ?? '').toLowerCase();

    // 3. Deep Focus: Development environments, terminals, complex doc writing
    const isIDE =
      app.includes('code') ||
      app.includes('antigravity') ||
      app.includes('studio') ||
      app.includes('intellij') ||
      app.includes('codex') ||
      app.includes('sublime');
    const isTerminal =
      app.includes('windowsterminal') ||
      app.includes('pwsh') ||
      app.includes('bash') ||
      app.includes('cmd') ||
      app.includes('powershell');
    const hasFocusKeywords =
      title.includes('debugging') ||
      title.includes('refactor') ||
      title.includes('test') ||
      title.includes('git');

    if (isIDE || isTerminal || hasFocusKeywords) {
      this.currentMode = 'DEEP_FOCUS';
      return this.currentMode;
    }

    // 4. Exploratory Learning: Browser docs, research papers, reading apps
    const isBrowser = app.includes('chrome') || app.includes('firefox') || app.includes('edge') || app.includes('brave');
    const isResearchTopic =
      title.includes('arxiv') ||
      title.includes('docs') ||
      title.includes('github.com') ||
      title.includes('stackoverflow') ||
      title.includes('wiki') ||
      title.includes('spec');

    if (isBrowser && isResearchTopic) {
      this.currentMode = 'EXPLORATORY_LEARNING';
      return this.currentMode;
    }

    // 5. Rest & Recovery hours (quiet hours for non-focus apps: 23:00 to 06:00 when screen is not actively ON)
    if ((hour >= 23 || hour < 6) && effective.screenState !== 'ON') {
      this.currentMode = 'REST_RECOVERY';
      return this.currentMode;
    }

    // 6. High Velocity Execution: Rapid interaction velocity (>15 actions/min), rapid recent app transitions, or low idle time
    const velocity = effective.recentInteractionVelocity ?? 0;
    const nowTs = effective.timestamp ?? Date.now();
    const recentTransitions = Array.isArray(effective.appTransitions)
      ? effective.appTransitions.filter((t) => t && typeof t.dwell_ms === 'number' && (!t.ts || nowTs - t.ts < 15 * 60 * 1000))
      : [];
    const hasRapidSwitches =
      recentTransitions.length >= 3 &&
      recentTransitions.filter((t) => (t.dwell_ms ?? 0) < 10000).length >= 2;

    if (velocity >= 15 || hasRapidSwitches || ((effective.idleDurationMs ?? 0) < 5000 && effective.screenState !== 'OFF')) {
      this.currentMode = 'HIGH_VELOCITY_EXECUTION';
      return this.currentMode;
    }

    // 7. Maintenance Surfacing: Routine tasks, home apps, walking, or moderate idle
    this.currentMode = 'MAINTENANCE_SURFACING';
    return this.currentMode;
  }

  /**
   * Filter and route a speculative proposal through the attentional gate.
   */
  public evaluateProposal(rawProposal: ProposalEnvelope, signals?: ContextualSignals): GateDecision {
    const effectiveSignals: ContextualSignals = signals
      ? { ...this.lastSignals, ...signals }
      : this.lastSignals;
    const activeMode = signals ? this.classifyMode(effectiveSignals) : this.currentMode;
    const now = Date.now();

    if (!rawProposal || typeof rawProposal !== 'object' || typeof rawProposal.id !== 'string' || !rawProposal.id.trim()) {
      return {
        action: 'DROP',
        mode: activeMode,
        reason: 'Malformed proposal: missing or invalid proposal envelope or id (fail closed).',
        targetDelivery: 'NONE',
        confidence: 0,
        evaluatedAt: now,
      };
    }

    const rawU = rawProposal.urgency;
    const rawC = rawProposal.confidence;
    const rawR = rawProposal.estimatedRisk;

    // For interruption gating, emergency cutoffs must not be silenced if urgency > 1
    const urgency = typeof rawU === 'number' && Number.isFinite(rawU) ? Math.max(0, Math.min(1, rawU)) : 0;
    // For confidence and risk, fail closed: out-of-range values reset to minimal confidence / maximum risk
    const confidence = typeof rawC === 'number' && Number.isFinite(rawC) && rawC >= 0 && rawC <= 1 ? rawC : 0;
    const risk = typeof rawR === 'number' && Number.isFinite(rawR) && rawR >= 0 && rawR <= 1 ? rawR : 1;

    const stagedAt = typeof rawProposal.stagedAt === 'number' && Number.isFinite(rawProposal.stagedAt) && rawProposal.stagedAt > 0 && rawProposal.stagedAt <= now
      ? rawProposal.stagedAt
      : now;

    const proposal: ProposalEnvelope = {
      ...rawProposal,
      urgency,
      confidence,
      estimatedRisk: risk,
      stagedAt,
    };

    const isThrottling =
      (typeof effectiveSignals.thermalHeadroom === 'number' && effectiveSignals.thermalHeadroom >= this.config.thermalThrottlingCutoff) ||
      effectiveSignals.thermalStatus === 'throttling';

    // Invariant: Unacceptably high risk requires explicit approval, cannot be auto-executed.
    // Under thermal exhaustion, all speculative auto-execution is disabled.
    // Fail closed: out-of-range / non-finite scores can never authorize silent execution.
    // The allowlist (not the numeric scores) is what grants auto-execution of an actionable proposal.
    const canAutoExecute =
      !isThrottling &&
      isAutoExecuteAllowlisted(proposal) &&
      confidence >= this.config.autoExecuteMinConfidence &&
      risk <= this.config.autoExecuteMaxRisk;

    // Thermal Headroom Protection: Suppress speculative and background workloads under thermal exhaustion
    if (isThrottling && urgency < this.config.emergencyUrgencyCutoff) {
      this.queueProposal(proposal);
      return {
        action: 'SUPPRESS_AND_QUEUE',
        mode: activeMode,
        reason: `Thermal exhaustion: device throttling (${typeof effectiveSignals.thermalHeadroom === 'number' ? `headroom ${effectiveSignals.thermalHeadroom.toFixed(2)}` : 'status throttling'}). Workload staged for cooldown.`,
        targetDelivery: 'BACKGROUND_QUEUE',
        confidence,
        evaluatedAt: now,
      };
    }

    // Metered Network Gating: Suppress heavy background data sync on metered connections
    // Evaluated before call/pocket auto-execution to prevent silent cellular data exhaustion
    if (effectiveSignals.networkMetered && urgency < this.config.emergencyUrgencyCutoff) {
      const isSyncOrNetworkHeavy =
        proposal.category === 'sync' ||
        proposal.category === 'download' ||
        proposal.category === 'backup' ||
        Boolean(proposal.suggestedAction && proposal.suggestedAction.heavyNetwork);
      if (isSyncOrNetworkHeavy) {
        this.queueProposal(proposal);
        return {
          action: 'SUPPRESS_AND_QUEUE',
          mode: activeMode,
          reason: `Metered network connection: network-intensive proposal (${proposal.category ?? 'network_sync'}) queued until unmetered Wi-Fi/Ethernet is available.`,
          targetDelivery: 'BACKGROUND_QUEUE',
          confidence,
          evaluatedAt: now,
        };
      }
    }

    // Audio Mode & Interruption Gating: Suppress intrusive modals during phone calls & VoIP meetings
    if (effectiveSignals.inCall) {
      if (canAutoExecute) {
        return {
          action: 'SILENT_AUTO_EXECUTE',
          mode: activeMode,
          reason: `In-call/meeting: Safe proposal executed silently without disturbing conversation.`,
          targetDelivery: 'SILENT_EXECUTE',
          confidence,
          evaluatedAt: now,
        };
      }
      if (urgency >= this.config.emergencyUrgencyCutoff) {
        return {
          action: 'ALLOW_PROMPT',
          mode: activeMode,
          reason: `In-call/meeting: Critical emergency urgency ${urgency.toFixed(2)} breaches call suppression gate.`,
          targetDelivery: 'GLASS_MODAL',
          confidence,
          evaluatedAt: now,
        };
      }
      this.queueProposal(proposal);
      return {
        action: 'SUPPRESS_AND_QUEUE',
        mode: activeMode,
        reason: `In-call/meeting active: non-emergency interruptions suppressed to preserve conversation flow.`,
        targetDelivery: 'BACKGROUND_QUEUE',
        confidence,
        evaluatedAt: now,
      };
    }

    // Low-Power Motion Prior & Car Audio: In-vehicle driving safety gating
    const isDriving =
      effectiveSignals.motionState === 'in_vehicle' ||
      ((effectiveSignals.carAudioConnected === true || effectiveSignals.audioOutput === 'car_audio') &&
        effectiveSignals.motionState !== 'stationary');

    if (isDriving) {
      if (canAutoExecute) {
        return {
          action: 'SILENT_AUTO_EXECUTE',
          mode: activeMode,
          reason: `In-vehicle / Car Audio: Safe routine action executed silently without visual distraction.`,
          targetDelivery: 'SILENT_EXECUTE',
          confidence,
          evaluatedAt: now,
        };
      }
      if (urgency >= this.config.emergencyUrgencyCutoff) {
        return {
          action: 'ALLOW_PROMPT',
          mode: activeMode,
          reason: `In-vehicle / Car Audio: Critical emergency urgency ${urgency.toFixed(2)} allowed.`,
          targetDelivery: 'GLASS_MODAL',
          confidence,
          evaluatedAt: now,
        };
      }
      this.queueProposal(proposal);
      return {
        action: 'SUPPRESS_AND_QUEUE',
        mode: activeMode,
        reason: `In-vehicle / Car Audio connected: visual modals suppressed for driving safety.`,
        targetDelivery: 'BACKGROUND_QUEUE',
        confidence,
        evaluatedAt: now,
      };
    }

    // Native Zen / Do-Not-Disturb (DND) Interruption Gating
    const isDnd =
      effectiveSignals.dndActive === true ||
      effectiveSignals.interruptionFilter === 'PRIORITY' ||
      effectiveSignals.interruptionFilter === 'NONE' ||
      effectiveSignals.interruptionFilter === 'ALARMS';

    if (isDnd) {
      if (canAutoExecute) {
        return {
          action: 'SILENT_AUTO_EXECUTE',
          mode: activeMode,
          reason: `Zen/DND active: Safe routine action executed silently without visual interruption.`,
          targetDelivery: 'SILENT_EXECUTE',
          confidence,
          evaluatedAt: now,
        };
      }
      // Total silence requested under interruptionFilter === 'NONE'
      if (effectiveSignals.interruptionFilter === 'NONE') {
        this.queueProposal(proposal);
        return {
          action: 'SUPPRESS_AND_QUEUE',
          mode: activeMode,
          reason: `Zen/DND total silence (interruption filter NONE): all visual interruptions suppressed.`,
          targetDelivery: 'BACKGROUND_QUEUE',
          confidence,
          evaluatedAt: now,
        };
      }
      if (urgency >= this.config.emergencyUrgencyCutoff) {
        return {
          action: 'ALLOW_PROMPT',
          mode: activeMode,
          reason: `Zen/DND active: Critical emergency urgency ${urgency.toFixed(2)} allowed through filter.`,
          targetDelivery: 'GLASS_MODAL',
          confidence,
          evaluatedAt: now,
        };
      }
      this.queueProposal(proposal);
      return {
        action: 'SUPPRESS_AND_QUEUE',
        mode: activeMode,
        reason: `Zen/DND active (${effectiveSignals.interruptionFilter ?? 'ACTIVE'}): non-emergency notifications suppressed.`,
        targetDelivery: 'BACKGROUND_QUEUE',
        confidence,
        evaluatedAt: now,
      };
    }

    // Physical Surface & Pocket Gating: Suppress intrusive modals when phone is in pocket or face down
    // (Bypassed if the screen is already ON and interactive)
    if (
      effectiveSignals.screenState !== 'ON' &&
      (effectiveSignals.physicalState === 'in_pocket' || effectiveSignals.physicalState === 'face_down')
    ) {
      if (canAutoExecute) {
        return {
          action: 'SILENT_AUTO_EXECUTE',
          mode: activeMode,
          reason: `Physical surface (${effectiveSignals.physicalState}): Safe routine proposal executed silently without activating display.`,
          targetDelivery: 'SILENT_EXECUTE',
          confidence,
          evaluatedAt: now,
        };
      }
      if (urgency >= this.config.emergencyUrgencyCutoff) {
        return {
          action: 'ALLOW_PROMPT',
          mode: activeMode,
          reason: `Physical surface (${effectiveSignals.physicalState}): Critical emergency urgency ${urgency.toFixed(2)} breaches pocket suppression gate.`,
          targetDelivery: 'GLASS_MODAL',
          confidence,
          evaluatedAt: now,
        };
      }
      this.queueProposal(proposal);
      return {
        action: 'SUPPRESS_AND_QUEUE',
        mode: activeMode,
        reason: `Device is ${effectiveSignals.physicalState === 'in_pocket' ? 'in pocket' : 'face down'}: visual modals suppressed to prevent phantom touches and save power.`,
        targetDelivery: 'BACKGROUND_QUEUE',
        confidence,
        evaluatedAt: now,
      };
    }

    // Clipboard Intent Surface: If proposal matches an active fresh clipboard intent, prioritize immediate glass modal
    const clipIntent = effectiveSignals.clipboardIntent;
    const isClipIntentFresh = Boolean(clipIntent && (!clipIntent.ts || now - clipIntent.ts < 60_000));
    if (
      isClipIntentFresh &&
      clipIntent &&
      typeof clipIntent.action === 'string' &&
      !isThrottling &&
      effectiveSignals.screenState !== 'OFF'
    ) {
      const clipAct = clipIntent.action.trim().toLowerCase();
      const propCmd = typeof (proposal.suggestedAction as Record<string, unknown> | null)?.command === 'string'
        ? ((proposal.suggestedAction as Record<string, unknown>).command as string).trim().toLowerCase()
        : '';
      const isExactMatch = clipAct.length > 0 && (
        propCmd === clipAct ||
        (proposal.category === 'clipboard_action' && proposal.candidateId.toLowerCase() === clipAct)
      );

      // Do not breach safety: proposal must be low risk or have high urgency
      const isSafeOrUrgent = risk <= this.config.autoExecuteMaxRisk || urgency >= 0.8;

      if (isExactMatch && isSafeOrUrgent) {
        return {
          action: 'ALLOW_PROMPT',
          mode: activeMode,
          reason: `Clipboard Intent Surface: Immediate match for ${clipIntent.action} (${clipIntent.entity_type}).`,
          targetDelivery: 'GLASS_MODAL',
          confidence,
          evaluatedAt: now,
        };
      }
    }

    switch (activeMode) {
      case 'DEEP_FOCUS': {
        // In Deep Focus, preserve flow state at all costs
        if (canAutoExecute) {
          return {
            action: 'SILENT_AUTO_EXECUTE',
            mode: activeMode,
            reason: `Deep Focus: Confidence ${confidence.toFixed(2)} meets threshold and risk ${risk.toFixed(2)} is trivial. Executing silently without disturbing flow.`,
            targetDelivery: 'SILENT_EXECUTE',
            confidence,
            evaluatedAt: now,
          };
        }

        if (urgency >= this.config.deepFocusUrgencyCutoff) {
          return {
            action: 'ALLOW_PROMPT',
            mode: activeMode,
            reason: `Deep Focus: Urgency ${urgency.toFixed(2)} exceeds critical cutoff (${this.config.deepFocusUrgencyCutoff}). Breaching gate.`,
            targetDelivery: 'GLASS_MODAL',
            confidence,
            evaluatedAt: now,
          };
        }

        // Otherwise suppress and queue for later review
        this.queueProposal(proposal);
        return {
          action: 'SUPPRESS_AND_QUEUE',
          mode: activeMode,
          reason: `Deep Focus: Preserving flow state. Urgency ${urgency.toFixed(2)} is below cutoff. Queued for post-focus review.`,
          targetDelivery: 'BACKGROUND_QUEUE',
          confidence,
          evaluatedAt: now,
        };
      }

      case 'HIGH_VELOCITY_EXECUTION': {
        // High Velocity: Deliver 1-tap glass modal if confidence is substantial
        if (canAutoExecute) {
          return {
            action: 'SILENT_AUTO_EXECUTE',
            mode: activeMode,
            reason: `High Velocity: Safe routine pre-execution completed silently.`,
            targetDelivery: 'SILENT_EXECUTE',
            confidence,
            evaluatedAt: now,
          };
        }

        if (confidence >= 0.5 || urgency >= 0.6) {
          return {
            action: 'ALLOW_PROMPT',
            mode: activeMode,
            reason: `High Velocity: Pre-staged for instant 1-tap biometric glass authorization.`,
            targetDelivery: 'GLASS_MODAL',
            confidence,
            evaluatedAt: now,
          };
        }

        this.queueProposal(proposal);
        return {
          action: 'SUPPRESS_AND_QUEUE',
          mode: activeMode,
          reason: `High Velocity: Low confidence proposal queued to avoid context clutter.`,
          targetDelivery: 'BACKGROUND_QUEUE',
          confidence,
          evaluatedAt: now,
        };
      }

      case 'EXPLORATORY_LEARNING': {
        // Exploratory Learning: Allow helpful context and insights
        if (confidence >= 0.6 || urgency >= 0.5) {
          return {
            action: 'ALLOW_PROMPT',
            mode: activeMode,
            reason: `Exploratory Learning: Contextual proposal surfaced for review.`,
            targetDelivery: 'GLASS_MODAL',
            confidence,
            evaluatedAt: now,
          };
        }

        this.queueProposal(proposal);
        return {
          action: 'SUPPRESS_AND_QUEUE',
          mode: activeMode,
          reason: `Exploratory Learning: Marginally relevant proposal queued.`,
          targetDelivery: 'BACKGROUND_QUEUE',
          confidence,
          evaluatedAt: now,
        };
      }

      case 'MAINTENANCE_SURFACING': {
        // Maintenance: Ideal state for clearing queues and binary yes/no glass checks
        if (canAutoExecute) {
          return {
            action: 'SILENT_AUTO_EXECUTE',
            mode: activeMode,
            reason: `Maintenance: Background maintenance executed automatically.`,
            targetDelivery: 'SILENT_EXECUTE',
            confidence,
            evaluatedAt: now,
          };
        }

        if (urgency >= 0.3 || confidence >= 0.4) {
          return {
            action: 'ALLOW_PROMPT',
            mode: activeMode,
            reason: `Maintenance: Surface binary 1-tap approval during ambient window.`,
            targetDelivery: 'GLASS_MODAL',
            confidence,
            evaluatedAt: now,
          };
        }

        return {
          action: 'DROP',
          mode: activeMode,
          reason: `Maintenance: Proposal below minimal relevance threshold.`,
          targetDelivery: 'NONE',
          confidence,
          evaluatedAt: now,
        };
      }

      case 'REST_RECOVERY': {
        // Rest & Recovery: Strict zero intrusive alerts unless life/critical security emergency
        if (urgency >= this.config.restRecoveryUrgencyCutoff) {
          return {
            action: 'ALLOW_PROMPT',
            mode: activeMode,
            reason: `Rest Recovery: Life/critical threshold exceeded (${urgency.toFixed(2)}). Emergency glass alert allowed.`,
            targetDelivery: 'GLASS_MODAL',
            confidence,
            evaluatedAt: now,
          };
        }

        this.queueProposal(proposal);
        return {
          action: 'SUPPRESS_AND_QUEUE',
          mode: activeMode,
          reason: `Rest Recovery: Suppressing all non-emergency interruptions during quiet hours. Staged for morning briefing.`,
          targetDelivery: 'BACKGROUND_QUEUE',
          confidence,
          evaluatedAt: now,
        };
      }

      default: {
        // Unknown mode (corrupt state): fail closed by suppressing and queueing
        this.queueProposal(proposal);
        return {
          action: 'SUPPRESS_AND_QUEUE',
          mode: activeMode,
          reason: `Unknown cognitive mode '${String(activeMode)}': suppressed and queued (fail closed).`,
          targetDelivery: 'BACKGROUND_QUEUE',
          confidence,
          evaluatedAt: now,
        };
      }
    }
  }

  /**
   * Queue a proposal for delayed execution or batched morning surfacing.
   */
  private queueProposal(proposal: ProposalEnvelope): void {
    if (!proposal.id || this.queuedProposals.some(p => p.id === proposal.id)) return;
    this.queuedProposals.push(proposal);
    if (this.queuedProposals.length > MAX_QUEUED_PROPOSALS) {
      this.queuedProposals.splice(0, this.queuedProposals.length - MAX_QUEUED_PROPOSALS);
    }
  }

  /**
   * Get all currently queued proposals, evicting any that exceed max TTL.
   */
  public getPendingQueue(): ProposalEnvelope[] {
    const now = Date.now();
    this.queuedProposals = this.queuedProposals.filter(
      p => !p.stagedAt || now - p.stagedAt < this.config.queueMaxAgeMs
    );
    return [...this.queuedProposals];
  }

  /**
   * Clears and returns all queued proposals when transitioning out of Deep Focus or Rest Recovery.
   */
  public drainQueue(): ProposalEnvelope[] {
    const items = this.getPendingQueue();
    this.queuedProposals = [];
    return items;
  }

  /**
   * Size of current suppressed queue.
   */
  public get queueSize(): number {
    return this.getPendingQueue().length; // evicts TTL-expired entries so the size is not stale
  }
}

function toBool(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
  }
  if (typeof raw === 'number') {
    if (raw === 1) return true;
    if (raw === 0) return false;
  }
  return undefined;
}

const VALID_INTERRUPTION_FILTERS = new Set(['ALL', 'PRIORITY', 'NONE', 'ALARMS', 'UNKNOWN'] as const);

function normalizeInterruptionFilter(raw: unknown): ContextualSignals['interruptionFilter'] {
  if (typeof raw === 'number') {
    switch (raw) {
      case 1: return 'ALL';
      case 2: return 'PRIORITY';
      case 3: return 'NONE';
      case 4: return 'ALARMS';
      case 0: return 'UNKNOWN';
      default: return undefined;
    }
  }
  if (typeof raw === 'string') {
    const cleaned = raw.trim().toUpperCase().replace(/^INTERRUPTION_FILTER_/, '');
    if (cleaned === '1') return 'ALL';
    if (cleaned === '2') return 'PRIORITY';
    if (cleaned === '3') return 'NONE';
    if (cleaned === '4') return 'ALARMS';
    if (cleaned === '0') return 'UNKNOWN';
    if (VALID_INTERRUPTION_FILTERS.has(cleaned as any)) {
      return cleaned as ContextualSignals['interruptionFilter'];
    }
  }
  return undefined;
}

/**
 * Map a PredictionContext snapshot to ContextualSignals for the CognitiveModeGate.
 */
export function contextToSignals(ctx: PredictionContext | undefined): ContextualSignals {
  if (!ctx) return {};
  const screenUpper = ctx.device?.screen_state?.toUpperCase();
  const screenState: 'ON' | 'OFF' | 'UNLOCKED' | undefined =
    screenUpper === 'ON' ? 'ON' : screenUpper === 'OFF' ? 'OFF' : screenUpper === 'UNLOCKED' ? 'UNLOCKED' : undefined;

  const rawRecord = ctx as Record<string, unknown>;
  const focusRecord = rawRecord.focus as Record<string, unknown> | undefined;
  const audioRecord = ctx.audio as Record<string, unknown> | undefined;

  const rawFilter = rawRecord.interruption_filter ?? rawRecord.interruptionFilter ?? focusRecord?.interruption_filter;
  const interruptionFilter = normalizeInterruptionFilter(rawFilter);

  const rawDnd = rawRecord.dnd_active ?? rawRecord.dndActive ?? focusRecord?.dnd_active;
  const parsedDnd = toBool(rawDnd);
  const dndActive = parsedDnd !== undefined
    ? parsedDnd
    : interruptionFilter === 'ALL'
      ? false
      : interruptionFilter && interruptionFilter !== 'UNKNOWN'
        ? true
        : undefined;

  const rawCarAudio = rawRecord.car_audio_connected ?? rawRecord.carAudioConnected ?? audioRecord?.car_audio_connected;
  const carAudioConnected = toBool(rawCarAudio);

  return {
    foregroundApp: ctx.app?.package,
    windowTitle: ctx.app?.screen ?? ctx.app?.label,
    timestamp: ctx.time?.ts,
    hourOfDay: ctx.time?.hour,
    isWeekend: ctx.time?.is_weekend,
    screenState,
    idleDurationMs: ctx.device?.idle_ms,
    inCall: ctx.audio?.in_call,
    audioOutput: ctx.audio?.output_type,
    motionState: ctx.motion?.state,
    thermalHeadroom: ctx.thermal?.headroom,
    thermalStatus: ctx.thermal?.status,
    physicalState: (ctx.physical_surface?.state && ctx.physical_surface.state !== 'unknown' ? ctx.physical_surface.state : undefined) ??
      (ctx.ambient?.physical_state && ctx.ambient.physical_state !== 'unknown' ? ctx.ambient.physical_state : undefined),
    networkMetered: ctx.network_telemetry?.connected === false ? undefined : (ctx.network_telemetry?.metered ?? ctx.device?.metered),
    carAudioConnected,
    interruptionFilter,
    dndActive,
    appTransitions: (rawRecord.app_transitions ?? rawRecord.transitions ?? rawRecord.appTransitions) as ContextualSignals['appTransitions'],
    clipboardIntent: (rawRecord.clipboard_intent ?? rawRecord.clipboardIntent) as ContextualSignals['clipboardIntent'],
  };
}
