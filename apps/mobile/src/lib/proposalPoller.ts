import { App as CapacitorApp } from "@capacitor/app";
import { getPendingProposals, type PendingProposal } from "./api";
import { proposalManager, type IncomingProposal } from "./proposals";

export const POLL_INTERVAL_MS = 10_000;
export const MAX_BACKOFF_MS = 120_000;

export interface ProposalPollerDeps {
  fetchPending: () => Promise<PendingProposal[]>;
  ingest: (p: IncomingProposal) => void;
  intervalMs?: number;
  maxBackoffMs?: number;
}

export interface ProposalPoller {
  /** Begin the foreground poll loop (polls immediately). No-op if already running. */
  start(): void;
  /** Stop the loop. An in-flight request is allowed to finish and still ingests. */
  stop(): void;
  /** Poll now (e.g. on a push message). Single-flight: joins an in-flight poll. Never rejects. */
  pollNow(): Promise<void>;
  isRunning(): boolean;
}

export function createProposalPoller(deps: ProposalPollerDeps): ProposalPoller {
  const intervalMs = deps.intervalMs ?? POLL_INTERVAL_MS;
  const maxBackoffMs = deps.maxBackoffMs ?? MAX_BACKOFF_MS;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<boolean> | null = null;
  let failures = 0;

  // Resolves true on success, false on failure. Never rejects.
  function pollOnce(): Promise<boolean> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const proposals = await deps.fetchPending();
        for (const p of proposals) {
          try {
            deps.ingest(p);
          } catch {
            // one bad proposal must not drop the rest
          }
        }
        failures = 0;
        return true;
      } catch {
        failures++;
        return false;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function nextDelay(): number {
    return Math.min(intervalMs * 2 ** failures, maxBackoffMs);
  }

  function schedule(delay: number) {
    if (!running) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await pollOnce();
      schedule(nextDelay());
    }, delay);
  }

  return {
    start() {
      if (running) return;
      running = true;
      void pollOnce().then(() => schedule(nextDelay()));
    },
    stop() {
      running = false;
      clearTimeout(timer);
      timer = undefined;
    },
    async pollNow() {
      await pollOnce();
    },
    isRunning: () => running,
  };
}

let shared: ProposalPoller | null = null;

/** App-wide poller wired to the real API and proposal manager. */
export function getProposalPoller(): ProposalPoller {
  shared ??= createProposalPoller({
    fetchPending: () => getPendingProposals({ includeShadow: true }),
    ingest: (p) => {
      proposalManager.ingestProposal(p);
    },
  });
  return shared;
}

/**
 * Polls while the app is foregrounded and stops when it is backgrounded. Returns a disposer.
 * Safe on web/tests: if the app plugin is unavailable it just treats the app as foregrounded.
 */
export function startForegroundProposalPolling(poller: ProposalPoller = getProposalPoller()): () => void {
  let disposed = false;
  let handle: { remove: () => Promise<void> | void } | undefined;

  poller.start();

  try {
    CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (disposed) return;
      if (isActive) poller.start();
      else poller.stop();
    })
      .then((h) => {
        if (disposed) void h.remove();
        else handle = h;
      })
      .catch(() => {});
  } catch {
    // plugin missing: keep polling while mounted
  }

  return () => {
    disposed = true;
    poller.stop();
    try {
      void handle?.remove();
    } catch {
      // ignore
    }
  };
}
