export enum LifecycleTier {
  Observed = 'observed',   // Tier 0: Raw telemetry counter, no formal status
  Candidate = 'candidate', // In the bounded promotion pool competing for promotion
  Keep = 'keep',           // Graduated: Active automation with reusability meter & 14-day clock
  Review = 'review',       // Demoted: 14 days without execution or high prompt friction
  Archive = 'archive',     // Collapsed: 28 days without execution
  Cut = 'cut',             // Offboarded / uninstalled
}

export enum PatternKind {
  Sequence = 'sequence',                 // Frequent multi-app sequence
  DwellGap = 'dwell_gap',                 // High dwell / manual churn gap
  ShortcutCandidate = 'shortcut_candidate', // Concrete synthesized automation
  AppAlternative = 'app_alternative',     // Better tool / workflow alternative
}

export enum TaskCategory {
  Writing = 'writing',
  Coding = 'coding',
  Communication = 'communication',
  Design = 'design',
  Productivity = 'productivity',
  Media = 'media',
  Finance = 'finance',
  Utilities = 'utilities',
  Other = 'other',
}

export interface TriggerSignature {
  sourceApps: string[];                   // e.g. ['com.android.chrome', 'com.google.android.keep']
  sequenceLength?: number;
  timeContext?: string;                   // e.g. 'weekday_morning'
  windowTitlePatterns?: string[];
}

export interface SuggestedAction {
  type: 'script' | 'intent' | 'shortcut' | 'tool_swap';
  payload: string;                        // Intent URI, script command, or deep link
  estimatedSecondsSaved: number;
}

export interface WorkflowPattern {
  id: string;
  name: string;
  description: string;
  kind: PatternKind;
  taskCategory: TaskCategory;

  // Lifecycle & State Machine
  tier: LifecycleTier;
  tierEnteredAt: string;                  // ISO-8601
  keepClockExpiresAt: string | null;      // 14-day countdown timestamp (null if not in Keep)
  reusabilityCount: number;               // Number of times automation was executed
  promotionScore: number;                 // Decaying score in candidate pool
  lastObservedAt: string;                 // ISO-8601
  lastExecutedAt: string | null;          // ISO-8601

  // Evaluation & Triage
  reviewReason?: 'dormant' | 'high_friction' | 'gap_detected' | null;
  timesPrompted: number;
  timesAccepted: number;
  timesDismissed: number;

  // Pattern specifics
  triggerSignature: TriggerSignature;
  suggestedAction?: SuggestedAction;

  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PatternObservation {
  id: string;
  patternId?: string | null;
  source: 'phone_usage' | 'accessibility_dwell' | 'gemini_nano_gap' | 'desktop_heartbeat' | 'manual';
  actionType: 'launch' | 'dwell' | 'shortcut_executed' | 'prompt_displayed' | 'prompt_accepted' | 'prompt_dismissed';
  durationMs: number;
  observedAt: string;                     // ISO-8601
  metadata?: Record<string, unknown>;
  createdBy: string;
}

export const CONSTANTS = {
  KEEP_DECAY_CLOCK_MS: 14 * 24 * 60 * 60 * 1000,   // 14 days in ms
  REVIEW_TO_ARCHIVE_MS: 14 * 24 * 60 * 60 * 1000,  // 14 days in ms
  CANDIDATE_POOL_CAPACITY: 50,
  SCORE_DECAY_HALF_LIFE_DAYS: 30,
  TIER0_RING_BUFFER_SIZE: 16,
  STAGE2_ADOPTION_THRESHOLD: 0.60,                 // 60% accepted
  STAGE2_FRICTION_THRESHOLD: 0.20,                 // <20% accepted
} as const;
