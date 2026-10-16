import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { stateDirectory } from "./security.js";
import {
  cleanupWorktree,
  prepareWorktree,
  verifyWorktreeArtifacts,
} from "./worktree.js";
import type { Origin, Provider } from "./types.js";
import type { TaskRegistry } from "./registry.js";
import type { TaskTrafficGate } from "./router.js";
import type {
  OrchestrationPresetName,
  WorkspaceStrategy,
} from "./orchestration-presets.js";

type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "");

export interface InitiativeRecord {
  id: string;
  origin: Origin;
  name: string;
  objective: string;
  preset: OrchestrationPresetName;
  strategy: WorkspaceStrategy;
  sourceCwd: string;
  repoRoot: string;
  worktreePath: string;
  effectiveCwd: string;
  baseCommit: string;
  status: "active" | "closed";
  writerTaskId: string | null;
  writerProvider: Provider | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export class InitiativeRegistry {
  private readonly db: DatabaseSync;
  private readonly tasks?: TaskRegistry;
  private readonly trafficGate?: TaskTrafficGate;

  constructor(
    readonly origin: Origin,
    readonly path = join(stateDirectory(), "initiatives.db"),
    tasks?: TaskRegistry,
    trafficGate?: TaskTrafficGate,
  ) {
    this.tasks = tasks;
    this.trafficGate = trafficGate;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS initiatives (
        id TEXT PRIMARY KEY, origin TEXT NOT NULL, name TEXT NOT NULL,
        objective TEXT NOT NULL, preset TEXT NOT NULL, strategy TEXT NOT NULL,
        source_cwd TEXT NOT NULL, repo_root TEXT NOT NULL,
        worktree_path TEXT NOT NULL, effective_cwd TEXT NOT NULL,
        base_commit TEXT NOT NULL, status TEXT NOT NULL,
        writer_task_id TEXT, writer_provider TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_initiatives_origin
        ON initiatives(origin, updated_at DESC);
    `);
    if (tasks) this.recoverWriters(tasks);
  }

  close(): void {
    this.db.close();
  }

  async create(input: {
    name: string;
    objective: string;
    cwd: string;
    preset: OrchestrationPresetName;
    strategy: WorkspaceStrategy;
    baseRef?: string;
  }): Promise<InitiativeRecord> {
    const id = randomUUID();
    const prepared = await prepareWorktree(input.cwd, `initiative-${id}`, input.baseRef);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO initiatives (
          id, origin, name, objective, preset, strategy, source_cwd,
          repo_root, worktree_path, effective_cwd, base_commit, status,
          writer_task_id, writer_provider, created_at, updated_at, closed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?, ?, NULL)`,
      )
      .run(
        id,
        this.origin,
        input.name.slice(0, 160),
        input.objective.slice(0, 8_000),
        input.preset,
        input.strategy,
        input.cwd,
        prepared.repoRoot,
        prepared.worktreePath,
        prepared.effectiveCwd,
        prepared.baseCommit,
        now,
        now,
      );
    return this.get(id);
  }

  get(id: string): InitiativeRecord {
    const row = this.db
      .prepare("SELECT * FROM initiatives WHERE id = ? AND origin = ?")
      .get(id, this.origin) as Row | undefined;
    if (!row) throw new Error(`Unknown initiative: ${id}`);
    return {
      id,
      origin: this.origin,
      name: text(row.name),
      objective: text(row.objective),
      preset: text(row.preset) as OrchestrationPresetName,
      strategy: text(row.strategy) as WorkspaceStrategy,
      sourceCwd: text(row.source_cwd),
      repoRoot: text(row.repo_root),
      worktreePath: text(row.worktree_path),
      effectiveCwd: text(row.effective_cwd),
      baseCommit: text(row.base_commit),
      status: text(row.status) as "active" | "closed",
      writerTaskId: row.writer_task_id ? text(row.writer_task_id) : null,
      writerProvider: row.writer_provider ? (text(row.writer_provider) as Provider) : null,
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
      closedAt: row.closed_at ? text(row.closed_at) : null,
    };
  }

  list(limit = 100): InitiativeRecord[] {
    return (
      this.db
        .prepare("SELECT id FROM initiatives WHERE origin = ? ORDER BY updated_at DESC LIMIT ?")
        .all(this.origin, Math.min(Math.max(limit, 1), 1_000)) as Row[]
    ).map((row) => this.get(text(row.id)));
  }

  acquireWriter(id: string, taskId: string, provider: Provider): InitiativeRecord {
    const result = this.db
      .prepare(
        `UPDATE initiatives SET writer_task_id = ?, writer_provider = ?, updated_at = ?
         WHERE id = ? AND origin = ? AND status = 'active' AND writer_task_id IS NULL`,
      )
      .run(taskId, provider, new Date().toISOString(), id, this.origin);
    if (result.changes !== 1) throw new Error("Initiative already has an active writer.");
    return this.get(id);
  }

  releaseWriter(id: string, taskId: string): InitiativeRecord {
    const result = this.db
      .prepare(
        `UPDATE initiatives SET writer_task_id = NULL, writer_provider = NULL, updated_at = ?
         WHERE id = ? AND origin = ? AND writer_task_id = ?`,
      )
      .run(new Date().toISOString(), id, this.origin, taskId);
    if (result.changes !== 1) {
      const initiative = this.get(id);
      if (initiative.writerTaskId === null) return initiative;
      throw new Error("Task does not own the initiative writer lease.");
    }
    return this.get(id);
  }

  transferWriter(id: string, fromTaskId: string, toTaskId: string): InitiativeRecord {
    const result = this.db
      .prepare(
        `UPDATE initiatives SET writer_task_id = ?, updated_at = ?
         WHERE id = ? AND origin = ? AND status = 'active' AND writer_task_id = ?`,
      )
      .run(toTaskId, new Date().toISOString(), id, this.origin, fromTaskId);
    if (result.changes !== 1) throw new Error("Writer lease transfer failed.");
    return this.get(id);
  }

  async closeInitiative(id: string): Promise<InitiativeRecord> {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE initiatives SET status = 'closed', closed_at = ?, updated_at = ?
         WHERE id = ? AND origin = ? AND status = 'active' AND writer_task_id IS NULL`,
      )
      .run(now, now, id, this.origin);
    if (result.changes !== 1) {
      const initiative = this.get(id);
      if (initiative.status === "closed") return initiative;
      throw new Error("Initiative still has an active writer.");
    }
    return this.get(id);
  }

  async discardCleanInitiative(id: string): Promise<InitiativeRecord> {
    const initiative = this.get(id);
    const cleanupId = randomUUID();
    if (
      this.tasks &&
      !this.tasks.acquireCleanupLease(initiative.worktreePath, "")
    ) {
      throw new Error(
        "Cannot discard an initiative worktree with an active task or cleanup lease.",
      );
    }
    let trafficReserved = false;
    try {
      await this.trafficGate?.reserveCleanupPath?.(
        initiative.worktreePath,
        cleanupId,
      );
      trafficReserved = true;
      await verifyWorktreeArtifacts(
        initiative.worktreePath,
        initiative.baseCommit,
        "clean",
        null,
      );
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          `UPDATE initiatives SET status = 'closed', closed_at = ?, updated_at = ?
           WHERE id = ? AND origin = ? AND status = 'active' AND writer_task_id IS NULL`,
        )
        .run(now, now, id, this.origin);
      if (result.changes !== 1) {
        throw new Error(
          "Clean initiative acquired a writer before it could be discarded.",
        );
      }
      try {
        await cleanupWorktree(initiative.repoRoot, initiative.worktreePath);
      } catch (error) {
        const restoredAt = new Date().toISOString();
        const restored = this.db
          .prepare(
            `UPDATE initiatives
             SET status = 'active', closed_at = NULL, updated_at = ?
             WHERE id = ? AND origin = ? AND status = 'closed'
               AND closed_at = ? AND writer_task_id IS NULL`,
          )
          .run(restoredAt, id, this.origin, now);
        if (restored.changes !== 1) {
          throw new Error(
            "Initiative cleanup failed and its active state could not be restored.",
            { cause: error },
          );
        }
        throw error;
      }
      return this.get(id);
    } finally {
      if (trafficReserved) {
        this.trafficGate?.releaseCleanupPath?.(cleanupId);
      }
      this.tasks?.releaseCleanupLease(initiative.worktreePath);
    }
  }

  private recoverWriters(tasks: TaskRegistry): void {
    const rows = this.db
      .prepare(
        `SELECT id, writer_task_id FROM initiatives
         WHERE origin = ? AND status = 'active' AND writer_task_id IS NOT NULL`,
      )
      .all(this.origin) as Row[];
    for (const row of rows) {
      const taskId = text(row.writer_task_id);
      const task = tasks.get(taskId);
      if (
        !task ||
        task.origin !== this.origin ||
        ["completed", "failed", "cancelled", "interrupted"].includes(task.status)
      ) {
        this.db
          .prepare(
            `UPDATE initiatives SET writer_task_id = NULL, writer_provider = NULL,
             updated_at = ? WHERE id = ? AND writer_task_id = ?`,
          )
          .run(new Date().toISOString(), text(row.id), taskId);
      }
    }
  }
}
