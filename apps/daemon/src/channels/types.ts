/**
 * @file types.ts
 * Type definitions for Sovereign Exocortex Integration Channels.
 */

export type ChannelId = "obsidian" | "notion" | "gmail";

export type ChannelConnectionStatus = "connected" | "disconnected" | "syncing" | "error";

export interface ChannelStatus {
  id: ChannelId;
  name: string;
  description: string;
  status: ChannelConnectionStatus;
  itemCount: number;
  lastSyncAt?: string;
  configSummary?: string;
  error?: string;
  airGapped: boolean;
}

export interface SyncResult {
  channelId: ChannelId;
  itemsSynced: number;
  durationMs: number;
  error?: string;
}

export interface ChannelAdapter {
  readonly id: ChannelId;
  readonly name: string;
  getStatus(): Promise<ChannelStatus>;
  configure(config: Record<string, unknown>): Promise<void>;
  sync(): Promise<SyncResult>;
  disconnect(): Promise<void>;
  dispose(): void;
}

export interface IngestedDocument {
  id: string;
  channelId: ChannelId;
  title: string;
  body: string;
  sourcePath?: string;
  tags: string[];
  wikilinks: string[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  untrusted: boolean;
}

export interface IngestedEntity {
  id: string;
  type: "PERSON" | "PROJECT" | "TASK" | "DOC" | "TOPIC";
  name: string;
  channelId: ChannelId;
  properties?: Record<string, unknown>;
  untrusted: boolean;
}
