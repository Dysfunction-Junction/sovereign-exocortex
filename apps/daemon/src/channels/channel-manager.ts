/**
 * @file channel-manager.ts
 * Master Channel Manager for Sovereign Exocortex.
 * Manages Obsidian, Notion, and Gmail adapters, background schedulers, and entity routing.
 */

import { ObsidianAdapter, getDefaultVaultPath } from "./obsidian-adapter.js";
import { NotionAdapter } from "./notion-adapter.js";
import { GmailAdapter } from "./gmail-adapter.js";
import { AirGapPolicy } from "./air-gap.js";
import type { ChannelAdapter, ChannelId, ChannelStatus, SyncResult, IngestedDocument, IngestedEntity } from "./types.js";
import type { WorldModelHost } from "../world-model-host.js";

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

  constructor(options?: {
    obsidianVaultPath?: string;
    onDocument?: (doc: IngestedDocument) => void;
    onEntity?: (entity: IngestedEntity) => void;
  }) {
    this.onDocumentIngested = options?.onDocument;
    this.onEntityIngested = options?.onEntity;

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

      for (const tag of doc.tags) {
        const topicId = `topic:${tag.toLowerCase()}`;
        if (!graph.getEntity(topicId)) {
          graph.addEntity({
            id: topicId,
            type: "TOPIC",
            name: `#${tag}`,
            activation: 0.8,
            lastActive: Date.now(),
          });
        }
        try {
          graph.addEdge(doc.id, topicId, "HAS_TOPIC", 0.8);
        } catch {
          // Safe edge insert
        }
      }

      for (const link of doc.wikilinks) {
        const cleanLink = link.toLowerCase().replace(/\\/g, "/");
        const targetId = `doc:${cleanLink}`;
        if (!graph.getEntity(targetId)) {
          graph.addEntity({
            id: targetId,
            type: "DOC",
            name: link,
            activation: 0.5,
            lastActive: Date.now(),
          });
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
  }

  purgeChannel(id: ChannelId): number {
    if (!this.worldModelHost) return 0;
    let removed = 0;
    for (const prefix of CHANNEL_ENTITY_PREFIXES[id]) {
      removed += this.worldModelHost.lifeGraph.removeEntitiesByPrefix(prefix);
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

export const defaultChannelManager = new ChannelManager({
  obsidianVaultPath: getDefaultVaultPath(),
});
