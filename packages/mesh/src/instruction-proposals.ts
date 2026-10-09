import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { DatabaseSync } from "node:sqlite";

import { agentMeshHmac } from "./coordination-auth.js";
import { MESH_SKILL_IDS } from "./mesh-skills.js";
import {
  PEER_FRICTION_KINDS,
  type PeerFrictionSummary,
} from "./peer-channels.js";
import { redactSecrets, stateDirectory } from "./security.js";
import {
  PROVIDERS,
  type Origin,
  type Provider,
} from "./types.js";

export const INSTRUCTION_PROPOSAL_TARGET_KINDS = [
  "mesh_skill",
  "harness_instructions",
  "repository_ruleset",
] as const;
export type InstructionProposalTargetKind =
  (typeof INSTRUCTION_PROPOSAL_TARGET_KINDS)[number];

export const INSTRUCTION_PROPOSAL_STATES = [
  "proposed",
  "approved",
  "rejected",
  "applied",
  "superseded",
] as const;
export type InstructionProposalState =
  (typeof INSTRUCTION_PROPOSAL_STATES)[number];

export interface InstructionProposalTarget {
  kind: InstructionProposalTargetKind;
  identifier: string;
  relativePath?: string;
}

export interface InstructionFrictionEvidence {
  eventIds: string[];
  summary: PeerFrictionSummary;
}

export type InstructionProposalApprovalStatus =
  | "approved"
  | "void"
  | "consumed";

export interface InstructionProposalApproval {
  id: string;
  origin: Origin;
  proposalId: string;
  proposalSequence: number;
  digest: string;
  status: InstructionProposalApprovalStatus;
  method: "out_of_band_human";
  expiresAt: string | null;
  approvedAt: string;
  voidedAt: string | null;
  consumedAt: string | null;
  voidReason: string | null;
}

export interface InstructionProposal {
  id: string;
  origin: Origin;
  sequence: number;
  target: InstructionProposalTarget;
  proposedContent: string;
  rationale: string;
  frictionEvidence: InstructionFrictionEvidence;
  contentDigest: string;
  state: InstructionProposalState;
  approval: InstructionProposalApproval | null;
  supersedesProposalId: string | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  appliedAt: string | null;
  supersededAt: string | null;
}

export interface InstructionProposalAuditEvent {
  sequence: number;
  origin: Origin;
  proposalId: string;
  event: string;
  fromState: InstructionProposalState | null;
  toState: InstructionProposalState | null;
  data: unknown;
  previousHash: string | null;
  hash: string;
  createdAt: string;
}

export interface InstructionProposalStoreOptions {
  origin: Origin;
  path?: string;
  now?: () => Date;
  repositoryRoots?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
}

export interface CreateInstructionProposalInput {
  target: InstructionProposalTarget;
  proposedContent: string;
  rationale: string;
  frictionEvidence: InstructionFrictionEvidence;
  supersedesProposalId?: string;
  idempotencyKey?: string;
}

type Row = Record<string, unknown>;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/;
const MAX_CONTENT_BYTES = 1024 * 1024;
const MAX_RATIONALE_BYTES = 16 * 1024;
const MAX_EVIDENCE_BYTES = 64 * 1024;
const MAX_AUDIT_BYTES = 64 * 1024;

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite JSON number.");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error(`Unsupported JSON value: ${typeof value}`);
}

function safeJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(text(value)) as T;
  } catch {
    return fallback;
  }
}

function contentDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function instructionProposalContentDigest(value: string): string {
  return contentDigest(value);
}

export function instructionProposalApprovalConfirmation(
  proposalId: string,
  digest: string,
): string {
  return `APPROVE INSTRUCTION PROPOSAL ${proposalId} ${digest}`;
}

function boundedText(
  value: string,
  name: string,
  maximumBytes: number,
  trim = true,
): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string.`);
  const normalized = trim ? value.trim() : value;
  if (!normalized || Buffer.byteLength(normalized, "utf8") > maximumBytes) {
    throw new RangeError(`${name} must contain 1-${maximumBytes} UTF-8 bytes.`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${name} contains control characters.`);
  }
  return normalized;
}

function safeIdentifier(value: string, name: string): string {
  const normalized = boundedText(value, name, 512);
  if (!IDENTIFIER_PATTERN.test(normalized)) throw new Error(`Invalid ${name}.`);
  return normalized;
}

function safeInstant(value: string, name: string): string {
  const parsed = Date.parse(boundedText(value, name, 64));
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an instant.`);
  return new Date(parsed).toISOString();
}

function boundedInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return value;
}

function normalizeTarget(target: InstructionProposalTarget): InstructionProposalTarget {
  if (!INSTRUCTION_PROPOSAL_TARGET_KINDS.includes(target.kind)) {
    throw new Error("Unsupported instruction proposal target kind.");
  }
  const identifier = safeIdentifier(target.identifier, "target identifier");
  if (
    target.kind === "mesh_skill" &&
    !(MESH_SKILL_IDS as readonly string[]).includes(identifier)
  ) {
    throw new Error("Unknown mesh skill proposal target.");
  }
  if (
    target.kind === "harness_instructions" &&
    !PROVIDERS.includes(identifier as Provider)
  ) {
    throw new Error("Unknown harness instruction proposal target.");
  }
  if (target.kind === "repository_ruleset") {
    return {
      kind: target.kind,
      identifier,
      relativePath: boundedText(
        target.relativePath ?? "",
        "repository ruleset relative path",
        2_000,
      ),
    };
  }
  if (target.relativePath !== undefined) {
    throw new Error("Only repository ruleset targets accept a relative path.");
  }
  return { kind: target.kind, identifier };
}

function normalizeEvidence(
  evidence: InstructionFrictionEvidence,
): InstructionFrictionEvidence {
  if (!evidence || typeof evidence !== "object") {
    throw new Error("Instruction proposal friction evidence is required.");
  }
  if (
    !Array.isArray(evidence.eventIds) ||
    evidence.eventIds.length < 1 ||
    evidence.eventIds.length > 500
  ) {
    throw new Error("Instruction proposals must cite 1-500 friction events.");
  }
  const eventIds = [...new Set(
    evidence.eventIds.map((id) => safeIdentifier(id, "friction event id")),
  )];
  if (eventIds.length !== evidence.eventIds.length) {
    throw new Error("Instruction proposal friction event ids must be unique.");
  }
  const summary = evidence.summary;
  if (!summary || typeof summary !== "object") {
    throw new Error("Instruction proposal friction summary is required.");
  }
  if (!Array.isArray(summary.byKind) || !Array.isArray(summary.byProvider)) {
    throw new Error("Instruction proposal friction summary groups are required.");
  }
  const total = boundedInteger(summary.total, "friction summary total", 1, 1_000_000);
  const byKind = summary.byKind.map((entry) => {
    if (!PEER_FRICTION_KINDS.includes(entry.kind)) {
      throw new Error("Unsupported friction summary kind.");
    }
    return {
      kind: entry.kind,
      count: boundedInteger(entry.count, "friction kind count", 1, 1_000_000),
    };
  });
  const byProvider = summary.byProvider.map((entry) => {
    if (entry.provider !== null && !PROVIDERS.includes(entry.provider)) {
      throw new Error("Unsupported friction summary provider.");
    }
    return {
      provider: entry.provider,
      count: boundedInteger(
        entry.count,
        "friction provider count",
        1,
        1_000_000,
      ),
    };
  });
  const normalized = { eventIds, summary: { total, byKind, byProvider } };
  if (Buffer.byteLength(canonicalJson(normalized), "utf8") > MAX_EVIDENCE_BYTES) {
    throw new RangeError("Instruction proposal friction evidence exceeds the size bound.");
  }
  return normalized;
}

function proposalHashPayload(row: Row): Record<string, unknown> {
  return {
    id: text(row.id),
    origin: text(row.origin),
    sequence: Number(row.sequence),
    targetKind: text(row.target_kind),
    targetIdentifier: text(row.target_identifier),
    relativePath: nullableText(row.relative_path),
    proposedContent: text(row.proposed_content),
    rationale: text(row.rationale),
    frictionEvidence: safeJson(row.friction_evidence_json, {}),
    contentDigest: text(row.content_digest),
    state: text(row.state),
    approvalId: nullableText(row.approval_id),
    supersedesProposalId: nullableText(row.supersedes_proposal_id),
    rejectionReason: nullableText(row.rejection_reason),
    idempotencyKey: nullableText(row.idempotency_key),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    approvedAt: nullableText(row.approved_at),
    rejectedAt: nullableText(row.rejected_at),
    appliedAt: nullableText(row.applied_at),
    supersededAt: nullableText(row.superseded_at),
  };
}

function proposalHash(row: Row): string {
  return agentMeshHmac(
    "instruction-proposal",
    canonicalJson(proposalHashPayload(row)),
  );
}

function approvalHashPayload(row: Row): Record<string, unknown> {
  return {
    id: text(row.id),
    origin: text(row.origin),
    proposalId: text(row.proposal_id),
    proposalSequence: Number(row.proposal_sequence),
    digest: text(row.digest),
    status: text(row.status),
    method: text(row.method),
    expiresAt: nullableText(row.expires_at),
    approvedAt: text(row.approved_at),
    voidedAt: nullableText(row.voided_at),
    consumedAt: nullableText(row.consumed_at),
    voidReason: nullableText(row.void_reason),
  };
}

function approvalHash(row: Row): string {
  return agentMeshHmac(
    "instruction-approval",
    canonicalJson(approvalHashPayload(row)),
  );
}

function activeAssetHash(row: Row): string {
  return agentMeshHmac(
    "instruction-active",
    canonicalJson({
      origin: text(row.origin),
      targetKind: text(row.target_kind),
      targetIdentifier: text(row.target_identifier),
      relativePath: nullableText(row.relative_path),
      proposalId: text(row.proposal_id),
      content: text(row.content),
      contentDigest: text(row.content_digest),
      appliedAt: text(row.applied_at),
    }),
  );
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

export class InstructionProposalStore {
  readonly origin: Origin;
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly repositoryRoots:
    | ReadonlyMap<string, string>
    | Readonly<Record<string, string>>;
  private closed = false;

  constructor(options: InstructionProposalStoreOptions) {
    this.origin = options.origin;
    this.path = options.path ?? join(stateDirectory(), "instruction-proposals.db");
    this.now = options.now ?? (() => new Date());
    this.repositoryRoots = options.repositoryRoots ?? {};
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.path), 0o700);
    this.db = new DatabaseSync(this.path);
    chmodSync(this.path, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS instruction_proposal_counters (
        origin TEXT PRIMARY KEY,
        next_proposal_sequence INTEGER NOT NULL,
        next_audit_sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS instruction_proposals (
        id TEXT PRIMARY KEY,
        origin TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        target_kind TEXT NOT NULL CHECK (
          target_kind IN ('mesh_skill', 'harness_instructions', 'repository_ruleset')
        ),
        target_identifier TEXT NOT NULL,
        relative_path TEXT,
        proposed_content TEXT NOT NULL,
        rationale TEXT NOT NULL,
        friction_evidence_json TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('proposed', 'approved', 'rejected', 'applied', 'superseded')
        ),
        approval_id TEXT,
        supersedes_proposal_id TEXT,
        rejection_reason TEXT,
        idempotency_key TEXT,
        proposal_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        approved_at TEXT,
        rejected_at TEXT,
        applied_at TEXT,
        superseded_at TEXT,
        UNIQUE(origin, sequence),
        UNIQUE(origin, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_instruction_proposals_origin
        ON instruction_proposals(origin, state, target_kind, target_identifier, sequence);
      CREATE TABLE IF NOT EXISTS instruction_proposal_approvals (
        id TEXT PRIMARY KEY,
        origin TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        proposal_sequence INTEGER NOT NULL,
        digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('approved', 'void', 'consumed')),
        method TEXT NOT NULL CHECK (method = 'out_of_band_human'),
        expires_at TEXT,
        approved_at TEXT NOT NULL,
        voided_at TEXT,
        consumed_at TEXT,
        void_reason TEXT,
        approval_hash TEXT NOT NULL,
        FOREIGN KEY(proposal_id) REFERENCES instruction_proposals(id)
      );
      CREATE INDEX IF NOT EXISTS idx_instruction_approvals_origin
        ON instruction_proposal_approvals(origin, proposal_id, status);
      CREATE TABLE IF NOT EXISTS instruction_active_assets (
        origin TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_identifier TEXT NOT NULL,
        relative_path TEXT NOT NULL DEFAULT '',
        proposal_id TEXT NOT NULL,
        content TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        asset_hash TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY(origin, target_kind, target_identifier, relative_path)
      );
      CREATE TABLE IF NOT EXISTS instruction_proposal_audit_events (
        origin TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        proposal_id TEXT NOT NULL,
        event TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT,
        data_json TEXT NOT NULL,
        previous_hash TEXT,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(origin, sequence)
      );
      CREATE TABLE IF NOT EXISTS instruction_proposal_audit_state (
        origin TEXT PRIMARY KEY,
        last_sequence INTEGER NOT NULL,
        last_hash TEXT,
        state_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.db
      .prepare(
        `INSERT INTO instruction_proposal_counters
         (origin, next_proposal_sequence, next_audit_sequence)
         VALUES (?, 1, 1) ON CONFLICT(origin) DO NOTHING`,
      )
      .run(this.origin);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  createProposal(input: CreateInstructionProposalInput): InstructionProposal {
    const target = normalizeTarget(input.target);
    const proposedContent = boundedText(
      input.proposedContent,
      "proposed replacement content",
      MAX_CONTENT_BYTES,
      false,
    );
    if (redactSecrets(proposedContent) !== proposedContent) {
      throw new Error("Proposed replacement content must not contain secrets.");
    }
    const rationale = boundedText(
      redactSecrets(input.rationale),
      "proposal rationale",
      MAX_RATIONALE_BYTES,
    );
    const frictionEvidence = normalizeEvidence(input.frictionEvidence);
    const idempotencyKey = input.idempotencyKey
      ? boundedText(input.idempotencyKey, "idempotency key", 512)
      : null;
    if (idempotencyKey && !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
      throw new Error("Invalid idempotency key.");
    }
    const requestDigest = contentDigest(
      canonicalJson({
        target,
        proposedContent,
        rationale,
        frictionEvidence,
        supersedesProposalId: input.supersedesProposalId ?? null,
      }),
    );
    const now = this.now().toISOString();
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (idempotencyKey) {
        const existing = this.db
          .prepare(
            `SELECT * FROM instruction_proposals
             WHERE origin = ? AND idempotency_key = ?`,
          )
          .get(this.origin, idempotencyKey) as Row | undefined;
        if (existing) {
          const existingRequestDigest = contentDigest(
            canonicalJson({
              target: {
                kind: text(existing.target_kind),
                identifier: text(existing.target_identifier),
                ...(existing.relative_path
                  ? { relativePath: text(existing.relative_path) }
                  : {}),
              },
              proposedContent: text(existing.proposed_content),
              rationale: text(existing.rationale),
              frictionEvidence: safeJson(existing.friction_evidence_json, {}),
              supersedesProposalId: nullableText(existing.supersedes_proposal_id),
            }),
          );
          if (existingRequestDigest !== requestDigest) {
            throw new Error("Instruction proposal idempotency key has a different request.");
          }
          const proposal = this.parseProposal(existing);
          this.db.exec("COMMIT");
          return proposal;
        }
      }
      const supersedesProposalId = input.supersedesProposalId
        ? safeIdentifier(input.supersedesProposalId, "superseded proposal id")
        : null;
      if (supersedesProposalId) {
        const superseded = this.requireProposalRow(supersedesProposalId);
        this.verifyProposalRow(superseded);
        const priorState = text(superseded.state) as InstructionProposalState;
        if (["proposed", "approved"].includes(priorState)) {
          if (superseded.approval_id) {
            const approval = this.requireApprovalRow(text(superseded.approval_id));
            this.voidApprovalInternal(approval, "proposal_superseded", now);
          }
          this.updateProposalStateInternal(
            superseded,
            "superseded",
            {
              updated_at: now,
              superseded_at: now,
            },
          );
          this.appendAuditInternal({
            proposalId: supersedesProposalId,
            event: "proposal_superseded",
            fromState: priorState,
            toState: "superseded",
            data: { replacementProposalId: id },
            createdAt: now,
          });
        }
      }
      const counter = this.db
        .prepare(
          `SELECT next_proposal_sequence AS sequence
           FROM instruction_proposal_counters WHERE origin = ?`,
        )
        .get(this.origin) as Row;
      const sequence = Number(counter.sequence);
      this.db
        .prepare(
          `UPDATE instruction_proposal_counters
           SET next_proposal_sequence = next_proposal_sequence + 1
           WHERE origin = ?`,
        )
        .run(this.origin);
      const digest = contentDigest(proposedContent);
      const row: Row = {
        id,
        origin: this.origin,
        sequence,
        target_kind: target.kind,
        target_identifier: target.identifier,
        relative_path: target.relativePath ?? null,
        proposed_content: proposedContent,
        rationale,
        friction_evidence_json: canonicalJson(frictionEvidence),
        content_digest: digest,
        state: "proposed",
        approval_id: null,
        supersedes_proposal_id: supersedesProposalId,
        rejection_reason: null,
        idempotency_key: idempotencyKey,
        created_at: now,
        updated_at: now,
        approved_at: null,
        rejected_at: null,
        applied_at: null,
        superseded_at: null,
      };
      this.db
        .prepare(
          `INSERT INTO instruction_proposals
           (id, origin, sequence, target_kind, target_identifier, relative_path,
            proposed_content, rationale, friction_evidence_json, content_digest,
            state, approval_id, supersedes_proposal_id, rejection_reason,
            idempotency_key, proposal_hash, created_at, updated_at, approved_at,
            rejected_at, applied_at, superseded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', NULL, ?, NULL,
                   ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
        )
        .run(
          id,
          this.origin,
          sequence,
          target.kind,
          target.identifier,
          target.relativePath ?? null,
          proposedContent,
          rationale,
          canonicalJson(frictionEvidence),
          digest,
          supersedesProposalId,
          idempotencyKey,
          proposalHash(row),
          now,
          now,
        );
      this.appendAuditInternal({
        proposalId: id,
        event: "proposal_created",
        fromState: null,
        toState: "proposed",
        data: {
          sequence,
          target,
          contentDigest: digest,
          frictionEventIds: frictionEvidence.eventIds,
          supersedesProposalId,
        },
        createdAt: now,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getProposal(id);
  }

  supersedeProposal(
    proposalId: string,
    replacement: Omit<CreateInstructionProposalInput, "supersedesProposalId">,
  ): InstructionProposal {
    return this.createProposal({
      ...replacement,
      supersedesProposalId: proposalId,
    });
  }

  approveProposal(input: {
    proposalId: string;
    expectedDigest: string;
    expiresAt?: string;
  }): InstructionProposal {
    const expectedDigest = boundedText(input.expectedDigest, "expected digest", 64);
    if (!/^[0-9a-f]{64}$/u.test(expectedDigest)) {
      throw new Error("Expected digest must be a SHA-256 digest.");
    }
    const now = this.now().toISOString();
    const expiresAt = input.expiresAt
      ? safeInstant(input.expiresAt, "expiresAt")
      : null;
    if (expiresAt && expiresAt <= now) {
      throw new Error("Instruction proposal approval expiry must be in the future.");
    }
    const approvalId = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const proposal = this.requireProposalRow(input.proposalId);
      this.verifyProposalRow(proposal);
      if (text(proposal.state) !== "proposed") {
        throw new Error("Instruction proposal cannot be approved from its current state.");
      }
      if (text(proposal.content_digest) !== expectedDigest) {
        throw new Error("Instruction proposal approval digest mismatch.");
      }
      const approval: Row = {
        id: approvalId,
        origin: this.origin,
        proposal_id: text(proposal.id),
        proposal_sequence: Number(proposal.sequence),
        digest: expectedDigest,
        status: "approved",
        method: "out_of_band_human",
        expires_at: expiresAt,
        approved_at: now,
        voided_at: null,
        consumed_at: null,
        void_reason: null,
      };
      this.db
        .prepare(
          `INSERT INTO instruction_proposal_approvals
           (id, origin, proposal_id, proposal_sequence, digest, status, method,
            expires_at, approved_at, voided_at, consumed_at, void_reason,
            approval_hash)
           VALUES (?, ?, ?, ?, ?, 'approved', 'out_of_band_human', ?, ?,
                   NULL, NULL, NULL, ?)`,
        )
        .run(
          approvalId,
          this.origin,
          text(proposal.id),
          Number(proposal.sequence),
          expectedDigest,
          expiresAt,
          now,
          approvalHash(approval),
        );
      this.updateProposalStateInternal(
        proposal,
        "approved",
        {
          approval_id: approvalId,
          updated_at: now,
          approved_at: now,
        },
      );
      this.appendAuditInternal({
        proposalId: text(proposal.id),
        event: "approval_granted",
        fromState: "proposed",
        toState: "approved",
        data: {
          approvalId,
          digest: expectedDigest,
          method: "out_of_band_human",
          expiresAt,
        },
        createdAt: now,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getProposal(input.proposalId);
  }

  rejectProposal(input: {
    proposalId: string;
    reason: string;
  }): InstructionProposal {
    const reason = boundedText(
      redactSecrets(input.reason),
      "proposal rejection reason",
      4_000,
    );
    const now = this.now().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const proposal = this.requireProposalRow(input.proposalId);
      this.verifyProposalRow(proposal);
      const priorState = text(proposal.state) as InstructionProposalState;
      if (!["proposed", "approved"].includes(priorState)) {
        throw new Error("Instruction proposal cannot be rejected from its current state.");
      }
      if (proposal.approval_id) {
        this.voidApprovalInternal(
          this.requireApprovalRow(text(proposal.approval_id)),
          "proposal_rejected",
          now,
        );
      }
      this.updateProposalStateInternal(
        proposal,
        "rejected",
        {
          rejection_reason: reason,
          updated_at: now,
          rejected_at: now,
        },
      );
      this.appendAuditInternal({
        proposalId: text(proposal.id),
        event: "proposal_rejected",
        fromState: priorState,
        toState: "rejected",
        data: { reason },
        createdAt: now,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getProposal(input.proposalId);
  }

  applyProposal(input: {
    proposalId: string;
    expectedDigest: string;
  }): InstructionProposal {
    const expectedDigest = boundedText(input.expectedDigest, "expected digest", 64);
    if (!/^[0-9a-f]{64}$/u.test(expectedDigest)) {
      throw new Error("Expected digest must be a SHA-256 digest.");
    }
    const now = this.now().toISOString();
    let committed = false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const proposal = this.requireProposalRow(input.proposalId);
      const actualDigest = contentDigest(text(proposal.proposed_content));
      const intact =
        actualDigest === text(proposal.content_digest) &&
        proposalHash(proposal) === text(proposal.proposal_hash);
      if (!intact) {
        if (proposal.approval_id) {
          const approval = this.requireApprovalRow(text(proposal.approval_id));
          if (
            text(approval.status) === "approved" &&
            approvalHash(approval) === text(approval.approval_hash)
          ) {
            this.voidApprovalInternal(
              approval,
              "proposal_content_or_integrity_changed",
              now,
            );
            this.appendAuditInternal({
              proposalId: text(proposal.id),
              event: "approval_voided",
              fromState: text(proposal.state) as InstructionProposalState,
              toState: text(proposal.state) as InstructionProposalState,
              data: {
                approvalId: text(approval.id),
                approvedDigest: text(approval.digest),
                observedDigest: actualDigest,
              },
              createdAt: now,
            });
          }
        }
        this.db.exec("COMMIT");
        committed = true;
        throw new Error(
          "Instruction proposal content changed after approval; its approval is void.",
        );
      }
      const parsed = this.parseProposal(proposal);
      if (parsed.state === "applied") {
        this.verifyAppliedTarget(parsed);
        this.db.exec("COMMIT");
        committed = true;
        return parsed;
      }
      if (parsed.state !== "approved") {
        throw new Error("Instruction proposal must be approved before application.");
      }
      if (parsed.contentDigest !== expectedDigest) {
        throw new Error("Instruction proposal application digest mismatch.");
      }
      if (!proposal.approval_id) {
        throw new Error("Instruction proposal is missing its human approval.");
      }
      // This separate, HMAC-protected, single-use approval is the authority
      // boundary: without it, injected model text could rewrite agents' rules.
      const approval = this.requireApprovalRow(text(proposal.approval_id));
      this.verifyApprovalRow(approval);
      if (text(approval.status) !== "approved") {
        throw new Error("Instruction proposal approval is void or already consumed.");
      }
      if (
        text(approval.digest) !== parsed.contentDigest ||
        text(approval.digest) !== expectedDigest
      ) {
        this.voidApprovalInternal(approval, "approval_digest_mismatch", now);
        this.appendAuditInternal({
          proposalId: parsed.id,
          event: "approval_voided",
          fromState: "approved",
          toState: "approved",
          data: {
            approvalId: text(approval.id),
            approvedDigest: text(approval.digest),
            proposalDigest: parsed.contentDigest,
          },
          createdAt: now,
        });
        this.db.exec("COMMIT");
        committed = true;
        throw new Error("Instruction proposal approval is not bound to this content digest.");
      }
      if (approval.expires_at && text(approval.expires_at) <= now) {
        this.voidApprovalInternal(approval, "approval_expired", now);
        this.appendAuditInternal({
          proposalId: parsed.id,
          event: "approval_voided",
          fromState: "approved",
          toState: "approved",
          data: { approvalId: text(approval.id), reason: "approval_expired" },
          createdAt: now,
        });
        this.db.exec("COMMIT");
        committed = true;
        throw new Error("Instruction proposal approval has expired.");
      }
      if (parsed.target.kind === "repository_ruleset") {
        this.applyRepositoryRuleset(parsed);
      } else {
        this.activateInstructionAsset(parsed, now);
      }
      this.consumeApprovalInternal(approval, now);
      this.updateProposalStateInternal(
        proposal,
        "applied",
        {
          updated_at: now,
          applied_at: now,
        },
      );
      this.appendAuditInternal({
        proposalId: parsed.id,
        event: "proposal_applied",
        fromState: "approved",
        toState: "applied",
        data: {
          approvalId: text(approval.id),
          digest: parsed.contentDigest,
          target: parsed.target,
        },
        createdAt: now,
      });
      this.db.exec("COMMIT");
      committed = true;
    } catch (error) {
      if (!committed) this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getProposal(input.proposalId);
  }

  getProposal(id: string): InstructionProposal {
    return this.parseProposal(this.requireProposalRow(id));
  }

  listProposals(input: {
    state?: InstructionProposalState;
    targetKind?: InstructionProposalTargetKind;
    targetIdentifier?: string;
    limit?: number;
  } = {}): InstructionProposal[] {
    const clauses = ["origin = ?"];
    const parameters: Array<string | number> = [this.origin];
    if (input.state) {
      if (!INSTRUCTION_PROPOSAL_STATES.includes(input.state)) {
        throw new Error("Unsupported instruction proposal state.");
      }
      clauses.push("state = ?");
      parameters.push(input.state);
    }
    if (input.targetKind) {
      if (!INSTRUCTION_PROPOSAL_TARGET_KINDS.includes(input.targetKind)) {
        throw new Error("Unsupported instruction proposal target kind.");
      }
      clauses.push("target_kind = ?");
      parameters.push(input.targetKind);
    }
    if (input.targetIdentifier) {
      clauses.push("target_identifier = ?");
      parameters.push(
        safeIdentifier(input.targetIdentifier, "target identifier"),
      );
    }
    const limit = boundedInteger(input.limit ?? 100, "limit", 1, 1_000);
    parameters.push(limit);
    return (
      this.db
        .prepare(
          `SELECT * FROM instruction_proposals
           WHERE ${clauses.join(" AND ")}
           ORDER BY sequence DESC LIMIT ?`,
        )
        .all(...parameters) as Row[]
    ).map((row) => this.parseProposal(row));
  }

  getApproval(id: string): InstructionProposalApproval {
    return this.parseApproval(this.requireApprovalRow(id));
  }

  activeInstruction(target: InstructionProposalTarget): {
    proposalId: string;
    content: string;
    contentDigest: string;
    appliedAt: string;
  } | null {
    const normalized = normalizeTarget(target);
    const row = this.db
      .prepare(
        `SELECT * FROM instruction_active_assets
         WHERE origin = ? AND target_kind = ? AND target_identifier = ?
           AND relative_path = ?`,
      )
      .get(
        this.origin,
        normalized.kind,
        normalized.identifier,
        normalized.relativePath ?? "",
      ) as Row | undefined;
    if (!row) return null;
    if (
      contentDigest(text(row.content)) !== text(row.content_digest) ||
      activeAssetHash(row) !== text(row.asset_hash)
    ) {
      throw new Error("Active instruction asset failed integrity verification.");
    }
    return {
      proposalId: text(row.proposal_id),
      content: text(row.content),
      contentDigest: text(row.content_digest),
      appliedAt: text(row.applied_at),
    };
  }

  auditEvents(afterSequence = 0, limit = 500): InstructionProposalAuditEvent[] {
    this.verifyAuditState();
    const cursor = boundedInteger(
      afterSequence,
      "afterSequence",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const boundedLimit = boundedInteger(limit, "limit", 1, 5_000);
    const predecessor = this.db
      .prepare(
        `SELECT hash FROM instruction_proposal_audit_events
         WHERE origin = ? AND sequence <= ?
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(this.origin, cursor) as Row | undefined;
    let previousHash = predecessor ? text(predecessor.hash) : null;
    return (
      this.db
        .prepare(
          `SELECT * FROM instruction_proposal_audit_events
           WHERE origin = ? AND sequence > ?
           ORDER BY sequence ASC LIMIT ?`,
        )
        .all(this.origin, cursor, boundedLimit) as Row[]
    ).map((row) => {
      const event: InstructionProposalAuditEvent = {
        sequence: Number(row.sequence),
        origin: text(row.origin) as Origin,
        proposalId: text(row.proposal_id),
        event: text(row.event),
        fromState: nullableText(row.from_state) as InstructionProposalState | null,
        toState: nullableText(row.to_state) as InstructionProposalState | null,
        data: safeJson(row.data_json, {}),
        previousHash: nullableText(row.previous_hash),
        hash: text(row.hash),
        createdAt: text(row.created_at),
      };
      if (event.previousHash !== previousHash) {
        throw new Error(
          `Instruction proposal audit event ${event.sequence} has a broken predecessor.`,
        );
      }
      const expected = agentMeshHmac(
        "instruction-audit",
        `${previousHash ?? ""}\0${canonicalJson({
          sequence: event.sequence,
          origin: event.origin,
          proposalId: event.proposalId,
          event: event.event,
          fromState: event.fromState,
          toState: event.toState,
          data: event.data,
          previousHash: event.previousHash,
          createdAt: event.createdAt,
        })}`,
      );
      if (expected !== event.hash) {
        throw new Error(
          `Instruction proposal audit event ${event.sequence} failed verification.`,
        );
      }
      previousHash = event.hash;
      return event;
    });
  }

  private requireProposalRow(id: string): Row {
    const safeId = safeIdentifier(id, "proposal id");
    const row = this.db
      .prepare(
        "SELECT * FROM instruction_proposals WHERE id = ? AND origin = ?",
      )
      .get(safeId, this.origin) as Row | undefined;
    if (!row) throw new Error(`Unknown instruction proposal: ${safeId}`);
    return row;
  }

  private requireApprovalRow(id: string): Row {
    const safeId = safeIdentifier(id, "approval id");
    const row = this.db
      .prepare(
        "SELECT * FROM instruction_proposal_approvals WHERE id = ? AND origin = ?",
      )
      .get(safeId, this.origin) as Row | undefined;
    if (!row) throw new Error(`Unknown instruction proposal approval: ${safeId}`);
    return row;
  }

  private parseProposal(row: Row): InstructionProposal {
    this.verifyProposalRow(row);
    const evidence = safeJson<InstructionFrictionEvidence>(
      row.friction_evidence_json,
      { eventIds: [], summary: { total: 0, byKind: [], byProvider: [] } },
    );
    const approvalId = nullableText(row.approval_id);
    return {
      id: text(row.id),
      origin: text(row.origin) as Origin,
      sequence: Number(row.sequence),
      target: {
        kind: text(row.target_kind) as InstructionProposalTargetKind,
        identifier: text(row.target_identifier),
        ...(row.relative_path
          ? { relativePath: text(row.relative_path) }
          : {}),
      },
      proposedContent: text(row.proposed_content),
      rationale: text(row.rationale),
      frictionEvidence: evidence,
      contentDigest: text(row.content_digest),
      state: text(row.state) as InstructionProposalState,
      approval: approvalId ? this.parseApproval(this.requireApprovalRow(approvalId)) : null,
      supersedesProposalId: nullableText(row.supersedes_proposal_id),
      rejectionReason: nullableText(row.rejection_reason),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
      approvedAt: nullableText(row.approved_at),
      rejectedAt: nullableText(row.rejected_at),
      appliedAt: nullableText(row.applied_at),
      supersededAt: nullableText(row.superseded_at),
    };
  }

  private verifyProposalRow(row: Row): void {
    if (
      contentDigest(text(row.proposed_content)) !== text(row.content_digest) ||
      proposalHash(row) !== text(row.proposal_hash)
    ) {
      throw new Error(
        `Instruction proposal ${text(row.id)} failed integrity verification.`,
      );
    }
  }

  private parseApproval(row: Row): InstructionProposalApproval {
    this.verifyApprovalRow(row);
    return {
      id: text(row.id),
      origin: text(row.origin) as Origin,
      proposalId: text(row.proposal_id),
      proposalSequence: Number(row.proposal_sequence),
      digest: text(row.digest),
      status: text(row.status) as InstructionProposalApprovalStatus,
      method: "out_of_band_human",
      expiresAt: nullableText(row.expires_at),
      approvedAt: text(row.approved_at),
      voidedAt: nullableText(row.voided_at),
      consumedAt: nullableText(row.consumed_at),
      voidReason: nullableText(row.void_reason),
    };
  }

  private verifyApprovalRow(row: Row): void {
    if (approvalHash(row) !== text(row.approval_hash)) {
      throw new Error(
        `Instruction proposal approval ${text(row.id)} failed integrity verification.`,
      );
    }
  }

  private updateProposalStateInternal(
    row: Row,
    state: InstructionProposalState,
    updates: Partial<Record<
      | "approval_id"
      | "rejection_reason"
      | "updated_at"
      | "approved_at"
      | "rejected_at"
      | "applied_at"
      | "superseded_at",
      string | null
    >>,
  ): void {
    const next: Row = { ...row, ...updates, state };
    const result = this.db
      .prepare(
        `UPDATE instruction_proposals
         SET state = ?, approval_id = ?, rejection_reason = ?, updated_at = ?,
             approved_at = ?, rejected_at = ?, applied_at = ?,
             superseded_at = ?, proposal_hash = ?
         WHERE id = ? AND origin = ? AND state = ? AND proposal_hash = ?`,
      )
      .run(
        state,
        nullableText(next.approval_id),
        nullableText(next.rejection_reason),
        text(next.updated_at),
        nullableText(next.approved_at),
        nullableText(next.rejected_at),
        nullableText(next.applied_at),
        nullableText(next.superseded_at),
        proposalHash(next),
        text(row.id),
        this.origin,
        text(row.state),
        text(row.proposal_hash),
      );
    if (result.changes !== 1) {
      throw new Error("Instruction proposal changed concurrently.");
    }
  }

  private voidApprovalInternal(row: Row, reason: string, now: string): void {
    this.verifyApprovalRow(row);
    if (text(row.status) !== "approved") return;
    const next: Row = {
      ...row,
      status: "void",
      voided_at: now,
      void_reason: reason,
    };
    const result = this.db
      .prepare(
        `UPDATE instruction_proposal_approvals
         SET status = 'void', voided_at = ?, void_reason = ?, approval_hash = ?
         WHERE id = ? AND origin = ? AND status = 'approved'
           AND approval_hash = ?`,
      )
      .run(
        now,
        reason,
        approvalHash(next),
        text(row.id),
        this.origin,
        text(row.approval_hash),
      );
    if (result.changes !== 1) {
      throw new Error("Instruction proposal approval changed concurrently.");
    }
  }

  private consumeApprovalInternal(row: Row, now: string): void {
    this.verifyApprovalRow(row);
    const next: Row = { ...row, status: "consumed", consumed_at: now };
    const result = this.db
      .prepare(
        `UPDATE instruction_proposal_approvals
         SET status = 'consumed', consumed_at = ?, approval_hash = ?
         WHERE id = ? AND origin = ? AND status = 'approved'
           AND approval_hash = ?`,
      )
      .run(
        now,
        approvalHash(next),
        text(row.id),
        this.origin,
        text(row.approval_hash),
      );
    if (result.changes !== 1) {
      throw new Error("Instruction proposal approval is void or already consumed.");
    }
  }

  private repositoryRoot(repoKey: string): string {
    const configured =
      "get" in this.repositoryRoots &&
      typeof this.repositoryRoots.get === "function"
        ? this.repositoryRoots.get(repoKey)
        : (this.repositoryRoots as Readonly<Record<string, string>>)[repoKey];
    if (!configured) {
      throw new Error("Repository ruleset target has no allowed repository root.");
    }
    const rootInfo = lstatSync(configured);
    if (rootInfo.isSymbolicLink()) {
      throw new Error("Allowed repository root must not be a symlink.");
    }
    const root = realpathSync(configured);
    if (!statSync(root).isDirectory()) {
      throw new Error("Allowed repository root must be a directory.");
    }
    return root;
  }

  private repositoryTarget(root: string, relativePath: string): string {
    if (isAbsolute(relativePath) || win32.isAbsolute(relativePath)) {
      throw new Error("Repository ruleset path must be relative.");
    }
    if (relativePath.includes("\\")) {
      throw new Error("Repository ruleset path must use repository-relative separators.");
    }
    const segments = relativePath.split("/");
    if (segments.some((segment) => segment === "..")) {
      throw new Error("Repository ruleset path must not traverse a parent directory.");
    }
    if (segments.some((segment) => !segment || segment === ".")) {
      throw new Error("Repository ruleset path must name a file.");
    }
    const target = resolve(root, ...segments);
    if (!isWithin(root, target) || target === root) {
      throw new Error("Repository ruleset target is outside the allowed repository root.");
    }
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      current = join(current, segment);
      const info = lstatSync(current);
      if (info.isSymbolicLink()) {
        throw new Error("Repository ruleset target must not use symlinked paths.");
      }
      if (!info.isDirectory()) {
        throw new Error("Repository ruleset parent must be a directory.");
      }
      const canonical = realpathSync(current);
      if (!isWithin(root, canonical)) {
        throw new Error("Repository ruleset target is outside the allowed repository root.");
      }
      current = canonical;
    }
    try {
      const info = lstatSync(target);
      if (info.isSymbolicLink()) {
        throw new Error("Repository ruleset target must not be a symlink.");
      }
      if (!info.isFile()) {
        throw new Error("Repository ruleset target must be a regular file.");
      }
      if (info.nlink !== 1) {
        throw new Error("Repository ruleset target must not be multiply linked.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return target;
  }

  private readRuleset(path: string): string | null {
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_CONTENT_BYTES) {
        throw new Error("Repository ruleset target must be a bounded regular file.");
      }
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  }

  private writeRuleset(root: string, path: string, content: string): void {
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
      0o644,
    );
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1) {
        throw new Error("Repository ruleset target must be a regular file.");
      }
      const current = lstatSync(path);
      if (
        current.isSymbolicLink() ||
        !isWithin(root, realpathSync(path))
      ) {
        throw new Error("Repository ruleset target escaped its allowed root.");
      }
      ftruncateSync(fd, 0);
      writeFileSync(fd, content, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private applyRepositoryRuleset(proposal: InstructionProposal): void {
    const root = this.repositoryRoot(proposal.target.identifier);
    const target = this.repositoryTarget(root, proposal.target.relativePath ?? "");
    if (this.readRuleset(target) === proposal.proposedContent) return;
    this.writeRuleset(root, target, proposal.proposedContent);
    if (this.readRuleset(target) !== proposal.proposedContent) {
      throw new Error("Repository ruleset application could not be verified.");
    }
  }

  private activateInstructionAsset(
    proposal: InstructionProposal,
    appliedAt: string,
  ): void {
    const row: Row = {
      origin: this.origin,
      target_kind: proposal.target.kind,
      target_identifier: proposal.target.identifier,
      relative_path: proposal.target.relativePath ?? "",
      proposal_id: proposal.id,
      content: proposal.proposedContent,
      content_digest: proposal.contentDigest,
      applied_at: appliedAt,
    };
    this.db
      .prepare(
        `INSERT INTO instruction_active_assets
         (origin, target_kind, target_identifier, relative_path, proposal_id,
          content, content_digest, asset_hash, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(origin, target_kind, target_identifier, relative_path)
         DO UPDATE SET proposal_id = excluded.proposal_id,
           content = excluded.content,
           content_digest = excluded.content_digest,
           asset_hash = excluded.asset_hash,
           applied_at = excluded.applied_at`,
      )
      .run(
        this.origin,
        proposal.target.kind,
        proposal.target.identifier,
        proposal.target.relativePath ?? "",
        proposal.id,
        proposal.proposedContent,
        proposal.contentDigest,
        activeAssetHash(row),
        appliedAt,
      );
  }

  private verifyAppliedTarget(proposal: InstructionProposal): void {
    if (proposal.target.kind === "repository_ruleset") {
      const root = this.repositoryRoot(proposal.target.identifier);
      const target = this.repositoryTarget(root, proposal.target.relativePath ?? "");
      if (this.readRuleset(target) !== proposal.proposedContent) {
        throw new Error(
          "Applied repository ruleset no longer matches the approved content.",
        );
      }
      return;
    }
    const active = this.activeInstruction(proposal.target);
    if (
      !active ||
      active.proposalId !== proposal.id ||
      active.contentDigest !== proposal.contentDigest
    ) {
      throw new Error("Applied instruction asset no longer matches the proposal.");
    }
  }

  private appendAuditInternal(input: {
    proposalId: string;
    event: string;
    fromState: InstructionProposalState | null;
    toState: InstructionProposalState | null;
    data: unknown;
    createdAt: string;
  }): void {
    const dataJson = canonicalJson(input.data);
    if (Buffer.byteLength(dataJson, "utf8") > MAX_AUDIT_BYTES) {
      throw new RangeError("Instruction proposal audit data exceeds the size bound.");
    }
    const counter = this.db
      .prepare(
        `SELECT next_audit_sequence AS sequence
         FROM instruction_proposal_counters WHERE origin = ?`,
      )
      .get(this.origin) as Row;
    const sequence = Number(counter.sequence);
    const predecessor = this.db
      .prepare(
        `SELECT hash FROM instruction_proposal_audit_events
         WHERE origin = ? ORDER BY sequence DESC LIMIT 1`,
      )
      .get(this.origin) as Row | undefined;
    const previousHash = predecessor ? text(predecessor.hash) : null;
    const payload = {
      sequence,
      origin: this.origin,
      proposalId: input.proposalId,
      event: input.event,
      fromState: input.fromState,
      toState: input.toState,
      data: input.data,
      previousHash,
      createdAt: input.createdAt,
    };
    const hash = agentMeshHmac(
      "instruction-audit",
      `${previousHash ?? ""}\0${canonicalJson(payload)}`,
    );
    this.db
      .prepare(
        `INSERT INTO instruction_proposal_audit_events
         (origin, sequence, proposal_id, event, from_state, to_state, data_json,
          previous_hash, hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.origin,
        sequence,
        input.proposalId,
        input.event,
        input.fromState,
        input.toState,
        dataJson,
        previousHash,
        hash,
        input.createdAt,
      );
    this.db
      .prepare(
        `UPDATE instruction_proposal_counters
         SET next_audit_sequence = next_audit_sequence + 1
         WHERE origin = ?`,
      )
      .run(this.origin);
    const stateHash = agentMeshHmac(
      "instruction-audit-state",
      canonicalJson({
        origin: this.origin,
        lastSequence: sequence,
        lastHash: hash,
        updatedAt: input.createdAt,
      }),
    );
    this.db
      .prepare(
        `INSERT INTO instruction_proposal_audit_state
         (origin, last_sequence, last_hash, state_hash, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(origin) DO UPDATE SET
           last_sequence = excluded.last_sequence,
           last_hash = excluded.last_hash,
           state_hash = excluded.state_hash,
           updated_at = excluded.updated_at`,
      )
      .run(this.origin, sequence, hash, stateHash, input.createdAt);
  }

  private verifyAuditState(): void {
    const state = this.db
      .prepare(
        "SELECT * FROM instruction_proposal_audit_state WHERE origin = ?",
      )
      .get(this.origin) as Row | undefined;
    const latest = this.db
      .prepare(
        `SELECT sequence, hash FROM instruction_proposal_audit_events
         WHERE origin = ? ORDER BY sequence DESC LIMIT 1`,
      )
      .get(this.origin) as Row | undefined;
    if (!state && !latest) return;
    if (!state || !latest) {
      throw new Error("Instruction proposal audit state does not match its event chain.");
    }
    const expected = agentMeshHmac(
      "instruction-audit-state",
      canonicalJson({
        origin: this.origin,
        lastSequence: Number(latest.sequence),
        lastHash: text(latest.hash),
        updatedAt: text(state.updated_at),
      }),
    );
    if (
      Number(state.last_sequence) !== Number(latest.sequence) ||
      nullableText(state.last_hash) !== text(latest.hash) ||
      text(state.state_hash) !== expected
    ) {
      throw new Error("Instruction proposal audit state failed monotonic verification.");
    }
  }
}
