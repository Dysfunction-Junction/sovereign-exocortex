import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExocortexDatabase } from "@exocortex/core/db";
import { addLabel, backfill, formatReport, labeledSeqs, nextToLabel, score, triageableEvents } from "./triage-labels.js";

const T0 = Date.UTC(2026, 9, 11, 15, 0, 0);
const DEVICE = "phone-1";
const A = "model-a";
const B = "model-b";

// model-a calls everything with "bank" urgent and the rest noise; model-b also calls "water" routine.
function fakeFetch(calls: string[] = []): typeof fetch {
  return (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> };
    const text = body.messages[1].content;
    calls.push(`${body.model}|${text}`);
    let category = "noise";
    if (/bank/i.test(text)) category = "urgent";
    else if (/water/i.test(text) && body.model === B) category = "routine";
    return new Response(JSON.stringify({ message: { content: JSON.stringify({ category, reason: "x" }) } }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("triage labels", () => {
  let dir: string;
  let db: ExocortexDatabase;
  let n = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "triage-labels-"));
    db = new ExocortexDatabase({ path: join(dir, "t.db") });
    db.registerDevice({
      device_id: DEVICE, name: "test phone", platform: "android", pubkey_spki: new Uint8Array([1]),
      key_attested: 0, scopes: [], enrolled_at: T0, revoked_at: null,
    });
    n = 0;
    db.ingestBatch({
      device_id: DEVICE,
      events: [
        { kind: "telemetry", text: "Bank: unusual sign-in attempt" },
        { kind: "telemetry", text: "Reminder: water bill due in 5 days" },
        { kind: "telemetry", text: "Promo: 20% off pizza" },
        { kind: "telemetry", text: "SMS outbound Mom See you at six" },
        { kind: "touch", text: "" },
      ].map((e) => ({
        event_id: `e${++n}`, schema_ver: 1 as const, kind: e.kind, ts_device: T0 + n,
        payload: e.kind === "telemetry" ? { type: "system_telemetry", telemetry: e.text, app_label: "Messages" } : { type: "screen_view", screen: "status" },
      })),
    });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds only incoming telemetry events that carry text (not touches, not your own sent messages)", () => {
    assert.equal(triageableEvents(db).length, 3);
    assert.ok(triageableEvents(db).every((e) => !e.text.includes("outbound")));
  });

  it("breaks scores down by event type and ignores labels on events triage does not run on", async () => {
    await backfill(db, { models: [A], host: { fetchImpl: fakeFetch() } });
    const [bank] = triageableEvents(db);
    addLabel(db, bank.seq, "urgent");
    const outbound = (db.raw.prepare("SELECT seq FROM events WHERE payload LIKE '%SMS outbound%'").get() as { seq: number }).seq;
    addLabel(db, outbound, "noise"); // labeled earlier, before outgoing messages were excluded
    const r = score(db, [A]);
    assert.equal(r.labeled, 1, "the outgoing-message label is not counted");
    assert.deepEqual(r.models[0].byType.other, { n: 1, correct: 1, urgent: 1 });
    assert.deepEqual(r.models[0].byType.voicemail, { n: 0, correct: 0, urgent: 0 });
    assert.match(formatReport(r), /other\s+1\/1 correct \(100%\), 1 labeled urgent/);
  });

  it("backfills each model once and resumes without re-running finished pairs", async () => {
    const calls: string[] = [];
    const first = await backfill(db, { models: [A, B], host: { fetchImpl: fakeFetch(calls) } });
    assert.deepEqual(first[A], { ran: 3, failed: 0, skipped: 0 });
    assert.deepEqual(first[B], { ran: 3, failed: 0, skipped: 0 });
    // One model at a time: all of A before any of B.
    assert.deepEqual(calls.map((c) => c.split("|")[0]), [A, A, A, B, B, B]);

    calls.length = 0;
    const again = await backfill(db, { models: [A, B], host: { fetchImpl: fakeFetch(calls) } });
    assert.deepEqual([again[A].ran, again[A].skipped, again[B].ran, again[B].skipped], [0, 3, 0, 3]);
    assert.equal(calls.length, 0);
  });

  it("counts a model that is down as failed and stores nothing for it", async () => {
    const down = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const s = await backfill(db, { models: [A], host: { fetchImpl: down } });
    assert.deepEqual(s[A], { ran: 0, failed: 3, skipped: 0 });
    assert.equal((db.raw.prepare("SELECT COUNT(*) AS c FROM triage_results").get() as { c: number }).c, 0);
  });

  it("queues disagreements first, blind, and skips labeled events", async () => {
    await backfill(db, { models: [A, B], host: { fetchImpl: fakeFetch() } });
    const q = nextToLabel(db, [A, B], true);
    assert.equal(q.length, 3);
    assert.equal(q[0].disagree, true);
    assert.match(q[0].text, /water/i);
    assert.deepEqual(Object.keys(q[0]).sort(), ["disagree", "seq", "text"], "no model output leaks into the candidate");
    assert.equal(nextToLabel(db, [A, B]).length, 1, "only the disagreement without --all");

    addLabel(db, q[0].seq, "routine");
    assert.equal(nextToLabel(db, [A, B]).length, 0);
    assert.ok(labeledSeqs(db).has(q[0].seq));
  });

  it("lets you label events before any model has run, then scores them once verdicts exist", async () => {
    assert.equal(nextToLabel(db, [A, B], true).length, 0, "default needs verdicts");
    const early = nextToLabel(db, [A, B], false, true);
    assert.equal(early.length, 3);
    assert.ok(early.every((c) => c.disagree === false));
    const bank = early.find((c) => /bank/i.test(c.text))!;
    addLabel(db, bank.seq, "urgent");
    assert.equal(score(db, [A, B]).models[0].n, 0, "nothing to score yet");

    await backfill(db, { models: [A, B], host: { fetchImpl: fakeFetch() } });
    const r = score(db, [A, B]);
    assert.deepEqual(r.models.map((m) => [m.n, m.correct]), [[1, 1], [1, 1]]);
  });

  it("scores models against labels, with urgent recall/precision and the latest label winning", async () => {
    await backfill(db, { models: [A, B], host: { fetchImpl: fakeFetch() } });
    const [bank, water, promo] = triageableEvents(db).map((e) => e.seq);
    addLabel(db, bank, "urgent");
    addLabel(db, water, "noise"); // first thought noise ...
    addLabel(db, water, "routine"); // ... then corrected: the latest label wins
    addLabel(db, promo, "noise");

    const r = score(db, [A, B]);
    assert.equal(r.labeled, 3);
    assert.deepEqual(r.labelCounts, { urgent: 1, routine: 1, noise: 1 });
    const a = r.models.find((m) => m.model === A)!;
    const b = r.models.find((m) => m.model === B)!;
    assert.deepEqual([a.correct, a.n], [2, 3]); // A calls water noise
    assert.deepEqual([b.correct, b.n], [3, 3]);
    assert.equal(a.urgentRecall, 1);
    assert.equal(a.urgentPrecision, 1);
    assert.equal(a.confusion.routine.noise, 1);
    assert.match(formatReport(r), /model-b: accuracy 3\/3 \(100%\)/);
    assert.match(formatReport(r), /Only 3 labels/);
  });

  it("labels are append-only and reject unknown categories", () => {
    addLabel(db, 1, "urgent");
    assert.throws(() => db.raw.prepare("UPDATE triage_labels SET label = 'noise'").run(), /append-only/);
    assert.throws(() => db.raw.prepare("DELETE FROM triage_labels").run(), /append-only/);
    assert.throws(() => addLabel(db, 1, "spam" as never), /invalid label/);
  });
});
