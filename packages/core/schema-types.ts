/**
 * @file schema-types.ts
 * Wire protocol types and database entity schemas for Sovereign Exocortex v3.
 */

export interface EventIn {
  event_id: string; // client UUID (makes ingest idempotent)
  kind: 'telemetry' | 'observation' | 'wake' | 'touch' | 'action' | 'label' | string;
  ts_device: number;
  schema_ver: 1;
  payload: Record<string, unknown>;
}

export interface IngestReq {
  device_id: string;
  events: EventIn[];
}

export type RiskTier = 0 | 1 | 2 | 3 | 4;

export interface ProposalPush {
  proposal_id: string;
  tier: RiskTier;
  summary: string;
  action_hash: string;
  nonce: string;
  expires_at: number;
}

export interface ApprovalReq {
  proposal_id: string;
  decision: 'approve' | 'reject';
  nonce: string;
  signature: string; // ECDSA P-256 signature over canonical(ProposalPush + decision)
}

export type ProposalState =
  | 'DRAFT'
  | 'GATED'
  | 'SUPPRESSED'
  | 'STAGED'
  | 'SURFACED'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'EXECUTING'
  | 'SUCCEEDED'
  | 'FAILED';

export type GateDecisionAction = 'SUPPRESS' | 'QUEUE' | 'SURFACE' | 'AUTO_DRY_RUN';

export type ShadowLabel = 'wanted' | 'not_wanted' | 'already_did' | 'ignored';

export interface DeviceRecord {
  device_id: string;
  name: string;
  platform: 'android' | 'windows' | 'linux';
  pubkey_spki: Uint8Array;
  key_attested: number;
  scopes: string[];
  enrolled_at: number;
  revoked_at?: number | null;
}

export interface EventRecord {
  seq: number;
  event_id: string;
  device_id: string;
  kind: string;
  ts_device: number;
  ts_server: number;
  schema_ver: number;
  payload: string; // JSON string
  prev_hash: Uint8Array;
  hash: Uint8Array;
}

export interface ProposalRecord {
  proposal_id: string;
  created_seq: number;
  invariant_id?: string | null;
  policy_type: 'PRAGMATIC' | 'EPISTEMIC';
  tier: RiskTier;
  summary: string;
  action: string; // JSON
  action_hash: Uint8Array;
  efe: number;
  risk_term: number;
  ambiguity_term: number;
  state: ProposalState;
  shadow: number; // 1 or 0
  expires_at: number;
  updated_at: number;
}

export interface InvariantRecord {
  invariant_id: string;
  name: string;
  category: string;
  enabled: number; // 1 or 0
}

export interface ModelParamRecord {
  factor: string;
  kind: 'A' | 'B' | 'C' | 'D';
  version: number;
  counts: string; // JSON array or table of Dirichlet counts
  as_of_seq: number;
}

export interface BeliefSnapshotRecord {
  as_of_seq: number;
  mode: 'DEEP_FOCUS' | 'HIGH_VELOCITY' | 'EXPLORATORY' | 'MAINTENANCE' | 'REST';
  q: string; // JSON belief distribution
  surprisal: number;
}

export interface GateDecisionRecord {
  proposal_id: string;
  mode: string;
  decision: GateDecisionAction;
  reason: string;
  ts: number;
}

export interface ApprovalRecord {
  approval_id: string;
  proposal_id: string;
  device_id: string;
  nonce: string;
  decision: 'approve' | 'reject';
  signed_payload: Uint8Array;
  signature: Uint8Array;
  verified: number;
  ts: number;
}

export interface ExecutionRecord {
  exec_id: string;
  proposal_id: string;
  dry_run: number; // 1 or 0
  started_at: number;
  finished_at?: number | null;
  exit_code?: number | null;
  result?: string | null; // JSON
  undo?: string | null; // JSON
}

export interface ShadowLabelRecord {
  proposal_id: string;
  label: ShadowLabel;
  actual?: string | null; // JSON
  latency_ms?: number | null;
  ts: number;
}

export interface MutationRecord {
  mutation_id: string;
  friction_seq: number;
  base_commit: string;
  branch: string;
  strategy: string;
  diff_hash: Uint8Array;
  gates: string; // JSON
  state: 'REJECTED' | 'PASSED' | 'MERGED' | 'DISCARDED';
  created_at: number;
}

