import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExocortexDatabase } from "@exocortex/core/db";
import type { ChannelId } from "./types.js";

export interface ChannelVaultContent {
  title?: string;
  body?: string;
  display_name?: string;
  email?: string;
  url?: string;
}

export interface ChannelVaultOptions {
  keyDir?: string;
  nowMs?: () => number;
}

const CHANNELS: readonly ChannelId[] = ["gmail", "notion", "obsidian"];

function defaultKeyDir(): string {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "exocortex", "channel-keys");
  }
  return join(homedir(), ".local", "share", "exocortex", "channel-keys");
}

function validateContent(value: ChannelVaultContent): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("vault content must be an object");
  const allowed = new Set(["title", "body", "display_name", "email", "url"]);
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key) || typeof item !== "string") throw new TypeError(`invalid vault content field: ${key}`);
  }
}

export class ChannelVault {
  private readonly keyDir: string;
  private readonly nowMs: () => number;

  constructor(private readonly db: ExocortexDatabase, options: ChannelVaultOptions = {}) {
    this.keyDir = options.keyDir ?? defaultKeyDir();
    this.nowMs = options.nowMs ?? Date.now;
  }

  put(channel: ChannelId, content: ChannelVaultContent): string {
    validateContent(content);
    const ref = randomUUID();
    const key = this.channelKey(channel, true)!;
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(`${channel}:${ref}`, "utf8"));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(content), "utf8"), cipher.final()]);
    const ciphertext = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    this.db.raw.prepare("INSERT INTO channel_vault(ref, channel, ciphertext, created_at) VALUES (?, ?, ?, ?)")
      .run(ref, channel, ciphertext, this.nowMs());
    return ref;
  }

  get(ref: string): ChannelVaultContent | null {
    const row = this.db.raw.prepare("SELECT channel, ciphertext FROM channel_vault WHERE ref = ?").get(ref) as
      | { channel: ChannelId; ciphertext: Uint8Array }
      | undefined;
    if (!row) return null;
    const key = this.channelKey(row.channel, false);
    if (!key) return null;
    const packed = Buffer.from(row.ciphertext);
    if (packed.length < 28) throw new Error("invalid channel vault ciphertext");
    const nonce = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(`${row.channel}:${ref}`, "utf8"));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8");
    const content = JSON.parse(plain) as ChannelVaultContent;
    validateContent(content);
    return content;
  }

  purgeChannel(channel: ChannelId): number {
    const result = this.db.raw.prepare("DELETE FROM channel_vault WHERE channel = ?").run(channel);
    try {
      unlinkSync(this.keyPath(channel));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return Number(result.changes);
  }

  private keyPath(channel: ChannelId): string {
    if (!CHANNELS.includes(channel)) throw new TypeError("invalid channel id");
    return join(this.keyDir, `${channel}.key`);
  }

  private channelKey(channel: ChannelId, create: boolean): Buffer | null {
    const path = this.keyPath(channel);
    try {
      const key = readFileSync(path);
      if (key.length !== 32) throw new Error(`invalid channel key length for ${channel}`);
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && !create) return null;
        throw error;
      }
    }

    mkdirSync(this.keyDir, { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    try {
      writeFileSync(path, key, { flag: "wx", mode: 0o600 });
      chmodSync(path, 0o600);
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readFileSync(path);
      if (existing.length !== 32) throw new Error(`invalid channel key length for ${channel}`);
      return existing;
    }
  }
}
