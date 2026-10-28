import { pathToFileURL } from "node:url";
import { createHmac } from "node:crypto";
import type { ExocortexDatabase } from "@exocortex/core/db";
import { getDatabase } from "./db-host.js";
import { WorldModelHost, defaultWorldModelHost } from "./world-model-host.js";
import { ChannelVault } from "./channels/channel-vault.js";
import { ChannelManager, defaultChannelManager } from "./channels/channel-manager.js";

export interface ResyncResult {
  beforeCount: number;
  afterCount: number;
  syncedChannels: string[];
  replacedLegacyIds: string[];
}

/**
 * Re-reads connected channels through their adapters (the R6 path), emitting channel.*
 * events and private vault content, while migrating legacy person:<email> graph IDs
 * to deterministic keyed IDs (HMAC-SHA256).
 */
export async function resyncChannels(options: {
  manager?: ChannelManager;
  host?: WorldModelHost;
  db?: ExocortexDatabase;
} = {}): Promise<ResyncResult> {
  const db = options.db ?? getDatabase();
  const host = options.host ?? defaultWorldModelHost;
  const manager = options.manager ?? defaultChannelManager;
  const vault = manager.getChannelVault() ?? new ChannelVault(db);

  manager.attachToWorldModel(host);
  manager.setDatabase(db);
  manager.setVault(vault);
  host.setVault(vault);

  const beforeSnapshot = host.lifeGraph.snapshot();
  const beforeCount = beforeSnapshot.entities.length;
  const legacyPersonEntities = beforeSnapshot.entities
    .filter((entity) => entity.type === "PERSON" && entity.id.startsWith("person:") && entity.id.includes("@"));

  const syncedChannels: string[] = [];
  const channels = await manager.getChannels();
  for (const ch of channels) {
    if (ch.status === "connected" && !ch.airGapped) {
      const result = await manager.syncChannel(ch.id);
      if (result.error) throw new Error(`${ch.id} resync failed: ${result.error}`);
      syncedChannels.push(ch.id);
    }
  }

  const replacedLegacyIds: string[] = [];
  const rewrites = new Map<string, string>();
  const gmailKey = syncedChannels.includes("gmail") ? manager.getChannelKey("gmail") : null;
  if (gmailKey) for (const legacy of legacyPersonEntities) {
    const email = legacy.id.slice("person:".length).toLowerCase();
    const keyedId = `person:${createHmac("sha256", gmailKey).update(email, "utf8").digest("hex")}`;
    if (host.lifeGraph.getEntity(keyedId)) rewrites.set(legacy.id, keyedId);
  }
  for (const [legacyId, keyedId] of rewrites) {
    host.lifeGraph.removeEntity(legacyId);
    replacedLegacyIds.push(legacyId);
  }
  for (const edge of beforeSnapshot.edges) {
    const sourceId = rewrites.get(edge.sourceId) ?? edge.sourceId;
    const targetId = rewrites.get(edge.targetId) ?? edge.targetId;
    if (sourceId === edge.sourceId && targetId === edge.targetId) continue;
    if (!host.lifeGraph.getEntity(sourceId) || !host.lifeGraph.getEntity(targetId)) continue;
    const edgeId = `${sourceId}:${edge.relation}:${targetId}`;
    if (!host.lifeGraph.getEdge(edgeId)) {
      host.lifeGraph.addEdge(sourceId, targetId, edge.relation, edge.weight, edge.halfLifeDays);
    }
  }

  const afterCount = host.lifeGraph.entityCount;
  if (beforeCount !== afterCount) throw new Error(`resync entity count mismatch: before=${beforeCount} after=${afterCount}`);

  return {
    beforeCount,
    afterCount,
    syncedChannels,
    replacedLegacyIds,
  };
}

async function main(): Promise<void> {
  console.log("[channel-resync] Starting one-time channel re-sync...");
  try {
    const result = await resyncChannels();
    console.log(`[channel-resync] Entity count before: ${result.beforeCount}`);
    console.log(`[channel-resync] Synced channels: ${result.syncedChannels.join(", ") || "(none)"}`);
    console.log(`[channel-resync] Replaced legacy IDs: ${result.replacedLegacyIds.join(", ") || "(none)"}`);
    console.log(`[channel-resync] Entity count after: ${result.afterCount}`);
    console.log(`[channel-resync] Counts matched or verified successfully.`);
  } catch (err) {
    console.error("[channel-resync] Failed:", err);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
