import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { redactSecrets, stateDirectory } from "./security.js";

// MESH[2026-07-25T22:20Z][agent:cursor-parent][direction:user/8]
// What: turns mesh task completion into a message submitted to the parent chat.
// Why: an MCP server cannot push into a Cursor conversation, and neither the CLI
//   nor the SDK can post into an open composer. The `stop` hook's
//   followup_message is the one documented path that submits text as the next
//   user message, so completion is delivered at the turn boundary instead of the
//   parent polling. It fires only when something actually finished, because
//   re-engaging with no news would burn turns for nothing.
// Aligns-with: direction user revision 8 (notify the parent shell).
// Status: complete

const TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;
const MAX_REPORTED = 8;
const MAX_DESCRIPTION = 120;
const DEFAULT_LOOP_BUDGET = 3;

export interface StopHookPayload {
  status?: string;
  loop_count?: number;
  conversation_id?: string;
  workspace_roots?: string[];
}

export interface StopHookOutcome {
  followupMessage?: string;
  reason:
    | "no-mesh-state"
    | "baseline-recorded"
    | "nothing-new"
    | "loop-budget-exhausted"
    | "reported"
    | "awaiting";
}

interface FinishedTask {
  id: string;
  provider: string;
  description: string;
  status: string;
  error: string | null;
  completedAt: string;
  cwd: string;
  repoRoot: string | null;
}

// MESH[2026-07-25T22:25Z][agent:cursor-parent][direction:user/13]
// What: only reports work belonging to the conversation's own workspace.
// Why: the first version reported every finished task to every conversation.
//   A session working on an unrelated repository was interrupted with a report
//   about this tool's own review tasks and correctly ignored it, which is pure
//   noise and exactly the turn-burning the watermark was meant to prevent.
//   A control window that dispatches across repositories can opt back in.
// Aligns-with: direction user revision 13 (hook fired for another repo).
// Status: complete
function withinWorkspace(
  task: Pick<FinishedTask, "cwd" | "repoRoot">,
  roots: readonly string[],
): boolean {
  if (roots.length === 0) return true;
  return roots.some((root) => {
    const base = resolve(root);
    return [task.repoRoot, task.cwd].some((candidate) => {
      if (!candidate) return false;
      const target = resolve(candidate);
      return target === base || target.startsWith(`${base}/`);
    });
  });
}

function workspaceRoots(payload: StopHookPayload): string[] {
  if (process.env.AGENT_MESH_STOP_HOOK_ALL_REPOS === "1") return [];
  const declared = Array.isArray(payload.workspace_roots)
    ? payload.workspace_roots.filter(
        (root): root is string => typeof root === "string" && root.length > 0,
      )
    : [];
  if (declared.length > 0) return declared;
  const projectDir = process.env.CURSOR_PROJECT_DIR;
  return projectDir ? [projectDir] : [];
}

function stateFile(conversationId: string): string {
  const safe = /^[A-Za-z0-9._-]{1,128}$/u.test(conversationId)
    ? conversationId
    : "default";
  return join(stateDirectory(), "stop-hook", `${safe}.json`);
}

function readLastSeen(path: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      lastSeen?: unknown;
    };
    return typeof parsed.lastSeen === "string" ? parsed.lastSeen : undefined;
  } catch {
    return undefined;
  }
}

// Records why the hook did or did not speak. Scoping fails open when the editor
// supplies no workspace root, so without this the difference between "nothing
// finished" and "could not tell whose work this was" is invisible.
function writeLastSeen(
  path: string,
  lastSeen: string,
  decision?: { reason: string; roots: readonly string[]; reported: number },
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    `${JSON.stringify({
      lastSeen,
      ...(decision
        ? {
            lastDecision: {
              at: new Date().toISOString(),
              reason: decision.reason,
              scopedToRoots: decision.roots.length > 0,
              roots: decision.roots.slice(0, 8),
              reported: decision.reported,
            },
          }
        : {}),
    })}\n`,
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
}

function finishedSince(
  meshPath: string,
  since: string,
): { tasks: FinishedTask[]; running: number; latest: string } {
  const db = new DatabaseSync(meshPath, { readOnly: true });
  try {
    const placeholders = TERMINAL_STATUSES.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT id, provider, description, status, error, completed_at, cwd, repo_root
         FROM tasks
         WHERE status IN (${placeholders}) AND completed_at IS NOT NULL
           AND completed_at > ?
         ORDER BY completed_at ASC`,
      )
      .all(...TERMINAL_STATUSES, since) as Array<Record<string, unknown>>;
    const running = Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS live FROM tasks WHERE status IN ('queued', 'running')",
          )
          .get() as Record<string, unknown>
      ).live ?? 0,
    );
    const latestRow = db
      .prepare("SELECT MAX(completed_at) AS latest FROM tasks")
      .get() as Record<string, unknown>;
    return {
      tasks: rows.map((row) => ({
        id: String(row.id ?? ""),
        provider: String(row.provider ?? "unknown"),
        description: String(row.description ?? "task"),
        status: String(row.status ?? "unknown"),
        error: row.error === null || row.error === undefined ? null : String(row.error),
        completedAt: String(row.completed_at ?? ""),
        cwd: String(row.cwd ?? ""),
        repoRoot:
          row.repo_root === null || row.repo_root === undefined
            ? null
            : String(row.repo_root),
      })),
      running,
      latest: typeof latestRow.latest === "string" ? latestRow.latest : since,
    };
  } finally {
    db.close();
  }
}

function describe(task: FinishedTask): string {
  const description = redactSecrets(task.description).slice(0, MAX_DESCRIPTION);
  const detail =
    task.status === "completed"
      ? ""
      : ` - ${redactSecrets(task.error ?? "no detail").slice(0, 160)}`;
  return `- ${task.id.slice(0, 8)} (${task.provider}) ${task.status}: ${description}${detail}`;
}

export function runStopHook(
  payload: StopHookPayload,
  options: {
    meshPath?: string;
    loopBudget?: number;
    waitForRunning?: boolean;
    workspaceRoots?: string[];
  } = {},
): StopHookOutcome {
  const meshPath = options.meshPath ?? resolve(stateDirectory(), "mesh.db");
  if (!existsSync(meshPath)) return { reason: "no-mesh-state" };

  const path = stateFile(payload.conversation_id ?? "default");
  const lastSeen = readLastSeen(path);
  const nowIso = new Date().toISOString();
  if (!lastSeen) {
    // First turn in this conversation: establish a baseline rather than
    // replaying every historical completion.
    writeLastSeen(path, nowIso);
    return { reason: "baseline-recorded" };
  }

  const { tasks: allFinished, running, latest } = finishedSince(meshPath, lastSeen);
  const roots = options.workspaceRoots ?? workspaceRoots(payload);
  // Always advance past other repositories' work so it is never replayed here.
  const tasks = allFinished.filter((task) => withinWorkspace(task, roots));
  const budget = options.loopBudget ?? DEFAULT_LOOP_BUDGET;
  if (tasks.length === 0) {
    writeLastSeen(path, latest > lastSeen ? latest : lastSeen, {
      reason:
        allFinished.length > 0 ? "filtered-other-workspace" : "nothing-finished",
      roots,
      reported: 0,
    });
    // Completion that lands while the session is idle would otherwise never be
    // seen, because this hook only runs at a turn boundary. Waiting keeps the
    // parent attached to work it dispatched. Off by default: it spends turns,
    // and a human who has moved on should not be dragged back.
    const waitEnabled =
      (options.waitForRunning ?? process.env.AGENT_MESH_STOP_HOOK_WAIT === "1") &&
      running > 0 &&
      (payload.loop_count ?? 0) < budget;
    if (waitEnabled) {
      return {
        reason: "awaiting",
        followupMessage: [
          `${running} delegated mesh task${running === 1 ? " is" : "s are"} still running and nothing has finished yet.`,
          "Wait for the next completion instead of polling: run a bounded shell watcher that exits as soon as a result file appears, then report what finished.",
          "If you have unrelated work that does not touch what those agents are editing, do that first and let the watcher notify you.",
        ].join("\n"),
      };
    }
    return { reason: "nothing-new" };
  }

  if ((payload.loop_count ?? 0) >= budget) {
    // Record the watermark anyway so the same completions are not replayed
    // once the human speaks again.
    writeLastSeen(path, latest);
    return { reason: "loop-budget-exhausted" };
  }

  writeLastSeen(path, latest, {
    reason: roots.length > 0 ? "reported-in-workspace" : "reported-unscoped",
    roots,
    reported: tasks.length,
  });
  const shown = tasks.slice(0, MAX_REPORTED);
  const omitted = tasks.length - shown.length;
  const lines = [
    `${tasks.length} delegated mesh task${tasks.length === 1 ? "" : "s"} finished while you were working:`,
    ...shown.map(describe),
    ...(omitted > 0 ? [`- and ${omitted} more`] : []),
    running > 0
      ? `${running} task${running === 1 ? " is" : "s are"} still running.`
      : "No mesh tasks are still running.",
    "Collect the results, act on anything that needs it, and report what changed. If none of this is relevant to what you were doing, say so briefly and stop.",
  ];
  return { followupMessage: lines.join("\n"), reason: "reported" };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  let payload: StopHookPayload = {};
  try {
    payload = JSON.parse(await readStdin()) as StopHookPayload;
  } catch {
    // A malformed payload must never block the agent loop.
  }
  const outcome = runStopHook(payload);
  if (outcome.followupMessage) {
    process.stdout.write(
      `${JSON.stringify({ followup_message: outcome.followupMessage })}\n`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]).endsWith("stop-hook-cli.js")) {
  main()
    .catch(() => undefined)
    // The agent loop must continue even when this hook fails.
    .finally(() => process.exit(0));
}
