import { chmodSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { isProcessAlive, stateDirectory } from "./security.js";
import type {
  Origin,
  Provider,
  QuestionDelivery,
  QuestionRecord,
  QuestionStatus,
  TaskRecord,
  TaskStatus,
} from "./types.js";

type Row = Record<string, unknown>;

const COLUMN_BY_FIELD: Record<keyof TaskRecord, string> = {
  id: "id",
  origin: "origin",
  provider: "provider",
  description: "description",
  mode: "mode",
  status: "status",
  cwd: "cwd",
  effectiveCwd: "effective_cwd",
  repoRoot: "repo_root",
  worktreePath: "worktree_path",
  baseCommit: "base_commit",
  model: "model",
  effort: "effort",
  actualModel: "actual_model",
  actualEffort: "actual_effort",
  fallbackCount: "fallback_count",
  fallbackReason: "fallback_reason",
  mcpProfile: "mcp_profile",
  sessionId: "session_id",
  parentTaskId: "parent_task_id",
  initiativeId: "initiative_id",
  swarmId: "swarm_id",
  swarmMemberId: "swarm_member_id",
  peerCausalRoot: "peer_causal_root",
  peerCausalPath: "peer_causal_path_json",
  ownerPid: "owner_pid",
  pid: "pid",
  resultPath: "result_path",
  eventsPath: "events_path",
  transcriptPath: "transcript_path",
  pendingQuestionId: "pending_question_id",
  patchPath: "patch_path",
  changedFiles: "changed_files_json",
  artifactStatus: "artifact_status",
  error: "error",
  createdAt: "created_at",
  updatedAt: "updated_at",
  completedAt: "completed_at",
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : asString(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function rowToTask(row: Row): TaskRecord {
  return {
    id: asString(row.id),
    origin: asString(row.origin) as TaskRecord["origin"],
    provider: asString(row.provider) as Provider,
    description: asString(row.description),
    mode: asString(row.mode) as TaskRecord["mode"],
    status: asString(row.status) as TaskStatus,
    cwd: asString(row.cwd),
    effectiveCwd: asString(row.effective_cwd),
    repoRoot: nullableString(row.repo_root),
    worktreePath: nullableString(row.worktree_path),
    baseCommit: nullableString(row.base_commit),
    model: nullableString(row.model),
    effort: nullableString(row.effort),
    actualModel: nullableString(row.actual_model),
    actualEffort: nullableString(row.actual_effort),
    fallbackCount: Number(row.fallback_count ?? 0),
    fallbackReason: nullableString(row.fallback_reason),
    mcpProfile: (nullableString(row.mcp_profile) ?? "none") as TaskRecord["mcpProfile"],
    sessionId: nullableString(row.session_id),
    parentTaskId: nullableString(row.parent_task_id),
    initiativeId: nullableString(row.initiative_id),
    swarmId: nullableString(row.swarm_id),
    swarmMemberId: nullableString(row.swarm_member_id),
    peerCausalRoot: nullableString(row.peer_causal_root),
    peerCausalPath: (() => {
      try {
        const parsed = JSON.parse(
          asString(row.peer_causal_path_json || "[]"),
        ) as unknown;
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        return [];
      }
    })(),
    ownerPid: Number(row.owner_pid),
    pid: nullableNumber(row.pid),
    resultPath: nullableString(row.result_path),
    eventsPath: nullableString(row.events_path),
    transcriptPath: nullableString(row.transcript_path),
    pendingQuestionId: nullableString(row.pending_question_id),
    patchPath: nullableString(row.patch_path),
    changedFiles: (() => {
      try {
        const parsed = JSON.parse(asString(row.changed_files_json || "[]")) as unknown;
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        return [];
      }
    })(),
    artifactStatus: (nullableString(row.artifact_status) ??
      "not_applicable") as TaskRecord["artifactStatus"],
    error: nullableString(row.error),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    completedAt: nullableString(row.completed_at),
  };
}

function rowToQuestion(row: Row): QuestionRecord {
  let options: string[] = [];
  try {
    const parsed = JSON.parse(asString(row.options_json || "[]")) as unknown;
    if (Array.isArray(parsed)) options = parsed.map(String);
  } catch {
    options = [];
  }
  return {
    id: asString(row.id),
    taskId: asString(row.task_id),
    origin: asString(row.origin) as Origin,
    provider: asString(row.provider) as Provider,
    sessionId: nullableString(row.session_id),
    delivery: (nullableString(row.delivery) ?? "resume") as QuestionDelivery,
    nativeRequestId: nullableString(row.native_request_id),
    question: asString(row.question),
    context: nullableString(row.context),
    options,
    status: asString(row.status) as QuestionStatus,
    answer: nullableString(row.answer),
    createdAt: asString(row.created_at),
    answeredAt: nullableString(row.answered_at),
  };
}

export class TaskRegistry {
  readonly path: string;
  private readonly db: DatabaseSync;
  private lastRecoveryAt = 0;

  constructor(path = join(stateDirectory(), "mesh.db")) {
    mkdirSync(stateDirectory(), { recursive: true, mode: 0o700 });
    chmodSync(stateDirectory(), 0o700);
    this.path = path;
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        origin TEXT NOT NULL,
        provider TEXT NOT NULL,
        description TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        cwd TEXT NOT NULL,
        effective_cwd TEXT NOT NULL,
        repo_root TEXT,
        worktree_path TEXT,
        base_commit TEXT,
        model TEXT,
        effort TEXT,
        actual_model TEXT,
        actual_effort TEXT,
        fallback_count INTEGER NOT NULL DEFAULT 0,
        fallback_reason TEXT,
        mcp_profile TEXT NOT NULL DEFAULT 'none',
        session_id TEXT,
        parent_task_id TEXT,
        initiative_id TEXT,
        swarm_id TEXT,
        swarm_member_id TEXT,
        peer_causal_root TEXT,
        peer_causal_path_json TEXT NOT NULL DEFAULT '[]',
        owner_pid INTEGER NOT NULL,
        pid INTEGER,
        result_path TEXT,
        events_path TEXT,
        transcript_path TEXT,
        pending_question_id TEXT,
        patch_path TEXT,
        changed_files_json TEXT NOT NULL DEFAULT '[]',
        artifact_status TEXT NOT NULL DEFAULT 'not_applicable',
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS worktree_cleanup_leases (
        worktree_path TEXT PRIMARY KEY,
        owner_pid INTEGER NOT NULL,
        acquired_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        origin TEXT NOT NULL,
        provider TEXT NOT NULL,
        session_id TEXT,
        delivery TEXT NOT NULL DEFAULT 'resume',
        native_request_id TEXT,
        question TEXT NOT NULL,
        context TEXT,
        options_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        answer TEXT,
        created_at TEXT NOT NULL,
        answered_at TEXT,
        FOREIGN KEY(task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(provider, session_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_worktree
        ON tasks(worktree_path)
        WHERE worktree_path IS NOT NULL
          AND status IN ('queued', 'running', 'cancelling');
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_session
        ON tasks(origin, provider, session_id)
        WHERE session_id IS NOT NULL
          AND status IN ('queued', 'running', 'cancelling');
      CREATE INDEX IF NOT EXISTS idx_questions_origin_status
        ON questions(origin, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_questions_task
        ON questions(task_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_questions_pending_task
        ON questions(task_id)
        WHERE status = 'pending';
      CREATE TABLE IF NOT EXISTS task_transitions (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_transitions_task
        ON task_transitions(task_id, sequence);
      CREATE TRIGGER IF NOT EXISTS trg_task_status_transition
      AFTER UPDATE OF status ON tasks
      WHEN OLD.status <> NEW.status
      BEGIN
        INSERT INTO task_transitions(task_id, from_status, to_status, occurred_at)
        VALUES (NEW.id, OLD.status, NEW.status, NEW.updated_at);
      END;
    `);
    const columns = this.db.prepare("PRAGMA table_info(tasks)").all() as Row[];
    if (!columns.some((column) => column.name === "changed_files_json")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN changed_files_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!columns.some((column) => column.name === "base_commit")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN base_commit TEXT");
    }
    if (!columns.some((column) => column.name === "artifact_status")) {
      this.db.exec(
        "ALTER TABLE tasks ADD COLUMN artifact_status TEXT NOT NULL DEFAULT 'not_applicable'",
      );
      this.db.exec(
        "UPDATE tasks SET artifact_status = CASE WHEN worktree_path IS NULL THEN 'not_applicable' WHEN patch_path IS NOT NULL THEN 'captured' ELSE 'failed' END",
      );
    }
    if (!columns.some((column) => column.name === "mcp_profile")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN mcp_profile TEXT NOT NULL DEFAULT 'none'");
    }
    if (!columns.some((column) => column.name === "transcript_path")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN transcript_path TEXT");
    }
    if (!columns.some((column) => column.name === "pending_question_id")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN pending_question_id TEXT");
    }
    if (!columns.some((column) => column.name === "initiative_id")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN initiative_id TEXT");
    }
    if (!columns.some((column) => column.name === "swarm_id")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN swarm_id TEXT");
    }
    if (!columns.some((column) => column.name === "swarm_member_id")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN swarm_member_id TEXT");
    }
    if (!columns.some((column) => column.name === "peer_causal_root")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN peer_causal_root TEXT");
    }
    if (!columns.some((column) => column.name === "peer_causal_path_json")) {
      this.db.exec(
        "ALTER TABLE tasks ADD COLUMN peer_causal_path_json TEXT NOT NULL DEFAULT '[]'",
      );
    }
    if (!columns.some((column) => column.name === "actual_model")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN actual_model TEXT");
    }
    if (!columns.some((column) => column.name === "actual_effort")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN actual_effort TEXT");
    }
    if (!columns.some((column) => column.name === "fallback_count")) {
      this.db.exec(
        "ALTER TABLE tasks ADD COLUMN fallback_count INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!columns.some((column) => column.name === "fallback_reason")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN fallback_reason TEXT");
    }
    const questionColumns = this.db.prepare("PRAGMA table_info(questions)").all() as Row[];
    if (!questionColumns.some((column) => column.name === "delivery")) {
      this.db.exec(
        "ALTER TABLE questions ADD COLUMN delivery TEXT NOT NULL DEFAULT 'resume'",
      );
    }
    if (!questionColumns.some((column) => column.name === "native_request_id")) {
      this.db.exec("ALTER TABLE questions ADD COLUMN native_request_id TEXT");
    }
    this.recoverOrphans();
    this.lastRecoveryAt = Date.now();
  }

  close(): void {
    this.db.close();
  }

  insert(task: TaskRecord): void {
    const values = Object.keys(COLUMN_BY_FIELD).map((field) => {
      if (field === "changedFiles") return JSON.stringify(task.changedFiles);
      if (field === "peerCausalPath") {
        return JSON.stringify(task.peerCausalPath ?? []);
      }
      if (field === "fallbackCount") return task.fallbackCount ?? 0;
      const value = task[field as keyof TaskRecord] as string | number | null | undefined;
      return value === undefined ? null : value;
    });
    const columns = Object.values(COLUMN_BY_FIELD);
    const placeholders = columns.map(() => "?").join(", ");
    this.db
      .prepare(`INSERT INTO tasks (${columns.join(", ")}) VALUES (${placeholders})`)
      .run(...values);
    this.db
      .prepare(
        `INSERT INTO task_transitions(task_id, from_status, to_status, occurred_at)
         VALUES (?, NULL, ?, ?)`,
      )
      .run(task.id, task.status, task.createdAt);
  }

  insertIfBelowLimit(task: TaskRecord, limit: number): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let replacementTaskId: string | null = null;
      if (task.parentTaskId) {
        const replacement = this.db
          .prepare(
            `SELECT id FROM tasks
             WHERE id = ? AND origin = ? AND provider = ?
               AND session_id = ? AND status = 'resuming'`,
          )
          .get(task.parentTaskId, task.origin, task.provider, task.sessionId) as
          | Row
          | undefined;
        replacementTaskId = replacement ? asString(replacement.id) : null;
      }
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM tasks
           WHERE (
             status IN ('queued', 'running', 'cancelling', 'resuming')
             OR (
               status = 'waiting_for_input'
               AND EXISTS (
                 SELECT 1 FROM questions
                 WHERE questions.id = tasks.pending_question_id
                   AND questions.delivery = 'native'
               )
             )
           )
           AND (? IS NULL OR id <> ?)`,
        )
        .get(replacementTaskId, replacementTaskId) as Row;
      if (Number(row.count) >= limit) {
        this.db.exec("ROLLBACK");
        return false;
      }
      if (task.worktreePath) {
        const cleanupLease = this.db
          .prepare(
            "SELECT 1 AS found FROM worktree_cleanup_leases WHERE worktree_path = ?",
          )
          .get(task.worktreePath) as Row | undefined;
        if (cleanupLease) {
          throw new Error("Worktree is currently leased for cleanup.");
        }
      }
      this.insert(task);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  update(id: string, patch: Partial<TaskRecord>): TaskRecord {
    const entries = Object.entries(patch).filter(([field]) => field !== "id");
    if (entries.length === 0) return this.require(id);

    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [field, value] of entries) {
      const column = COLUMN_BY_FIELD[field as keyof TaskRecord];
      if (!column) throw new Error(`Unsupported task field: ${field}`);
      assignments.push(`${column} = ?`);
      values.push(
        field === "changedFiles" || field === "peerCausalPath"
          ? JSON.stringify(value ?? [])
          : (value as string | number | null),
      );
    }
    if (!("updatedAt" in patch)) {
      assignments.push("updated_at = ?");
      values.push(new Date().toISOString());
    }
    values.push(id);
    this.db.prepare(`UPDATE tasks SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
    return this.require(id);
  }

  updateIfStatus(
    id: string,
    expected: TaskStatus[],
    patch: Partial<TaskRecord>,
  ): TaskRecord | undefined {
    if (expected.length === 0) return undefined;
    const entries = Object.entries(patch).filter(([field]) => field !== "id");
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [field, value] of entries) {
      const column = COLUMN_BY_FIELD[field as keyof TaskRecord];
      if (!column) throw new Error(`Unsupported task field: ${field}`);
      assignments.push(`${column} = ?`);
      values.push(
        field === "changedFiles"
          ? JSON.stringify(value)
          : (value as string | number | null),
      );
    }
    if (!("updatedAt" in patch)) {
      assignments.push("updated_at = ?");
      values.push(new Date().toISOString());
    }
    values.push(id, ...expected);
    const placeholders = expected.map(() => "?").join(", ");
    const result = this.db
      .prepare(
        `UPDATE tasks SET ${assignments.join(", ")} WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(...values);
    return result.changes > 0 ? this.require(id) : undefined;
  }

  get(id: string): TaskRecord | undefined {
    this.refreshOrphans();
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToTask(row) : undefined;
  }

  require(id: string): TaskRecord {
    const task = this.get(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    return task;
  }

  findBySession(
    origin: TaskRecord["origin"],
    provider: Provider,
    sessionId: string,
  ): TaskRecord | undefined {
    this.refreshOrphans();
    const row = this.db
      .prepare(
        "SELECT * FROM tasks WHERE origin = ? AND provider = ? AND session_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(origin, provider, sessionId) as Row | undefined;
    return row ? rowToTask(row) : undefined;
  }

  tasksBySession(origin: Origin, provider: Provider, sessionId: string): TaskRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM tasks WHERE origin = ? AND provider = ? AND session_id = ? ORDER BY created_at ASC",
      )
      .all(origin, provider, sessionId) as Row[];
    return rows.map(rowToTask);
  }

  tasksByInitiative(origin: Origin, initiativeId: string): TaskRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE origin = ? AND initiative_id = ?
         ORDER BY created_at ASC`,
      )
      .all(origin, initiativeId) as Row[];
    return rows.map(rowToTask);
  }

  latestChildTask(origin: Origin, parentTaskId: string): TaskRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE origin = ? AND parent_task_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(origin, parentTaskId) as Row | undefined;
    return row ? rowToTask(row) : undefined;
  }

  createQuestion(input: {
    taskId: string;
    origin: Origin;
    provider: Provider;
    sessionId: string | null;
    question: string;
    context?: string;
    options?: string[];
  }): QuestionRecord {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO questions (
          id, task_id, origin, provider, session_id, delivery, native_request_id,
          question, context, options_json, status, answer, created_at, answered_at
        ) VALUES (?, ?, ?, ?, ?, 'resume', NULL, ?, ?, ?, 'pending', NULL, ?, NULL)`,
      )
      .run(
        id,
        input.taskId,
        input.origin,
        input.provider,
        input.sessionId,
        input.question,
        input.context ?? null,
        JSON.stringify(input.options ?? []),
        createdAt,
      );
    return this.requireQuestion(id);
  }

  createQuestionAndWait(input: {
    taskId: string;
    origin: Origin;
    provider: Provider;
    sessionId: string | null;
    question: string;
    context?: string;
    options?: string[];
    resultPath: string | null;
    patchPath: string | null;
    changedFiles: string[];
    artifactStatus: TaskRecord["artifactStatus"];
  }): { question: QuestionRecord; task: TaskRecord } {
    this.db.exec("BEGIN IMMEDIATE");
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO questions (
            id, task_id, origin, provider, session_id, delivery, native_request_id,
            question, context, options_json, status, answer, created_at, answered_at
          ) VALUES (?, ?, ?, ?, ?, 'resume', NULL, ?, ?, ?, 'pending', NULL, ?, NULL)`,
        )
        .run(
          id,
          input.taskId,
          input.origin,
          input.provider,
          input.sessionId,
          input.question,
          input.context ?? null,
          JSON.stringify(input.options ?? []),
          createdAt,
        );
      const taskResult = this.db
        .prepare(
          `UPDATE tasks
           SET status = 'waiting_for_input', result_path = ?, patch_path = ?,
               changed_files_json = ?, artifact_status = ?,
               pending_question_id = ?, pid = NULL, completed_at = NULL,
               updated_at = ?
           WHERE id = ? AND origin = ? AND status IN ('queued', 'running')`,
        )
        .run(
          input.resultPath,
          input.patchPath,
          JSON.stringify(input.changedFiles),
          input.artifactStatus,
          id,
          createdAt,
          input.taskId,
          input.origin,
        );
      if (taskResult.changes !== 1) {
        throw new Error("Task state changed before question could be recorded.");
      }
      this.db.exec("COMMIT");
      return {
        question: this.requireQuestion(id),
        task: this.require(input.taskId),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createNativeQuestionAndWait(input: {
    taskId: string;
    origin: Origin;
    provider: Provider;
    sessionId: string;
    nativeRequestId: string;
    question: string;
    context?: string;
    options?: string[];
  }): { question: QuestionRecord; task: TaskRecord } {
    this.db.exec("BEGIN IMMEDIATE");
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO questions (
            id, task_id, origin, provider, session_id, delivery, native_request_id,
            question, context, options_json, status, answer, created_at, answered_at
          ) VALUES (?, ?, ?, ?, ?, 'native', ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
        )
        .run(
          id,
          input.taskId,
          input.origin,
          input.provider,
          input.sessionId,
          input.nativeRequestId,
          input.question,
          input.context ?? null,
          JSON.stringify(input.options ?? []),
          createdAt,
        );
      const taskResult = this.db
        .prepare(
          `UPDATE tasks
           SET status = 'waiting_for_input', pending_question_id = ?, updated_at = ?
           WHERE id = ? AND origin = ? AND owner_pid = ?
             AND status = 'running' AND pending_question_id IS NULL`,
        )
        .run(id, createdAt, input.taskId, input.origin, process.pid);
      if (taskResult.changes !== 1) {
        throw new Error("Task state changed before native question could be recorded.");
      }
      this.db.exec("COMMIT");
      return {
        question: this.requireQuestion(id),
        task: this.require(input.taskId),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getQuestion(id: string): QuestionRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM questions WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? rowToQuestion(row) : undefined;
  }

  requireQuestion(id: string): QuestionRecord {
    const question = this.getQuestion(id);
    if (!question) throw new Error(`Unknown question: ${id}`);
    return question;
  }

  listQuestions(options: {
    origin: Origin;
    taskId?: string;
    status?: QuestionStatus;
    limit: number;
  }): QuestionRecord[] {
    const clauses = ["origin = ?"];
    const values: Array<string | number> = [options.origin];
    if (options.taskId) {
      clauses.push("task_id = ?");
      values.push(options.taskId);
    }
    if (options.status) {
      clauses.push("status = ?");
      values.push(options.status);
    }
    values.push(options.limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM questions WHERE ${clauses.join(
          " AND ",
        )} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...values) as Row[];
    return rows.map(rowToQuestion);
  }

  answerQuestion(id: string, origin: Origin, answer: string): QuestionRecord {
    const answeredAt = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE questions
         SET status = 'answered', answer = ?, answered_at = ?
         WHERE id = ? AND origin = ? AND status = 'pending'`,
      )
      .run(answer, answeredAt, id, origin);
    if (result.changes === 0) {
      const current = this.requireQuestion(id);
      if (current.origin !== origin) throw new Error("Question belongs to another mesh origin.");
      throw new Error(`Question is not pending: ${current.status}`);
    }
    return this.requireQuestion(id);
  }

  claimQuestionAnswer(
    id: string,
    origin: Origin,
    answer: string,
  ): {
    delivery: QuestionDelivery;
    question: QuestionRecord;
    task: TaskRecord;
  } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const questionRow = this.db
        .prepare("SELECT * FROM questions WHERE id = ?")
        .get(id) as Row | undefined;
      if (!questionRow) throw new Error(`Unknown question: ${id}`);
      const question = rowToQuestion(questionRow);
      if (question.origin !== origin) throw new Error("Question belongs to another mesh origin.");
      if (question.status !== "pending") {
        throw new Error(`Question is not pending: ${question.status}`);
      }
      const taskRow = this.db
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get(question.taskId) as Row | undefined;
      if (!taskRow) throw new Error(`Unknown task: ${question.taskId}`);
      const task = rowToTask(taskRow);
      if (
        task.origin !== origin ||
        task.status !== "waiting_for_input" ||
        task.pendingQuestionId !== id
      ) {
        throw new Error("Question is not the active blocker for this task.");
      }
      const answeredAt = new Date().toISOString();
      const nativeDelivery =
        question.delivery === "native" && isProcessAlive(task.ownerPid);
      this.db
        .prepare(
          `UPDATE questions
           SET status = 'answered', answer = ?, answered_at = ?,
               delivery = ?
           WHERE id = ?`,
        )
        .run(answer, answeredAt, nativeDelivery ? "native" : "resume", id);
      if (!nativeDelivery) {
        this.db
          .prepare(
            `UPDATE tasks
             SET status = 'resuming', owner_pid = ?, pid = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(process.pid, answeredAt, task.id);
      }
      this.db.exec("COMMIT");
      return {
        delivery: nativeDelivery ? "native" : "resume",
        question: this.requireQuestion(id),
        task: this.require(task.id),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeNativeQuestionDelivery(
    taskId: string,
    questionId: string,
    origin: Origin,
  ): TaskRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const questionResult = this.db
        .prepare(
          `SELECT 1 AS found FROM questions
           WHERE id = ? AND task_id = ? AND origin = ? AND delivery = 'native'
             AND status = 'answered'`,
        )
        .get(questionId, taskId, origin) as Row | undefined;
      const taskResult = this.db
        .prepare(
          `UPDATE tasks
           SET status = 'running', pending_question_id = NULL, updated_at = ?
           WHERE id = ? AND origin = ? AND owner_pid = ?
             AND status = 'waiting_for_input' AND pending_question_id = ?`,
        )
        .run(new Date().toISOString(), taskId, origin, process.pid, questionId);
      if (!questionResult || taskResult.changes !== 1) {
        throw new Error("Native question delivery is no longer active.");
      }
      this.db.exec("COMMIT");
      return this.require(taskId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  rollbackNativeQuestionDelivery(
    taskId: string,
    questionId: string,
    origin: Origin,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.db
        .prepare(
          `SELECT 1 AS found FROM tasks
           WHERE id = ? AND origin = ? AND owner_pid = ?
             AND status = 'waiting_for_input' AND pending_question_id = ?`,
        )
        .get(taskId, origin, process.pid, questionId) as Row | undefined;
      if (task) {
        this.db
          .prepare(
            `UPDATE questions
             SET status = 'pending', answer = NULL, answered_at = NULL
             WHERE id = ? AND origin = ? AND delivery = 'native'
               AND status = 'answered'`,
          )
          .run(questionId, origin);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  expireNativeQuestion(taskId: string, questionId: string, origin: Origin): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const questionResult = this.db
        .prepare(
          `UPDATE questions
           SET status = 'dismissed', answered_at = ?
           WHERE id = ? AND task_id = ? AND origin = ?
             AND delivery = 'native' AND status = 'pending'`,
        )
        .run(now, questionId, taskId, origin);
      if (questionResult.changes !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const taskResult = this.db
        .prepare(
          `UPDATE tasks
           SET status = 'running', pending_question_id = NULL, updated_at = ?
           WHERE id = ? AND origin = ? AND owner_pid = ?
             AND status = 'waiting_for_input' AND pending_question_id = ?`,
        )
        .run(now, taskId, origin, process.pid, questionId);
      if (taskResult.changes !== 1) {
        throw new Error("Native question task changed before timeout.");
      }
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recoverNativeQuestionForResume(input: {
    taskId: string;
    questionId: string;
    origin: Origin;
    error: string;
    patchPath: string | null;
    changedFiles: string[];
    artifactStatus: TaskRecord["artifactStatus"];
  }): { question: QuestionRecord; task: TaskRecord } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const questionResult = this.db
        .prepare(
          `UPDATE questions
           SET delivery = 'resume', status = 'pending',
               answer = NULL, answered_at = NULL
           WHERE id = ? AND task_id = ? AND origin = ?
             AND delivery = 'native' AND status IN ('pending', 'answered')`,
        )
        .run(input.questionId, input.taskId, input.origin);
      const taskResult = this.db
        .prepare(
          `UPDATE tasks
           SET status = 'waiting_for_input', pid = NULL, error = ?,
               patch_path = ?, changed_files_json = ?, artifact_status = ?,
               updated_at = ?
           WHERE id = ? AND origin = ? AND owner_pid = ?
             AND status = 'waiting_for_input' AND pending_question_id = ?`,
        )
        .run(
          input.error,
          input.patchPath,
          JSON.stringify(input.changedFiles),
          input.artifactStatus,
          now,
          input.taskId,
          input.origin,
          process.pid,
          input.questionId,
        );
      if (questionResult.changes !== 1 || taskResult.changes !== 1) {
        throw new Error("Native question could not be recovered for session resume.");
      }
      this.db.exec("COMMIT");
      return {
        question: this.requireQuestion(input.questionId),
        task: this.require(input.taskId),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeQuestionHandoff(taskId: string, questionId: string, origin: Origin): TaskRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `UPDATE tasks
           SET status = 'completed', pending_question_id = NULL,
               completed_at = ?, updated_at = ?
           WHERE id = ? AND origin = ? AND status = 'resuming'
             AND pending_question_id = ?`,
        )
        .run(new Date().toISOString(), new Date().toISOString(), taskId, origin, questionId);
      if (result.changes !== 1) throw new Error("Question handoff task is no longer resumable.");
      this.db.exec("COMMIT");
      return this.require(taskId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  rollbackQuestionResume(taskId: string, questionId: string, origin: Origin): TaskRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const questionResult = this.db
        .prepare(
          `UPDATE questions
           SET status = 'pending', answer = NULL, answered_at = NULL
           WHERE id = ? AND origin = ? AND status = 'answered'`,
        )
        .run(questionId, origin);
      const taskResult = this.db
        .prepare(
          `UPDATE tasks
           SET status = 'waiting_for_input', owner_pid = ?, updated_at = ?
           WHERE id = ? AND origin = ? AND status = 'resuming'
             AND pending_question_id = ?`,
        )
        .run(process.pid, new Date().toISOString(), taskId, origin, questionId);
      if (questionResult.changes !== 1 || taskResult.changes !== 1) {
        throw new Error("Unable to rollback question resume claim.");
      }
      this.db.exec("COMMIT");
      return this.require(taskId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  cancelWaitingTask(
    taskId: string,
    origin: Origin,
  ): { task: TaskRecord; native: boolean } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const taskRow = this.db
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get(taskId) as Row | undefined;
      if (!taskRow) throw new Error(`Unknown task: ${taskId}`);
      const task = rowToTask(taskRow);
      if (task.origin !== origin) throw new Error("Task belongs to another mesh origin.");
      if (task.status !== "waiting_for_input") {
        throw new Error(`Task is not waiting for input: ${task.status}`);
      }
      const questionRow = task.pendingQuestionId
        ? (this.db
            .prepare("SELECT * FROM questions WHERE id = ?")
            .get(task.pendingQuestionId) as Row | undefined)
        : undefined;
      const question = questionRow ? rowToQuestion(questionRow) : undefined;
      const native =
        question?.delivery === "native" && isProcessAlive(task.ownerPid);
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE questions
           SET status = 'dismissed', answered_at = ?
           WHERE task_id = ? AND origin = ? AND status IN ('pending', 'answered')`,
        )
        .run(now, taskId, origin);
      if (native) {
        this.db
          .prepare(
            `UPDATE tasks
             SET status = 'cancelling', error = ?,
                 pending_question_id = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run("Cancellation requested while waiting for parent input.", now, taskId);
      } else {
        this.db
          .prepare(
            `UPDATE tasks
             SET status = 'cancelled', error = ?,
                 pending_question_id = NULL, pid = NULL,
                 completed_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run("Cancelled while waiting for parent input.", now, now, taskId);
      }
      this.db.exec("COMMIT");
      return { task: this.require(taskId), native };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  restorePendingQuestion(id: string, origin: Origin): QuestionRecord {
    const result = this.db
      .prepare(
        `UPDATE questions
         SET status = 'pending', answer = NULL, answered_at = NULL
         WHERE id = ? AND origin = ? AND status = 'answered'`,
      )
      .run(id, origin);
    if (result.changes === 0) throw new Error("Unable to restore pending question.");
    return this.requireQuestion(id);
  }

  dismissPendingQuestions(taskId: string, origin: Origin): void {
    this.db
      .prepare(
        `UPDATE questions
         SET status = 'dismissed', answered_at = ?
         WHERE task_id = ? AND origin = ? AND status = 'pending'`,
      )
      .run(new Date().toISOString(), taskId, origin);
  }

  settleActiveTask(
    taskId: string,
    origin: Origin,
    expected: TaskStatus[],
    patch: Partial<TaskRecord>,
  ): TaskRecord | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get(taskId) as Row | undefined;
      if (!row) throw new Error(`Unknown task: ${taskId}`);
      const task = rowToTask(row);
      if (task.origin !== origin) throw new Error("Task belongs to another mesh origin.");
      if (!expected.includes(task.status)) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE questions
           SET status = 'dismissed', answered_at = ?
           WHERE task_id = ? AND origin = ? AND delivery = 'native'
             AND status IN ('pending', 'answered')`,
        )
        .run(now, taskId, origin);
      const settled = this.updateIfStatus(taskId, expected, {
        ...patch,
        pendingQuestionId: null,
      });
      if (!settled) throw new Error("Task changed while settling provider state.");
      this.db.exec("COMMIT");
      return this.require(taskId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  search(options: {
    origin: TaskRecord["origin"];
    query?: string;
    provider?: Provider;
    status?: TaskStatus;
    limit: number;
  }): TaskRecord[] {
    this.refreshOrphans();
    const clauses: string[] = ["origin = ?"];
    const values: Array<string | number> = [options.origin];
    if (options.query) {
      clauses.push(
        "(description LIKE ? ESCAPE '\\' OR session_id LIKE ? ESCAPE '\\' OR cwd LIKE ? ESCAPE '\\' OR model LIKE ? ESCAPE '\\')",
      );
      const escaped = options.query.replace(/[\\%_]/g, "\\$&");
      const pattern = `%${escaped}%`;
      values.push(pattern, pattern, pattern, pattern);
    }
    if (options.provider) {
      clauses.push("provider = ?");
      values.push(options.provider);
    }
    if (options.status) {
      clauses.push("status = ?");
      values.push(options.status);
    }
    values.push(options.limit);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...values) as Row[];
    return rows.map(rowToTask);
  }

  transitions(taskId: string): Array<{
    sequence: number;
    taskId: string;
    fromStatus: TaskStatus | null;
    toStatus: TaskStatus;
    occurredAt: string;
  }> {
    return (
      this.db
        .prepare(
          `SELECT sequence, task_id, from_status, to_status, occurred_at
           FROM task_transitions WHERE task_id = ? ORDER BY sequence ASC`,
        )
        .all(taskId) as Row[]
    ).map((row) => ({
      sequence: Number(row.sequence),
      taskId: asString(row.task_id),
      fromStatus: row.from_status ? (asString(row.from_status) as TaskStatus) : null,
      toStatus: asString(row.to_status) as TaskStatus,
      occurredAt: asString(row.occurred_at),
    }));
  }

  activeCount(): number {
    this.refreshOrphans();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM tasks
         WHERE status IN ('queued', 'running', 'cancelling', 'resuming')
            OR (
              status = 'waiting_for_input'
              AND EXISTS (
                SELECT 1 FROM questions
                WHERE questions.id = tasks.pending_question_id
                  AND questions.delivery = 'native'
              )
            )`,
      )
      .get() as Row;
    return Number(row.count);
  }

  activePids(): number[] {
    this.refreshOrphans();
    const rows = this.db
      .prepare(
        `SELECT DISTINCT pid FROM tasks
         WHERE pid IS NOT NULL
           AND (
             status IN ('running', 'cancelling')
             OR (
               status = 'waiting_for_input'
               AND EXISTS (
                 SELECT 1 FROM questions
                 WHERE questions.id = tasks.pending_question_id
                   AND questions.delivery = 'native'
               )
             )
           )`,
      )
      .all() as Row[];
    return rows.map((row) => Number(row.pid)).filter((pid) => Number.isInteger(pid) && pid > 1);
  }

  hasActiveWorktreeReference(worktreePath: string, excludingTaskId?: string): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM tasks
         WHERE worktree_path = ?
           AND status IN (
             'queued', 'running', 'cancelling', 'waiting_for_input', 'resuming'
           )
           AND (? IS NULL OR id <> ?)`,
      )
      .get(worktreePath, excludingTaskId ?? null, excludingTaskId ?? null) as Row;
    return Number(row.count) > 0;
  }

  clearWorktreeReferences(worktreePath: string): void {
    this.db
      .prepare(
        "UPDATE tasks SET worktree_path = NULL, updated_at = ? WHERE worktree_path = ?",
      )
      .run(new Date().toISOString(), worktreePath);
  }

  acquireCleanupLease(worktreePath: string, excludingTaskId: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const active = this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM tasks
           WHERE worktree_path = ?
             AND status IN (
               'queued', 'running', 'cancelling', 'waiting_for_input', 'resuming'
             )
             AND id <> ?`,
        )
        .get(worktreePath, excludingTaskId) as Row;
      if (Number(active.count) > 0) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const unsafeArtifacts = this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM tasks
           WHERE worktree_path = ?
             AND artifact_status NOT IN ('clean', 'captured')`,
        )
        .get(worktreePath) as Row;
      if (Number(unsafeArtifacts.count) > 0) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db
        .prepare(
          "INSERT INTO worktree_cleanup_leases (worktree_path, owner_pid, acquired_at) VALUES (?, ?, ?)",
        )
        .run(worktreePath, process.pid, new Date().toISOString());
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (String(error).includes("UNIQUE constraint failed")) return false;
      throw error;
    }
  }

  releaseCleanupLease(worktreePath: string): void {
    this.db
      .prepare(
        "DELETE FROM worktree_cleanup_leases WHERE worktree_path = ? AND owner_pid = ?",
      )
      .run(worktreePath, process.pid);
  }

  private recoverOrphans(): void {
    const leases = this.db
      .prepare("SELECT worktree_path, owner_pid FROM worktree_cleanup_leases")
      .all() as Row[];
    const deleteLease = this.db.prepare(
      "DELETE FROM worktree_cleanup_leases WHERE worktree_path = ?",
    );
    for (const lease of leases) {
      if (!isProcessAlive(Number(lease.owner_pid))) {
        deleteLease.run(asString(lease.worktree_path));
      }
    }
    // Matching only native delivery stranded tasks permanently: the first
    // recovery converted a dead owner's question to resume delivery and claimed
    // it, and when that server also exited the task no longer matched, so its
    // owner was never refreshed again. Reclaim any waiting task whose owner is
    // gone, whatever its delivery mode.
    const nativeWaiting = this.db
      .prepare(
        `SELECT tasks.id, tasks.owner_pid, tasks.pending_question_id
         FROM tasks
         JOIN questions ON questions.id = tasks.pending_question_id
         WHERE tasks.status = 'waiting_for_input'
           AND questions.status IN ('pending', 'answered')`,
      )
      .all() as Row[];
    for (const task of nativeWaiting) {
      if (isProcessAlive(Number(task.owner_pid))) continue;
      const questionId = nullableString(task.pending_question_id);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (questionId) {
          this.db
            .prepare(
              `UPDATE questions
               SET delivery = 'resume', status = 'pending',
                   answer = NULL, answered_at = NULL
               WHERE id = ? AND delivery = 'native'
                 AND status IN ('pending', 'answered')`,
            )
            .run(questionId);
        }
        this.db
          .prepare(
            `UPDATE tasks
             SET owner_pid = ?, pid = NULL, updated_at = ?
             WHERE id = ? AND status = 'waiting_for_input'`,
          )
          .run(process.pid, new Date().toISOString(), asString(task.id));
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    const resuming = this.db
      .prepare(
        "SELECT id, owner_pid, pending_question_id FROM tasks WHERE status = 'resuming'",
      )
      .all() as Row[];
    for (const task of resuming) {
      if (isProcessAlive(Number(task.owner_pid))) continue;
      const questionId = nullableString(task.pending_question_id);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (questionId) {
          this.db
            .prepare(
              `UPDATE questions
               SET status = 'pending', answer = NULL, answered_at = NULL
               WHERE id = ? AND status = 'answered'`,
            )
            .run(questionId);
        }
        this.db
          .prepare(
            `UPDATE tasks
             SET status = 'waiting_for_input', owner_pid = ?,
                 updated_at = ?
             WHERE id = ? AND status = 'resuming'`,
          )
          .run(process.pid, new Date().toISOString(), asString(task.id));
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    const rows = this.db
      .prepare(
        "SELECT id, owner_pid, status FROM tasks WHERE status IN ('queued', 'running', 'cancelling')",
      )
      .all() as Row[];
    const now = new Date().toISOString();
    const mark = this.db.prepare(
      "UPDATE tasks SET status = 'interrupted', error = ?, updated_at = ?, completed_at = ? WHERE id = ?",
    );
    const markCancelled = this.db.prepare(
      "UPDATE tasks SET status = 'cancelled', error = ?, pid = NULL, updated_at = ?, completed_at = ? WHERE id = ?",
    );
    for (const row of rows) {
      const ownerPid = Number(row.owner_pid);
      if (!isProcessAlive(ownerPid)) {
        if (asString(row.status) === "cancelling") {
          markCancelled.run("Cancelled after the owning mesh process exited.", now, now, asString(row.id));
        } else {
          mark.run("Owning mesh process exited before task completion.", now, now, asString(row.id));
        }
      }
    }
    // A task that died mid-flight keeps artifact_status 'pending' forever, which
    // reads as "capture still in progress" long after nothing is running. The
    // worktree is retained, so the work is still recoverable by hand; say that
    // plainly instead of leaving a state no code will ever advance.
    this.db
      .prepare(
        `UPDATE tasks SET artifact_status = 'failed', updated_at = ?
         WHERE artifact_status = 'pending'
           AND status IN ('failed', 'cancelled', 'interrupted')`,
      )
      .run(now);
  }

  private refreshOrphans(): void {
    const now = Date.now();
    if (now - this.lastRecoveryAt < 1_000) return;
    this.recoverOrphans();
    this.lastRecoveryAt = now;
  }
}
