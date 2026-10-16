import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { redactSecrets, stateDirectory } from "./security.js";
import type { Origin, Provider } from "./types.js";
import type { TaskRegistry } from "./registry.js";
import type { OrchestrationPresetName } from "./orchestration-presets.js";

export const PLAN_STATUSES = [
  "draft",
  "under_review",
  "approved",
  "executing",
  "completed",
  "rejected",
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export type PlanReviewVerdict = "approve" | "changes_requested";

export interface PlanRevision {
  id: string;
  planId: string;
  version: number;
  body: string;
  summary: string;
  author: string;
  createdAt: string;
}

export interface PlanReview {
  id: string;
  planId: string;
  revisionVersion: number;
  reviewer: string;
  provider: Provider | null;
  sessionId: string | null;
  verdict: PlanReviewVerdict;
  feedback: string;
  createdAt: string;
}

export interface PlanRecord {
  id: string;
  origin: Origin;
  title: string;
  objective: string;
  cwd: string;
  preset: OrchestrationPresetName;
  status: PlanStatus;
  version: number;
  currentRevision: PlanRevision;
  reviews: PlanReview[];
  executionTaskId: string | null;
  initiativeId: string | null;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  completedAt: string | null;
}

type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "");
const nullable = (value: unknown) =>
  value === null || value === undefined ? null : String(value);

export class PlanRegistry {
  private readonly db: DatabaseSync;

  constructor(
    readonly origin: Origin,
    readonly path = join(stateDirectory(), "plans.db"),
    tasks?: TaskRegistry,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY, origin TEXT NOT NULL, title TEXT NOT NULL,
        objective TEXT NOT NULL, cwd TEXT NOT NULL, preset TEXT NOT NULL,
        status TEXT NOT NULL, version INTEGER NOT NULL,
        execution_task_id TEXT, initiative_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        approved_at TEXT, completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS plan_revisions (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, version INTEGER NOT NULL,
        body TEXT NOT NULL, summary TEXT NOT NULL, author TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(plan_id, version),
        FOREIGN KEY(plan_id) REFERENCES plans(id)
      );
      CREATE TABLE IF NOT EXISTS plan_reviews (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, revision_version INTEGER NOT NULL,
        reviewer TEXT NOT NULL, provider TEXT, session_id TEXT,
        verdict TEXT NOT NULL, feedback TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(plan_id) REFERENCES plans(id)
      );
      CREATE INDEX IF NOT EXISTS idx_plans_origin_updated ON plans(origin, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_plan_reviews_plan ON plan_reviews(plan_id, created_at);
    `);
    if (tasks) this.recoverExecutionReservations(tasks);
  }

  close(): void {
    this.db.close();
  }

  create(input: {
    title: string;
    objective: string;
    cwd: string;
    preset: OrchestrationPresetName;
    body: string;
    author: string;
  }): PlanRecord {
    const id = randomUUID();
    const revisionId = randomUUID();
    const now = new Date().toISOString();
    const title = redactSecrets(input.title.trim()).slice(0, 200);
    const objective = redactSecrets(input.objective.trim()).slice(0, 4_000);
    const body = redactSecrets(input.body).slice(0, 1_048_576);
    if (!title || !objective || !body) throw new Error("Plan title, objective, and body are required.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO plans (
            id, origin, title, objective, cwd, preset, status, version,
            execution_task_id, initiative_id, created_at, updated_at,
            approved_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'draft', 1, NULL, NULL, ?, ?, NULL, NULL)`,
        )
        .run(id, this.origin, title, objective, input.cwd, input.preset, now, now);
      this.db
        .prepare(
          `INSERT INTO plan_revisions
           (id, plan_id, version, body, summary, author, created_at)
           VALUES (?, ?, 1, ?, 'Initial plan', ?, ?)`,
        )
        .run(revisionId, id, body, redactSecrets(input.author).slice(0, 200), now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.get(id);
  }

  get(id: string): PlanRecord {
    const row = this.db
      .prepare("SELECT * FROM plans WHERE id = ? AND origin = ?")
      .get(id, this.origin) as Row | undefined;
    if (!row) throw new Error(`Unknown plan: ${id}`);
    const revision = this.db
      .prepare("SELECT * FROM plan_revisions WHERE plan_id = ? AND version = ?")
      .get(id, Number(row.version)) as Row;
    const reviews = this.db
      .prepare("SELECT * FROM plan_reviews WHERE plan_id = ? ORDER BY created_at ASC")
      .all(id) as Row[];
    return {
      id,
      origin: this.origin,
      title: text(row.title),
      objective: text(row.objective),
      cwd: text(row.cwd),
      preset: text(row.preset) as OrchestrationPresetName,
      status: text(row.status) as PlanStatus,
      version: Number(row.version),
      currentRevision: {
        id: text(revision.id),
        planId: id,
        version: Number(revision.version),
        body: text(revision.body),
        summary: text(revision.summary),
        author: text(revision.author),
        createdAt: text(revision.created_at),
      },
      reviews: reviews.map((review) => ({
        id: text(review.id),
        planId: id,
        revisionVersion: Number(review.revision_version),
        reviewer: text(review.reviewer),
        provider: nullable(review.provider) as Provider | null,
        sessionId: nullable(review.session_id),
        verdict: text(review.verdict) as PlanReviewVerdict,
        feedback: text(review.feedback),
        createdAt: text(review.created_at),
      })),
      executionTaskId: nullable(row.execution_task_id),
      initiativeId: nullable(row.initiative_id),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
      approvedAt: nullable(row.approved_at),
      completedAt: nullable(row.completed_at),
    };
  }

  list(limit = 100): PlanRecord[] {
    const rows = this.db
      .prepare("SELECT id FROM plans WHERE origin = ? ORDER BY updated_at DESC LIMIT ?")
      .all(this.origin, Math.min(Math.max(limit, 1), 1_000)) as Row[];
    return rows.map((row) => this.get(text(row.id)));
  }

  revise(id: string, input: { body: string; summary: string; author: string }): PlanRecord {
    const plan = this.get(id);
    if (["executing", "completed"].includes(plan.status)) {
      throw new Error(`Cannot revise a ${plan.status} plan.`);
    }
    const version = plan.version + 1;
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO plan_revisions
           (id, plan_id, version, body, summary, author, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          id,
          version,
          redactSecrets(input.body).slice(0, 1_048_576),
          redactSecrets(input.summary).slice(0, 4_000),
          redactSecrets(input.author).slice(0, 200),
          now,
        );
      const updated = this.db
        .prepare(
          `UPDATE plans SET version = ?, status = 'draft',
           updated_at = ?, approved_at = NULL
           WHERE id = ? AND origin = ? AND version = ?
             AND status NOT IN ('executing', 'completed')`,
        )
        .run(version, now, id, this.origin, plan.version);
      if (updated.changes !== 1) throw new Error("Plan changed while it was being revised.");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.get(id);
  }

  submitForReview(id: string): PlanRecord {
    this.get(id);
    const result = this.db
      .prepare(
        `UPDATE plans SET status = 'under_review', updated_at = ?
         WHERE id = ? AND origin = ? AND status = 'draft'`,
      )
      .run(new Date().toISOString(), id, this.origin);
    if (result.changes !== 1) throw new Error("Only draft plans can enter review.");
    return this.get(id);
  }

  review(
    id: string,
    input: {
      reviewer: string;
      provider?: Provider;
      sessionId?: string;
      verdict: PlanReviewVerdict;
      feedback: string;
    },
  ): PlanRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const plan = this.get(id);
      if (plan.status !== "under_review") throw new Error("Plan is not under review.");
      this.db
        .prepare(
          `INSERT INTO plan_reviews (
            id, plan_id, revision_version, reviewer, provider, session_id,
            verdict, feedback, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          id,
          plan.version,
          redactSecrets(input.reviewer).slice(0, 200),
          input.provider ?? null,
          input.sessionId ?? null,
          input.verdict,
          redactSecrets(input.feedback).slice(0, 32_000),
          new Date().toISOString(),
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.get(id);
  }

  approve(id: string): PlanRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const plan = this.get(id);
      if (plan.status !== "under_review") throw new Error("Plan is not under review.");
      const reviews = plan.reviews.filter(
        (review) => review.revisionVersion === plan.version,
      );
      if (reviews.some((review) => review.verdict === "changes_requested")) {
        throw new Error("Plan still has requested changes.");
      }
      if (!reviews.some((review) => review.verdict === "approve")) {
        throw new Error("Plan requires at least one approving review.");
      }
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          `UPDATE plans SET status = 'approved', approved_at = ?, updated_at = ?
           WHERE id = ? AND origin = ? AND status = 'under_review' AND version = ?`,
        )
        .run(now, now, id, this.origin, plan.version);
      if (result.changes !== 1) throw new Error("Plan changed during approval.");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.get(id);
  }

  attachExecution(
    id: string,
    input: { taskId?: string; initiativeId?: string },
  ): PlanRecord {
    this.get(id);
    const result = this.db
      .prepare(
        `UPDATE plans SET status = 'executing', execution_task_id = ?,
         initiative_id = ?, updated_at = ?
         WHERE id = ? AND origin = ? AND status = 'approved'`,
      )
      .run(
        input.taskId ?? null,
        input.initiativeId ?? null,
        new Date().toISOString(),
        id,
        this.origin,
      );
    if (result.changes !== 1) throw new Error("Only approved plans can execute.");
    return this.get(id);
  }

  rollbackExecutionReservation(id: string, taskId: string): PlanRecord {
    const result = this.db
      .prepare(
        `UPDATE plans SET status = 'approved', execution_task_id = NULL,
         initiative_id = NULL, updated_at = ?
         WHERE id = ? AND origin = ? AND status = 'executing'
           AND execution_task_id = ?`,
      )
      .run(new Date().toISOString(), id, this.origin, taskId);
    if (result.changes !== 1) {
      const plan = this.get(id);
      if (
        plan.status === "approved" &&
        plan.executionTaskId === null &&
        plan.initiativeId === null
      ) {
        return plan;
      }
      throw new Error("Plan execution reservation no longer belongs to this task.");
    }
    return this.get(id);
  }

  transferExecutionReservation(
    id: string,
    fromTaskId: string,
    toTaskId: string,
  ): PlanRecord {
    const result = this.db
      .prepare(
        `UPDATE plans SET execution_task_id = ?, updated_at = ?
         WHERE id = ? AND origin = ? AND status = 'executing'
           AND execution_task_id = ?`,
      )
      .run(toTaskId, new Date().toISOString(), id, this.origin, fromTaskId);
    if (result.changes !== 1) {
      const plan = this.get(id);
      if (plan.status === "executing" && plan.executionTaskId === toTaskId) {
        return plan;
      }
      throw new Error("Plan execution reservation transfer failed.");
    }
    return this.get(id);
  }

  complete(id: string): PlanRecord {
    this.get(id);
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE plans SET status = 'completed', completed_at = ?, updated_at = ?
         WHERE id = ? AND origin = ? AND status = 'executing'`,
      )
      .run(now, now, id, this.origin);
    if (result.changes !== 1) throw new Error("Plan is not executing.");
    return this.get(id);
  }

  private recoverExecutionReservations(tasks: TaskRegistry): void {
    const rows = this.db
      .prepare(
        `SELECT id, execution_task_id FROM plans
         WHERE origin = ? AND status = 'executing' AND execution_task_id IS NOT NULL`,
      )
      .all(this.origin) as Row[];
    for (const row of rows) {
      const taskId = text(row.execution_task_id);
      const task = tasks.get(taskId);
      const everRan = task
        ? tasks.transitions(taskId).some((transition) => transition.toStatus === "running")
        : false;
      if (
        !task ||
        (["failed", "cancelled", "interrupted"].includes(task.status) && !everRan)
      ) {
        this.db
          .prepare(
            `UPDATE plans SET status = 'approved', execution_task_id = NULL,
             initiative_id = NULL, updated_at = ?
             WHERE id = ? AND execution_task_id = ? AND status = 'executing'`,
          )
          .run(new Date().toISOString(), text(row.id), taskId);
      }
    }
  }
}
