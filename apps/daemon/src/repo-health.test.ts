import assert from "node:assert/strict";
import test from "node:test";
import { ExocortexDatabase } from "@exocortex/core/db";
import { HOST_DEVICE_ID } from "./shadow-recorder.js";
import { WorldModelHost } from "./world-model-host.js";
import {
  checkRepoCleanliness,
  recordRepoCheckoutObservation,
  RepoHealthWatcher,
  type RepoObservationNotification,
} from "./repo-health.js";

test("checkRepoCleanliness: resolves true on empty git porcelain output", async () => {
  const fakeExec: any = (_cmd: string, args: string[], _opts: any, cb: (err: any, out: string) => void) => {
    assert.ok(args.includes("--no-optional-locks"));
    assert.ok(args.includes("--untracked-files=no"));
    cb(null, "   \n");
  };
  const isClean = await checkRepoCleanliness(process.cwd(), { execFileFn: fakeExec });
  assert.equal(isClean, true);
});

test("checkRepoCleanliness: resolves false on non-empty git porcelain output", async () => {
  const fakeExec: any = (_cmd: string, _args: string[], _opts: any, cb: (err: any, out: string) => void) => {
    cb(null, " M src/index.ts\n");
  };
  const isClean = await checkRepoCleanliness(process.cwd(), { execFileFn: fakeExec });
  assert.equal(isClean, false);
});

test("checkRepoCleanliness: rejects on non-directory path", async () => {
  await assert.rejects(
    async () => {
      await checkRepoCleanliness("/path/that/does/not/exist/at/all");
    },
    /cannot access repository path/,
  );
});

test("recordRepoCheckoutObservation: clean checkout appends host observation without producing proposals", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  const host = WorldModelHost.createIsolatedForTest();
  try {
    const result = recordRepoCheckoutObservation(true, db, { repoName: "test-repo", host });
    const events = db.listEvents();

    assert.equal(result.generatedPoliciesCount, 0);
    assert.equal(result.proposalIds.length, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].device_id, HOST_DEVICE_ID);

    const payload = JSON.parse(events[0].payload);
    assert.equal(payload.observedState, true);
    assert.equal(payload.observation, "clean_checkout");
    assert.equal(payload.invariantId, "inv_zero_broken_commits");
    assert.equal(payload.repo, "test-repo");
    assert.equal(db.verifyEventChain().valid, true);
  } finally {
    db.close();
  }
});

test("recordRepoCheckoutObservation: uncommitted edits produce persisted shadow proposals", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  const host = WorldModelHost.createIsolatedForTest();
  try {
    const result = recordRepoCheckoutObservation(false, db, {
      repoName: "test-repo",
      dirtyRepos: ["test-repo"],
      checkedRepos: ["test-repo"],
      host,
    });
    const proposals = result.proposalIds.map((id) => db.getProposal(id));

    assert.equal(result.generatedPoliciesCount, 2);
    assert.equal(proposals.length, 2);
    assert.ok(proposals.every((p) => p?.shadow === 1));

    const obsEvents = db.listEvents({ kind: "observation" });
    assert.equal(obsEvents.length, 1);
    const payload = JSON.parse(obsEvents[0].payload);
    assert.equal(payload.observedState, false);
    assert.equal(payload.observation, "uncommitted_edits");
    assert.deepEqual(payload.dirtyRepos, ["test-repo"]);

    assert.equal(db.listEvents({ kind: "proposal" }).length, 2);
    assert.equal(db.verifyEventChain().valid, true);
  } finally {
    db.close();
  }
});

test("recordRepoCheckoutObservation: suppressProposals=true updates beliefs without synthesizing proposals", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  const host = WorldModelHost.createIsolatedForTest();
  try {
    const result = recordRepoCheckoutObservation(false, db, {
      repoName: "test-repo",
      host,
      suppressProposals: true,
    });
    assert.equal(result.generatedPoliciesCount, 0);
    assert.equal(result.proposalIds.length, 0);
    assert.equal(db.listEvents({ kind: "observation" }).length, 1);
    assert.equal(db.listEvents({ kind: "proposal" }).length, 0);
    assert.equal(db.verifyEventChain().valid, true);
  } finally {
    db.close();
  }
});

test("RepoHealthWatcher: aggregates multi-repo status and enforces dirty dwell debounce", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  const host = WorldModelHost.createIsolatedForTest();
  try {
    let clock = 1_000;
    const cleanMap: Record<string, boolean> = {
      "/workspace/repo-a": true,
      "/workspace/repo-b": true,
    };
    const notifications: RepoObservationNotification[] = [];

    const watcher = new RepoHealthWatcher({
      db,
      host,
      repos: ["/workspace/repo-a", "/workspace/repo-b"],
      pollIntervalMs: 100,
      heartbeatIntervalMs: 10_000,
      dirtyDwellMs: 2_000, // 2 second dirty dwell
      nowFn: () => clock,
      checkCleanlinessFn: async (p) => cleanMap[p] ?? true,
      onObservation: (n) => notifications.push(n),
    });

    // 1. Initial pass: both clean
    const firstPass = await watcher.checkOnce();
    assert.ok(firstPass);
    assert.equal(firstPass.reason, "initial");
    assert.equal(firstPass.isClean, true);
    assert.equal(notifications.length, 1);

    // 2. repo-b becomes dirty, but clock hasn't dwelled past 2,000ms
    cleanMap["/workspace/repo-b"] = false;
    clock += 500;
    const secondPass = await watcher.checkOnce();
    assert.equal(secondPass, null); // suppressed by dwell window

    // 3. Clock advances past 2,000ms dwell -> state transition to dirty emitted
    clock += 2_000;
    const thirdPass = await watcher.checkOnce();
    assert.ok(thirdPass);
    assert.equal(thirdPass.reason, "state_transition");
    assert.equal(thirdPass.isClean, false);
    assert.deepEqual(thirdPass.dirtyRepos, ["repo-b"]);
    assert.equal(notifications.length, 2);

    // 4. repo-b is fixed -> immediately flips back to clean
    cleanMap["/workspace/repo-b"] = true;
    clock += 500;
    const fourthPass = await watcher.checkOnce();
    assert.ok(fourthPass);
    assert.equal(fourthPass.reason, "state_transition");
    assert.equal(fourthPass.isClean, true);
    assert.deepEqual(fourthPass.dirtyRepos, []);
    assert.equal(notifications.length, 3);
  } finally {
    db.close();
  }
});

test("RepoHealthWatcher: heartbeat skips when repo is raw dirty within dwell and suppresses proposals", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  const host = WorldModelHost.createIsolatedForTest();
  try {
    let clock = 1_000;
    let isClean = true;
    const notifications: RepoObservationNotification[] = [];

    const watcher = new RepoHealthWatcher({
      db,
      host,
      repos: ["/workspace/dwell-repo"],
      pollIntervalMs: 100,
      heartbeatIntervalMs: 5_000,
      dirtyDwellMs: 3_000,
      nowFn: () => clock,
      checkCleanlinessFn: async () => isClean,
      onObservation: (n) => notifications.push(n),
    });

    // Initial clean pass
    const pass1 = await watcher.checkOnce();
    assert.ok(pass1);
    assert.equal(notifications.length, 1);

    // Repo turns dirty at clock 2,000
    clock = 2_000;
    isClean = false;
    await watcher.checkOnce(); // sets firstDirtyAt = 2000

    // Advance clock to 6,500 (heartbeat due at 6,000, but repo is raw dirty dwelling)
    clock = 6_500;
    // Dwell (3000ms) has now expired: this is a state transition to dirty!
    const pass2 = await watcher.checkOnce();
    assert.ok(pass2);
    assert.equal(pass2.reason, "state_transition");
    assert.equal(pass2.isClean, false);
    assert.equal(pass2.proposalIds.length, 2);
    assert.equal(notifications.length, 2);

    // Advance clock past next heartbeat while still dirty
    clock += 6_000;
    const pass3 = await watcher.checkOnce();
    assert.ok(pass3);
    assert.equal(pass3.reason, "heartbeat");
    assert.equal(pass3.isClean, false);
    assert.equal(pass3.proposalIds.length, 0); // Proposals suppressed on heartbeat!
    assert.equal(notifications.length, 3);
  } finally {
    db.close();
  }
});

test("RepoHealthWatcher: partial check failure withholds aggregate verdict and resets firstDirtyAt on error", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  const host = WorldModelHost.createIsolatedForTest();
  try {
    const notifications: RepoObservationNotification[] = [];
    const errors: { repo: string; err: unknown }[] = [];

    const watcher = new RepoHealthWatcher({
      db,
      host,
      repos: ["/workspace/repo-good", "/workspace/repo-bad"],
      checkCleanlinessFn: async (p) => {
        if (p === "/workspace/repo-bad") throw new Error("git lock timeout");
        return true;
      },
      onObservation: (n) => notifications.push(n),
      onError: (repo, err) => errors.push({ repo, err }),
    });

    const pass = await watcher.checkOnce();
    assert.equal(pass, null); // Withheld! Does not emit false "clean"
    assert.equal(notifications.length, 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].repo, "/workspace/repo-bad");

    // Check error clears firstDirtyAt
    const state = watcher.getRepoState("/workspace/repo-bad");
    assert.equal(state?.firstDirtyAt, null);
  } finally {
    db.close();
  }
});

test("RepoHealthWatcher: stop() generational cancellation cancels in-flight check", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  const host = WorldModelHost.createIsolatedForTest();
  try {
    let slowResolver: (() => void) | undefined;
    const notifications: RepoObservationNotification[] = [];

    const watcher = new RepoHealthWatcher({
      db,
      host,
      repos: ["/workspace/repo"],
      checkCleanlinessFn: async () => {
        await new Promise<void>((r) => {
          slowResolver = r;
        });
        return true;
      },
      onObservation: (n) => notifications.push(n),
    });

    const checkPromise = watcher.checkOnce();
    // Stop while check is in flight!
    watcher.stop();
    if (slowResolver) (slowResolver as () => void)();

    const result = await checkPromise;
    assert.equal(result, null); // Generation mismatch -> canceled!
    assert.equal(notifications.length, 0);
  } finally {
    db.close();
  }
});
