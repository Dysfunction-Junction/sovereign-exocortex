/**
 * @file obsidian-adapter.ts
 * 100% Offline, Air-Gapped Obsidian Vault Adapter for Sovereign Exocortex.
 * Per-file debounced watcher, robust error isolation, and frontmatter/tag/wikilink parsing.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { join, extname, basename, relative } from "node:path";
import type { ChannelAdapter, ChannelStatus, SyncResult, IngestedDocument } from "./types.js";

export interface ObsidianConfig {
  vaultPath: string;
  watchEnabled?: boolean;
}

export interface ParsedMarkdown {
  title: string;
  body: string;
  tags: string[];
  wikilinks: string[];
  frontmatter: Record<string, unknown>;
}

const DEFAULT_VAULT_PATH = "C:\\Users\\micha\\Vault";
// Exclude embeds ![[...]] from wikilinks
const WIKILINK_REGEX = /(?<!\!)\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
const TAG_REGEX = /(?:^|\s)#([a-zA-Z0-9_\-/]+)/g;
const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Parses raw markdown text extracting title, frontmatter, tags, and wikilinks.
 */
export function parseMarkdownFile(content: string, fallbackTitle: string): ParsedMarkdown {
  let body = content;
  const frontmatter: Record<string, unknown> = {};

  const fmMatch = content.match(FRONTMATTER_REGEX);
  if (fmMatch) {
    const rawFm = fmMatch[1];
    body = content.slice(fmMatch[0].length);
    // Parse key-values and lists
    for (const line of rawFm.split(/\r?\n/)) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const rawVal = line.slice(colonIdx + 1).trim();
        // Strip quotes or brackets
        const cleanVal = rawVal.replace(/^["'\[]+|["'\]]+$/g, "").trim();
        frontmatter[key] = cleanVal;
      }
    }
  }

  // Extract title (frontmatter title > first H1 > fallback filename)
  let title = typeof frontmatter.title === "string" ? frontmatter.title : "";
  if (!title) {
    const h1Match = body.match(/^#\s+(.+)$/m);
    if (h1Match) {
      title = h1Match[1].trim();
    } else {
      title = fallbackTitle;
    }
  }

  // Strip code blocks before scanning tags and wikilinks to prevent code comments from leaking
  const strippedBody = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");

  // Extract wikilinks (skipping embeds)
  const wikilinks = new Set<string>();
  let wlMatch: RegExpExecArray | null;
  const wlScanner = new RegExp(WIKILINK_REGEX.source, "g");
  while ((wlMatch = wlScanner.exec(strippedBody)) !== null) {
    const target = wlMatch[1].trim();
    if (target) wikilinks.add(target);
  }

  // Extract tags from body
  const tags = new Set<string>();
  let tagMatch: RegExpExecArray | null;
  const tagScanner = new RegExp(TAG_REGEX.source, "g");
  while ((tagMatch = tagScanner.exec(strippedBody)) !== null) {
    const tag = tagMatch[1].trim();
    if (tag) tags.add(tag);
  }

  // Also include tags from frontmatter if present
  if (typeof frontmatter.tags === "string") {
    frontmatter.tags
      .split(/[, ]+/)
      .map((t) => t.replace(/^#/, "").trim())
      .filter(Boolean)
      .forEach((t) => tags.add(t));
  }

  return {
    title,
    body: body.trim(),
    tags: Array.from(tags),
    wikilinks: Array.from(wikilinks),
    frontmatter,
  };
}

export class ObsidianAdapter implements ChannelAdapter {
  readonly id = "obsidian";
  readonly name = "Obsidian Local Vault";

  private vaultPath: string = DEFAULT_VAULT_PATH;
  private watchEnabled = true;
  private status: ChannelStatus = {
    id: "obsidian",
    name: "Obsidian Local Vault",
    description: "Local-first markdown vault watcher and graph link extractor",
    status: "disconnected",
    itemCount: 0,
    airGapped: true,
  };

  private watcher: FSWatcher | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private onDocumentIngested?: (doc: IngestedDocument) => void;

  constructor(vaultPath?: string, onDoc?: (doc: IngestedDocument) => void) {
    if (vaultPath) this.vaultPath = vaultPath;
    if (onDoc) this.onDocumentIngested = onDoc;
  }

  setDocumentListener(listener: (doc: IngestedDocument) => void): void {
    this.onDocumentIngested = listener;
  }

  async getStatus(): Promise<ChannelStatus> {
    const exists = existsSync(this.vaultPath);
    return {
      ...this.status,
      status: exists ? (this.status.status === "syncing" ? "syncing" : "connected") : "disconnected",
      configSummary: this.vaultPath,
      airGapped: true,
    };
  }

  async configure(config: Record<string, unknown>): Promise<void> {
    if (typeof config.vaultPath === "string" && config.vaultPath.trim().length > 0) {
      this.vaultPath = config.vaultPath.trim();
    }
    if (typeof config.watchEnabled === "boolean") {
      this.watchEnabled = config.watchEnabled;
    }

    if (this.watchEnabled && existsSync(this.vaultPath)) {
      this.startWatching();
    } else {
      this.stopWatching();
    }
  }

  async sync(): Promise<SyncResult> {
    const start = Date.now();
    this.status.status = "syncing";

    if (!existsSync(this.vaultPath)) {
      this.status.status = "error";
      this.status.error = `Vault path not found: ${this.vaultPath}`;
      return {
        channelId: "obsidian",
        itemsSynced: 0,
        durationMs: Date.now() - start,
        error: this.status.error,
      };
    }

    try {
      const files: string[] = [];
      await this.scanMarkdownFiles(this.vaultPath, files);

      let syncedCount = 0;
      for (const filePath of files) {
        try {
          const content = await readFile(filePath, "utf-8");
          const fileStat = await stat(filePath).catch(() => null);
          const fallbackTitle = basename(filePath, extname(filePath));
          const parsed = parseMarkdownFile(content, fallbackTitle);
          const relPath = relative(this.vaultPath, filePath);

          const doc: IngestedDocument = {
            id: `doc:obsidian:${relPath.replace(/\\/g, "/")}`,
            channelId: "obsidian",
            title: parsed.title,
            body: parsed.body,
            sourcePath: filePath,
            tags: parsed.tags,
            wikilinks: parsed.wikilinks,
            metadata: parsed.frontmatter,
            createdAt: fileStat?.birthtimeMs || Date.now(),
            updatedAt: fileStat?.mtimeMs || Date.now(),
            untrusted: false,
          };

          syncedCount++;
          if (this.onDocumentIngested) {
            this.onDocumentIngested(doc);
          }
        } catch {
          // Skip unreadable files safely
        }
      }

      this.status.status = "connected";
      this.status.itemCount = syncedCount;
      this.status.lastSyncAt = new Date().toISOString();
      this.status.error = undefined;

      if (this.watchEnabled && !this.watcher) {
        this.startWatching();
      }

      return {
        channelId: "obsidian",
        itemsSynced: syncedCount,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      this.status.status = "error";
      this.status.error = err instanceof Error ? err.message : String(err);
      return {
        channelId: "obsidian",
        itemsSynced: 0,
        durationMs: Date.now() - start,
        error: this.status.error,
      };
    }
  }

  async disconnect(): Promise<void> {
    this.stopWatching();
    this.status.status = "disconnected";
  }

  dispose(): void {
    this.stopWatching();
  }

  private startWatching(): void {
    this.stopWatching();
    if (!existsSync(this.vaultPath)) return;

    try {
      this.watcher = watch(this.vaultPath, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const norm = filename.toString();
        if (norm.split(/[/\\]/).some((part) => part.startsWith(".")) || !norm.endsWith(".md")) return;

        const targetFile = join(this.vaultPath, norm);
        const existingTimer = this.debounceTimers.get(targetFile);
        if (existingTimer) clearTimeout(existingTimer);

        const newTimer = setTimeout(() => {
          this.debounceTimers.delete(targetFile);
          this.handleFileChange(targetFile);
        }, 500);

        this.debounceTimers.set(targetFile, newTimer);
      });

      // Defensive error handling: prevent unhandled EPERM/lock crashes
      this.watcher.on("error", () => {
        this.stopWatching();
      });
    } catch {
      // Fallback gracefully if recursive watch is unsupported
    }
  }

  private stopWatching(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // Safe close
      }
      this.watcher = null;
    }
  }

  private async handleFileChange(fullPath: string): Promise<void> {
    if (!existsSync(fullPath)) return;
    try {
      const content = await readFile(fullPath, "utf-8");
      const fileStat = await stat(fullPath).catch(() => null);
      const fallbackTitle = basename(fullPath, extname(fullPath));
      const parsed = parseMarkdownFile(content, fallbackTitle);
      const relPath = relative(this.vaultPath, fullPath);

      const doc: IngestedDocument = {
        id: `doc:obsidian:${relPath.replace(/\\/g, "/")}`,
        channelId: "obsidian",
        title: parsed.title,
        body: parsed.body,
        sourcePath: fullPath,
        tags: parsed.tags,
        wikilinks: parsed.wikilinks,
        metadata: parsed.frontmatter,
        createdAt: fileStat?.birthtimeMs || Date.now(),
        updatedAt: fileStat?.mtimeMs || Date.now(),
        untrusted: false,
      };

      if (this.onDocumentIngested) {
        this.onDocumentIngested(doc);
      }
    } catch {
      // Ignore transient write lock errors
    }
  }

  private async scanMarkdownFiles(dir: string, results: string[], maxDepth = 6, depth = 0): Promise<void> {
    if (depth > maxDepth) return;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue; // Skip all dot-dirs
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await this.scanMarkdownFiles(full, results, maxDepth, depth + 1);
        } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
          results.push(full);
        }
      }
    } catch {
      // Ignore unreadable dirs
    }
  }
}
