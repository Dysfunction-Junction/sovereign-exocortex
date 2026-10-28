import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseMarkdownFile, ObsidianAdapter, getDefaultVaultPath } from "./obsidian-adapter.js";
import type { IngestedDocument } from "./types.js";

describe("obsidian-adapter", () => {
  describe("parseMarkdownFile", () => {
    it("extracts frontmatter, title, tags, and wikilinks", () => {
      const content = `---
title: Project Exocortex
tags: ai, world-model
author: operator
---

# Project Exocortex Overview

Here is a note that references [[Living Brain]] and also links to [[Active Inference#Theory|Active Inference Theory]].
We are collaborating with #research and tracking progress under #release-v3.
`;

      const parsed = parseMarkdownFile(content, "default_title");

      assert.equal(parsed.title, "Project Exocortex");
      assert.equal(parsed.frontmatter.author, "operator");
      assert.ok(parsed.wikilinks.includes("Living Brain"));
      assert.ok(parsed.wikilinks.includes("Active Inference"));
      assert.ok(parsed.tags.includes("ai"));
      assert.ok(parsed.tags.includes("world-model"));
      assert.ok(parsed.tags.includes("research"));
      assert.ok(parsed.tags.includes("release-v3"));
      assert.ok(parsed.body.includes("Here is a note that references"));
    });

    it("falls back to first H1 when no frontmatter title exists", () => {
      const content = `# Architecture Note\n\nSome body text referencing [[Other Note]].`;
      const parsed = parseMarkdownFile(content, "fallback");
      assert.equal(parsed.title, "Architecture Note");
      assert.deepEqual(parsed.wikilinks, ["Other Note"]);
    });

    it("falls back to filename when no frontmatter or H1 exists", () => {
      const content = `Just plain text without headers.`;
      const parsed = parseMarkdownFile(content, "MyCustomNote");
      assert.equal(parsed.title, "MyCustomNote");
    });
  });

  describe("getDefaultVaultPath", () => {
    it("respects OBSIDIAN_VAULT_PATH environment variable override", () => {
      const original = process.env.OBSIDIAN_VAULT_PATH;
      try {
        process.env.OBSIDIAN_VAULT_PATH = "C:\\Custom\\TestVault";
        assert.equal(getDefaultVaultPath(), "C:\\Custom\\TestVault");
      } finally {
        if (original !== undefined) {
          process.env.OBSIDIAN_VAULT_PATH = original;
        } else {
          delete process.env.OBSIDIAN_VAULT_PATH;
        }
      }
    });
  });

  describe("ObsidianAdapter lifecycle", () => {
    let tempVaultDir: string;
    const activeAdapters: ObsidianAdapter[] = [];

    const createAdapter = (
      vaultPath?: string,
      onDoc?: (doc: IngestedDocument) => void,
    ): ObsidianAdapter => {
      const adapter = new ObsidianAdapter(vaultPath, onDoc);
      activeAdapters.push(adapter);
      return adapter;
    };

    before(async () => {
      tempVaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-vault-"));
      await fs.writeFile(
        path.join(tempVaultDir, "Note 1.md"),
        `# Note 1 Heading\n\nThis note references [[Note 2]] and #project.\n`,
        "utf-8",
      );
      await fs.writeFile(
        path.join(tempVaultDir, "Note 2.md"),
        `---\ntags: reference\n---\n# Note 2 Title\n\nContent for note 2.\n`,
        "utf-8",
      );
      await fs.writeFile(
        path.join(tempVaultDir, "Plain.md"),
        `Plain note content without frontmatter or headers.\n`,
        "utf-8",
      );
    });

    afterEach(() => {
      while (activeAdapters.length > 0) {
        const adapter = activeAdapters.pop();
        adapter?.dispose();
      }
    });

    after(async () => {
      if (tempVaultDir) {
        await fs.rm(tempVaultDir, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        });
      }
    });

    it("reports connected and 100% airGapped: true when vault exists", async () => {
      const adapter = createAdapter(tempVaultDir);
      const status = await adapter.getStatus();
      assert.equal(status.id, "obsidian");
      assert.equal(status.airGapped, true);
      assert.equal(status.status, "connected");
    });

    it("reports disconnected status when vault path does not exist", async () => {
      const adapter = createAdapter(path.join(tempVaultDir, "non_existent_folder"));
      const status = await adapter.getStatus();
      assert.equal(status.id, "obsidian");
      assert.equal(status.airGapped, true);
      assert.equal(status.status, "disconnected");
    });

    it("syncs notes and extracts wikilinks and tags from temp vault", async () => {
      const ingested: IngestedDocument[] = [];
      const adapter = createAdapter(tempVaultDir, (doc) => {
        ingested.push(doc);
      });
      const result = await adapter.sync();
      assert.equal(result.itemsSynced, 3);
      assert.equal(ingested.length, 3);

      const note1 = ingested.find((d) => d.title === "Note 1 Heading");
      assert.ok(note1);
      assert.deepEqual(note1.wikilinks, ["Note 2"]);
      assert.ok(note1.tags.includes("project"));

      const note2 = ingested.find((d) => d.title === "Note 2 Title");
      assert.ok(note2);
      assert.ok(note2.tags.includes("reference"));

      const plain = ingested.find((d) => d.title === "Plain");
      assert.ok(plain);

      const status = await adapter.getStatus();
      assert.equal(status.status, "connected");
      assert.equal(status.itemCount, 3);
    });
  });
});
