import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  PatchPromotionService,
  type PatchPromotionRecord,
} from "../src/patch-promotion.js";
import type { Origin, TaskRecord } from "../src/types.js";

const execFileAsync = promisify(execFile);

interface Fixture {
  root: string;
  targetRepo: string;
  delegatedRepo: string;
  stateDirectory: string;
  artifactsDirectory: string;
  storeDirectory: string;
  patchPath: string;
  baseCommit: string;
  task: TaskRecord;
  tasks: Map<string, TaskRecord>;
  service: PatchPromotionService;
}

async function gitRaw(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await gitRaw(cwd, args)).trimEnd();
}

function serviceFor(
  fixture: Fixture,
  origin: Origin = "cursor",
  overrides: Partial<ConstructorParameters<typeof PatchPromotionService>[0]> = {},
): PatchPromotionService {
  return new PatchPromotionService({
    origin,
    taskLookup: fixture.tasks,
    storeDirectory: fixture.storeDirectory,
    artifactsDirectory: fixture.artifactsDirectory,
    allowedRoots: [fixture.root],
    ...overrides,
  });
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-mesh-promotion-"));
  const targetRepo = join(root, "target");
  const delegatedRepo = join(root, "delegated");
  const stateDirectory = join(root, "state");
  const artifactsDirectory = join(stateDirectory, "tasks");
  const storeDirectory = join(stateDirectory, "promotions");
  const taskId = `task-${randomUUID()}`;
  const taskDirectory = join(artifactsDirectory, taskId);
  const patchPath = join(taskDirectory, "changes.patch");

  await mkdir(targetRepo, { mode: 0o700 });
  await git(targetRepo, ["init", "--quiet"]);
  await git(targetRepo, ["config", "user.name", "Patch Promotion Tests"]);
  await git(targetRepo, ["config", "user.email", "patch-promotion@example.test"]);
  await git(targetRepo, ["config", "core.autocrlf", "false"]);
  await writeFile(join(targetRepo, "hello.txt"), "before\n", "utf8");
  await git(targetRepo, ["add", "hello.txt"]);
  await git(targetRepo, ["commit", "--quiet", "-m", "base"]);
  const baseCommit = await git(targetRepo, ["rev-parse", "HEAD"]);

  await git(root, ["clone", "--config", "core.autocrlf=false", "--quiet", targetRepo, delegatedRepo]);
  await writeFile(join(delegatedRepo, "hello.txt"), "after\n", "utf8");
  const patch = await gitRaw(delegatedRepo, [
    "diff",
    "--binary",
    "--no-ext-diff",
    "--no-textconv",
    baseCommit,
    "--",
  ]);
  expect(patch.endsWith("\n")).toBe(true);

  await mkdir(taskDirectory, { recursive: true, mode: 0o700 });
  await chmod(stateDirectory, 0o700);
  await chmod(artifactsDirectory, 0o700);
  await chmod(taskDirectory, 0o700);
  await writeFile(patchPath, patch, { mode: 0o600 });
  await chmod(patchPath, 0o600);
  const finalizedAt = new Date().toISOString();
  const task: TaskRecord = {
    id: taskId,
    origin: "cursor",
    provider: "codex",
    description: "Update the greeting",
    mode: "implement",
    status: "completed",
    cwd: targetRepo,
    effectiveCwd: delegatedRepo,
    repoRoot: targetRepo,
    worktreePath: delegatedRepo,
    baseCommit,
    model: null,
    effort: null,
    mcpProfile: "none",
    sessionId: null,
    parentTaskId: null,
    ownerPid: process.pid,
    pid: null,
    resultPath: null,
    eventsPath: null,
    transcriptPath: null,
    pendingQuestionId: null,
    patchPath,
    changedFiles: ["hello.txt"],
    artifactStatus: "captured",
    error: null,
    createdAt: finalizedAt,
    updatedAt: finalizedAt,
    completedAt: finalizedAt,
  };
  const tasks = new Map([[task.id, task]]);
  const fixture = {
    root,
    targetRepo,
    delegatedRepo,
    stateDirectory,
    artifactsDirectory,
    storeDirectory,
    patchPath,
    baseCommit,
    task,
    tasks,
    service: undefined as unknown as PatchPromotionService,
  };
  fixture.service = serviceFor(fixture);
  return fixture;
}

async function replaceCapturedPatch(
  fixture: Fixture,
  patch: string,
  changedFiles: string[],
): Promise<void> {
  await writeFile(fixture.patchPath, patch, "utf8");
  await chmod(fixture.patchPath, 0o600);
  fixture.task.worktreePath = null;
  fixture.task.changedFiles = changedFiles;
  const finalizedAt = new Date().toISOString();
  fixture.task.updatedAt = finalizedAt;
  fixture.task.completedAt = finalizedAt;
}

async function cleanup(fixture: Fixture): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true });
}

function confirmation(record: PatchPromotionRecord): string {
  return `ROLLBACK ${record.id}`;
}

describe("production-safe patch promotion", { timeout: 20000 }, () => {
  it("previews, applies without committing, persists privately, and safely rolls back", async () => {
    const fixture = await createFixture();
    try {
      const preview = await fixture.service.preview({
        taskId: fixture.task.id,
        targetRepo: fixture.targetRepo,
      });
      expect(preview).toMatchObject({
        taskId: fixture.task.id,
        origin: "cursor",
        baseCommit: fixture.baseCommit,
        affectedPaths: ["hello.txt"],
        requiredConfirmation: `APPLY ${fixture.task.id}`,
        activePromotionId: null,
      });
      expect(preview.targetRepo).toBe(await realpath(fixture.targetRepo));
      expect(preview.patchSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(preview.preStatus.clean).toBe(true);

      await expect(
        fixture.service.apply({
          taskId: fixture.task.id,
          targetRepo: fixture.targetRepo,
          confirmation: `APPLY ${fixture.task.id} `,
        }),
      ).rejects.toMatchObject({
        code: "CONFIRMATION_REQUIRED",
        requiredConfirmation: `APPLY ${fixture.task.id}`,
      });
      expect(await git(fixture.targetRepo, ["status", "--porcelain=v1"])).toBe("");

      const applied = await fixture.service.apply({
        taskId: fixture.task.id,
        targetRepo: fixture.targetRepo,
        confirmation: `APPLY ${fixture.task.id}`,
      });
      expect(applied).toMatchObject({
        state: "applied",
        rollbackState: "available",
        patchSha256: preview.patchSha256,
        preStatus: { clean: true },
        postStatus: { clean: false },
      });
      expect(await readFile(join(fixture.targetRepo, "hello.txt"), "utf8")).toBe("after\n");
      expect(await git(fixture.targetRepo, ["rev-parse", "HEAD"])).toBe(
        fixture.baseCommit,
      );
      expect(await git(fixture.targetRepo, ["diff", "--cached", "--name-only"])).toBe("");

      const recordPath = join(
        fixture.storeDirectory,
        "records",
        applied.id,
        "record.json",
      );
      const storedPatchPath = join(
        fixture.storeDirectory,
        "records",
        applied.id,
        "patch.patch",
      );
      expect((await stat(recordPath)).mode & 0o777).toBe(
        process.platform === "win32" ? 0o666 : 0o600,
      );
      expect((await stat(storedPatchPath)).mode & 0o777).toBe(
        process.platform === "win32" ? 0o444 : 0o400,
      );
      expect((await stat(join(fixture.storeDirectory, "records", applied.id))).mode & 0o777).toBe(
        process.platform === "win32" ? 0o666 : 0o700,
      );
      expect(await fixture.service.listPromotions()).toEqual([
        expect.objectContaining({ id: applied.id, state: "applied" }),
      ]);

      await writeFile(join(fixture.targetRepo, "unrelated.txt"), "do not remove\n", "utf8");
      await expect(
        fixture.service.rollback({
          promotionId: applied.id,
          confirmation: confirmation(applied),
        }),
      ).rejects.toMatchObject({ code: "ROLLBACK_UNSAFE" });
      expect(await readFile(join(fixture.targetRepo, "hello.txt"), "utf8")).toBe("after\n");
      await rm(join(fixture.targetRepo, "unrelated.txt"));

      const rolledBack = await fixture.service.rollback({
        promotionId: applied.id,
        confirmation: confirmation(applied),
      });
      expect(rolledBack).toMatchObject({
        state: "rolled_back",
        rollbackState: "rolled_back",
      });
      expect(await readFile(join(fixture.targetRepo, "hello.txt"), "utf8")).toBe(
        "before\n",
      );
      expect(await git(fixture.targetRepo, ["status", "--porcelain=v1"])).toBe("");
      expect(await git(fixture.targetRepo, ["rev-parse", "HEAD"])).toBe(
        fixture.baseCommit,
      );
    } finally {
      await cleanup(fixture);
    }
  });

  it("promotes into a dirty target when the affected paths are untouched", async () => {
    // Unrelated dirt is safe: only the paths this patch touches have to be pristine.
    const dirty = await createFixture();
    try {
      await writeFile(join(dirty.targetRepo, "untracked.txt"), "dirty\n", "utf8");
      const preview = await dirty.service.preview({
        taskId: dirty.task.id,
        targetRepo: dirty.targetRepo,
      });
      expect(preview.affectedPaths).toContain("hello.txt");
    } finally {
      await cleanup(dirty);
    }
  });

  it("refuses when an affected path is itself dirty and names it", async () => {
    const conflicting = await createFixture();
    try {
      await writeFile(
        join(conflicting.targetRepo, "hello.txt"),
        "locally edited\n",
        "utf8",
      );
      await expect(
        conflicting.service.preview({
          taskId: conflicting.task.id,
          targetRepo: conflicting.targetRepo,
        }),
      ).rejects.toMatchObject({ code: "DIRTY_TARGET" });
    } finally {
      await cleanup(conflicting);
    }
  });

  it("promotes after unrelated commits moved HEAD", async () => {
    const moved = await createFixture();
    try {
      await git(moved.targetRepo, [
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "move HEAD",
      ]);
      const preview = await moved.service.preview({
        taskId: moved.task.id,
        targetRepo: moved.targetRepo,
      });
      expect(preview.affectedPaths).toContain("hello.txt");
    } finally {
      await cleanup(moved);
    }
  });

  it("rejects rollback after a same-file edit that preserves porcelain status", async () => {
    const fixture = await createFixture();
    try {
      const applied = await fixture.service.apply({
        taskId: fixture.task.id,
        targetRepo: fixture.targetRepo,
        confirmation: `APPLY ${fixture.task.id}`,
      });
      const recordedStatus = applied.postStatus?.porcelainV1Z;
      await writeFile(
        join(fixture.targetRepo, "hello.txt"),
        "after\nsame-file user edit\n",
        "utf8",
      );
      expect(
        (
          await execFileAsync(
            "git",
            ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            { cwd: fixture.targetRepo, encoding: "utf8" },
          )
        ).stdout,
      ).toBe(recordedStatus);

      await expect(
        fixture.service.rollback({
          promotionId: applied.id,
          confirmation: confirmation(applied),
        }),
      ).rejects.toMatchObject({ code: "ROLLBACK_UNSAFE" });
      expect((await fixture.service.store.get(applied.id))?.state).toBe("applied");
      expect(await readFile(join(fixture.targetRepo, "hello.txt"), "utf8")).toContain(
        "same-file user edit",
      );

      await writeFile(join(fixture.targetRepo, "hello.txt"), "after\n", "utf8");
      await expect(
        fixture.service.rollback({
          promotionId: applied.id,
          confirmation: confirmation(applied),
        }),
      ).resolves.toMatchObject({ state: "rolled_back" });
    } finally {
      await cleanup(fixture);
    }
  });

  it("never marks a partially reversed promotion applied after postcondition failure", async () => {
    const fixture = await createFixture();
    try {
      const applied = await fixture.service.apply({
        taskId: fixture.task.id,
        targetRepo: fixture.targetRepo,
        confirmation: `APPLY ${fixture.task.id}`,
      });
      const internals = fixture.service as unknown as {
        checkedGit: (
          operation: string,
          args: readonly string[],
          cwd: string,
          input?: Buffer,
        ) => Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
          stdout: Buffer;
          stderr: string;
        }>;
      };
      const checkedGit = internals.checkedGit.bind(fixture.service);
      internals.checkedGit = async (operation, args, cwd, input) => {
        if (operation === "reverse apply") {
          await writeFile(
            join(fixture.targetRepo, "hello.txt"),
            "before\npartial reverse residue\n",
            "utf8",
          );
          return {
            code: 0,
            signal: null,
            stdout: Buffer.alloc(0),
            stderr: "",
          };
        }
        return checkedGit(operation, args, cwd, input);
      };

      await expect(
        fixture.service.rollback({
          promotionId: applied.id,
          confirmation: confirmation(applied),
        }),
      ).rejects.toMatchObject({ code: "ROLLBACK_UNSAFE" });
      expect(await fixture.service.store.get(applied.id)).toMatchObject({
        state: "needs_attention",
        rollbackState: "needs_attention",
        operationPhase: "needs_attention",
        recoveryState: "needs_attention",
      });
      expect((await fixture.service.store.get(applied.id))?.state).not.toBe(
        "applied",
      );
    } finally {
      await cleanup(fixture);
    }
  }, 15_000);

  it("detects source artifact tampering after preview", async () => {
    const fixture = await createFixture();
    try {
      await fixture.service.preview({
        taskId: fixture.task.id,
        targetRepo: fixture.targetRepo,
      });
      const patch = await readFile(fixture.patchPath, "utf8");
      await writeFile(fixture.patchPath, patch.replace("+after", "+tampered"), "utf8");
      await chmod(fixture.patchPath, 0o600);

      await expect(
        fixture.service.apply({
          taskId: fixture.task.id,
          targetRepo: fixture.targetRepo,
          confirmation: `APPLY ${fixture.task.id}`,
        }),
      ).rejects.toMatchObject({ code: "ARTIFACT_UNSAFE" });
      expect(await readFile(join(fixture.targetRepo, "hello.txt"), "utf8")).toBe(
        "before\n",
      );
      expect(await fixture.service.listPromotions()).toEqual([]);
    } finally {
      await cleanup(fixture);
    }
  });

  it("rejects duplicate application of the same active promotion", async () => {
    const fixture = await createFixture();
    try {
      const input = {
        taskId: fixture.task.id,
        targetRepo: fixture.targetRepo,
        confirmation: `APPLY ${fixture.task.id}`,
      };
      const first = await fixture.service.apply(input);
      await expect(fixture.service.apply(input)).rejects.toMatchObject({
        code: "DUPLICATE",
      });
      expect((await fixture.service.listPromotions()).map((record) => record.id)).toEqual([
        first.id,
      ]);
    } finally {
      await cleanup(fixture);
    }
  });

  it("recovers an apply crash before mutation and permits a safe retry", async () => {
    const fixture = await createFixture();
    try {
      const applied = await fixture.service.apply({
        taskId: fixture.task.id,
        targetRepo: fixture.targetRepo,
        confirmation: `APPLY ${fixture.task.id}`,
      });
      const rolledBack = await fixture.service.rollback({
        promotionId: applied.id,
        confirmation: confirmation(applied),
      });
      await fixture.service.store.save({
        ...rolledBack,
        state: "applying",
        rollbackState: "not_available",
        operationPhase: "apply_prepared",
        recoveryState: "pending",
        postStatus: null,
        postFingerprint: null,
        appliedAt: null,
        rollbackStartedAt: null,
        rolledBackAt: null,
        error: null,
      });

      const restarted = serviceFor(fixture);
      const report = await restarted.recoverPromotions();
      expect(report).toMatchObject({
        scanned: 1,
        pending: [],
        needsAttention: [],
      });
      expect(report.recovered[0]).toMatchObject({
        id: applied.id,
        state: "failed",
        operationPhase: "stable_failed",
        recoveryState: "recovered_not_applied",
      });

      const retry = await restarted.apply({
        taskId: fixture.task.id,
        targetRepo: fixture.targetRepo,
        confirmation: `APPLY ${fixture.task.id}`,
      });
      expect(retry).toMatchObject({
        state: "applied",
        recoveryState: "none",
      });
      expect(retry.id).not.toBe(applied.id);
    } finally {
      await cleanup(fixture);
    }
  });

  it("recovers an apply crash after Git mutation but before final store save", async () => {
    const fixture = await createFixture();
    try {
      const applied = await fixture.service.apply({
        taskId: fixture.task.id,
        targetRepo: fixture.targetRepo,
        confirmation: `APPLY ${fixture.task.id}`,
      });
      await fixture.service.store.save({
        ...applied,
        state: "applying",
        rollbackState: "not_available",
        operationPhase: "apply_mutating",
        recoveryState: "pending",
        postStatus: null,
        postFingerprint: null,
        appliedAt: null,
        error: null,
      });

      const restarted = serviceFor(fixture);
      const [recovered] = await restarted.listPromotions();
      expect(recovered).toMatchObject({
        id: applied.id,
        state: "applied",
        rollbackState: "available",
        operationPhase: "stable_applied",
        recoveryState: "recovered_applied",
      });
      expect(recovered?.postFingerprint?.sha256).toBe(
        recovered?.expectedPostFingerprint.sha256,
      );
      await expect(
        restarted.rollback({
          promotionId: applied.id,
          confirmation: confirmation(applied),
        }),
      ).resolves.toMatchObject({ state: "rolled_back" });
    } finally {
      await cleanup(fixture);
    }
  });

  it("recovers rollback crashes before and after reverse mutation", async () => {
    const beforeMutation = await createFixture();
    try {
      const applied = await beforeMutation.service.apply({
        taskId: beforeMutation.task.id,
        targetRepo: beforeMutation.targetRepo,
        confirmation: `APPLY ${beforeMutation.task.id}`,
      });
      await beforeMutation.service.store.save({
        ...applied,
        state: "rolling_back",
        rollbackState: "in_progress",
        operationPhase: "rollback_prepared",
        recoveryState: "pending",
        rollbackStartedAt: new Date().toISOString(),
      });
      const restarted = serviceFor(beforeMutation);
      const report = await restarted.recoverPromotions();
      expect(report.recovered[0]).toMatchObject({
        state: "applied",
        rollbackState: "available",
        recoveryState: "recovered_applied",
      });
      await expect(
        restarted.rollback({
          promotionId: applied.id,
          confirmation: confirmation(applied),
        }),
      ).resolves.toMatchObject({ state: "rolled_back" });
    } finally {
      await cleanup(beforeMutation);
    }

    const afterMutation = await createFixture();
    try {
      const applied = await afterMutation.service.apply({
        taskId: afterMutation.task.id,
        targetRepo: afterMutation.targetRepo,
        confirmation: `APPLY ${afterMutation.task.id}`,
      });
      const rolledBack = await afterMutation.service.rollback({
        promotionId: applied.id,
        confirmation: confirmation(applied),
      });
      await afterMutation.service.store.save({
        ...rolledBack,
        state: "rolling_back",
        rollbackState: "in_progress",
        operationPhase: "rollback_mutating",
        recoveryState: "pending",
        rolledBackAt: null,
      });
      const restarted = serviceFor(afterMutation);
      const report = await restarted.recoverPromotions();
      expect(report.recovered[0]).toMatchObject({
        state: "rolled_back",
        rollbackState: "rolled_back",
        operationPhase: "stable_rolled_back",
        recoveryState: "recovered_rolled_back",
      });
      expect(await git(afterMutation.targetRepo, ["status", "--porcelain=v1"])).toBe("");
    } finally {
      await cleanup(afterMutation);
    }
  });

  it("never recovers state=applied after a partial reverse mutation", async () => {
    const fixture = await createFixture();
    try {
      const applied = await fixture.service.apply({
        taskId: fixture.task.id,
        targetRepo: fixture.targetRepo,
        confirmation: `APPLY ${fixture.task.id}`,
      });
      await fixture.service.store.save({
        ...applied,
        state: "rolling_back",
        rollbackState: "in_progress",
        operationPhase: "rollback_mutating",
        recoveryState: "pending",
        rollbackStartedAt: new Date().toISOString(),
      });
      await writeFile(
        join(fixture.targetRepo, "hello.txt"),
        "before\npartial reverse residue\n",
        "utf8",
      );

      const restarted = serviceFor(fixture);
      const report = await restarted.recoverPromotions();
      expect(report.needsAttention).toEqual([applied.id]);
      expect(report.recovered[0]).toMatchObject({
        state: "needs_attention",
        rollbackState: "needs_attention",
        operationPhase: "needs_attention",
        recoveryState: "needs_attention",
      });
      expect(report.recovered[0]?.state).not.toBe("applied");
    } finally {
      await cleanup(fixture);
    }
  });

  it("enforces task, list, and rollback ownership by mesh origin", async () => {
    const fixture = await createFixture();
    try {
      const otherOrigin = serviceFor(fixture, "codex");
      await expect(
        otherOrigin.preview({
          taskId: fixture.task.id,
          targetRepo: fixture.targetRepo,
        }),
      ).rejects.toMatchObject({ code: "ORIGIN_MISMATCH" });

      const applied = await fixture.service.apply({
        taskId: fixture.task.id,
        targetRepo: fixture.targetRepo,
        confirmation: `APPLY ${fixture.task.id}`,
      });
      expect(await otherOrigin.listPromotions()).toEqual([]);
      await expect(
        otherOrigin.rollback({
          promotionId: applied.id,
          confirmation: confirmation(applied),
        }),
      ).rejects.toMatchObject({ code: "ORIGIN_MISMATCH" });
    } finally {
      await cleanup(fixture);
    }
  });

  it("rejects escaping paths, symlink traversal, binary patches, and oversized artifacts", async () => {
    const escaping = await createFixture();
    try {
      await replaceCapturedPatch(
        escaping,
        [
          "diff --git a/../../escaped.txt b/../../escaped.txt",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/../../escaped.txt",
          "@@ -0,0 +1 @@",
          "+escaped",
          "",
        ].join("\n"),
        ["../../escaped.txt"],
      );
      await expect(
        escaping.service.preview({
          taskId: escaping.task.id,
          targetRepo: escaping.targetRepo,
        }),
      ).rejects.toMatchObject({ code: "PATCH_INVALID" });
      await expect(access(join(escaping.root, "escaped.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await cleanup(escaping);
    }

    const linked = await createFixture();
    try {
      const outside = join(linked.root, "outside");
      await mkdir(outside, { mode: 0o700 });
      await symlink(outside, join(linked.targetRepo, "linked"));
      await replaceCapturedPatch(
        linked,
        [
          "diff --git a/linked/escaped.txt b/linked/escaped.txt",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/linked/escaped.txt",
          "@@ -0,0 +1 @@",
          "+escaped",
          "",
        ].join("\n"),
        ["linked/escaped.txt"],
      );
      await expect(
        linked.service.preview({
          taskId: linked.task.id,
          targetRepo: linked.targetRepo,
        }),
      ).rejects.toMatchObject({ code: "PATCH_INVALID" });
      await expect(access(join(outside, "escaped.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await cleanup(linked);
    }

    const binary = await createFixture();
    try {
      await replaceCapturedPatch(
        binary,
        [
          "diff --git a/image.bin b/image.bin",
          "new file mode 100644",
          "index 0000000..1111111",
          "GIT binary patch",
          "literal 1",
          "AcmZQz00001",
          "",
        ].join("\n"),
        ["image.bin"],
      );
      await expect(
        binary.service.preview({
          taskId: binary.task.id,
          targetRepo: binary.targetRepo,
        }),
      ).rejects.toMatchObject({ code: "PATCH_INVALID" });
    } finally {
      await cleanup(binary);
    }

    const oversized = await createFixture();
    try {
      oversized.task.worktreePath = null;
      const constrained = serviceFor(oversized, "cursor", { maxPatchBytes: 64 });
      await expect(
        constrained.preview({
          taskId: oversized.task.id,
          targetRepo: oversized.targetRepo,
        }),
      ).rejects.toMatchObject({ code: "ARTIFACT_UNSAFE" });
    } finally {
      await cleanup(oversized);
    }
  });

  it("serializes concurrent apply attempts with an atomic repository lock", async () => {
    const fixture = await createFixture();
    try {
      const firstService = serviceFor(fixture);
      const secondService = serviceFor(fixture);
      const input = {
        taskId: fixture.task.id,
        targetRepo: fixture.targetRepo,
        confirmation: `APPLY ${fixture.task.id}`,
      };
      const results = await Promise.allSettled([
        firstService.apply(input),
        secondService.apply(input),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(rejected).toBeDefined();
      expect(["LOCKED", "DUPLICATE", "DIRTY_TARGET", "ARTIFACT_UNSAFE"]).toContain(
        (rejected?.reason as { code?: string }).code,
      );
      expect(await firstService.listPromotions()).toHaveLength(1);
    } finally {
      await cleanup(fixture);
    }
  });

  it("drains in-flight work and rejects new operations after close", async () => {
    const fixture = await createFixture();
    try {
      let releaseLookup!: () => void;
      let lookupStarted!: () => void;
      const lookupGate = new Promise<void>((resolve) => {
        releaseLookup = resolve;
      });
      const started = new Promise<void>((resolve) => {
        lookupStarted = resolve;
      });
      const service = serviceFor(fixture, "cursor", {
        taskLookup: async (taskId) => {
          lookupStarted();
          await lookupGate;
          return fixture.tasks.get(taskId);
        },
      });
      const preview = service.preview({
        taskId: fixture.task.id,
        targetRepo: fixture.targetRepo,
      });
      await started;
      expect(service.inFlightOperationCount).toBe(1);

      const closing = service.close();
      expect(service.isClosing).toBe(true);
      expect(
        await Promise.race([
          closing.then(() => "closed"),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve("still-draining"), 20),
          ),
        ]),
      ).toBe("still-draining");
      releaseLookup();
      await expect(preview).resolves.toMatchObject({ taskId: fixture.task.id });
      await closing;
      expect(service.inFlightOperationCount).toBe(0);
      await expect(
        service.preview({
          taskId: fixture.task.id,
          targetRepo: fixture.targetRepo,
        }),
      ).rejects.toMatchObject({ code: "SERVICE_CLOSING" });
    } finally {
      await cleanup(fixture);
    }
  });
});
