import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InferenceBroker, BrokerOverflowError, BrokerWaitTimeoutError, LANE_PRIORITY } from "./inference-broker.js";

/** A job that stays running until `release()` is called. */
function gate(log: string[], name: string) {
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  return { release: () => release(), job: async () => { log.push(`start:${name}`); await done; log.push(`end:${name}`); return name; } };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

describe("InferenceBroker", () => {
  it("ranks triage above embed above vision", () => {
    assert.ok(LANE_PRIORITY.triage < LANE_PRIORITY.embed && LANE_PRIORITY.embed < LANE_PRIORITY.vision);
  });

  it("runs one job at a time and starts the highest-priority waiter next", async () => {
    const log: string[] = [];
    const b = new InferenceBroker();
    const first = gate(log, "embed-1");
    const p1 = b.run("embed", first.job);
    const vision = b.run("vision", async () => { log.push("start:vision"); return "vision"; });
    const embed2 = b.run("embed", async () => { log.push("start:embed-2"); return "embed-2"; });
    const triage = b.run("triage", async () => { log.push("start:triage"); return "triage"; });
    await tick();
    assert.deepEqual(log, ["start:embed-1"]);
    first.release();
    await Promise.all([p1, vision, embed2, triage]);
    assert.deepEqual(log, ["start:embed-1", "end:embed-1", "start:triage", "start:embed-2", "start:vision"]);
  });

  it("keeps first-come order inside a lane", async () => {
    const log: string[] = [];
    const b = new InferenceBroker();
    const hold = gate(log, "hold");
    const p = b.run("triage", hold.job);
    const rest = [1, 2, 3].map((n) => b.run("embed", async () => { log.push(`embed-${n}`); }));
    hold.release();
    await Promise.all([p, ...rest]);
    assert.deepEqual(log.slice(2), ["embed-1", "embed-2", "embed-3"]);
  });

  it("does not preempt a running job", async () => {
    const log: string[] = [];
    const b = new InferenceBroker();
    const slow = gate(log, "embed");
    const p = b.run("embed", slow.job);
    await tick();
    const t = b.run("triage", async () => { log.push("start:triage"); });
    await tick();
    assert.deepEqual(log, ["start:embed"]);
    slow.release();
    await Promise.all([p, t]);
    assert.deepEqual(log, ["start:embed", "end:embed", "start:triage"]);
  });

  it("a failing job frees its slot and rejects only its own caller", async () => {
    const b = new InferenceBroker();
    const bad = b.run("embed", async () => { throw new Error("boom"); });
    const good = b.run("triage", async () => "ok");
    await assert.rejects(bad, /boom/);
    assert.equal(await good, "ok");
    assert.equal(b.stats().embed.failed, 1);
    assert.equal(b.stats().triage.completed, 1);
  });

  it("a job that throws synchronously also frees the slot", async () => {
    const b = new InferenceBroker();
    const bad = b.run("embed", (() => { throw new Error("sync"); }) as () => Promise<never>);
    const good = b.run("embed", async () => "next");
    await assert.rejects(bad, /sync/);
    assert.equal(await good, "next");
  });

  it("honours a higher concurrency", async () => {
    const log: string[] = [];
    const b = new InferenceBroker({ concurrency: 2 });
    const a = gate(log, "a");
    const c = gate(log, "c");
    const d = gate(log, "d");
    const ps = [b.run("embed", a.job), b.run("embed", c.job), b.run("embed", d.job)];
    await tick();
    assert.deepEqual(log, ["start:a", "start:c"]);
    a.release();
    await tick();
    assert.deepEqual(log.slice(-2), ["end:a", "start:d"]);
    c.release();
    d.release();
    await Promise.all(ps);
  });

  it("holds jobs back when the memory budget is full and admits them as memory frees", async () => {
    const log: string[] = [];
    const b = new InferenceBroker({ concurrency: 4, memoryBudgetMb: 1000 });
    const big = gate(log, "big");
    const p1 = b.run("embed", big.job, { memoryMb: 700 });
    const p2 = b.run("vision", async () => { log.push("start:vision"); }, { memoryMb: 600 });
    const p3 = b.run("triage", async () => { log.push("start:small"); }, { memoryMb: 200 });
    await tick();
    assert.deepEqual(log, ["start:big", "start:small"]);
    big.release();
    await Promise.all([p1, p2, p3]);
    assert.equal(log.at(-1), "start:vision");
  });

  it("rejects a job larger than the whole budget", async () => {
    const b = new InferenceBroker({ memoryBudgetMb: 500 });
    await assert.rejects(b.run("vision", async () => 1, { memoryMb: 501 }), /budget/);
  });

  it("rejects when a lane queue is full", async () => {
    const log: string[] = [];
    const b = new InferenceBroker({ maxQueuePerLane: { embed: 1 } });
    const hold = gate(log, "hold");
    const p = b.run("triage", hold.job);
    const queued = b.run("embed", async () => "q");
    await assert.rejects(b.run("embed", async () => "overflow"), BrokerOverflowError);
    hold.release();
    await Promise.all([p, queued]);
    assert.equal(b.stats().embed.rejected, 1);
  });

  it("drops a job that waited longer than maxWaitMs, leaving the rest intact", async () => {
    const log: string[] = [];
    const b = new InferenceBroker();
    const hold = gate(log, "hold");
    const p = b.run("triage", hold.job);
    const stale = b.run("vision", async () => "late", { maxWaitMs: 5 });
    const fresh = b.run("embed", async () => "fresh");
    await assert.rejects(stale, BrokerWaitTimeoutError);
    hold.release();
    assert.equal(await fresh, "fresh");
    await p;
  });

  it("cancels a queued job on abort and never runs it", async () => {
    const log: string[] = [];
    const b = new InferenceBroker();
    const hold = gate(log, "hold");
    const p = b.run("triage", hold.job);
    const ctrl = new AbortController();
    const cancelled = b.run("embed", async () => { log.push("start:cancelled"); }, { signal: ctrl.signal });
    ctrl.abort(new Error("stop"));
    await assert.rejects(cancelled, /stop/);
    hold.release();
    await p;
    assert.ok(!log.includes("start:cancelled"));
  });

  it("an already-aborted signal is rejected without queueing", async () => {
    const b = new InferenceBroker();
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(b.run("embed", async () => 1, { signal: ctrl.signal }));
    assert.equal(b.stats().embed.queued, 0);
  });

  it("triage never waits behind more than the one job already running, however long the backfill queue", async () => {
    const b = new InferenceBroker();
    const order: string[] = [];
    let release!: () => void;
    const first = new Promise<void>((r) => (release = r));
    const work = (name: string) => async () => { order.push(name); await new Promise<void>((r) => setImmediate(r)); };
    const backfill = [
      b.run("embed", async () => { order.push("embed"); await first; }),
      ...Array.from({ length: 39 }, () => b.run("embed", work("embed"))),
    ];
    const triage = Array.from({ length: 5 }, () => b.run("triage", work("triage")));
    release();
    await Promise.all([...triage, ...backfill]);
    const lastTriage = order.lastIndexOf("triage");
    // One embed was already running when triage arrived; all five triage jobs ran right after it.
    assert.deepEqual(order.slice(0, lastTriage + 1), ["embed", "triage", "triage", "triage", "triage", "triage"]);
    const s = b.stats();
    assert.equal(s.triage.completed, 5);
    assert.equal(s.embed.completed, 40);
  });
});
