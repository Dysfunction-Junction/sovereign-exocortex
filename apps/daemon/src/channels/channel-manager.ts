/**
 * @file channel-manager.ts
 * Master Channel Manager for Sovereign Exocortex.
 * Manages Obsidian, Notion, and Gmail adapters, background schedulers, and entity routing.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ObsidianAdapter, getDefaultVaultPath, resolveVaultPath } from "./obsidian-adapter.js";
import { NotionAdapter } from "./notion-adapter.js";
import { GmailAdapter } from "./gmail-adapter.js";
import { AirGapPolicy } from "./air-gap.js";
import type { ChannelAdapter, ChannelId, ChannelStatus, SyncResult, IngestedDocument, IngestedEntity } from "./types.js";
import type { WorldModelHost } from "../world-model-host.js";
import { attachDocumentToOwner } from "@exocortex/world-model";

// Entity id prefixes each adapter writes (see the adapters' `id:` fields); purge must match them.
const CHANNEL_ENTITY_PREFIXES: Record<ChannelId, readonly string[]> = {
  obsidian: ["doc:obsidian:"],
  notion: ["notion:"],
  gmail: ["gmail:"],
};

export class ChannelManager {
  private adapters: Map<ChannelId, ChannelAdapter> = new Map();
  private auditSink: ((item: IngestedDocument | IngestedEntity) => void) | null = null;
  private onDocumentIngested?: (doc: IngestedDocument) => void;
  private onEntityIngested?: (entity: IngestedEntity) => void;
  private worldModelHost?: WorldModelHost;
  private readonly configPath?: string;

  constructor(options?: {
    obsidianVaultPath?: string;
    /** JSON file remembering the linked vault across restarts (non-secret settings only). */
    configPath?: string;
    onDocument?: (doc: IngestedDocument) => void;
    onEntity?: (entity: IngestedEntity) => void;
  }) {
    this.onDocumentIngested = options?.onDocument;
    this.onEntityIngested = options?.onEntity;
    this.configPath = options?.configPath;

    // 1. Initialize Obsidian Adapter
    const obsidian = new ObsidianAdapter(options?.obsidianVaultPath, (doc) => {
      if (this.onDocumentIngested) this.onDocumentIngested(doc);
    });
    this.adapters.set("obsidian", obsidian);

    // 2. Initialize Notion Adapter
    const notion = new NotionAdapter(undefined, (item) => {
      if ("body" in item && this.onDocumentIngested) {
        this.onDocumentIngested(item as IngestedDocument);
      } else if (this.onEntityIngested) {
        this.onEntityIngested(item as IngestedEntity);
      }
    });
    this.adapters.set("notion", notion);

    // 3. Initialize Gmail Adapter
    const gmail = new GmailAdapter(undefined, (item) => {
      if ("body" in item && this.onDocumentIngested) {
        this.onDocumentIngested(item as IngestedDocument);
      } else if (this.onEntityIngested) {
        this.onEntityIngested(item as IngestedEntity);
      }
    });
    this.adapters.set("gmail", gmail);
  }

  getAdapter(id: ChannelId): ChannelAdapter | undefined {
    return this.adapters.get(id);
  }

  /** Append metadata-only audit events to the event log for every ingested item. */
  setAuditSink(sink: ((item: IngestedDocument | IngestedEntity) => void) | null): void {
    this.auditSink = sink;
  }

  attachToWorldModel(worldModelHost: WorldModelHost): void {
    this.worldModelHost = worldModelHost;
    const graph = worldModelHost.lifeGraph;

    this.onDocumentIngested = (doc) => {
      this.auditSink?.(doc);
      const existing = graph.getEntity(doc.id);
      // Preserve existing decay activation rather than inflating to 1.0 on every re-sync
      const activation = existing ? existing.activation : 1.0;

      graph.addEntity({
        id: doc.id,
        type: "DOC",
        name: doc.title,
        properties: {
          ...(doc.metadata || {}),
          sourcePath: doc.sourcePath,
          tags: doc.tags,
          channelId: doc.channelId,
          untrusted: doc.untrusted, // Fixed field placed last to prevent clobbering
        },
        activation,
        lastActive: existing ? existing.lastActive : Date.now(),
      });

      // Tags are source metadata; each doc is filed under one project (or the operator), never a tag hub.
      attachDocumentToOwner(graph, { id: doc.id, name: doc.title, properties: { sourcePath: doc.sourcePath, tags: doc.tags } }, process.env.EXOCORTEX_OPERATOR_ID || "person_operator");

      for (const link of doc.wikilinks) {
        const cleanLink = link.toLowerCase().replace(/\\/g, "/");
        const bareLink = link.replace(/\\/g, "/").replace(/\.md$/i, "");
        const cleanBareLink = cleanLink.replace(/\.md$/i, "");

        let targetId = `doc:${cleanLink}`;
        const candidateObsidianId = `doc:obsidian:${bareLink}.md`;
        const candidateObsidianLower = `doc:obsidian:${cleanBareLink}.md`;

        if (graph.getEntity(candidateObsidianId)) {
          targetId = candidateObsidianId;
        } else if (graph.getEntity(candidateObsidianLower)) {
          targetId = candidateObsidianLower;
        } else {
          // Check existing entities for a case-insensitive path match
          for (const ent of graph.snapshot().entities) {
            if (ent.type === "DOC" && ent.id.toLowerCase() === candidateObsidianLower) {
              targetId = ent.id;
              break;
            }
          }
          // Direct project link if referencing Sovereign Exocortex monorepo
          if (cleanBareLink.includes("sovereign") && cleanBareLink.includes("exocortex") && graph.getEntity("project_sovereign_exocortex")) {
            targetId = "project_sovereign_exocortex";
          }
        }

        // If targetId is not an existing entity, prefer canonical doc:obsidian prefix for vault paths
        if (!graph.getEntity(targetId)) {
          if (bareLink.includes("/")) {
            targetId = `doc:obsidian:${bareLink}.md`;
          }
          if (!graph.getEntity(targetId)) {
            graph.addEntity({
              id: targetId,
              type: "DOC",
              name: link,
              activation: 0.5,
              lastActive: Date.now(),
            });
          }
        }
        try {
          graph.addEdge(doc.id, targetId, "REFERENCES", 0.9);
        } catch {
          // Safe edge insert
        }
      }
    };

    this.onEntityIngested = (entity) => {
      this.auditSink?.(entity);
      const existing = graph.getEntity(entity.id);
      const activation = existing ? existing.activation : 1.0;

      graph.addEntity({
        id: entity.id,
        type: entity.type,
        name: entity.name,
        properties: {
          ...(entity.properties || {}),
          channelId: entity.channelId,
          sourceChannel: (entity.properties as Record<string, unknown> | undefined)?.sourceChannel || entity.channelId,
          untrusted: entity.untrusted, // Fixed field placed last to prevent clobbering
        },
        activation,
        lastActive: existing ? existing.lastActive : Date.now(),
      });
    };
  }

  async getChannels(): Promise<ChannelStatus[]> {
    const statuses: ChannelStatus[] = [];
    for (const adapter of this.adapters.values()) {
      const status = await adapter.getStatus();
      statuses.push({
        ...status,
        airGapped: status.airGapped || AirGapPolicy.isAirGapActive(),
      });
    }
    return statuses;
  }

  async getChannel(id: ChannelId): Promise<ChannelStatus | undefined> {
    const adapter = this.adapters.get(id);
    if (!adapter) return undefined;
    const status = await adapter.getStatus();
    return {
      ...status,
      airGapped: status.airGapped || AirGapPolicy.isAirGapActive(),
    };
  }

  async configureChannel(id: ChannelId, config: Record<string, unknown>): Promise<void> {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new Error(`Unknown channel: ${id}`);
    }
    await adapter.configure(config);
    if (adapter instanceof ObsidianAdapter) this.saveObsidianConfig(adapter.getConfig());
  }

  /** Re-applies the vault link saved by a previous run. A missing, corrupt or stale file is ignored. */
  async restoreSavedConfig(): Promise<boolean> {
    if (!this.configPath) return false;
    try {
      const saved = JSON.parse(readFileSync(this.configPath, "utf-8"))?.obsidian;
      if (!saved || typeof saved.vaultPath !== "string") return false;
      const { path } = resolveVaultPath(saved.vaultPath);
      await this.adapters.get("obsidian")?.configure({
        vaultPath: path,
        watchEnabled: typeof saved.watchEnabled === "boolean" ? saved.watchEnabled : true,
      });
      return true;
    } catch {
      return false;
    }
  }

  private saveObsidianConfig(config: { vaultPath: string; watchEnabled: boolean }): void {
    if (!this.configPath) return;
    try {
      mkdirSync(dirname(this.configPath), { recursive: true });
      const tmp = `${this.configPath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ obsidian: config }, null, 2));
      renameSync(tmp, this.configPath);
    } catch {
      // Linking still works for this run; it just will not survive a restart.
    }
  }

  purgeChannel(id: ChannelId): number {
    if (!this.worldModelHost) return 0;
    const graph = this.worldModelHost.lifeGraph;
    let removed = 0;
    for (const prefix of CHANNEL_ENTITY_PREFIXES[id]) {
      removed += graph.removeEntitiesByPrefix(prefix);
    }
    // Also remove any entities tagged with this source channel (e.g. person: entities created by Gmail)
    for (const entity of graph.snapshot().entities) {
      const props = entity.properties as Record<string, unknown> | undefined;
      if (!props) continue;
      const isTagged =
        props.sourceChannel === id ||
        props.channelId === id ||
        (Array.isArray(props.tags) && (props.tags.includes(`source:${id}`) || props.tags.includes(id)));
      if (isTagged) {
        if (graph.removeEntity(entity.id)) {
          removed++;
        }
      }
    }
    return removed;
  }

  async syncChannel(id: ChannelId): Promise<SyncResult> {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new Error(`Unknown channel: ${id}`);
    }
    // Purge stale entities before fresh sync to remove deleted/ignored files
    this.purgeChannel(id);
    return adapter.sync();
  }

  async syncAll(): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    for (const id of this.adapters.keys()) {
      results.push(await this.syncChannel(id));
    }
    return results;
  }

  async disconnectChannel(id: ChannelId): Promise<void> {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new Error(`Unknown channel: ${id}`);
    }
    await adapter.disconnect();
    this.purgeChannel(id);
  }

  setAirGapMode(active: boolean): void {
    AirGapPolicy.setAirGapActive(active);
  }

  isAirGapActive(): boolean {
    return AirGapPolicy.isAirGapActive();
  }

  dispose(): void {
    for (const adapter of this.adapters.values()) {
      adapter.dispose();
    }
    this.adapters.clear();
  }
}

export function getChannelConfigPath(): string {
  if (process.env.EXOCORTEX_CHANNELS_CONFIG) return process.env.EXOCORTEX_CHANNELS_CONFIG;
  return join(process.env.LOCALAPPDATA || join(homedir(), ".exocortex"), "channels.json");
}

export const defaultChannelManager = new ChannelManager({
  obsidianVaultPath: getDefaultVaultPath(),
  configPath: process.env.NODE_ENV === "test" ? undefined : getChannelConfigPath(),
});
