import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExocortexDatabase } from "@exocortex/core/db";
import { TriageHost, triageTextOf } from "./triage-host.js";

const T0 = Date.UTC(2026, 9, 11, 15, 0, 0);
const DEVICE = "phone-1";

function okFetch(content: unknown, calls: Array<Record<string, unknown>> = []): typeof fetch {
  return (async (_url: unknown, init?: { body?: string }) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("TriageHost", () => {
  let dir: string;
  let db: ExocortexDatabase;
  let n = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "triage-host-"));
    db = new ExocortexDatabase({ path: join(dir, "t.db") });
    db.registerDevice({
      device_id: DEVICE, name: "test phone", platform: "android", pubkey_spki: new Uint8Array([1]),
      key_attested: 0, scopes: [], enrolled_at: T0, revoked_at: null,
    });
    n = 0;
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const telemetry = (text: unknown, extra: Record<string, unknown> = {}) => ({
    kind: "telemetry",
    ts_device: T0 + ++n,
    payload: { type: "system_telemetry", telemetry: text, app_label: "Messages", ...extra },
  });
  const ingest = (events: Array<ReturnType<typeof telemetry> | { kind: string; ts_device: number; payload: Record<string, unknown> }>) =>
    db.ingestBatch({ device_id: DEVICE, events: events.map((e) => ({ ...e, event_id: `e${++n}`, schema_ver: 1 as const })) });
  const rows = () => db.raw.prepare("SELECT * FROM triage_results ORDER BY event_seq").all() as Array<Record<string, unknown>>;

  it("stores a verdict from qwen3:1.7b with the JSON schema and think disabled", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const h = new TriageHost({ fetchImpl: okFetch({ category: "urgent", reason: "refill expires tomorrow" }, calls) });
    h.onEventsAppended(ingest([telemetry("your prescription refill is ready")]).events, db);
    await h.idle();
    const r = rows();
    assert.equal(r.length, 1);
    assert.equal(r[0].category, "urgent");
    assert.equal(r[0].model, "qwen3:1.7b");
    assert.equal(calls[0].model, "qwen3:1.7b");
    assert.equal(calls[0].think, false);
    assert.ok(calls[0].format);
  });

  it("ignores non-telemetry events and telemetry without text", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const h = new TriageHost({ fetchImpl: okFetch({ category: "noise", reason: "x" }, calls) });
    const r = ingest([
      { kind: "touch", ts_device: T0 + 1, payload: { type: "screen_view", screen: "status" } },
      telemetry("   "),
      telemetry(undefined),
    ]);
    assert.equal(h.onEventsAppended(r.events, db).queued, 0);
    await h.idle();
    assert.equal(calls.length, 0);
  });

  it("fails soft: HTTP error, bad JSON, unknown category and network error store nothing", async () => {
    const bad: Array<typeof fetch> = [
      (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
      okFetch("not json"),
      okFetch({ category: "spam", reason: "x" }),
      (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    ];
    for (const fetchImpl of bad) {
      const h = new TriageHost({ fetchImpl });
      h.onEventsAppended(ingest([telemetry("hello")]).events, db);
      await h.idle();
    }
    assert.equal(db.raw.prepare("SELECT name FROM sqlite_master WHERE name='triage_results'").all().length, 0);
  });

  it("is disabled cleanly and bounds the queue", async () => {
    const off = new TriageHost({ enabled: false, fetchImpl: okFetch({ category: "noise", reason: "x" }) });
    assert.equal(off.onEventsAppended(ingest([telemetry("a")]).events, db).queued, 0);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = (async () => {
      await gate;
      return new Response(JSON.stringify({ message: { content: JSON.stringify({ category: "noise", reason: "x" }) } }), { status: 200 });
    }) as unknown as typeof fetch;
    const h = new TriageHost({ fetchImpl: slow, maxQueue: 2 });
    h.onEventsAppended(ingest([telemetry("1"), telemetry("2"), telemetry("3"), telemetry("4")]).events, db);
    release();
    await h.idle();
    assert.ok(rows().length <= 3, "queue bound drops oldest jobs");
  });

  it("results are append-only", async () => {
    const h = new TriageHost({ fetchImpl: okFetch({ category: "routine", reason: "later" }) });
    h.onEventsAppended(ingest([telemetry("water bill due")]).events, db);
    await h.idle();
    assert.throws(() => db.raw.prepare("UPDATE triage_results SET category='noise'").run(), /append-only/);
    assert.throws(() => db.raw.prepare("DELETE FROM triage_results").run(), /append-only/);
  });

  it("skips messages you sent yourself", () => {
    const mk = (t: string) => ({ kind: "telemetry", payload: JSON.stringify({ type: "system_telemetry", telemetry: t, app_label: "Messages" }) }) as never;
    assert.equal(triageTextOf(mk("SMS outbound Mom Hello there")), null);
    assert.ok(triageTextOf(mk("SMS inbound Mom Hello there")));
  });

  it("triageTextOf prefixes the app label and caps length", () => {
    const t = triageTextOf({ kind: "telemetry", payload: JSON.stringify({ type: "system_telemetry", telemetry: "x".repeat(5000), app_label: "Bank" }) } as never);
    assert.ok(t!.startsWith("Bank: x"));
    assert.equal(t!.length, 1500);
  });
});
