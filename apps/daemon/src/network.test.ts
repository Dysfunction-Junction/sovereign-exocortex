import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJsonStringify, delegateUpstream, forwardApprove, forwardDelegate, isDelegateEnvelope, localNodes, loopbackBase, parseDelegateEnvelope } from "./network.js";
import { MISHMASH_LAUNCH } from "./mishmash-nodes.js";

test("delegation targets stay on this PC", () => {
  const env = {};
  assert.equal(delegateUpstream("hermes-api", env), "http://127.0.0.1:3000");
  assert.equal(delegateUpstream("autonomous-triad", env), "http://127.0.0.1:8789");
  assert.equal(delegateUpstream("pieces-for-all", env), "http://127.0.0.1:39400");
  assert.equal(delegateUpstream("gut-instinct", env), "http://127.0.0.1:39404");
  const nodes = localNodes(env);
  assert.deepEqual(nodes.map((node) => node.id), MISHMASH_LAUNCH.map((spec) => spec.id));
  for (const node of nodes) {
    assert.equal(node.delegate, true, node.id);
    assert.match(node.upstream ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
  }
});

test("an env override still has to be an explicit upstream", () => {
  assert.equal(
    delegateUpstream("hermes-api", { HERMES_UPSTREAM: "http://127.0.0.1:3010" }),
    "http://127.0.0.1:3010",
  );
  assert.equal(
    delegateUpstream("hermes-api", { HERMES_UPSTREAM: "http://[::1]:3010" }),
    "http://[::1]:3010",
  );
});

test("an upstream off this PC is not used", () => {
  assert.equal(delegateUpstream("hermes-api", { HERMES_UPSTREAM: "http://example.com:3000" }), null);
  assert.equal(delegateUpstream("hermes-api", { HERMES_UPSTREAM: "http://user:pass@127.0.0.1:3000" }), null);
  assert.equal(delegateUpstream("hermes-api", { HERMES_UPSTREAM: "http://127.0.0.1.evil.com:3000" }), null);
});

test("loopbackBase supports IPv4 and IPv6 loopback correctly", () => {
  assert.equal(loopbackBase("http://127.0.0.1:8080/foo"), "http://127.0.0.1:8080");
  assert.equal(loopbackBase("http://localhost:8080"), "http://localhost:8080");
  assert.equal(loopbackBase("http://[::1]:8080"), "http://[::1]:8080");
  assert.equal(loopbackBase("http://10.0.0.1:8080"), null);
});

test("delegate envelopes are rejected unless they name a real hop", () => {
  const bad = parseDelegateEnvelope({ v: 1, id: "short", from: "phone", to: "hermes-api", capability: "device", action: "ping" });
  assert.equal(isDelegateEnvelope(bad), false);
  const good = parseDelegateEnvelope({
    v: 1,
    id: "0123456789abcdef",
    from: "pieces-android-companion-seamless",
    to: "hermes-api",
    capability: "device",
    action: "ping",
    payload: {},
  });
  assert.equal(isDelegateEnvelope(good), true);
});

test("forwardApprove wraps payload and targets autonomous-triad", async () => {
  let capturedBody: any = null;
  const mockFetch: any = async (_url: any, init: any) => {
    capturedBody = JSON.parse(init.body);
    return {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({ ok: true, status: "approved" }),
    };
  };
  const res = await forwardApprove(
    { proposalId: "prop_abc", nonce: "nonce_xyz", reason: "Test reason" },
    {},
    mockFetch,
  );
  assert.equal(res.status, 200);
  assert.equal(capturedBody.to, "autonomous-triad");
  assert.equal(capturedBody.action, "approve");
  assert.equal(capturedBody.payload.proposal_id, "prop_abc");
  assert.equal(capturedBody.payload.nonce, "nonce_xyz");
  assert.equal(capturedBody.payload.reason, "Test reason");
});

test("forwardApprove propagates biometricAttestation string and object to envelope", async () => {
  let capturedBody: any = null;
  const mockFetch: any = async (_url: any, init: any) => {
    capturedBody = JSON.parse(init.body);
    return {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({ ok: true, status: "approved" }),
    };
  };

  await forwardApprove(
    {
      proposalId: "prop_bio_1",
      nonce: "nonce_123",
      biometricAttestation: "android_hardware_keystore_sig_xyz",
    },
    {},
    mockFetch,
  );
  assert.equal(capturedBody.payload.biometric_attestation, "android_hardware_keystore_sig_xyz");

  await forwardApprove(
    {
      proposalId: "prop_bio_2",
      nonce: "nonce_456",
      biometricAttestation: { zKey: "valZ", aKey: "valA" },
    },
    {},
    mockFetch,
  );
  assert.equal(
    capturedBody.payload.biometric_attestation,
    JSON.stringify({ aKey: "valA", zKey: "valZ" }),
  );

  await forwardApprove(
    {
      proposalId: "prop_bio_3",
      nonce: "nonce_789",
      biometricAttestation: "invalid",
    },
    {},
    mockFetch,
  );
  assert.equal(capturedBody.payload.biometric_attestation, "invalid");
});

test("canonicalJsonStringify recursively sorts keys at all depths", () => {
  const nested = {
    z: { b: 2, a: 1 },
    a: [3, { y: 20, x: 10 }],
  };
  assert.equal(
    canonicalJsonStringify(nested),
    '{"a":[3,{"x":10,"y":20}],"z":{"a":1,"b":2}}',
  );
});

test("forwardDelegate sends TRIAD_SERVER_TOKEN only to the triad", async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const fakeFetch = (async (url: URL | string, init?: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const env = { TRIAD_SERVER_TOKEN: "triad-secret" } as NodeJS.ProcessEnv;
  const base = { v: 1 as const, id: "env-12345678", from: "x-client", capability: "intent", action: "review", payload: {} };
  await forwardDelegate({ ...base, to: "autonomous-triad" }, env, fakeFetch);
  await forwardDelegate({ ...base, to: "pieces-for-all" }, env, fakeFetch);
  assert.equal(seen[0].auth, "Bearer triad-secret");
  assert.equal(seen[1].auth, null);
});
