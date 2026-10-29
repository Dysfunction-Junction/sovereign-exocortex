import test from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { issueToken } from "../jwt.js";
import { setDatabase } from "../db-host.js";
import { ExocortexDatabase } from "@exocortex/core/db";

const SECRET = "channel-route-auth-test-secret";
process.env.GATEWAY_JWT_SECRET = SECRET;
process.env.NODE_ENV = "test";
const { server } = await import("../server.js");

function device(id: string, scopes: string[], revoked_at: number | null = null) {
  return { device_id: id, name: id, platform: "linux" as const, pubkey_spki: new Uint8Array([0]), key_attested: 0, scopes, enrolled_at: Date.now(), revoked_at };
}

async function listen(s: Server): Promise<number> {
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const address = s.address();
  return typeof address === "object" && address ? address.port : 0;
}

test("channel routes require channel admin scopes and reject revoked devices", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  db.registerDevice(device("telemetry", ["telemetry:write"]));
  db.registerDevice(device("admin-read", ["admin:read"]));
  db.registerDevice(device("admin-write", ["admin:write"]));
  db.registerDevice(device("revoked", ["admin:write"], Date.now() - 1000));
  setDatabase(db);
  const port = await listen(server);
  const routes: Array<[string, string, string?]> = [
    ["GET", "/v3/channels"],
    ["POST", "/v3/channels/air-gap", "{}"],
    ["POST", "/v3/channels/not-a-channel/configure", "{}"],
    ["POST", "/v3/channels/not-a-channel/sync"],
    ["POST", "/v3/channels/not-a-channel/purge"],
    ["DELETE", "/v3/channels/not-a-channel"],
  ];
  const call = async (id: string, method: string, path: string, body?: string) => fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${issueToken(id, SECRET)}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body }),
  });
  try {
    for (const [method, path, body] of routes) {
      const denied = await call("telemetry", method, path, body);
      assert.equal(denied.status, 403, `${method} ${path}`);
      assert.deepEqual(await denied.json(), {
        error: method === "GET" ? "forbidden: requires admin, admin:read, or admin:write" : "forbidden: requires admin:write",
      });

      const revoked = await call("revoked", method, path, body);
      assert.equal(revoked.status, 401, `revoked ${method} ${path}`);
    }

    assert.equal((await call("admin-read", "GET", "/v3/channels")).status, 200);
    const readPost = await call("admin-read", "POST", "/v3/channels/air-gap", "{}");
    assert.equal(readPost.status, 403);
    assert.deepEqual(await readPost.json(), { error: "forbidden: requires admin:write" });

    for (const [method, path, body] of routes.slice(1)) {
      const response = await call("admin-write", method, path, body);
      assert.notEqual(response.status, 403, `${method} ${path} passed the admin:write check`);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setDatabase(null);
  }
});
