import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { Databank } from "../databank.js";
import { DatabankKeys } from "../crypto.js";
import { createDatabankServer } from "../server.js";

const TOKEN = "test-token-0123456789abcdef";

describe("databank server", () => {
  let root: string;
  let bank: Databank;
  let server: Server;
  let base: string;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "dbk-srv-"));
    Databank.provision(root, "srv-vault");
    bank = Databank.open({ root, keys: new DatabankKeys(Buffer.alloc(32, 6)), embedder: null });
    server = createDatabankServer(bank, { token: TOKEN });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    bank.close();
    rmSync(root, { recursive: true, force: true });
  });

  const call = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
    fetch(base + path, { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", ...init.headers } });

  it("rejects missing, wrong and near-miss tokens on every route", async () => {
    for (const [path, init] of [["/health", {}], ["/search", { method: "POST", body: "{}" }], ["/blob/" + "a".repeat(64), {}]] as const) {
      assert.equal((await call(path, init, null)).status, 401);
      assert.equal((await call(path, init, "wrong")).status, 401);
      assert.equal((await call(path, init, TOKEN + "x")).status, 401);
    }
  });

  it("refuses to start with a short token", () => {
    assert.throws(() => createDatabankServer(bank, { token: "short" }), /at least 16/);
  });

  it("ingests text, searches it, serves the item and the decrypted blob", async () => {
    const put = await call("/ingest/text", {
      method: "POST",
      body: JSON.stringify({ source: "t", kind: "memory", title: "Boiler", text: "the boiler pressure valve was replaced in march" }),
    });
    assert.equal(put.status, 200);
    const { itemId, blobId } = (await put.json()) as { itemId: string; blobId: string };

    const found = await call("/search", { method: "POST", body: JSON.stringify({ q: "boiler valve" }) });
    const { hits } = (await found.json()) as { hits: Array<{ itemId: string; title: string }> };
    assert.equal(hits[0].itemId, itemId);

    const item = await call(`/item/${itemId}`);
    assert.equal(((await item.json()) as { title: string }).title, "Boiler");

    const blob = await call(`/blob/${blobId}`);
    assert.equal(await blob.text(), "the boiler pressure valve was replaced in march");
    assert.equal(blob.headers.get("cache-control"), "no-store");
  });

  it("validates input and never resolves paths from the client", async () => {
    assert.equal((await call("/search", { method: "POST", body: "not json" })).status, 400);
    assert.equal((await call("/search", { method: "POST", body: JSON.stringify({ q: "x", kind: "bogus" }) })).status, 400);
    assert.equal((await call("/ingest/text", { method: "POST", body: JSON.stringify({ title: "x" }) })).status, 400);
    assert.equal((await call("/blob/" + "0".repeat(64))).status, 404);
    for (const bad of ["../../etc/passwd", "..%2F..%2Fetc%2Fpasswd", "A".repeat(64), "a".repeat(63)]) {
      assert.equal((await call(`/blob/${bad}`)).status, 404);
    }
    assert.equal((await call("/item/zzz")).status, 404);
  });

  it("defaults to Michael and permits explicit authenticated Gwen retrieval", async () => {
    await bank.ingestText({ source: "gwen-messenger", kind: "conversation", title: "Fixture", text: "ownerpartitionfixture", meta: { owner: "gwen" } });
    const search = async (extra: Record<string, unknown>) => {
      const res = await call("/search", { method: "POST", body: JSON.stringify({ q: "ownerpartitionfixture", ...extra }) });
      assert.equal(res.status, 200);
      return (await res.json()) as { hits: unknown[] };
    };
    assert.equal((await search({})).hits.length, 0);
    assert.equal((await search({ source: "gwen-messenger" })).hits.length, 0);
    assert.equal((await search({ owner: "gwen" })).hits.length, 1);
    for (const owner of ["", 123, {}, " "]) {
      assert.equal((await call("/search", { method: "POST", body: JSON.stringify({ q: "x", owner }) })).status, 400);
    }
  });

  it("reports health with counts", async () => {
    const h = (await (await call("/health")).json()) as { ok: boolean; items: number };
    assert.equal(h.ok, true);
    assert.ok(h.items >= 1);
  });

  it("serves the search UI without a token but nothing else", async () => {
    const r = await call("/", {}, null);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    const html = await r.text();
    assert.match(html, /Databank Search/);
    assert.doesNotMatch(html, new RegExp(TOKEN));
    assert.equal((await call("/index.html", {}, null)).status, 200);
    assert.equal((await call("/item/" + "a".repeat(32), {}, null)).status, 401);
  });

  it("reports per-source counts for the UI filters", async () => {
    const h = (await (await call("/health")).json()) as { bySource: Record<string, number>; byKind: Record<string, number> };
    assert.ok(Object.values(h.bySource).reduce((a, b) => a + b, 0) >= 1);
    assert.ok(Object.keys(h.byKind).length >= 1);
  });
});
