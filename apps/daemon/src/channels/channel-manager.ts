/**
 * @file channel-manager.ts
 * Master Channel Manager for Sovereign Exocortex.
 * Manages Obsidian, Notion, and Gmail adapters, background schedulers, and entity routing.
 *
 * Spec R6 / Row 1.2: Channel data ingestion is event-sourced. Direct graph entity/edge
 * mutations are removed. Adapters store human-readable content in the private
 * ChannelVault and append validated channel.* events to the event log.
 */

import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ObsidianAdapter, getDefaultVaultPath, resolveVaultPath } from "./obsidian-adapter.js";
import { NotionAdapter } from "./notion-adapter.js";
import { GmailAdapter } from "./gmail-adapter.js";
import { AirGapPolicy } from "./air-gap.js";
import type { ChannelAdapter, ChannelId, ChannelStatus, SyncResult, IngestedDocument, IngestedEntity } from "./types.js";
import type { WorldModelHost } from "../world-model-host.js";
import type { EventRecord } from "@exocortex/core";
import type { ExocortexDatabase } from "@exocortex/core/db";
import { getDatabase, hasDatabase } from "../db-host.js";
import { scheduleIngestProcessing } from "../ingest-scheduler.js";
import { ChannelVault } from "./channel-vault.js";
import {
  buildDocumentUpserted,
  buildEntityUpserted,
  buildLinkUpserted,
  buildChannelDisconnected,
  appendChannelEvent,
} from "./channel-events.js";

// Entity id prefixes each adapter writes (see the adapters' `id:` fields); purge must match them.
const CHANNEL_ENTITY_PREFIXES: Record<ChannelId, readonly string[]> = {
  obsidian: ["doc:obsidian:"],
  notion: ["notion:"],
  gmail: ["gmail:"],
};

export interface ChannelManagerOptions {
  obsidianVaultPath?: string;
  /** JSON file remembering the linked vault across restarts (non-secret settings only). */
  configPath?: string;
  onDocument?: (doc: IngestedDocument) => void;
  onEntity?: (entity: IngestedEntity) => void;
  db?: ExocortexDatabase | null;
  vault?: ChannelVault | null;
}

export class ChannelManager {
  private adapters: Map<ChannelId, ChannelAdapter> = new Map();
  private auditSink: ((item: IngestedDocument | IngestedEntity) => void) | null = null;
  public onDocumentIngested: (doc: IngestedDocument) => void;
  public onEntityIngested: (entity: IngestedEntity) => void;
  private customOnDocument?: (doc: IngestedDocument) => void;
  private customOnEntity?: (entity: IngestedEntity) => void;
  private worldModelHost?: WorldModelHost;
  private readonly configPath?: string;
  private db?: ExocortexDatabase | null;
  private vault?: ChannelVault | null;

  constructor(options?: ChannelManagerOptions) {
    this.customOnDocument = options?.onDocument;
    this.customOnEntity = options?.onEntity;
    this.configPath = options?.configPath;
    this.db = options?.db ?? null;
    this.vault = options?.vault ?? null;

    this.onDocumentIngested = (doc) => {
      this.handleDocumentIngested(doc);
    };

    this.onEntityIngested = (entity) => {
      this.handleEntityIngested(entity);
    };

    // 1. Initialize Obsidian Adapter
    const obsidian = new ObsidianAdapter(options?.obsidianVaultPath, (doc) => {
      this.onDocumentIngested(doc);
    });
    this.adapters.set("obsidian", obsidian);

    // 2. Initialize Notion Adapter
    const notion = new NotionAdapter(undefined, (item) => {
      if ("body" in item) {
        this.onDocumentIngested(item as IngestedDocument);
      } else {
        this.onEntityIngested(item as IngestedEntity);
      }
    });
    this.adapters.set("notion", notion);

    // 3. Initialize Gmail Adapter
    const gmail = new GmailAdapter(undefined, (item) => {
      if ("body" in item) {
        this.onDocumentIngested(item as IngestedDocument);
      } else {
        this.onEntityIngested(item as IngestedEntity);
      }
    });
    this.adapters.set("gmail", gmail);
  }

  setDatabase(db: ExocortexDatabase | null): void {
    this.db = db;
    if (db && !this.vault) {
      this.vault = new ChannelVault(db);
    }
  }

  setVault(vault: ChannelVault | null): void {
    this.vault = vault;
  }

  private getDb(): ExocortexDatabase | null {
    if (this.db) return this.db;
    try {
      return hasDatabase() ? getDatabase() : null;
    } catch {
      return null;
    }
  }

  private getVault(): ChannelVault | null {
    if (this.vault) return this.vault;
    const db = this.getDb();
    if (db) {
      this.vault = new ChannelVault(db);
      return this.vault;
    }
    return null;
  }

  getChannelKey(id: ChannelId): Uint8Array | null {
    return this.getVault()?.getChannelKey(id) ?? null;
  }

  getChannelVault(): ChannelVault | null {
    return this.getVault();
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
  }

  private processInsertedEvent(event: EventRecord | null, db: ExocortexDatabase): void {
    if (!event) return;
    if (scheduleIngestProcessing(db)) return;
    this.worldModelHost?.onEventsAppended([event], db);
  }

  private handleDocumentIngested(doc: IngestedDocument): void {
    this.auditSink?.(doc);
    if (this.customOnDocument) {
      this.customOnDocument(doc);
    }

    const db = this.getDb();
    const vault = this.getVault();
    if (!db || !vault) return;

    const channelKey = vault.getChannelKey(doc.channelId);
    if (!channelKey) return;

    // 1. Human-readable fields put into private AES-256-GCM vault
    const ref = vault.put(doc.channelId, {
      title: doc.title,
      body: doc.body,
      ...(doc.sourcePath ? { url: doc.sourcePath } : {}),
    });

    // 2. Append channel.document.upserted event with zero plaintext
    const docEvent = buildDocumentUpserted({
      channel: doc.channelId,
      channelKey,
      naturalId: doc.id,
      content: doc.body,
      ref,
      observedAt: doc.createdAt || Date.now(),
    });
    const insertedDoc = appendChannelEvent(db, docEvent);
    this.processInsertedEvent(insertedDoc, db);

    // 3. Append channel.link.upserted events for outgoing wikilinks
    if (Array.isArray(doc.wikilinks)) {
      for (const link of doc.wikilinks) {
        const cleanLink = link.toLowerCase().replace(/\\/g, "/");
        const bareLink = link.replace(/\\/g, "/").replace(/\.md$/i, "");
        const targetNaturalId = bareLink.includes("/") ? `doc:obsidian:${bareLink}.md` : `doc:${cleanLink}`;
        const toKey = createHmac("sha256", channelKey).update(targetNaturalId, "utf8").digest("hex");
        const linkEvent = buildLinkUpserted({
          channel: doc.channelId,
          fromKey: docEvent.payload.doc_key as string,
          toKey,
          rel: "links_to",
          observedAt: doc.updatedAt || Date.now(),
        });
        const insertedLink = appendChannelEvent(db, linkEvent);
        this.processInsertedEvent(insertedLink, db);
      }
    }
  }

  private handleEntityIngested(entity: IngestedEntity): void {
    this.auditSink?.(entity);
    if (this.customOnEntity) {
      this.customOnEntity(entity);
    }

    const db = this.getDb();
    const vault = this.getVault();
    if (!db || !vault) return;

    const channelKey = vault.getChannelKey(entity.channelId);
    if (!channelKey) return;

    const props = (entity.properties || {}) as Record<string, unknown>;
    const email = typeof props.email === "string" ? props.email : undefined;
    const url = typeof props.url === "string" ? props.url : undefined;

    // 1. Human-readable fields put into private AES-256-GCM vault
    const ref = vault.put(entity.channelId, {
      display_name: entity.name,
      ...(email ? { email } : {}),
      ...(url ? { url } : {}),
    });

    // 2. Append channel.entity.upserted event with zero plaintext
    const entityType = entity.type.toUpperCase() === "PROJECT" ? "project" : "person";
    const naturalId = email ? email.toLowerCase() : entity.id;

    const entityEvent = buildEntityUpserted({
      channel: entity.channelId,
      channelKey,
      entityType,
      naturalId,
      ref,
      observedAt: Date.now(),
    });
    const insertedEntity = appendChannelEvent(db, entityEvent);
    this.processInsertedEvent(insertedEntity, db);
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
    const vault = this.getVault();
    let removed = 0;
    if (vault) {
      removed += vault.purgeChannel(id);
    }
    if (this.worldModelHost) {
      removed += this.worldModelHost.purgeChannelEntities(id);
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
    const db = this.getDb();
    if (db) {
      const insertedDisc = appendChannelEvent(db, buildChannelDisconnected(id));
      this.processInsertedEvent(insertedDisc, db);
    }
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
  const base = process.env.LOCALAPPDATA
    || (process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : join(homedir(), ".config"));
  return join(base, "exocortex", "channels.json");
}

export const defaultChannelManager = new ChannelManager({
  obsidianVaultPath: getDefaultVaultPath(),
  configPath: process.env.NODE_ENV === "test" ? undefined : getChannelConfigPath(),
});
