import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdownFile, ObsidianAdapter, getDefaultVaultPath } from "./obsidian-adapter.js";

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

  describe("ObsidianAdapter lifecycle", () => {
    it("reports 100% airGapped: true in getStatus", async () => {
      const adapter = new ObsidianAdapter(getDefaultVaultPath());
      const status = await adapter.getStatus();
      assert.equal(status.id, "obsidian");
      assert.equal(status.airGapped, true);
      assert.equal(status.status, "connected");
      adapter.dispose();
    });
  });
});
