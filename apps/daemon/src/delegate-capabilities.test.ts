import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { issueToken } from "./jwt.js";
import { setDatabase } from "./db-host.js";
import { ExocortexDatabase } from "@exocortex/core/db";
import { MISHMASH_LAUNCH } from "./mishmash-nodes.js";
import { DELEGATE_MAP, resolveDelegate, scopesSatisfy } from "./delegate-capabilities.js";
import { isApprovalAction } from "./network.js";

const TEST_SECRET = "delegate-capabilities-jwt-secret";
process.env.GATEWAY_JWT_SECRET = TEST_SECRET;
delete process.env.GATEWAY_ENROLL_TOKEN;
process.env.NODE_ENV = "test";

const { server } = await import("./server.js");

// ---------- table ----------

test("every launch node has a map entry", () => {
  for (const spec of MISHMASH_LAUNCH) assert.ok(Object.hasOwn(DELEGATE_MAP, spec.id), spec.id);
  assert.deepEqual(Object.keys(DELEGATE_MAP).sort(), MISHMASH_LAUNCH.map((s) => s.id).sort());
});

const MAPPED: Array<[string, string, Record<string, unknown>, string, "allow" | "block"]> = [
  ["pieces-for-all", "ping", {}, "T0", "allow"],
  ["pieces-for-all", "status", {}, "T0", "allow"],
  ["pieces-for-all", "memory", {}, "T0", "allow"],
  ["pieces-for-all", "memory", { action: "search" }, "T0", "allow"],
  ["pieces-for-all", "memory", { action: "ADD" }, "T2", "block"],
  ["agent-mesh-mcp", "ping", {}, "T0", "allow"],
  ["agent-mesh-mcp", "skills", {}, "T0", "allow"],
  ["agent-mesh-mcp", "dispatch", {}, "T3", "block"],
  ["agent-mesh-mcp", "playbook", {}, "T3", "block"],
  ["agent-mesh-mcp", "synthesize", {}, "T3", "block"],
  ["agent-mesh-mcp", "demote", {}, "T3", "block"],
  ["pattern-analyzer", "ping", {}, "T0", "allow"],
  ["pattern-analyzer", "rank", {}, "T1", "allow"],
  ["pattern-analyzer", "feedback", {}, "T2", "block"],
  ["autonomous-triad", "ping", {}, "T0", "allow"],
  ["autonomous-triad", "classify", {}, "T1", "allow"],
  ["hermes-api", "ping", {}, "T4", "block"],
  ["hermes-api", "tap", {}, "T4", "block"],
  ["registry-app", "ping", {}, "T0", "allow"],
  ["gut-instinct", "ping", {}, "T0", "allow"],
  ["tool-registry-heartbeat", "ping", {}, "T0", "allow"],
];

test("mapped actions resolve to the documented tier and shadow behavior", () => {
  for (const [to, action, payload, tier, shadow] of MAPPED) {
    const cap = resolveDelegate(to, action, payload);
    assert.ok(cap, `${to}.${action}`);
    assert.equal(cap.tier, tier, `${to}.${action} tier`);
    assert.equal(cap.shadow, shadow, `${to}.${action} shadow`);
  }
});

test("everything the old shadow rule blocked is still shadow-blocked", () => {
  for (const action of ["demote", "synthesize", "dispatch", "playbook"]) {
    assert.equal(resolveDelegate("agent-mesh-mcp", action, {})?.shadow, "block", action);
  }
  for (const action of ["ping", "tap", "anything", "x1"]) {
    assert.equal(resolveDelegate("hermes-api", action, {})?.shadow, "block", action);
  }
});

test("unmapped and non-canonical input is denied", () => {
  const denied: Array<[string, string, Record<string, unknown>?]> = [
    ["registry-app", "stage"], ["registry-app", "speculate"], ["registry-app", "release"],
    ["registry-app", "pending_proposals"], ["registry-app", "cache_status"], ["registry-app", "reject"],
    ["gut-instinct", "contract"], ["tool-registry-heartbeat", "inventory"],
    ["autonomous-triad", "approve"], ["autonomous-triad", "reject"], ["autonomous-triad", "review"],
    ["pieces-for-all", "delete"], ["pieces-for-all", "memory", { action: "delete" }],
    ["pieces-for-all", "memory", { action: "add " }], ["pieces-for-all", "memory", { action: 7 }], ["pieces-for-all", "memory", { action: null }], ["pieces-for-all", "memory", { action: "" }],
    ["no-such-node", "ping"], ["__proto__", "ping"], ["constructor", "ping"], ["pieces-for-all", "constructor"],
    ["pieces-for-all", "Ping"], ["pieces-for-all", " ping"], ["pieces-for-all", "ping "], ["Pieces-For-All", "ping"],
    ["agent-mesh-mcp", "SKills"], ["pieces-for-all", ""], ["", "ping"],
  ];
  for (const [to, action, payload] of denied) {
    assert.equal(resolveDelegate(to, action, payload ?? {}), null, `${to}.${action} ${JSON.stringify(payload ?? {})}`);
  }
});

test("admin gets no exemption from default deny, only from the scope check", () => {
  assert.equal(resolveDelegate("registry-app", "release", {}), null);
  const sensitive = resolveDelegate("agent-mesh-mcp", "dispatch", {})!;
  assert.equal(scopesSatisfy(["admin"], sensitive), false, "T3 needs admin:write; admin alone is not enough");
  assert.equal(scopesSatisfy(["admin:write"], sensitive), false, "T3 needs delegate:actuate as well");
  assert.equal(scopesSatisfy(["delegate:actuate"], sensitive), false, "delegate:actuate alone is not enough");
  assert.equal(scopesSatisfy(["admin", "delegate:actuate"], sensitive), false);
  assert.equal(scopesSatisfy(["admin:write", "delegate:actuate"], sensitive), true);
  assert.equal(scopesSatisfy(["admin"], resolveDelegate("hermes-api", "tap", {})!), false);
  assert.equal(scopesSatisfy(["admin"], resolveDelegate("pieces-for-all", "memory", { action: "add" })!), true);
  assert.equal(scopesSatisfy(["delegate:read", "delegate:write", "delegate:memory-read"], sensitive), false);
});

test("ping needs delegate:read, search needs delegate:memory-read, add needs delegate:write", () => {
  const ping = resolveDelegate("pieces-for-all", "ping", {})!;
  const search = resolveDelegate("pieces-for-all", "memory", {})!;
  const add = resolveDelegate("pieces-for-all", "memory", { action: "add" })!;
  assert.deepEqual([scopesSatisfy(["delegate:read"], ping), scopesSatisfy(["delegate:read"], search), scopesSatisfy(["delegate:read"], add)], [true, false, false]);
  assert.deepEqual([scopesSatisfy(["delegate:memory-read"], ping), scopesSatisfy(["delegate:memory-read"], search)], [false, true]);
  assert.equal(scopesSatisfy(["delegate:write"], add), true);
  assert.equal(scopesSatisfy(["telemetry:write"], ping), false);
});

test("release is held to the approval rule", () => {
  for (const a of ["approve", "reject", "release", " Release "]) assert.equal(isApprovalAction(a), true, a);
  assert.equal(isApprovalAction("ping"), false);
});

// ---------- route ----------

function deviceRow(id: string, scopes: string[]) {
  return { device_id: id, name: id, platform: "linux" as const, pubkey_spki: new Uint8Array([0]), key_attested: 0, scopes, enrolled_at: Date.now(), revoked_at: null };
}

async function listen(s: Server): Promise<number> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const a = s.address();
  return typeof a === "object" && a ? a.port : 0;
}

function envelope(to: string, action: string, payload: Record<string, unknown> = {}, from = "autonomous-triad") {
  return JSON.stringify({ v: 1, id: "env-12345678", from, to, capability: "x1", action, payload });
}

test("route: scoped devices reach only what the map allows, and the caller is stated by the daemon", async () => {
  const prevShadow = process.env.SHADOW;
  delete process.env.SHADOW;
  const seen: Array<Record<string, unknown>> = [];
  const upstream = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push(JSON.parse(raw));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const upPort = await listen(upstream);
  const memEnvKey = MISHMASH_LAUNCH.find((s) => s.id === "pieces-for-all")!.envKey;
  const prevUp = process.env[memEnvKey];
  process.env[memEnvKey] = `http://127.0.0.1:${upPort}`;

  const db = new ExocortexDatabase({ path: ":memory:" });
  db.registerDevice(deviceRow("dev_read", ["delegate:read"]));
  db.registerDevice(deviceRow("dev_mem", ["delegate:memory-read"]));
  db.registerDevice(deviceRow("dev_write", ["delegate:write"]));
  db.registerDevice(deviceRow("dev_admin", ["admin:write", "delegate:actuate"]));
  db.registerDevice(deviceRow("dev_admin_noact", ["admin:write"]));
  db.registerDevice(deviceRow("dev_admin_plain", ["admin"]));
  db.registerDevice(deviceRow("dev_none", ["telemetry:write"]));
  setDatabase(db);
  const port = await listen(server);
  const post = async (device: string, body: string) =>
    (await fetch(`http://127.0.0.1:${port}/network/delegate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${issueToken(device, TEST_SECRET)}` },
      body,
    })).status;
  try {
    // No delegate scope: 403 even for a malformed body (the body is never read).
    assert.equal(await post("dev_none", "not json"), 403);
    assert.equal(await post("dev_none", envelope("pieces-for-all", "ping")), 403);

    // delegate:read reaches ping, but not search, add, mesh dispatch, hermes or unmapped actions.
    assert.equal(await post("dev_read", envelope("pieces-for-all", "ping")), 200);
    assert.equal(await post("dev_read", envelope("pieces-for-all", "memory", { action: "search", query: "q" })), 403);
    assert.equal(await post("dev_read", envelope("pieces-for-all", "memory", { action: "add" })), 403);
    assert.equal(await post("dev_read", envelope("agent-mesh-mcp", "dispatch")), 403);
    assert.equal(await post("dev_read", envelope("hermes-api", "ping")), 403);
    assert.equal(await post("dev_read", envelope("registry-app", "release")), 403);
    assert.equal(await post("dev_read", envelope("autonomous-triad", "approve")), 403);
    assert.equal(await post("dev_read", envelope("pieces-for-all", "Ping")), 403);

    // delegate:memory-read reaches search only.
    assert.equal(await post("dev_mem", envelope("pieces-for-all", "memory", { action: "search", query: "q" })), 200);
    assert.equal(await post("dev_mem", envelope("pieces-for-all", "ping")), 403);

    // delegate:write plus SHADOW on: allowed by scope, refused by shadow.
    assert.equal(await post("dev_write", envelope("pieces-for-all", "memory", { action: "add", title: "t", body: "b" })), 423);

    // admin: mapped actions pass, unmapped are still denied, shadow still blocks T3/T4.
    assert.equal(await post("dev_admin", envelope("pieces-for-all", "ping")), 200);
    assert.equal(await post("dev_admin", envelope("registry-app", "release")), 403);
    assert.equal(await post("dev_admin", envelope("no-such-node", "ping")), 403);
    assert.equal(await post("dev_admin", envelope("agent-mesh-mcp", "dispatch")), 423);
    assert.equal(await post("dev_admin", envelope("hermes-api", "tap")), 423);

    // admin:write without delegate:actuate is refused for T3/T4 too (403, not 423).
    assert.equal(await post("dev_admin_noact", envelope("agent-mesh-mcp", "dispatch")), 403);
    assert.equal(await post("dev_admin_noact", envelope("hermes-api", "tap")), 403);
    assert.equal(await post("dev_admin_noact", envelope("pieces-for-all", "ping")), 200);

    // Plain `admin` (no admin:write) is refused for T3/T4 but reaches T0-T2.
    assert.equal(await post("dev_admin_plain", envelope("agent-mesh-mcp", "dispatch")), 403);
    assert.equal(await post("dev_admin_plain", envelope("hermes-api", "tap")), 403);
    assert.equal(await post("dev_admin_plain", envelope("pieces-for-all", "ping")), 200);
    assert.equal(await post("dev_admin_plain", envelope("pieces-for-all", "memory", { action: "add", title: "t", body: "b" })), 423);

    // SHADOW=0 lifts shadow only for entries the device is scoped for.
    process.env.SHADOW = "0";
    assert.equal(await post("dev_write", envelope("pieces-for-all", "memory", { action: "add", title: "t", body: "b" }, "hermes-api")), 200);
    assert.equal(await post("dev_read", envelope("pieces-for-all", "memory", { action: "add" })), 403);

    // The client-supplied `from` never reaches the node: the daemon states the caller.
    assert.ok(seen.length >= 3);
    for (const e of seen) assert.equal(e.from, "pieces-android-companion-seamless");
  } finally {
    if (prevShadow === undefined) delete process.env.SHADOW; else process.env.SHADOW = prevShadow;
    if (prevUp === undefined) delete process.env[memEnvKey]; else process.env[memEnvKey] = prevUp;
    server.close();
    upstream.close();
    setDatabase(null);
  }
});

// ---------- audit, rate limit, 423 text ----------

test("route: every denial writes one metadata-only audit event, classify is rate limited, 423 names the action", async () => {
  const prevShadow = process.env.SHADOW;
  delete process.env.SHADOW;
  const upstream = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const upPort = await listen(upstream);
  const triadEnvKey = MISHMASH_LAUNCH.find((s) => s.id === "autonomous-triad")!.envKey;
  const prevUp = process.env[triadEnvKey];
  process.env[triadEnvKey] = `http://127.0.0.1:${upPort}`;

  const db = new ExocortexDatabase({ path: ":memory:" });
  db.registerDevice(deviceRow("dev_a", ["delegate:read"]));
  db.registerDevice(deviceRow("dev_b", ["delegate:read"]));
  db.registerDevice(deviceRow("dev_act", ["admin:write", "delegate:actuate"]));
  db.registerDevice(deviceRow("dev_none", ["telemetry:write"]));
  db.registerDevice(deviceRow("dev_actonly", ["delegate:actuate"]));
  db.registerDevice({ ...deviceRow("dev_revoked", ["admin:write", "delegate:actuate"]), revoked_at: Date.now() - 1000 });
  setDatabase(db);
  const port = await listen(server);
  const call = async (device: string, body: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/network/delegate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${issueToken(device, TEST_SECRET)}` },
      body,
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const denials = () => db.listEvents({ kind: "delegate_denied" }).map((e) => JSON.parse(String(e.payload)) as Record<string, unknown>);
  try {
    const secret = "SECRET-PAYLOAD-VALUE";
    assert.equal((await call("dev_none", envelope("pieces-for-all", "ping", { q: secret }))).status, 403); // scope (pre-check)
    assert.equal((await call("dev_a", envelope("pieces-for-all", "nope", { q: secret }))).status, 403); // unmapped
    assert.equal((await call("dev_a", envelope("autonomous-triad", "approve", { q: secret }))).status, 403); // approval_action
    assert.equal((await call("dev_a", envelope("pieces-for-all", "memory", { action: "add", q: secret }))).status, 403); // scope
    const shadow = await call("dev_act", envelope("agent-mesh-mcp", "dispatch", { q: secret }));
    assert.equal(shadow.status, 423); // shadow
    assert.match(String(shadow.json.error), /agent-mesh-mcp\.dispatch/);
    assert.doesNotMatch(String(shadow.json.error), /hermes-api/);

    const logged = denials();
    assert.deepEqual(logged.map((d) => d.reason), ["scope", "unmapped", "approval_action", "scope", "shadow"]);
    assert.equal(logged[0]!.denied_device, "dev_none");
    assert.equal(logged[0]!.delegate_to, null, "pre-check denials happen before the body is read");
    assert.equal(logged[1]!.delegate_to, "pieces-for-all");
    assert.equal(logged[1]!.delegate_action, null, "an unknown action name is not stored");
    assert.equal(logged[1]!.unrecognized, true);
    assert.equal(logged[4]!.denied_device, "dev_act");
    assert.doesNotMatch(JSON.stringify(logged), new RegExp(secret), "the payload is never logged");

    // A successful call writes no denial event.
    assert.equal((await call("dev_a", envelope("autonomous-triad", "ping"))).status, 200);
    assert.equal(denials().length, 5);

    // delegate:actuate alone does not pass the pre-check (403 before the body is read, even for a bad body).
    assert.equal((await call("dev_actonly", "not json")).status, 403);
    // A revoked device holding both scopes is stopped at authentication (401): never forwarded, never audited.
    assert.equal((await call("dev_revoked", envelope("agent-mesh-mcp", "dispatch"))).status, 401);
    assert.equal(denials().length, 6);
    assert.equal(db.verifyEventChain().valid, true);

    // classify: 30 per minute per device, then 429; another device is unaffected.
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) statuses.push((await call("dev_a", envelope("autonomous-triad", "classify", { text: "hi" }))).status);
    assert.equal(statuses.filter((s) => s === 200).length, 30);
    assert.deepEqual(statuses.slice(30), [429, 429]);
    assert.equal((await call("dev_b", envelope("autonomous-triad", "classify", { text: "hi" }))).status, 200);
    assert.equal(denials().length, 6, "429s write no audit events");
  } finally {
    if (prevShadow === undefined) delete process.env.SHADOW; else process.env.SHADOW = prevShadow;
    if (prevUp === undefined) delete process.env[triadEnvKey]; else process.env[triadEnvKey] = prevUp;
    server.close();
    upstream.close();
    setDatabase(null);
  }
});
