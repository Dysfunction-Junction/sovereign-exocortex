import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueToken } from "./jwt.js";
import { setDatabase } from "./db-host.js";
import { ExocortexDatabase } from "@exocortex/core/db";

const TEST_SECRET = "audit-fixes-jwt-secret";
process.env.GATEWAY_JWT_SECRET = TEST_SECRET;
delete process.env.GATEWAY_ENROLL_TOKEN;
process.env.NODE_ENV = "test";

const { server } = await import("./server.js");
const { isRevoked } = await import("./device-registry.js");

function deviceRow(id: string) {
  return {
    device_id: id,
    name: id,
    platform: "linux" as const,
    pubkey_spki: new Uint8Array([0]),
    key_attested: 0,
    scopes: ["telemetry:write"],
    enrolled_at: Date.now(),
    revoked_at: null,
  };
}

async function listen(): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const a = server.address();
  return typeof a === "object" && a ? a.port : 0;
}

test("enrollment is disabled (no default secret) when GATEWAY_ENROLL_TOKEN is unset", async () => {
  setDatabase(new ExocortexDatabase({ path: ":memory:" }));
  const port = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v3/devices/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer enroll-token-sovereign-dev" },
      body: "{}",
    });
    assert.equal(res.status, 401);
  } finally {
    server.close();
    setDatabase(null);
  }
});

test("malformed Host header does not crash the handler", async () => {
  const port = await listen();
  try {
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = connect(port, "127.0.0.1", () => {
        sock.write("GET /mobile/health HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n");
      });
      let buf = "";
      sock.on("data", (d) => (buf += d.toString()));
      sock.on("end", () => resolve(buf));
      sock.on("error", reject);
    });
    assert.match(raw, /^HTTP\/1\.1 200/);
    const res = await fetch(`http://127.0.0.1:${port}/mobile/health`);
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test("/network/approve fails closed when circuit-breaker state is unavailable", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  db.registerDevice(deviceRow("dev_breaker"));
  db.isCircuitBreakerTripped = () => {
    throw new Error("db unavailable");
  };
  setDatabase(db);
  const port = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/network/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${issueToken("dev_breaker", TEST_SECRET)}` },
      body: JSON.stringify({ proposal_id: "p1", nonce: "n1" }),
    });
    assert.equal(res.status, 503);
  } finally {
    server.close();
    setDatabase(null);
  }
});

test("isRevoked honors a v3 revocation in the on-disk DB even when the DB is not yet open", () => {
  const dir = mkdtempSync(join(tmpdir(), "exo-audit-"));
  const dbPath = join(dir, "exocortex.db");
  const prev = process.env.EXOCORTEX_DB_PATH;
  process.env.EXOCORTEX_DB_PATH = dbPath;
  try {
    const db = new ExocortexDatabase({ path: dbPath });
    db.registerDevice(deviceRow("dev_revoked_cold"));
    db.registerDevice(deviceRow("dev_ok_cold"));
    db.revokeDevice("dev_revoked_cold");
    db.close();
    setDatabase(null); // simulate fresh process: nothing open
    assert.equal(isRevoked("dev_revoked_cold"), true);
    assert.equal(isRevoked("dev_ok_cold"), false);
  } finally {
    setDatabase(null);
    if (prev === undefined) delete process.env.EXOCORTEX_DB_PATH;
    else process.env.EXOCORTEX_DB_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shadow mode blocks /network/approve and delegation to hermes-api", async () => {
  const prev = process.env.SHADOW;
  delete process.env.SHADOW; // default: shadow on
  const db = new ExocortexDatabase({ path: ":memory:" });
  db.registerDevice(deviceRow("dev_shadow"));
  setDatabase(db);
  const port = await listen();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${issueToken("dev_shadow", TEST_SECRET)}` };
  try {
    const approve = await fetch(`http://127.0.0.1:${port}/network/approve`, {
      method: "POST", headers, body: JSON.stringify({ proposal_id: "p1", nonce: "n1" }),
    });
    assert.equal(approve.status, 423);
    assert.equal((await approve.json()).shadow_mode, true);

    const delegate = await fetch(`http://127.0.0.1:${port}/network/delegate`, {
      method: "POST", headers,
      body: JSON.stringify({ v: 1, id: "env-12345678", from: "dev_shadow", to: "hermes-api", capability: "device", action: "tap", payload: {} }),
    });
    assert.equal(delegate.status, 423);

    // reject is not actuation and non-device nodes are untouched by the shadow gate
    const other = await fetch(`http://127.0.0.1:${port}/network/delegate`, {
      method: "POST", headers,
      body: JSON.stringify({ v: 1, id: "env-12345678", from: "dev_shadow", to: "no-such-node", capability: "intent", action: "review", payload: {} }),
    });
    assert.equal(other.status, 404);
  } finally {
    if (prev === undefined) delete process.env.SHADOW; else process.env.SHADOW = prev;
    server.close();
    setDatabase(null);
  }
});
