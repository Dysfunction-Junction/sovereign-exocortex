/**
 * @file db.ts
 * Sovereign Exocortex SQLite Event Store Driver (Architecture & Schema v3).
 *
 * Implements WAL mode, append-only hash-chained events, idempotency,
 * and deterministic cryptographic chain verification using node:sqlite.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJsonStringify } from "./canonical.js";
import type {
  DeviceRecord,
  EventIn,
  EventRecord,
  IngestReq,
  ProposalRecord,
  GateDecisionRecord,
  ShadowLabelRecord,
  InvariantRecord,
  ModelParamRecord,
  BeliefSnapshotRecord,
  ApprovalRecord,
  ExecutionRecord,
  MutationRecord,
  ProposalState,
} from "./schema-types.js";

export const V3_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS devices (
  device_id    TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  platform     TEXT NOT NULL CHECK (platform IN ('android','windows','linux')),
  pubkey_spki  BLOB NOT NULL,
  key_attested INTEGER NOT NULL DEFAULT 0,
  scopes       TEXT NOT NULL CHECK (json_valid(scopes)),
  enrolled_at  INTEGER NOT NULL,
  revoked_at   INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   TEXT NOT NULL UNIQUE,
  device_id  TEXT NOT NULL REFERENCES devices(device_id),
  kind       TEXT NOT NULL,
  ts_device  INTEGER NOT NULL,
  ts_server  INTEGER NOT NULL,
  schema_ver INTEGER NOT NULL DEFAULT 1,
  payload    TEXT NOT NULL CHECK (json_valid(payload)),
  prev_hash  BLOB NOT NULL,
  hash       BLOB NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS events_kind_ts ON events(kind, ts_server);
CREATE UNIQUE INDEX IF NOT EXISTS events_prev_hash ON events(prev_hash);
CREATE INDEX IF NOT EXISTS events_device_seq ON events(device_id, seq);

CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE IF NOT EXISTS invariants (
  invariant_id TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  category     TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE IF NOT EXISTS model_params (
  factor     TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('A','B','C','D')),
  version    INTEGER NOT NULL,
  counts     TEXT NOT NULL CHECK (json_valid(counts)),
  as_of_seq  INTEGER NOT NULL REFERENCES events(seq),
  PRIMARY KEY (factor, kind, version)
) STRICT;

CREATE TABLE IF NOT EXISTS belief_snapshots (
  as_of_seq  INTEGER PRIMARY KEY REFERENCES events(seq),
  mode       TEXT NOT NULL CHECK (mode IN ('DEEP_FOCUS','HIGH_VELOCITY','EXPLORATORY','MAINTENANCE','REST')),
  q          TEXT NOT NULL CHECK (json_valid(q)),
  surprisal  REAL NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS proposals (
  proposal_id    TEXT PRIMARY KEY,
  created_seq    INTEGER NOT NULL REFERENCES events(seq),
  invariant_id   TEXT REFERENCES invariants(invariant_id),
  policy_type    TEXT NOT NULL CHECK (policy_type IN ('PRAGMATIC','EPISTEMIC')),
  tier           INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 4),
  summary        TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (json_valid(action)),
  action_hash    BLOB NOT NULL,
  efe            REAL NOT NULL,
  risk_term      REAL NOT NULL,
  ambiguity_term REAL NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('DRAFT','GATED','SUPPRESSED','STAGED','SURFACED',
                   'APPROVED','REJECTED','EXPIRED','EXECUTING','SUCCEEDED','FAILED')),
  shadow         INTEGER NOT NULL DEFAULT 1,
  expires_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS proposals_state ON proposals(state, expires_at);

CREATE TABLE IF NOT EXISTS gate_decisions (
  proposal_id TEXT NOT NULL REFERENCES proposals(proposal_id),
  mode        TEXT NOT NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('SUPPRESS','QUEUE','SURFACE','AUTO_DRY_RUN')),
  reason      TEXT NOT NULL,
  ts          INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS approvals (
  approval_id    TEXT PRIMARY KEY,
  proposal_id    TEXT NOT NULL REFERENCES proposals(proposal_id),
  device_id      TEXT NOT NULL REFERENCES devices(device_id),
  nonce          TEXT NOT NULL UNIQUE,
  decision       TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  signed_payload BLOB NOT NULL,
  signature      BLOB NOT NULL,
  verified       INTEGER NOT NULL,
  ts             INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS executions (
  exec_id     TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(proposal_id),
  dry_run     INTEGER NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  exit_code   INTEGER,
  result      TEXT CHECK (json_valid(result)),
  undo        TEXT CHECK (json_valid(undo))
) STRICT;

CREATE TABLE IF NOT EXISTS shadow_labels (
  proposal_id TEXT PRIMARY KEY REFERENCES proposals(proposal_id),
  label       TEXT NOT NULL CHECK (label IN ('wanted','not_wanted','already_did','ignored')),
  actual      TEXT CHECK (json_valid(actual)),
  latency_ms  INTEGER,
  ts          INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS mutations (
  mutation_id    TEXT PRIMARY KEY,
  friction_seq   INTEGER NOT NULL REFERENCES events(seq),
  base_commit    TEXT NOT NULL,
  branch         TEXT NOT NULL,
  strategy       TEXT NOT NULL,
  diff_hash      BLOB NOT NULL,
  gates          TEXT NOT NULL CHECK (json_valid(gates)),
  state          TEXT NOT NULL CHECK (state IN ('REJECTED','PASSED','MERGED','DISCARDED')),
  created_at     INTEGER NOT NULL
) STRICT;
`;

export interface ExocortexDbOptions {
  path?: string;
  schemaSql?: string;
}

export function computeCanonicalEventHash(
  prevHash: Uint8Array,
  event: {
    event_id: string;
    device_id: string;
    kind: string;
    ts_device: number;
    ts_server: number;
    schema_ver: number;
    payload: string;
  }
): Buffer {
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(event.payload);
  } catch {
    parsedPayload = event.payload;
  }

  const canonicalRow = canonicalJsonStringify({
    event_id: event.event_id,
    device_id: event.device_id,
    kind: event.kind,
    ts_device: event.ts_device,
    ts_server: event.ts_server,
    schema_ver: event.schema_ver,
    payload: parsedPayload,
  });

  return createHash("sha256")
    .update(Buffer.from(prevHash))
    .update(Buffer.from(canonicalRow, "utf8"))
    .digest();
}

export class DeviceNotEnrolledError extends Error {
  constructor(public readonly deviceId: string) {
    super(`Device not enrolled: ${deviceId}`);
    this.name = "DeviceNotEnrolledError";
  }
}

export class DeviceRevokedError extends Error {
  constructor(public readonly deviceId: string) {
    super(`Device has been revoked: ${deviceId}`);
    this.name = "DeviceRevokedError";
  }
}

export class EventIdConflictError extends Error {
  constructor(public readonly eventId: string) {
    super(`Event ID collision across different devices: ${eventId}`);
    this.name = "EventIdConflictError";
  }
}

export class ExocortexDatabase {
  private readonly db: DatabaseSync;
  private txDepth = 0;

  constructor(options: ExocortexDbOptions = {}) {
    const dbPath = options.path ?? ":memory:";
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");

    const sql = options.schemaSql ?? V3_SCHEMA_SQL;
    this.db.exec(sql);
  }

  public get raw(): DatabaseSync {
    return this.db;
  }

  public close(): void {
    this.db.close();
  }

  public withTransaction<T>(fn: () => T): T {
    const isOuter = this.txDepth === 0;
    if (isOuter) {
      this.db.exec("BEGIN IMMEDIATE TRANSACTION;");
    } else {
      this.db.exec(`SAVEPOINT sp_${this.txDepth};`);
    }
    this.txDepth++;
    try {
      const result = fn();
      if (isOuter) {
        this.db.exec("COMMIT;");
      } else {
        this.db.exec(`RELEASE SAVEPOINT sp_${this.txDepth - 1};`);
      }
      this.txDepth--;
      return result;
    } catch (err) {
      try {
        if (isOuter) {
          this.db.exec("ROLLBACK;");
        } else {
          this.db.exec(`ROLLBACK TO SAVEPOINT sp_${this.txDepth - 1};`);
        }
      } catch {
        // Ignore rollback failure if SQLite automatically aborted
      }
      this.txDepth = isOuter ? 0 : this.txDepth - 1;
      throw err;
    }
  }

  // --- Devices ---

  public registerDevice(device: DeviceRecord): void {
    const scopesJson = canonicalJsonStringify(device.scopes ?? []);
    const stmt = this.db.prepare(`
      INSERT INTO devices (device_id, name, platform, pubkey_spki, key_attested, scopes, enrolled_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      device.device_id,
      device.name,
      device.platform,
      Buffer.from(device.pubkey_spki),
      device.key_attested ? 1 : 0,
      scopesJson,
      device.enrolled_at,
      device.revoked_at ?? null
    );
  }

  public revokeDevice(deviceId: string): void {
    const stmt = this.db.prepare("UPDATE devices SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL");
    stmt.run(Date.now(), deviceId);
  }


  public getDevice(deviceId: string): DeviceRecord | null {
    const stmt = this.db.prepare("SELECT * FROM devices WHERE device_id = ?");
    const row = stmt.get(deviceId) as any;
    if (!row) return null;
    return {
      device_id: String(row.device_id),
      name: String(row.name),
      platform: row.platform as 'android' | 'windows' | 'linux',
      pubkey_spki: new Uint8Array(row.pubkey_spki),
      key_attested: Number(row.key_attested),
      scopes: JSON.parse(String(row.scopes)),
      enrolled_at: Number(row.enrolled_at),
      revoked_at: row.revoked_at != null ? Number(row.revoked_at) : null,
    };
  }

  public listDevices(): DeviceRecord[] {
    const stmt = this.db.prepare("SELECT * FROM devices ORDER BY enrolled_at ASC");
    const rows = stmt.all() as any[];
    return rows.map((row) => ({
      device_id: String(row.device_id),
      name: String(row.name),
      platform: row.platform as 'android' | 'windows' | 'linux',
      pubkey_spki: new Uint8Array(row.pubkey_spki),
      key_attested: Number(row.key_attested),
      scopes: JSON.parse(String(row.scopes)),
      enrolled_at: Number(row.enrolled_at),
      revoked_at: row.revoked_at != null ? Number(row.revoked_at) : null,
    }));
  }

  // --- Events & Hash Chaining ---

  public getLatestEvent(): EventRecord | null {
    const stmt = this.db.prepare("SELECT * FROM events ORDER BY seq DESC LIMIT 1");
    const row = stmt.get() as any;
    if (!row) return null;
    return this.mapEventRow(row);
  }

  public getEventBySeq(seq: number): EventRecord | null {
    const stmt = this.db.prepare("SELECT * FROM events WHERE seq = ?");
    const row = stmt.get(seq) as any;
    if (!row) return null;
    return this.mapEventRow(row);
  }

  public getEventById(eventId: string): EventRecord | null {
    const stmt = this.db.prepare("SELECT * FROM events WHERE event_id = ?");
    const row = stmt.get(eventId) as any;
    if (!row) return null;
    return this.mapEventRow(row);
  }

  public ingestEvent(
    deviceId: string,
    eventIn: EventIn
  ): { status: 'inserted' | 'duplicate'; event: EventRecord } {
    // 1. Validate device enrollment
    const device = this.getDevice(deviceId);
    if (!device) {
      throw new DeviceNotEnrolledError(deviceId);
    }
    if (device.revoked_at != null) {
      throw new DeviceRevokedError(deviceId);
    }

    // 2. Pre-transaction idempotency and cross-device conflict check
    const existing = this.getEventById(eventIn.event_id);
    if (existing) {
      if (existing.device_id !== deviceId) {
        throw new EventIdConflictError(eventIn.event_id);
      }
      return { status: 'duplicate', event: existing };
    }

    // 3. Atomic insertion with immediate transaction / savepoint
    return this.withTransaction(() => {
      // Re-check idempotency under transaction lock
      const lockedExisting = this.getEventById(eventIn.event_id);
      if (lockedExisting) {
        if (lockedExisting.device_id !== deviceId) {
          throw new EventIdConflictError(eventIn.event_id);
        }
        return { status: 'duplicate', event: lockedExisting };
      }

      const latest = this.getLatestEvent();
      const prevHash = latest ? Buffer.from(latest.hash) : Buffer.alloc(32, 0);

      const ts_server = Date.now();
      const schema_ver = eventIn.schema_ver ?? 1;
      const payloadStr = canonicalJsonStringify(eventIn.payload ?? {});

      const hash = computeCanonicalEventHash(prevHash, {
        event_id: eventIn.event_id,
        device_id: deviceId,
        kind: eventIn.kind,
        ts_device: eventIn.ts_device,
        ts_server,
        schema_ver,
        payload: payloadStr,
      });

      const insertStmt = this.db.prepare(`
        INSERT INTO events (event_id, device_id, kind, ts_device, ts_server, schema_ver, payload, prev_hash, hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insertStmt.run(
        eventIn.event_id,
        deviceId,
        eventIn.kind,
        eventIn.ts_device,
        ts_server,
        schema_ver,
        payloadStr,
        prevHash,
        hash
      );

      const inserted = this.getEventById(eventIn.event_id);
      if (!inserted) {
        throw new Error(`Failed to retrieve inserted event: ${eventIn.event_id}`);
      }

      return { status: 'inserted', event: inserted };
    });
  }

  public ingestBatch(req: IngestReq): {
    insertedCount: number;
    duplicateCount: number;
    events: EventRecord[];
  } {
    return this.withTransaction(() => {
      const results: EventRecord[] = [];
      let insertedCount = 0;
      let duplicateCount = 0;

      for (const eventIn of req.events) {
        const res = this.ingestEvent(req.device_id, eventIn);
        results.push(res.event);
        if (res.status === 'inserted') insertedCount++;
        else duplicateCount++;
      }

      return { insertedCount, duplicateCount, events: results };
    });
  }

  public listEvents(filter: {
    deviceId?: string;
    kind?: string;
    sinceSeq?: number;
    from_seq?: number;
    to_seq?: number;
    limit?: number;
  } = {}): EventRecord[] {
    let sql = "SELECT * FROM events WHERE 1=1";
    const params: any[] = [];
    if (filter.deviceId) {
      sql += " AND device_id = ?";
      params.push(filter.deviceId);
    }
    if (filter.kind) {
      sql += " AND kind = ?";
      params.push(filter.kind);
    }
    if (filter.sinceSeq != null) {
      sql += " AND seq > ?";
      params.push(filter.sinceSeq);
    }
    if (filter.from_seq != null) {
      sql += " AND seq >= ?";
      params.push(filter.from_seq);
    }
    if (filter.to_seq != null) {
      sql += " AND seq <= ?";
      params.push(filter.to_seq);
    }
    sql += " ORDER BY seq ASC";
    if (filter.limit != null) {
      sql += " LIMIT ?";
      params.push(filter.limit);
    }
    const stmt = this.db.prepare(sql);
    const rows = (params.length > 0 ? stmt.all(...params) : stmt.all()) as any[];
    return rows.map((r) => this.mapEventRow(r));
  }

  public verifyEventChain(): {
    valid: boolean;
    totalEvents: number;
    brokenSeq?: number;
    reason?: string;
  } {
    const stmt = this.db.prepare("SELECT * FROM events ORDER BY seq ASC");
    let count = 0;
    let expectedPrevHash = Buffer.alloc(32, 0);

    for (const row of stmt.iterate() as Iterable<any>) {
      count++;
      const seq = Number(row.seq);
      const actualPrevHash = Buffer.from(row.prev_hash);
      const actualHash = Buffer.from(row.hash);

      // Check continuity
      if (seq !== count) {
        return {
          valid: false,
          totalEvents: count,
          brokenSeq: seq,
          reason: `Sequence break at position ${count}, found seq ${seq}`,
        };
      }

      // Check prev_hash matches previous row's hash
      if (!actualPrevHash.equals(expectedPrevHash)) {
        return {
          valid: false,
          totalEvents: count,
          brokenSeq: seq,
          reason: `prev_hash mismatch at seq ${seq}`,
        };
      }

      // Recalculate hash
      const computed = computeCanonicalEventHash(actualPrevHash, {
        event_id: String(row.event_id),
        device_id: String(row.device_id),
        kind: String(row.kind),
        ts_device: Number(row.ts_device),
        ts_server: Number(row.ts_server),
        schema_ver: Number(row.schema_ver),
        payload: String(row.payload),
      });

      if (!actualHash.equals(computed)) {
        return {
          valid: false,
          totalEvents: count,
          brokenSeq: seq,
          reason: `Hash mismatch at seq ${seq}`,
        };
      }

      expectedPrevHash = actualHash;
    }

    return { valid: true, totalEvents: count };
  }

  // --- Invariants ---

  public registerInvariant(inv: InvariantRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO invariants (invariant_id, name, category, enabled)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(invariant_id) DO UPDATE SET
        name = excluded.name,
        category = excluded.category,
        enabled = excluded.enabled
    `);
    stmt.run(inv.invariant_id, inv.name, inv.category, inv.enabled ? 1 : 0);
  }

  public listInvariants(): InvariantRecord[] {
    const stmt = this.db.prepare("SELECT * FROM invariants ORDER BY invariant_id ASC");
    const rows = stmt.all() as any[];
    return rows.map((r) => ({
      invariant_id: String(r.invariant_id),
      name: String(r.name),
      category: String(r.category),
      enabled: Number(r.enabled),
    }));
  }

  // --- Proposals ---

  public insertProposal(proposal: ProposalRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO proposals (
        proposal_id, created_seq, invariant_id, policy_type, tier, summary,
        action, action_hash, efe, risk_term, ambiguity_term, state, shadow,
        expires_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      proposal.proposal_id,
      proposal.created_seq,
      proposal.invariant_id ?? null,
      proposal.policy_type,
      proposal.tier,
      proposal.summary,
      proposal.action,
      Buffer.from(proposal.action_hash),
      proposal.efe,
      proposal.risk_term,
      proposal.ambiguity_term,
      proposal.state,
      proposal.shadow ? 1 : 0,
      proposal.expires_at,
      proposal.updated_at
    );
  }

  public getProposal(proposalId: string): ProposalRecord | null {
    const stmt = this.db.prepare("SELECT * FROM proposals WHERE proposal_id = ?");
    const row = stmt.get(proposalId) as any;
    if (!row) return null;
    return {
      proposal_id: String(row.proposal_id),
      created_seq: Number(row.created_seq),
      invariant_id: row.invariant_id != null ? String(row.invariant_id) : null,
      policy_type: row.policy_type as 'PRAGMATIC' | 'EPISTEMIC',
      tier: Number(row.tier) as any,
      summary: String(row.summary),
      action: String(row.action),
      action_hash: new Uint8Array(row.action_hash),
      efe: Number(row.efe),
      risk_term: Number(row.risk_term),
      ambiguity_term: Number(row.ambiguity_term),
      state: row.state as ProposalState,
      shadow: Number(row.shadow),
      expires_at: Number(row.expires_at),
      updated_at: Number(row.updated_at),
    };
  }

  public updateProposalState(proposalId: string, state: ProposalState): void {
    const stmt = this.db.prepare("UPDATE proposals SET state = ?, updated_at = ? WHERE proposal_id = ?");
    stmt.run(state, Date.now(), proposalId);
  }

  // --- Gate Decisions & Shadow Labels ---

  public recordGateDecision(decision: GateDecisionRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO gate_decisions (proposal_id, mode, decision, reason, ts)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(decision.proposal_id, decision.mode, decision.decision, decision.reason, decision.ts);
  }

  public recordShadowLabel(label: ShadowLabelRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO shadow_labels (proposal_id, label, actual, latency_ms, ts)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(proposal_id) DO UPDATE SET
        label = excluded.label,
        actual = excluded.actual,
        latency_ms = excluded.latency_ms,
        ts = excluded.ts
    `);
    stmt.run(label.proposal_id, label.label, label.actual ?? null, label.latency_ms ?? null, label.ts);
  }

  public getShadowLabels(proposalId?: string): ShadowLabelRecord[] {
    let sql = "SELECT * FROM shadow_labels";
    const params: any[] = [];
    if (proposalId) {
      sql += " WHERE proposal_id = ?";
      params.push(proposalId);
    }
    sql += " ORDER BY ts DESC";
    const stmt = this.db.prepare(sql);
    const rows = (params.length > 0 ? stmt.all(...params) : stmt.all()) as any[];
    return rows.map((r) => ({
      proposal_id: String(r.proposal_id),
      label: r.label as any,
      actual: r.actual != null ? String(r.actual) : null,
      latency_ms: r.latency_ms != null ? Number(r.latency_ms) : null,
      ts: Number(r.ts),
    }));
  }

  // --- Model Params (Dirichlet Counts for A, B, C, D) ---

  public saveModelParams(record: ModelParamRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO model_params (factor, kind, version, counts, as_of_seq)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(factor, kind, version) DO UPDATE SET
        counts = excluded.counts,
        as_of_seq = excluded.as_of_seq
    `);
    stmt.run(record.factor, record.kind, record.version, record.counts, record.as_of_seq);
  }

  public getModelParams(factor: string, kind: 'A' | 'B' | 'C' | 'D', version?: number): ModelParamRecord | null {
    let sql = "SELECT * FROM model_params WHERE factor = ? AND kind = ?";
    const params: any[] = [factor, kind];
    if (version !== undefined) {
      sql += " AND version = ?";
      params.push(version);
    } else {
      sql += " ORDER BY version DESC LIMIT 1";
    }
    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params) as any;
    if (!row) return null;
    return {
      factor: String(row.factor),
      kind: row.kind as 'A' | 'B' | 'C' | 'D',
      version: Number(row.version),
      counts: String(row.counts),
      as_of_seq: Number(row.as_of_seq),
    };
  }

  public listModelParams(factor?: string, kind?: 'A' | 'B' | 'C' | 'D'): ModelParamRecord[] {
    let sql = "SELECT * FROM model_params WHERE 1=1";
    const params: any[] = [];
    if (factor) {
      sql += " AND factor = ?";
      params.push(factor);
    }
    if (kind) {
      sql += " AND kind = ?";
      params.push(kind);
    }
    sql += " ORDER BY factor ASC, kind ASC, version DESC";
    const stmt = this.db.prepare(sql);
    const rows = (params.length > 0 ? stmt.all(...params) : stmt.all()) as any[];
    return rows.map((r) => ({
      factor: String(r.factor),
      kind: r.kind as 'A' | 'B' | 'C' | 'D',
      version: Number(r.version),
      counts: String(r.counts),
      as_of_seq: Number(r.as_of_seq),
    }));
  }

  // --- Belief Snapshots ---

  public saveBeliefSnapshot(record: BeliefSnapshotRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO belief_snapshots (as_of_seq, mode, q, surprisal)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(as_of_seq) DO UPDATE SET
        mode = excluded.mode,
        q = excluded.q,
        surprisal = excluded.surprisal
    `);
    stmt.run(record.as_of_seq, record.mode, record.q, record.surprisal);
  }

  public getLatestBeliefSnapshot(): BeliefSnapshotRecord | null {
    const stmt = this.db.prepare("SELECT * FROM belief_snapshots ORDER BY as_of_seq DESC LIMIT 1");
    const row = stmt.get() as any;
    if (!row) return null;
    return {
      as_of_seq: Number(row.as_of_seq),
      mode: row.mode,
      q: String(row.q),
      surprisal: Number(row.surprisal),
    };
  }

  public getBeliefSnapshot(asOfSeq: number): BeliefSnapshotRecord | null {
    const stmt = this.db.prepare("SELECT * FROM belief_snapshots WHERE as_of_seq = ?");
    const row = stmt.get(asOfSeq) as any;
    if (!row) return null;
    return {
      as_of_seq: Number(row.as_of_seq),
      mode: row.mode,
      q: String(row.q),
      surprisal: Number(row.surprisal),
    };
  }

  public listBeliefSnapshots(limit = 50): BeliefSnapshotRecord[] {
    const stmt = this.db.prepare("SELECT * FROM belief_snapshots ORDER BY as_of_seq DESC LIMIT ?");
    const rows = stmt.all(limit) as any[];
    return rows.map((r) => ({
      as_of_seq: Number(r.as_of_seq),
      mode: r.mode,
      q: String(r.q),
      surprisal: Number(r.surprisal),
    }));
  }

  private mapEventRow(row: any): EventRecord {
    return {
      seq: Number(row.seq),
      event_id: String(row.event_id),
      device_id: String(row.device_id),
      kind: String(row.kind),
      ts_device: Number(row.ts_device),
      ts_server: Number(row.ts_server),
      schema_ver: Number(row.schema_ver),
      payload: String(row.payload),
      prev_hash: new Uint8Array(row.prev_hash),
      hash: new Uint8Array(row.hash),
    };
  }

  public static eventToJson(e: EventRecord): {

    seq: number;
    event_id: string;
    device_id: string;
    kind: string;
    ts_device: number;
    ts_server: number;
    schema_ver: number;
    payload: unknown;
    prev_hash_b64: string;
    hash_b64: string;
  } {
    let payloadParsed: unknown;
    try {
      payloadParsed = JSON.parse(e.payload);
    } catch {
      payloadParsed = e.payload;
    }
    return {
      seq: e.seq,
      event_id: e.event_id,
      device_id: e.device_id,
      kind: e.kind,
      ts_device: e.ts_device,
      ts_server: e.ts_server,
      schema_ver: e.schema_ver,
      payload: payloadParsed,
      prev_hash_b64: Buffer.from(e.prev_hash).toString("base64"),
      hash_b64: Buffer.from(e.hash).toString("base64"),
    };
  }

  public static deviceToJson(d: DeviceRecord): {
    device_id: string;
    name: string;
    platform: string;
    pubkey_b64: string;
    key_attested: number;
    scopes: string[];
    enrolled_at: number;
    revoked_at: number | null;
  } {
    return {
      device_id: d.device_id,
      name: d.name,
      platform: d.platform,
      pubkey_b64: Buffer.from(d.pubkey_spki).toString("base64"),
      key_attested: d.key_attested,
      scopes: d.scopes,
      enrolled_at: d.enrolled_at,
      revoked_at: d.revoked_at ?? null,
    };
  }
}

