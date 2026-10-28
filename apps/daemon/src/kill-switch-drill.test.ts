// Kill-switch drill (row 2.5). SHADOW is read from the environment on every request, so flipping it at runtime must
// take effect without a restart: with SHADOW=0 an actuating delegation is forwarded, and the moment SHADOW is set
// back to 1 every one of them is refused and nothing more reaches a node.
//
// Actuating routes found in server.ts (POST/DELETE handlers that can make something outside the daemon act):
//   /network/delegate  every `shadow: "block"` map entry, incl. all of hermes-api       drilled here
//   /network/approve   approvals relay to the triad                                      drilled here
// Everything else that mutates only moves or stores data inside this system and does not read SHADOW:
//   /v3/events, /world-model/telemetry|observation, /v3/shadow/labels, /v3/devices/*, /v3/channels/* (sync, purge,
//   configure, air-gap), /v3/precognitive/*, /v3/databank/archive (admin), /v3/world-model/neo4j/sync|query (admin),
//   /v3/world-model/replay, /mobile/ask, /mobile/usage-report.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { issueToken } from "./jwt.js";
import { setDatabase } from "./db-host.js";
import { ExocortexDatabase } from "@exocortex/core/db";
import { MISHMASH_LAUNCH } from "./mishmash-nodes.js";
import { DELEGATE_MAP, resolveDelegate } from "./delegate-capabilities.js";

const TEST_SECRET = "kill-switch-drill-jwt-secret";
process.env.GATEWAY_JWT_SECRET = TEST_SECRET;
delete process.env.GATEWAY_ENROLL_TOKEN;
process.env.NODE_ENV = "test";

const { server } = await import("./server.js");

function deviceRow(id: string, scopes: string[]) {
  return { device_id: id, name: id, platform: "linux" as const, pubkey_spki: new Uint8Array([0]), key_attested: 0, scopes, enrolled_at: Date.now(), revoked_at: null };
}

async function listen(s: Server): Promise<number> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const a = s.address();
  return typeof a === "object" && a ? a.port : 0;
}

/** Every (node, action, payload) the map marks shadow:block, plus the sub-action and wildcard cases. */
function actuatingEntries(): Array<{ to: string; action: string; payload: Record<string, unknown> }> {
  const out: Array<{ to: string; action: string; payload: Record<string, unknown> }> = [];
  for (const [to, actions] of Object.entries(DELEGATE_MAP)) {
    for (const action of Object.keys(actions)) {
      if (resolveDelegate(to, action, {})?.shadow === "block") out.push({ to, action, payload: {} });
    }
  }
  if (resolveDelegate("pieces-for-all", "memory", { action: "add" })?.shadow === "block") {
    out.push({ to: "pieces-for-all", action: "memory", payload: { action: "add", title: "t", body: "b" } });
  }
  // hermes-api blocks every action name, so sample a few.
  for (const action of ["ping", "tap", "swipe", "type-text"]) out.push({ to: "hermes-api", action, payload: {} });
  return out;
}

test("kill switch: flipping SHADOW at runtime blocks every actuating route, and flipping it back forwards again", async () => {
  const prevShadow = process.env.SHADOW;
  const seen: string[] = [];
  const upstream = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        const e = JSON.parse(raw) as { to?: string; action?: string };
        seen.push(`${e.to}.${e.action}`);
      } catch {
        seen.push("unparsed");
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const upPort = await listen(upstream);
  const prevEnv = new Map<string, string | undefined>();
  for (const spec of MISHMASH_LAUNCH) {
    prevEnv.set(spec.envKey, process.env[spec.envKey]);
    process.env[spec.envKey] = `http://127.0.0.1:${upPort}`;
  }

  const db = new ExocortexDatabase({ path: ":memory:" });
  // Scopes for the strictest map entries (T3/T4) and for approvals.
  db.registerDevice(deviceRow("dev_drill", ["admin", "admin:write", "delegate:actuate", "delegate:write", "approval:write"]));
  setDatabase(db);
  const port = await listen(server);
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${issueToken("dev_drill", TEST_SECRET)}` };
  const delegate = async (to: string, action: string, payload: Record<string, unknown>) =>
    (await fetch(`http://127.0.0.1:${port}/network/delegate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ v: 1, id: "env-12345678", from: "dev_drill", to, capability: "drill", action, payload }),
    })).status;
  const approve = async () =>
    (await fetch(`http://127.0.0.1:${port}/network/approve`, {
      method: "POST",
      headers,
      body: JSON.stringify({ proposal_id: "p-drill", nonce: "n-drill", action: "approve" }),
    })).status;

  try {
    const entries = actuatingEntries();
    const names = entries.map((e) => `${e.to}.${e.action}`);
    for (const required of ["agent-mesh-mcp.dispatch", "agent-mesh-mcp.playbook", "agent-mesh-mcp.synthesize", "agent-mesh-mcp.demote", "hermes-api.tap", "pieces-for-all.memory"]) {
      assert.ok(names.includes(required), `drill must cover ${required}`);
    }

    // 1. SHADOW=0: the actuating delegations are forwarded to the node.
    process.env.SHADOW = "0";
    for (const e of entries) {
      const status = await delegate(e.to, e.action, e.payload);
      assert.equal(status, 200, `SHADOW=0 ${e.to}.${e.action} should forward`);
    }
    assert.equal(seen.length, entries.length);
    assert.notEqual(await approve(), 423, "SHADOW=0 lets /network/approve past the shadow gate (it fails later, on the unknown proposal)");

    // 2. Flip to SHADOW=1 at runtime, no restart: every one is refused and nothing more reaches a node.
    process.env.SHADOW = "1";
    const before = seen.length;
    for (const e of entries) {
      assert.equal(await delegate(e.to, e.action, e.payload), 423, `SHADOW=1 ${e.to}.${e.action} must be blocked`);
    }
    assert.equal(await approve(), 423, "SHADOW=1 /network/approve must be blocked");
    assert.equal(seen.length, before, "no blocked call may reach a node");

    // 3. Unset means shadow on as well.
    delete process.env.SHADOW;
    for (const e of entries) {
      assert.equal(await delegate(e.to, e.action, e.payload), 423, `SHADOW unset ${e.to}.${e.action} must be blocked`);
    }
    assert.equal(await approve(), 423);
    assert.equal(seen.length, before);

    // 4. And back to 0 forwards again, so the switch really is read per request.
    process.env.SHADOW = "0";
    assert.equal(await delegate("hermes-api", "tap", {}), 200);
    assert.equal(seen.length, before + 1);
  } finally {
    if (prevShadow === undefined) delete process.env.SHADOW; else process.env.SHADOW = prevShadow;
    for (const [k, v] of prevEnv) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    server.close();
    upstream.close();
    setDatabase(null);
  }
});
