import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, sep } from "node:path";
import { ObsidianAdapter, resolveVaultPath } from "./obsidian-adapter.js";
import { ChannelManager } from "./channel-manager.js";
import type { IngestedDocument } from "./types.js";

describe("vault linking", () => {
  let root: string;
  let vault: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "exo-vault-"));
    vault = join(root, "MyVault");
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    mkdirSync(join(vault, "Projects"), { recursive: true });
    writeFileSync(join(vault, "Index.md"), "# Index\n\nSee [[Plan]] #home\n");
    writeFileSync(join(vault, "Projects", "Plan.md"), "# Plan\n\nBody\n");
    writeFileSync(join(vault, ".obsidian", "workspace.md"), "# not a note\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("resolveVaultPath", () => {
    it("accepts an existing directory and reports whether it looks like an Obsidian vault", () => {
      const r = resolveVaultPath(vault);
      assert.equal(r.path, vault);
      assert.equal(r.hasObsidianConfig, true);
    });

    it("accepts a plain folder of markdown but flags it as not an Obsidian vault", () => {
      const plain = join(root, "plain");
      mkdirSync(plain);
      assert.equal(resolveVaultPath(plain).hasObsidianConfig, false);
    });

    it("expands a leading ~ to the home directory", () => {
      const r = resolveVaultPath("~");
      assert.equal(r.path, homedir());
    });

    it("rejects an empty, missing, or non-directory path with a clear reason", () => {
      assert.throws(() => resolveVaultPath("   "), /empty/i);
      assert.throws(() => resolveVaultPath(join(root, "nope")), /not found|does not exist/i);
      assert.throws(() => resolveVaultPath(join(vault, "Index.md")), /not a folder|not a directory/i);
    });

    it("rejects a path containing a NUL byte", () => {
      assert.throws(() => resolveVaultPath(`${vault}${sep}\0x`), /invalid/i);
    });
  });

  describe("ObsidianAdapter.configure", () => {
    it("rejects an invalid path and keeps the previous vault", async () => {
      const adapter = new ObsidianAdapter(vault);
      await assert.rejects(() => adapter.configure({ vaultPath: join(root, "nope"), watchEnabled: false }));
      assert.equal((await adapter.getStatus()).configSummary, vault);
      adapter.dispose();
    });

    it("syncs notes from the linked vault and skips .obsidian config", async () => {
      const docs: IngestedDocument[] = [];
      const adapter = new ObsidianAdapter(undefined, (d) => docs.push(d));
      await adapter.configure({ vaultPath: vault, watchEnabled: false });
      const result = await adapter.sync();
      assert.equal(result.error, undefined);
      assert.equal(result.itemsSynced, 2);
      assert.deepEqual(docs.map((d) => d.id).sort(), ["doc:obsidian:Index.md", "doc:obsidian:Projects/Plan.md"]);
      adapter.dispose();
    });
  });

  describe("linked folders inside a vault", () => {
    it("follows a folder link (junction/symlink) and ingests its notes", async () => {
      const external = join(root, "export");
      mkdirSync(join(external, "days"), { recursive: true });
      writeFileSync(join(external, "days", "Monday.md"), "# Monday\n");
      symlinkSync(external, join(vault, "Linked"), "junction");

      const docs: IngestedDocument[] = [];
      const adapter = new ObsidianAdapter(undefined, (d) => docs.push(d));
      await adapter.configure({ vaultPath: vault, watchEnabled: false });
      const result = await adapter.sync();
      assert.ok(docs.some((d) => d.id === "doc:obsidian:Linked/days/Monday.md"), `got ${docs.map((d) => d.id)}`);
      assert.equal(result.itemsSynced, 3);
      adapter.dispose();
    });

    it("does not loop forever when a link points back into the vault", async () => {
      symlinkSync(vault, join(vault, "Projects", "Loop"), "junction");
      const docs: IngestedDocument[] = [];
      const adapter = new ObsidianAdapter(undefined, (d) => docs.push(d));
      await adapter.configure({ vaultPath: vault, watchEnabled: false });
      const result = await adapter.sync();
      assert.equal(result.error, undefined);
      assert.equal(result.itemsSynced, 2);
      adapter.dispose();
    });
  });

  describe("ChannelManager persistence", () => {
    it("remembers the linked vault across restarts", async () => {
      const configPath = join(root, "channels.json");
      const first = new ChannelManager({ configPath, obsidianVaultPath: join(root, "unused") });
      await first.configureChannel("obsidian", { vaultPath: vault, watchEnabled: false });
      first.dispose();

      const second = new ChannelManager({ configPath, obsidianVaultPath: join(root, "unused") });
      await second.restoreSavedConfig();
      assert.equal((await second.getChannel("obsidian"))?.configSummary, vault);
      second.dispose();
    });

    it("does not persist a rejected path", async () => {
      const configPath = join(root, "channels.json");
      const m = new ChannelManager({ configPath });
      await assert.rejects(() => m.configureChannel("obsidian", { vaultPath: join(root, "nope") }));
      const again = new ChannelManager({ configPath, obsidianVaultPath: vault });
      await again.restoreSavedConfig();
      assert.equal((await again.getChannel("obsidian"))?.configSummary, vault);
      m.dispose();
      again.dispose();
    });

    it("ignores a corrupt or stale config file instead of crashing", async () => {
      const configPath = join(root, "channels.json");
      writeFileSync(configPath, "{not json");
      const m = new ChannelManager({ configPath, obsidianVaultPath: vault });
      await m.restoreSavedConfig();
      assert.equal((await m.getChannel("obsidian"))?.configSummary, vault);

      writeFileSync(configPath, JSON.stringify({ obsidian: { vaultPath: join(root, "deleted") } }));
      await m.restoreSavedConfig();
      assert.equal((await m.getChannel("obsidian"))?.configSummary, vault);
      m.dispose();
    });

    it("never writes secrets for other channels into the saved file", async () => {
      const configPath = join(root, "channels.json");
      const m = new ChannelManager({ configPath });
      await m.configureChannel("obsidian", { vaultPath: vault, watchEnabled: false });
      const saved = JSON.parse(await (await import("node:fs/promises")).readFile(configPath, "utf-8"));
      assert.deepEqual(Object.keys(saved), ["obsidian"]);
      assert.deepEqual(Object.keys(saved.obsidian).sort(), ["vaultPath", "watchEnabled"]);
      m.dispose();
    });
  });
});
