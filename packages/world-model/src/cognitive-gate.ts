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
}

export interface ProposalEnvelope {
  id: string;
  candidateId: string;
  summary: string;
  urgency: number; // 0.0 (casual) to 1.0 (emergency)
  confidence: number; // 0.0 to 1.0
  estimatedRisk: number; // 0.0 (safe/read-only) to 1.0 (destructive)
  category?: string;
  suggestedAction?: Record<string, unknown>;
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
  queueMaxAgeMs: 8 * 60 * 60 * 1000,
};

export class CognitiveModeGate {
  private currentMode: CognitiveMode = 'HIGH_VELOCITY_EXECUTION';
  private config: ModeGateConfig;
  private queuedProposals: ProposalEnvelope[] = [];
  private lastSignals: ContextualSignals = {};

  constructor(config: Partial<ModeGateConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get the current active cognitive mode.
   */
  public get mode(): CognitiveMode {
    return this.currentMode;
  }

  /**
   * Classify the user's cognitive state given environmental, temporal, and behavioural signals.
   */
  public classifyMode(signals: ContextualSignals): CognitiveMode {
    this.lastSignals = signals;

    // 1. Manual override takes highest priority
    if (signals.manualOverrideMode && VALID_MODES.includes(signals.manualOverrideMode)) {
      this.currentMode = signals.manualOverrideMode;
      return this.currentMode;
    }

    const now = new Date(signals.timestamp ?? Date.now());
    const hour = signals.hourOfDay ?? now.getHours();

    // 2. Explicit screen off or prolonged idle during night hours -> REST_RECOVERY
    if ((signals.screenState === 'OFF' || (signals.idleDurationMs ?? 0) > 300000) && (hour >= 22 || hour < 7)) {
      this.currentMode = 'REST_RECOVERY';
      return this.currentMode;
    }

    const app = (signals.foregroundApp ?? '').toLowerCase();
    const title = (signals.windowTitle ?? '').toLowerCase();

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

    // 5. Rest & Recovery hours (quiet hours for non-focus apps: 23:00 to 06:00)
    if (hour >= 23 || hour < 6) {
      this.currentMode = 'REST_RECOVERY';
      return this.currentMode;
    }

    // 6. High Velocity Execution: Rapid interaction velocity (>15 actions/min) or low idle time
    const velocity = signals.recentInteractionVelocity ?? 0;
    if (velocity >= 15 || ((signals.idleDurationMs ?? 0) < 5000 && signals.screenState !== 'OFF')) {
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
  public evaluateProposal(proposal: ProposalEnvelope, signals?: ContextualSignals): GateDecision {
    const activeMode = signals ? this.classifyMode(signals) : this.currentMode;
    const now = Date.now();

    // Invariant: Unacceptably high risk requires explicit approval, cannot be auto-executed
    // Fail closed: out-of-range / non-finite scores can never authorize silent execution.
    // The allowlist (not the numeric scores) is what grants auto-execution of an actionable proposal.
    const canAutoExecute =
      isAutoExecuteAllowlisted(proposal) &&
      Number.isFinite(proposal.confidence) &&
      Number.isFinite(proposal.estimatedRisk) &&
      proposal.confidence <= 1 &&
      proposal.estimatedRisk >= 0 &&
      proposal.confidence >= this.config.autoExecuteMinConfidence &&
      proposal.estimatedRisk <= this.config.autoExecuteMaxRisk;

    switch (activeMode) {
      case 'DEEP_FOCUS': {
        // In Deep Focus, preserve flow state at all costs
        if (canAutoExecute) {
          return {
            action: 'SILENT_AUTO_EXECUTE',
            mode: activeMode,
            reason: `Deep Focus: Confidence ${proposal.confidence.toFixed(2)} meets threshold and risk ${proposal.estimatedRisk.toFixed(2)} is trivial. Executing silently without disturbing flow.`,
            targetDelivery: 'SILENT_EXECUTE',
            confidence: proposal.confidence,
            evaluatedAt: now,
          };
        }

        if (proposal.urgency >= this.config.deepFocusUrgencyCutoff) {
          return {
            action: 'ALLOW_PROMPT',
            mode: activeMode,
            reason: `Deep Focus: Urgency ${proposal.urgency.toFixed(2)} exceeds critical cutoff (${this.config.deepFocusUrgencyCutoff}). Breaching gate.`,
            targetDelivery: 'GLASS_MODAL',
            confidence: proposal.confidence,
            evaluatedAt: now,
          };
        }

        // Otherwise suppress and queue for later review
        this.queueProposal(proposal);
        return {
          action: 'SUPPRESS_AND_QUEUE',
          mode: activeMode,
          reason: `Deep Focus: Preserving flow state. Urgency ${proposal.urgency.toFixed(2)} is below cutoff. Queued for post-focus review.`,
          targetDelivery: 'BACKGROUND_QUEUE',
          confidence: proposal.confidence,
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
            confidence: proposal.confidence,
            evaluatedAt: now,
          };
        }

        if (proposal.confidence >= 0.5 || proposal.urgency >= 0.6) {
          return {
            action: 'ALLOW_PROMPT',
            mode: activeMode,
            reason: `High Velocity: Pre-staged for instant 1-tap biometric glass authorization.`,
            targetDelivery: 'GLASS_MODAL',
            confidence: proposal.confidence,
            evaluatedAt: now,
          };
        }

        this.queueProposal(proposal);
        return {
          action: 'SUPPRESS_AND_QUEUE',
          mode: activeMode,
          reason: `High Velocity: Low confidence proposal queued to avoid context clutter.`,
          targetDelivery: 'BACKGROUND_QUEUE',
          confidence: proposal.confidence,
          evaluatedAt: now,
        };
      }

      case 'EXPLORATORY_LEARNING': {
        // Exploratory Learning: Allow helpful context and insights
        if (proposal.confidence >= 0.6 || proposal.urgency >= 0.5) {
          return {
            action: 'ALLOW_PROMPT',
            mode: activeMode,
            reason: `Exploratory Learning: Contextual proposal surfaced for review.`,
            targetDelivery: 'GLASS_MODAL',
            confidence: proposal.confidence,
            evaluatedAt: now,
          };
        }

        this.queueProposal(proposal);
        return {
          action: 'SUPPRESS_AND_QUEUE',
          mode: activeMode,
          reason: `Exploratory Learning: Marginally relevant proposal queued.`,
          targetDelivery: 'BACKGROUND_QUEUE',
          confidence: proposal.confidence,
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
            confidence: proposal.confidence,
            evaluatedAt: now,
          };
        }

        if (proposal.urgency >= 0.3 || proposal.confidence >= 0.4) {
          return {
            action: 'ALLOW_PROMPT',
            mode: activeMode,
            reason: `Maintenance: Surface binary 1-tap approval during ambient window.`,
            targetDelivery: 'GLASS_MODAL',
            confidence: proposal.confidence,
            evaluatedAt: now,
          };
        }

        return {
          action: 'DROP',
          mode: activeMode,
          reason: `Maintenance: Proposal below minimal relevance threshold.`,
          targetDelivery: 'NONE',
          confidence: proposal.confidence,
          evaluatedAt: now,
        };
      }

      case 'REST_RECOVERY': {
        // Rest & Recovery: Strict zero intrusive alerts unless life/critical security emergency
        if (proposal.urgency >= this.config.restRecoveryUrgencyCutoff) {
          return {
            action: 'ALLOW_PROMPT',
            mode: activeMode,
            reason: `Rest Recovery: Life/critical threshold exceeded (${proposal.urgency.toFixed(2)}). Emergency glass alert allowed.`,
            targetDelivery: 'GLASS_MODAL',
            confidence: proposal.confidence,
            evaluatedAt: now,
          };
        }

        this.queueProposal(proposal);
        return {
          action: 'SUPPRESS_AND_QUEUE',
          mode: activeMode,
          reason: `Rest Recovery: Suppressing all non-emergency interruptions during quiet hours. Staged for morning briefing.`,
          targetDelivery: 'BACKGROUND_QUEUE',
          confidence: proposal.confidence,
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
          confidence: proposal.confidence,
          evaluatedAt: now,
        };
      }
    }
  }

  /**
   * Queue a proposal for delayed execution or batched morning surfacing.
   */
  private queueProposal(proposal: ProposalEnvelope): void {
    proposal.stagedAt = proposal.stagedAt ?? Date.now();
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
