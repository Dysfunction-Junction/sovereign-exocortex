import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { ExocortexDatabase } from "@exocortex/core/db";
import { defaultWorldModelHost, type WorldModelHost } from "./world-model-host.js";
import { HOST_DEVICE_ID, ShadowRecorder } from "./shadow-recorder.js";
import { getDatabase } from "./db-host.js";

export interface RepoCheckoutObservationResult {
  eventId: string;
  generatedPoliciesCount: number;
  proposalIds: string[];
}

/**
 * Checks if a git repository has a clean working tree via `git status --porcelain`.
 * Excludes untracked files (`--untracked-files=no`) and avoids acquiring index locks
 * (`--no-optional-locks` and GIT_OPTIONAL_LOCKS=0) to prevent interfering with active user git commands.
 * Returns true if clean (empty porcelain output), false if tracked files are modified or staged.
 */
export async function checkRepoCleanliness(
  repoPath: string,
  options?: { timeoutMs?: number; execFileFn?: typeof execFile },
): Promise<boolean> {
  const timeout = options?.timeoutMs ?? 10_000;
  const execFn = options?.execFileFn ?? execFile;

  try {
    const s = await stat(repoPath);
    if (!s.isDirectory()) {
      throw new Error(`repository path is not a directory: ${repoPath}`);
    }
  } catch (err) {
    throw new Error(`cannot access repository path ${repoPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return new Promise((resolve, reject) => {
    execFn(
      "git",
      ["--no-optional-locks", "status", "--porcelain", "--untracked-files=no"],
      {
        cwd: repoPath,
        timeout,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout) => {
        if (error) {
          reject(new Error(`git status failed in ${repoPath}: ${error.message}`));
          return;
        }
        resolve(stdout.trim().length === 0);
      },
    );
  });
}

export interface RecordCheckoutOptions {
  repoName?: string;
  dirtyRepos?: string[];
  checkedRepos?: string[];
  host?: WorldModelHost;
  observedAt?: number;
  suppressProposals?: boolean;
}

/**
 * Persists an invariant observation for `inv_zero_broken_commits` to the SQLite event log.
 * Always updates active inference beliefs and learned parameters in the world model.
 * Proposal synthesis can be suppressed (e.g. for periodic heartbeats) to prevent calibration noise.
 */
export function recordRepoCheckoutObservation(
  isClean: boolean,
  db: ExocortexDatabase,
  options?: RecordCheckoutOptions,
): RepoCheckoutObservationResult {
  const observedAt = options?.observedAt ?? Date.now();
  const eventId = `repo-health:${randomUUID()}`;
  const wmHost = options?.host ?? defaultWorldModelHost;
  const suppressProposals = options?.suppressProposals ?? false;

  const recorder = new ShadowRecorder(db, { shadow: true });
  recorder.ensureHostDevice();

  const payload = {
    invariantId: "inv_zero_broken_commits",
    observedState: isClean,
    observedAt,
    confidence: isClean ? 1 : 0.85,
    source: "repo_health_watcher",
    factor: "repo_health",
    observation: isClean ? "clean_checkout" : "uncommitted_edits",
    ...(options?.repoName ? { repo: options.repoName } : {}),
    ...(options?.dirtyRepos && options.dirtyRepos.length > 0 ? { dirtyRepos: options.dirtyRepos } : {}),
    ...(options?.checkedRepos && options.checkedRepos.length > 0 ? { checkedRepos: options.checkedRepos } : {}),
  };

  db.ingestEvent(HOST_DEVICE_ID, {
    event_id: eventId,
    kind: "observation",
    ts_device: observedAt,
    schema_ver: 1,
    payload,
  });

  const hadRecorder = wmHost.shadowRecordingSettled;
  if (!hadRecorder && !suppressProposals) {
    wmHost.setShadowRecorder(recorder);
  }

  let evaluated: ReturnType<WorldModelHost["ingestObservation"]>;
  try {
    evaluated = wmHost.ingestObservation(
      {
        invariantId: "inv_zero_broken_commits",
        observedState: isClean,
        observedAt,
        confidence: isClean ? 1 : 0.85,
        metadata: {
          source: "repo_health_watcher",
          ...(options?.repoName ? { repo: options.repoName } : {}),
          ...(options?.dirtyRepos ? { dirtyRepos: options.dirtyRepos } : {}),
        },
      },
      { allowAutoExecute: false },
    );
  } finally {
    if (!hadRecorder && !suppressProposals) {
      wmHost.setShadowRecorder(null);
    }
  }

  return {
    eventId,
    generatedPoliciesCount: suppressProposals ? 0 : evaluated.generatedPoliciesCount,
    proposalIds: suppressProposals ? [] : evaluated.proposals.map((proposal) => proposal.id),
  };
}

export interface RepoObservationNotification {
  isClean: boolean;
  observation: "clean_checkout" | "uncommitted_edits";
  dirtyRepos: string[];
  checkedRepos: string[];
  proposalIds: string[];
  reason: "state_transition" | "heartbeat" | "initial";
}

export interface RepoHealthWatcherOptions {
  db?: ExocortexDatabase;
  getDb?: () => ExocortexDatabase;
  host?: WorldModelHost;
  repos?: string[];
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  dirtyDwellMs?: number;
  checkCleanlinessFn?: (repoPath: string) => Promise<boolean>;
  nowFn?: () => number;
  onObservation?: (event: RepoObservationNotification) => void;
  onError?: (repoPath: string, err: unknown) => void;
}

export class RepoHealthWatcher {
  private readonly db?: ExocortexDatabase;
  private readonly getDbFn?: () => ExocortexDatabase;
  private readonly host?: WorldModelHost;
  private readonly repos: string[];
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly dirtyDwellMs: number;
  private readonly checkCleanlinessFn: (repoPath: string) => Promise<boolean>;
  private readonly nowFn: () => number;
  private readonly onObservation?: (event: RepoObservationNotification) => void;
  private readonly onError?: (repoPath: string, err: unknown) => void;

  private timer: NodeJS.Timeout | null = null;
  private isChecking = false;
  private gen = 0;
  private repoStates = new Map<string, { isClean: boolean; lastCheckedAt: number; firstDirtyAt: number | null }>();
  private aggregateState: { isClean: boolean; lastReportedAt: number } | null = null;

  constructor(options: RepoHealthWatcherOptions) {
    this.db = options.db;
    this.getDbFn = options.getDb;
    this.host = options.host;
    this.repos = options.repos ?? [];
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15 * 60_000;
    this.dirtyDwellMs = options.dirtyDwellMs ?? 120_000; // 2 minutes dirty dwell debounce
    this.checkCleanlinessFn = options.checkCleanlinessFn ?? checkRepoCleanliness;
    this.nowFn = options.nowFn ?? Date.now;
    this.onObservation = options.onObservation;
    this.onError = options.onError;
  }

  private resolveDb(): ExocortexDatabase {
    if (this.db) return this.db;
    if (this.getDbFn) return this.getDbFn();
    throw new Error("RepoHealthWatcher: neither db nor getDb was provided");
  }

  public isRunning(): boolean {
    return this.timer !== null;
  }

  public getMonitoredRepos(): readonly string[] {
    return [...this.repos];
  }

  public getAggregateState(): { isClean: boolean; lastReportedAt: number } | null {
    return this.aggregateState ? { ...this.aggregateState } : null;
  }

  public getRepoState(repoPath: string): { isClean: boolean; lastCheckedAt: number; firstDirtyAt: number | null } | undefined {
    const s = this.repoStates.get(repoPath);
    return s ? { ...s } : undefined;
  }

  /**
   * Run a single pass over all monitored repositories.
   * - Aggregates cleanliness: all repos must be clean for inv_zero_broken_commits = true.
   * - Partial failure guard: if any repo check fails, the aggregate verdict is withheld (returns null).
   * - Dirty dwell debounce: uncommitted edits must persist for >= dirtyDwellMs before tripping the anomaly edge.
   * - True dirty awareness: heartbeats are skipped if any repo is currently dirty (even during dwell).
   * - Heartbeat proposal suppression: periodic heartbeats update beliefs without polluting proposal queues.
   * - Reentrancy & generation guards: check passes are safely canceled if stop() is called.
   */
  public async checkOnce(): Promise<RepoObservationNotification | null> {
    if (this.isChecking || this.repos.length === 0) return null;
    this.isChecking = true;
    const currentGen = this.gen;

    try {
      const db = this.resolveDb();
      const dirtyRepos: string[] = [];
      const checkedRepos: string[] = [];
      const failedRepos: string[] = [];
      let rawAllClean = true;

      for (const repo of this.repos) {
        if (currentGen !== this.gen) return null;
        const repoNow = this.nowFn();
        try {
          const isClean = await this.checkCleanlinessFn(repo);
          if (currentGen !== this.gen) return null;

          const repoName = path.basename(path.resolve(repo));
          checkedRepos.push(repoName);

          const previous = this.repoStates.get(repo);
          let firstDirtyAt: number | null = null;
          if (!isClean) {
            rawAllClean = false;
            firstDirtyAt = previous?.firstDirtyAt ?? repoNow;
            // Only consider dirty for proposal generation if dwell threshold has elapsed
            if (repoNow - firstDirtyAt >= this.dirtyDwellMs) {
              dirtyRepos.push(repoName);
            }
          }

          this.repoStates.set(repo, { isClean, lastCheckedAt: repoNow, firstDirtyAt });
        } catch (err) {
          failedRepos.push(repo);
          // On check error, clear firstDirtyAt to avoid stale dirty debounce across failures
          const previous = this.repoStates.get(repo);
          this.repoStates.set(repo, {
            isClean: false,
            lastCheckedAt: repoNow,
            firstDirtyAt: null,
          });
          if (this.onError) {
            this.onError(repo, err);
          } else {
            console.warn(`[repo-health] Check failed for ${repo}:`, err instanceof Error ? err.message : String(err));
          }
        }
      }

      // Partial check failure guard: withhold verdict if any repo failed
      if (failedRepos.length > 0 || checkedRepos.length === 0) {
        return null;
      }

      if (currentGen !== this.gen) return null;

      const dwelledClean = dirtyRepos.length === 0;
      const now = this.nowFn();
      let reason: RepoObservationNotification["reason"] | null = null;

      if (this.aggregateState === null) {
        reason = "initial";
      } else if (this.aggregateState.isClean !== dwelledClean) {
        reason = "state_transition";
      } else if (now - this.aggregateState.lastReportedAt >= this.heartbeatIntervalMs) {
        // Skip heartbeat if any repo is raw dirty (even during dwell), to never send false clean heartbeats
        if (!rawAllClean && dwelledClean) {
          return null;
        }
        reason = "heartbeat";
      }

      if (reason) {
        // Suppress proposal generation on heartbeats to avoid calibration noise
        const suppressProposals = reason === "heartbeat";

        const result = recordRepoCheckoutObservation(dwelledClean, db, {
          repoName: checkedRepos.length === 1 ? checkedRepos[0] : undefined,
          dirtyRepos,
          checkedRepos,
          host: this.host,
          observedAt: now,
          suppressProposals,
        });

        this.aggregateState = { isClean: dwelledClean, lastReportedAt: now };

        const notification: RepoObservationNotification = {
          isClean: dwelledClean,
          observation: dwelledClean ? "clean_checkout" : "uncommitted_edits",
          dirtyRepos,
          checkedRepos,
          proposalIds: result.proposalIds,
          reason,
        };

        this.onObservation?.(notification);
        return notification;
      }

      return null;
    } finally {
      this.isChecking = false;
    }
  }

  public start(): void {
    if (this.timer !== null || this.repos.length === 0) return;

    void this.checkOnce().catch((err) => {
      console.warn("[repo-health] initial check error:", err);
    });

    this.timer = setInterval(() => {
      void this.checkOnce().catch((err) => {
        console.warn("[repo-health] scheduled check error:", err);
      });
    }, this.pollIntervalMs);

    this.timer.unref?.();
  }

  public stop(): void {
    this.gen++;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function parseMonitoredRepos(): string[] {
  const envVal = process.env.EXOCORTEX_WATCH_REPOS;
  if (!envVal || envVal.trim().length === 0) return [];
  return envVal
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const defaultRepoHealthWatcher = new RepoHealthWatcher({
  getDb: () => getDatabase(),
  repos: parseMonitoredRepos(),
});
