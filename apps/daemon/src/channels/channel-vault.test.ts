import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExocortexDatabase } from "@exocortex/core/db";
import { ChannelVault } from "./channel-vault.js";

test("channel vault encrypts, decrypts and crypto-shreds per-channel content", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  const keyDir = mkdtempSync(join(tmpdir(), "channel-vault-"));
  try {
    const vault = new ChannelVault(db, { keyDir, nowMs: () => 1234 });
    const content = { title: "PRIVATE TITLE", body: "PRIVATE BODY", display_name: "PRIVATE NAME", email: "private@example.test", url: "https://private.test" };
    const ref = vault.put("gmail", content);
    assert.deepEqual(vault.get(ref), content);

    const row = db.raw.prepare("SELECT ciphertext FROM channel_vault WHERE ref = ?").get(ref) as { ciphertext: Uint8Array };
    const ciphertext = Buffer.from(row.ciphertext);
    for (const secret of Object.values(content)) assert.ok(!ciphertext.includes(Buffer.from(secret)));
    const keyPath = join(keyDir, "gmail.key");
    assert.equal(readFileSync(keyPath).length, 32);
    if (process.platform !== "win32") assert.equal(statSync(keyPath).mode & 0o777, 0o600);

    assert.equal(vault.purgeChannel("gmail"), 1);
    assert.equal(existsSync(keyPath), false);
    assert.equal(vault.get(ref), null);
    assert.equal(Number((db.raw.prepare("SELECT COUNT(*) AS count FROM channel_vault").get() as { count: number }).count), 0);
    assert.equal(db.verifyEventChain().valid, true);
  } finally {
    db.close();
    rmSync(keyDir, { recursive: true, force: true });
  }
});

test("core database migration creates a vault table outside the event log", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    const table = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_vault'").get();
    assert.ok(table);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM events").get() && db.verifyEventChain().valid, true);
  } finally {
    db.close();
  }
});
