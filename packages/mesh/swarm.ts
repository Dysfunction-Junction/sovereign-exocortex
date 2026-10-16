import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { isProcessAlive, redactSecrets, stateDirectory } from "./security.js";
import type { Origin, Provider } from "./types.js";
import type { TaskRegistry } from "./registry.js";
import type { OrchestrationPresetName } from "./orchestration-presets.js";

type Row = Record<string, unknown>;
const s = (value: unknown) => String(value ?? "");
const n = (value: unknown) => Number(value ?? 0);

export interface SwarmMember {
  id: string;
  swarmId: string;
  name: string;
  provider: Provider;
  role: string;
  taskId: string | null;
  sessionId: string | null;
  status: "active" | "dispatching" | "waiting" | "completed" | "failed";
  joinedAt: string;
  updatedAt: string;
  dispatchOwnerPid: number | null;
}

export interface SwarmMessage {
  id: string;
  swarmId: string;
  sequence: number;
  fromMemberId: string;
  toMemberId: string | null;
  kind: "message" | "feedback" | "decision" | "question";
  body: string;
  createdAt: string;
}

export interface SwarmRecord {
  id: string;
  origin: Origin;
  name: string;
  objective: string;
  cwd: string;
  preset: OrchestrationPresetName;
  planId: string | null;
  initiativeId: string | null;
  status: "active" | "closed";
  reviewsRevealed: boolean;
  members: SwarmMember[];
  createdAt: string;
  updatedAt: string;
}

export class SwarmRegistry {
  private readonly db: DatabaseSync;

  constructor(
    readonly origin: Origin,
    readonly path = join(stateDirectory(), "swarms.db"),
    tasks?: TaskRegistry,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS swarms (
        id TEXT PRIMARY KEY, origin TEXT NOT NULL, name TEXT NOT NULL,
        objective TEXT NOT NULL, cwd TEXT NOT NULL, preset TEXT NOT NULL,
        plan_id TEXT, initiative_id TEXT, status TEXT NOT NULL,
        reviews_revealed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS swarm_members (
        id TEXT PRIMARY KEY, swarm_id TEXT NOT NULL, name TEXT NOT NULL,
        provider TEXT NOT NULL, role TEXT NOT NULL, task_id TEXT, session_id TEXT,
        status TEXT NOT NULL, joined_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        dispatch_owner_pid INTEGER,
        UNIQUE(swarm_id, name), FOREIGN KEY(swarm_id) REFERENCES swarms(id)
      );
      CREATE TABLE IF NOT EXISTS swarm_messages (
        id TEXT PRIMARY KEY, swarm_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        from_member_id TEXT NOT NULL, to_member_id TEXT, kind TEXT NOT NULL,
        body TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(swarm_id, sequence),
        FOREIGN KEY(swarm_id) REFERENCES swarms(id)
      );
      CREATE TABLE IF NOT EXISTS swarm_blackboard (
        swarm_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        version INTEGER NOT NULL, author_member_id TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(swarm_id, key), FOREIGN KEY(swarm_id) REFERENCES swarms(id)
      );
      CREATE TABLE IF NOT EXISTS swarm_barriers (
        id TEXT PRIMARY KEY, swarm_id TEXT NOT NULL, name TEXT NOT NULL,
        required_count INTEGER NOT NULL, arrivals_json TEXT NOT NULL,
        created_at TEXT NOT NULL, completed_at TEXT,
        UNIQUE(swarm_id, name), FOREIGN KEY(swarm_id) REFERENCES swarms(id)
      );
      CREATE TABLE IF NOT EXISTS swarm_reviews (
        id TEXT PRIMARY KEY, swarm_id TEXT NOT NULL, member_id TEXT NOT NULL,
        body TEXT NOT NULL, verdict TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(swarm_id, member_id), FOREIGN KEY(swarm_id) REFERENCES swarms(id)
      );
    `);
    const memberColumns = this.db.prepare("PRAGMA table_info(swarm_members)").all() as Row[];
    if (!memberColumns.some((column) => column.name === "dispatch_owner_pid")) {
      this.db.exec("ALTER TABLE swarm_members ADD COLUMN dispatch_owner_pid INTEGER");
    }
    if (tasks) this.recoverMembers(tasks);
  }

  close(): void {
    this.db.close();
  }

  create(input: {
    name: string;
    objective: string;
    cwd: string;
    preset: OrchestrationPresetName;
    planId?: string;
    initiativeId?: string;
  }): SwarmRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO swarms (
          id, origin, name, objective, cwd, preset, plan_id, initiative_id,
          status, reviews_revealed, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)`,
      )
      .run(
        id,
        this.origin,
        redactSecrets(input.name).slice(0, 120),
        redactSecrets(input.objective).slice(0, 8_000),
        input.cwd,
        input.preset,
        input.planId ?? null,
        input.initiativeId ?? null,
        now,
        now,
      );
    return this.get(id);
  }

  get(id: string): SwarmRecord {
    const row = this.db
      .prepare("SELECT * FROM swarms WHERE id = ? AND origin = ?")
      .get(id, this.origin) as Row | undefined;
    if (!row) throw new Error(`Unknown swarm: ${id}`);
    const members = this.db
      .prepare("SELECT * FROM swarm_members WHERE swarm_id = ? ORDER BY joined_at")
      .all(id) as Row[];
    return {
      id,
      origin: this.origin,
      name: s(row.name),
      objective: s(row.objective),
      cwd: s(row.cwd),
      preset: s(row.preset) as OrchestrationPresetName,
      planId: row.plan_id ? s(row.plan_id) : null,
      initiativeId: row.initiative_id ? s(row.initiative_id) : null,
      status: s(row.status) as "active" | "closed",
      reviewsRevealed: Boolean(row.reviews_revealed),
      members: members.map((member) => ({
        id: s(member.id),
        swarmId: id,
        name: s(member.name),
        provider: s(member.provider) as Provider,
        role: s(member.role),
        taskId: member.task_id ? s(member.task_id) : null,
        sessionId: member.session_id ? s(member.session_id) : null,
        status: s(member.status) as SwarmMember["status"],
        joinedAt: s(member.joined_at),
        updatedAt: s(member.updated_at),
        dispatchOwnerPid: member.dispatch_owner_pid ? n(member.dispatch_owner_pid) : null,
      })),
      createdAt: s(row.created_at),
      updatedAt: s(row.updated_at),
    };
  }

  list(limit = 100): SwarmRecord[] {
    return (
      this.db
        .prepare("SELECT id FROM swarms WHERE origin = ? ORDER BY updated_at DESC LIMIT ?")
        .all(this.origin, Math.min(Math.max(limit, 1), 1_000)) as Row[]
    ).map((row) => this.get(s(row.id)));
  }

  linkPlan(swarmId: string, planId: string): SwarmRecord {
    const result = this.db
      .prepare(
        `UPDATE swarms SET plan_id = ?, updated_at = ?
         WHERE id = ? AND origin = ? AND status = 'active'
           AND (plan_id IS NULL OR plan_id = ?)`,
      )
      .run(planId, new Date().toISOString(), swarmId, this.origin, planId);
    if (result.changes !== 1) {
      throw new Error("Swarm is closed or already linked to another plan.");
    }
    return this.get(swarmId);
  }

  addMember(
    swarmId: string,
    input: { name: string; provider: Provider; role: string; taskId?: string; sessionId?: string },
  ): SwarmMember {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const swarm = this.assertActive(swarmId);
      if (swarm.reviewsRevealed && input.role === "reviewer") {
        throw new Error("Cannot add a reviewer after sealed reviews are revealed.");
      }
      this.db
        .prepare(
          `INSERT INTO swarm_members (
            id, swarm_id, name, provider, role, task_id, session_id,
            status, joined_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          id,
          swarmId,
          redactSecrets(input.name).slice(0, 120),
          input.provider,
          redactSecrets(input.role).slice(0, 120),
          input.taskId ?? null,
          input.sessionId ?? null,
          now,
          now,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.get(swarmId).members.find((member) => member.id === id)!;
  }

  updateMember(
    swarmId: string,
    memberId: string,
    input: Partial<Pick<SwarmMember, "taskId" | "sessionId" | "status">>,
  ): SwarmMember {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertActive(swarmId);
      const result = this.db
        .prepare(
          `UPDATE swarm_members SET
             task_id = COALESCE(?, task_id),
             session_id = COALESCE(?, session_id),
             status = COALESCE(?, status),
             dispatch_owner_pid = CASE
               WHEN COALESCE(?, status) = 'dispatching' THEN dispatch_owner_pid
               ELSE NULL
             END,
             updated_at = ?
           WHERE id = ? AND swarm_id = ?`,
        )
        .run(
          input.taskId ?? null,
          input.sessionId ?? null,
          input.status ?? null,
          input.status ?? null,
          new Date().toISOString(),
          memberId,
          swarmId,
        );
      if (result.changes !== 1) throw new Error(`Unknown swarm member: ${memberId}`);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.get(swarmId).members.find((member) => member.id === memberId)!;
  }

  claimMemberDispatch(swarmId: string, memberId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE swarm_members SET status = 'dispatching', dispatch_owner_pid = ?,
         updated_at = ?
         WHERE id = ? AND swarm_id = ? AND task_id IS NULL AND status = 'active'
           AND EXISTS (
             SELECT 1 FROM swarms
             WHERE swarms.id = swarm_members.swarm_id
               AND swarms.origin = ? AND swarms.status = 'active'
           )`,
      )
      .run(process.pid, new Date().toISOString(), memberId, swarmId, this.origin);
    return result.changes === 1;
  }

  releaseMemberDispatch(swarmId: string, memberId: string): void {
    this.db
      .prepare(
        `UPDATE swarm_members SET status = 'active', dispatch_owner_pid = NULL, updated_at = ?
         WHERE id = ? AND swarm_id = ? AND task_id IS NULL AND status = 'dispatching'`,
      )
      .run(new Date().toISOString(), memberId, swarmId);
  }

  resetMemberAfterPrelaunchFailure(
    swarmId: string,
    memberId: string,
    taskId: string,
  ): SwarmMember {
    const result = this.db
      .prepare(
        `UPDATE swarm_members SET task_id = NULL, session_id = NULL,
         status = 'active', dispatch_owner_pid = NULL, updated_at = ?
         WHERE id = ? AND swarm_id = ? AND task_id = ?
           AND EXISTS (
             SELECT 1 FROM swarms
             WHERE swarms.id = swarm_members.swarm_id
               AND swarms.origin = ? AND swarms.status = 'active'
           )`,
      )
      .run(new Date().toISOString(), memberId, swarmId, taskId, this.origin);
    if (result.changes !== 1) {
      const member = this.get(swarmId).members.find(
        (candidate) => candidate.id === memberId,
      );
      if (member?.status === "active" && member.taskId === null) return member;
      throw new Error("Member no longer owns the failed pre-launch task.");
    }
    return this.get(swarmId).members.find((member) => member.id === memberId)!;
  }

  send(
    swarmId: string,
    input: {
      fromMemberId: string;
      toMemberId?: string;
      kind?: SwarmMessage["kind"];
      body: string;
    },
  ): SwarmMessage {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const body = redactSecrets(input.body).slice(0, 64_000);
    this.db.exec("BEGIN IMMEDIATE");
    let sequence: number;
    try {
      const swarm = this.assertActive(swarmId);
      if (!swarm.members.some((member) => member.id === input.fromMemberId)) {
        throw new Error("Unknown sending member.");
      }
      if (
        input.toMemberId &&
        !swarm.members.some((member) => member.id === input.toMemberId)
      ) {
        throw new Error("Unknown receiving member.");
      }
      sequence = n(
        (
          this.db
            .prepare(
              "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM swarm_messages WHERE swarm_id = ?",
            )
            .get(swarmId) as Row
        ).sequence,
      );
      this.db
        .prepare(
          `INSERT INTO swarm_messages
           (id, swarm_id, sequence, from_member_id, to_member_id, kind, body, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          swarmId,
          sequence,
          input.fromMemberId,
          input.toMemberId ?? null,
          input.kind ?? "message",
          body,
          createdAt,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      id,
      swarmId,
      sequence,
      fromMemberId: input.fromMemberId,
      toMemberId: input.toMemberId ?? null,
      kind: input.kind ?? "message",
      body,
      createdAt,
    };
  }

  inbox(swarmId: string, memberId: string, afterSequence = 0, limit = 100): SwarmMessage[] {
    const swarm = this.get(swarmId);
    if (!swarm.members.some((member) => member.id === memberId)) {
      throw new Error("Unknown swarm member.");
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM swarm_messages
         WHERE swarm_id = ? AND sequence > ?
           AND (to_member_id IS NULL OR to_member_id = ?)
         ORDER BY sequence ASC LIMIT ?`,
      )
      .all(swarmId, afterSequence, memberId, Math.min(Math.max(limit, 1), 1_000)) as Row[];
    return rows.map((row) => ({
      id: s(row.id),
      swarmId,
      sequence: n(row.sequence),
      fromMemberId: s(row.from_member_id),
      toMemberId: row.to_member_id ? s(row.to_member_id) : null,
      kind: s(row.kind) as SwarmMessage["kind"],
      body: s(row.body),
      createdAt: s(row.created_at),
    }));
  }

  async waitForInbox(
    swarmId: string,
    memberId: string,
    afterSequence: number,
    timeoutMs: number,
  ): Promise<SwarmMessage[]> {
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 0), 600_000);
    for (;;) {
      const messages = this.inbox(swarmId, memberId, afterSequence);
      if (messages.length || Date.now() >= deadline) return messages;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  blackboardSet(
    swarmId: string,
    input: { key: string; value: string; authorMemberId: string; expectedVersion?: number },
  ) {
    const updatedAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    let version: number;
    try {
      const swarm = this.assertActive(swarmId);
      if (!swarm.members.some((member) => member.id === input.authorMemberId)) {
        throw new Error("Unknown blackboard author.");
      }
      const current = this.db
        .prepare("SELECT * FROM swarm_blackboard WHERE swarm_id = ? AND key = ?")
        .get(swarmId, input.key) as Row | undefined;
      version = current ? n(current.version) + 1 : 1;
      if (input.expectedVersion !== undefined && input.expectedVersion !== version - 1) {
        throw new Error("Blackboard version conflict.");
      }
      this.db
        .prepare(
          `INSERT INTO swarm_blackboard
           (swarm_id, key, value, version, author_member_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(swarm_id, key) DO UPDATE SET
             value=excluded.value, version=excluded.version,
             author_member_id=excluded.author_member_id, updated_at=excluded.updated_at`,
        )
        .run(
          swarmId,
          input.key.slice(0, 200),
          redactSecrets(input.value).slice(0, 128_000),
          version,
          input.authorMemberId,
          updatedAt,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { swarmId, key: input.key, value: redactSecrets(input.value), version, updatedAt };
  }

  blackboard(swarmId: string) {
    this.get(swarmId);
    return this.db
      .prepare("SELECT key, value, version, author_member_id, updated_at FROM swarm_blackboard WHERE swarm_id = ? ORDER BY key")
      .all(swarmId);
  }

  createBarrier(swarmId: string, name: string, requiredCount: number) {
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertActive(swarmId);
      this.db
        .prepare(
          `INSERT INTO swarm_barriers
           (id, swarm_id, name, required_count, arrivals_json, created_at, completed_at)
           VALUES (?, ?, ?, ?, '[]', ?, NULL)`,
        )
        .run(
          id,
          swarmId,
          name.slice(0, 120),
          Math.max(1, requiredCount),
          new Date().toISOString(),
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.barrier(id);
  }

  arrive(barrierId: string, memberId: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const barrier = this.barrier(barrierId);
      const swarm = this.assertActive(barrier.swarmId);
      if (!swarm.members.some((member) => member.id === memberId)) {
        throw new Error("Unknown barrier member.");
      }
      const current = this.db
        .prepare("SELECT arrivals_json, required_count, completed_at FROM swarm_barriers WHERE id = ?")
        .get(barrierId) as Row;
      const arrivals = new Set<string>(JSON.parse(s(current.arrivals_json)) as string[]);
      arrivals.add(memberId);
      const completedAt =
        (current.completed_at ? s(current.completed_at) : null) ??
        (arrivals.size >= n(current.required_count) ? new Date().toISOString() : null);
      this.db
        .prepare("UPDATE swarm_barriers SET arrivals_json = ?, completed_at = ? WHERE id = ?")
        .run(JSON.stringify([...arrivals]), completedAt, barrierId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.barrier(barrierId);
  }

  barrier(id: string) {
    const row = this.db.prepare("SELECT * FROM swarm_barriers WHERE id = ?").get(id) as
      | Row
      | undefined;
    if (!row) throw new Error(`Unknown barrier: ${id}`);
    this.get(s(row.swarm_id));
    return {
      id,
      swarmId: s(row.swarm_id),
      name: s(row.name),
      requiredCount: n(row.required_count),
      arrivals: JSON.parse(s(row.arrivals_json)) as string[],
      completedAt: row.completed_at ? s(row.completed_at) : null,
    };
  }

  submitReview(
    swarmId: string,
    input: { memberId: string; verdict: string; body: string },
  ) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const swarm = this.assertActive(swarmId);
      if (swarm.reviewsRevealed) throw new Error("Swarm reviews are already revealed.");
      const member = swarm.members.find((candidate) => candidate.id === input.memberId);
      if (!member || member.role !== "reviewer") {
        throw new Error("Only registered reviewer members may submit sealed reviews.");
      }
      try {
        this.db
          .prepare(
            `INSERT INTO swarm_reviews
             (id, swarm_id, member_id, body, verdict, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            swarmId,
            input.memberId,
            redactSecrets(input.body).slice(0, 128_000),
            redactSecrets(input.verdict).slice(0, 120),
            new Date().toISOString(),
          );
      } catch (error) {
        if (String(error).includes("UNIQUE constraint failed")) {
          throw new Error("Reviewer already submitted a sealed review.");
        }
        throw error;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { submitted: true, revealed: false };
  }

  reviews(swarmId: string) {
    const swarm = this.get(swarmId);
    if (!swarm.reviewsRevealed) return [];
    return this.db
      .prepare("SELECT * FROM swarm_reviews WHERE swarm_id = ? ORDER BY created_at")
      .all(swarmId);
  }

  revealReviews(swarmId: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const swarm = this.assertActive(swarmId);
      if (swarm.reviewsRevealed) {
        this.db.exec("COMMIT");
      } else {
        const reviewers = swarm.members.filter((member) => member.role === "reviewer");
        if (!reviewers.length) throw new Error("Swarm has no registered reviewers.");
        const submitted = this.db
          .prepare("SELECT member_id FROM swarm_reviews WHERE swarm_id = ?")
          .all(swarmId) as Row[];
        const submittedIds = new Set(submitted.map((row) => s(row.member_id)));
        const missing = reviewers.filter((member) => !submittedIds.has(member.id));
        if (missing.length) {
          throw new Error(
            `Cannot reveal reviews before every reviewer submits: ${missing
              .map((member) => member.name)
              .join(", ")}`,
          );
        }
        const unsettled = reviewers.filter((member) => member.status !== "completed");
        if (unsettled.length) {
          throw new Error(
            `Cannot reveal reviews before reviewer tasks complete: ${unsettled
              .map((member) => member.name)
              .join(", ")}`,
          );
        }
        const result = this.db
          .prepare(
            `UPDATE swarms SET reviews_revealed = 1, updated_at = ?
             WHERE id = ? AND origin = ? AND status = 'active' AND reviews_revealed = 0`,
          )
          .run(new Date().toISOString(), swarmId, this.origin);
        if (result.changes !== 1) {
          throw new Error("Review reveal raced with another transition.");
        }
        this.db.exec("COMMIT");
      }
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.reviews(swarmId);
  }

  closeSwarm(swarmId: string): SwarmRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const swarm = this.assertActive(swarmId);
      const active = swarm.members.filter(
        (member) =>
          member.status === "dispatching" ||
          member.status === "waiting" ||
          (member.status === "active" && member.taskId),
      );
      if (active.length) {
        throw new Error(
          `Cannot close a swarm with active members: ${active
            .map((member) => member.name)
            .join(", ")}`,
        );
      }
      const result = this.db
        .prepare(
          `UPDATE swarms SET status = 'closed', updated_at = ?
           WHERE id = ? AND origin = ? AND status = 'active'`,
        )
        .run(new Date().toISOString(), swarmId, this.origin);
      if (result.changes !== 1) throw new Error("Swarm close raced with another transition.");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.get(swarmId);
  }

  reopenSwarm(swarmId: string): SwarmRecord {
    const result = this.db
      .prepare(
        `UPDATE swarms SET status = 'active', updated_at = ?
         WHERE id = ? AND origin = ? AND status = 'closed' AND reviews_revealed = 0`,
      )
      .run(new Date().toISOString(), swarmId, this.origin);
    if (result.changes !== 1) {
      throw new Error("Only a closed swarm with unrevealed reviews can be reopened.");
    }
    return this.get(swarmId);
  }

  private recoverMembers(tasks: TaskRegistry): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(
          `SELECT members.*
           FROM swarm_members AS members
           JOIN swarms ON swarms.id = members.swarm_id
           WHERE swarms.origin = ? AND swarms.status = 'active'
             AND members.status IN ('dispatching', 'active', 'waiting')`,
        )
        .all(this.origin) as Row[];
      const now = new Date().toISOString();
      for (const row of rows) {
      const memberId = s(row.id);
      const taskId = row.task_id ? s(row.task_id) : null;
      const ownerPid = row.dispatch_owner_pid ? n(row.dispatch_owner_pid) : null;
      if (!taskId) {
        if (s(row.status) === "dispatching" && !isProcessAlive(ownerPid)) {
          this.db
            .prepare(
              `UPDATE swarm_members SET status = 'active',
               dispatch_owner_pid = NULL, updated_at = ?
               WHERE id = ? AND status = 'dispatching' AND task_id IS NULL`,
            )
            .run(now, memberId);
        }
        continue;
      }
      const task = tasks.get(taskId);
      if (!task || task.origin !== this.origin) {
        this.db
          .prepare(
            `UPDATE swarm_members SET status = 'failed',
             dispatch_owner_pid = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(now, memberId);
        continue;
      }
      if (["completed", "failed", "cancelled", "interrupted"].includes(task.status)) {
        const everRan = tasks
          .transitions(taskId)
          .some((transition) => transition.toStatus === "running");
        if (task.status !== "completed" && !everRan) {
          this.db
            .prepare(
              `UPDATE swarm_members SET status = 'active', task_id = NULL,
               session_id = NULL, dispatch_owner_pid = NULL, updated_at = ?
               WHERE id = ?`,
            )
            .run(now, memberId);
          continue;
        }
        this.db
          .prepare(
            `UPDATE swarm_members SET status = ?, session_id = COALESCE(?, session_id),
             dispatch_owner_pid = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(
            task.status === "completed" ? "completed" : "failed",
            task.sessionId,
            now,
            memberId,
          );
      } else if (task.status === "waiting_for_input") {
        this.db
          .prepare(
            `UPDATE swarm_members SET status = 'waiting',
             dispatch_owner_pid = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(now, memberId);
      }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private assertActive(id: string): SwarmRecord {
    const swarm = this.get(id);
    if (swarm.status !== "active") throw new Error("Swarm is closed.");
    return swarm;
  }
}
