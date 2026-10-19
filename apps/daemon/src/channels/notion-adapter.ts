/**
 * @file notion-adapter.ts
 * Notion Workspace Adapter for Sovereign Exocortex.
 * Supports both Live API Mode (gated by Air-Gap) and Offline Export Folder Mode.
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { AirGapPolicy } from "./air-gap.js";
import type { ChannelAdapter, ChannelStatus, SyncResult, IngestedDocument, IngestedEntity } from "./types.js";

export class NotionAdapter implements ChannelAdapter {
  readonly id = "notion";
  readonly name = "Notion Workspace";

  private apiKey?: string;
  private offlineExportPath?: string;
  private status: ChannelStatus = {
    id: "notion",
    name: "Notion Workspace",
    description: "Database and task synchronization via Notion REST API or offline export",
    status: "disconnected",
    itemCount: 0,
    airGapped: false,
  };

  private onEntityIngested?: (entity: IngestedEntity | IngestedDocument) => void;

  constructor(apiKey?: string, onEntity?: (entity: IngestedEntity | IngestedDocument) => void) {
    if (apiKey) this.apiKey = apiKey;
    if (onEntity) this.onEntityIngested = onEntity;
  }

  setEntityListener(listener: (entity: IngestedEntity | IngestedDocument) => void): void {
    this.onEntityIngested = listener;
  }

  async getStatus(): Promise<ChannelStatus> {
    const isConfigured = Boolean(this.apiKey || (this.offlineExportPath && existsSync(this.offlineExportPath)));
    return {
      ...this.status,
      status: isConfigured ? (this.status.status === "syncing" ? "syncing" : "connected") : "disconnected",
      configSummary: this.offlineExportPath ? `Offline: ${this.offlineExportPath}` : this.apiKey ? "API Token Configured" : undefined,
      airGapped: Boolean(this.offlineExportPath && !this.apiKey),
    };
  }

  async configure(config: Record<string, unknown>): Promise<void> {
    if (typeof config.apiKey === "string" && config.apiKey.trim().length > 0) {
      this.apiKey = config.apiKey.trim();
    }
    if (typeof config.offlineExportPath === "string" && config.offlineExportPath.trim().length > 0) {
      this.offlineExportPath = config.offlineExportPath.trim();
    }
    this.status.status = this.apiKey || this.offlineExportPath ? "connected" : "disconnected";
  }

  async sync(): Promise<SyncResult> {
    const start = Date.now();
    this.status.status = "syncing";

    // Mode A: Offline Export Mode (Air-Gap Compliant)
    if (this.offlineExportPath && existsSync(this.offlineExportPath)) {
      return this.syncOfflineFolder(start);
    }

    // Mode B: Live API Mode (Requires Outbound Network)
    if (!this.apiKey) {
      this.status.status = "disconnected";
      return {
        channelId: "notion",
        itemsSynced: 0,
        durationMs: Date.now() - start,
        error: "Notion API key or offline export path is required",
      };
    }

    try {
      AirGapPolicy.assertOutboundAllowed("api.notion.com");

      const res = await fetch("https://api.notion.com/v1/search", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ page_size: 50 }),
      });

      if (!res.ok) {
        throw new Error(`Notion API returned HTTP ${res.status}: ${res.statusText}`);
      }

      const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
      const results = data.results || [];
      let count = 0;

      for (const item of results) {
        const id = String(item.id || "");
        const objType = String(item.object || "");
        const props = (item.properties || {}) as Record<string, Record<string, unknown>>;

        let title = "Untitled Notion Item";
        for (const val of Object.values(props)) {
          if (val?.type === "title" && Array.isArray(val.title) && val.title[0]?.plain_text) {
            title = String(val.title[0].plain_text);
            break;
          }
        }

        const entityType = objType === "database" ? "PROJECT" : "DOC";
        const entity: IngestedEntity = {
          id: `notion:${id}`,
          type: entityType,
          name: title,
          channelId: "notion",
          properties: {
            url: item.url,
            archived: item.archived,
          },
          untrusted: false,
        };

        count++;
        if (this.onEntityIngested) {
          this.onEntityIngested(entity);
        }
      }

      this.status.status = "connected";
      this.status.itemCount = count;
      this.status.lastSyncAt = new Date().toISOString();
      this.status.error = undefined;

      return {
        channelId: "notion",
        itemsSynced: count,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      this.status.status = "error";
      this.status.error = err instanceof Error ? err.message : String(err);
      return {
        channelId: "notion",
        itemsSynced: 0,
        durationMs: Date.now() - start,
        error: this.status.error,
      };
    }
  }

  private async syncOfflineFolder(start: number): Promise<SyncResult> {
    try {
      const dir = this.offlineExportPath!;
      const entries = await readdir(dir, { withFileTypes: true });
      let count = 0;

      for (const entry of entries) {
        if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
          const fullPath = join(dir, entry.name);
          const content = await readFile(fullPath, "utf-8");
          const title = basename(entry.name, ".md").replace(/[_-]+/g, " ");

          const doc: IngestedDocument = {
            id: `notion:offline:${entry.name}`,
            channelId: "notion",
            title,
            body: content.slice(0, 5000),
            tags: ["notion-export"],
            wikilinks: [],
            metadata: { sourcePath: fullPath },
            createdAt: Date.now(),
            updatedAt: Date.now(),
            untrusted: false,
          };

          count++;
          if (this.onEntityIngested) {
            this.onEntityIngested(doc);
          }
        }
      }

      this.status.status = "connected";
      this.status.itemCount = count;
      this.status.lastSyncAt = new Date().toISOString();
      this.status.error = undefined;

      return {
        channelId: "notion",
        itemsSynced: count,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      this.status.status = "error";
      this.status.error = err instanceof Error ? err.message : String(err);
      return {
        channelId: "notion",
        itemsSynced: 0,
        durationMs: Date.now() - start,
        error: this.status.error,
      };
    }
  }

  async disconnect(): Promise<void> {
    this.apiKey = undefined;
    this.offlineExportPath = undefined;
    this.status.status = "disconnected";
  }

  dispose(): void {
    this.apiKey = undefined;
  }
}
