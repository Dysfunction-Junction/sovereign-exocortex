/**
 * @file gmail-adapter.ts
 * Gmail Communication Adapter for Sovereign Exocortex.
 * Features 5-layer malware quarantine, RFC machine-vs-human triage, and air-gap enforcement.
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";
import { AirGapPolicy } from "./air-gap.js";
import { stripHtmlToPlainText, stripInvisibleUnicode, defangAttachments } from "./sanitizer.js";
import { classifyEmailType, buildScopedGmailQuery } from "./email-triage.js";
import type { ChannelAdapter, ChannelStatus, SyncResult, IngestedEntity, IngestedDocument } from "./types.js";

export class GmailAdapter implements ChannelAdapter {
  readonly id = "gmail";
  readonly name = "Gmail Communication Graph";

  private accessToken?: string;
  private offlineMboxDir?: string;
  private userEmail?: string;
  private syncDays = 30;

  private status: ChannelStatus = {
    id: "gmail",
    name: "Gmail Communication Graph",
    description: "Triage-filtered communication threads and contact graph hydration",
    status: "disconnected",
    itemCount: 0,
    airGapped: false,
  };

  private onEntityIngested?: (entity: IngestedEntity | IngestedDocument) => void;

  constructor(token?: string, onEntity?: (entity: IngestedEntity | IngestedDocument) => void) {
    if (token) this.accessToken = token;
    if (onEntity) this.onEntityIngested = onEntity;
  }

  setEntityListener(listener: (entity: IngestedEntity | IngestedDocument) => void): void {
    this.onEntityIngested = listener;
  }

  async getStatus(): Promise<ChannelStatus> {
    const isConfigured = Boolean(this.accessToken || (this.offlineMboxDir && existsSync(this.offlineMboxDir)));
    return {
      ...this.status,
      status: isConfigured ? (this.status.status === "syncing" ? "syncing" : "connected") : "disconnected",
      configSummary: this.offlineMboxDir
        ? `Offline MBOX: ${this.offlineMboxDir}`
        : this.userEmail
        ? `Account: ${this.userEmail}`
        : this.accessToken
        ? "OAuth Token Active"
        : undefined,
      airGapped: Boolean(this.offlineMboxDir && !this.accessToken),
    };
  }

  async configure(config: Record<string, unknown>): Promise<void> {
    if (typeof config.accessToken === "string" && config.accessToken.trim().length > 0) {
      this.accessToken = config.accessToken.trim();
    }
    if (typeof config.userEmail === "string" && config.userEmail.trim().length > 0) {
      this.userEmail = config.userEmail.trim();
    }
    if (typeof config.offlineMboxDir === "string" && config.offlineMboxDir.trim().length > 0) {
      this.offlineMboxDir = config.offlineMboxDir.trim();
    }
    if (typeof config.syncDays === "number" && config.syncDays > 0) {
      this.syncDays = config.syncDays;
    }
    this.status.status = this.accessToken || this.offlineMboxDir ? "connected" : "disconnected";
  }

  async sync(): Promise<SyncResult> {
    const start = Date.now();
    this.status.status = "syncing";

    // Mode A: Offline Mbox Mode (Air-Gap Compliant)
    if (this.offlineMboxDir && existsSync(this.offlineMboxDir)) {
      return this.syncOfflineMbox(start);
    }

    // Mode B: Live API Mode (Requires Outbound Network)
    if (!this.accessToken) {
      this.status.status = "disconnected";
      return {
        channelId: "gmail",
        itemsSynced: 0,
        durationMs: Date.now() - start,
        error: "Gmail OAuth access token or offline mbox directory is required",
      };
    }

    try {
      AirGapPolicy.assertOutboundAllowed("googleapis.com");

      const query = buildScopedGmailQuery(this.syncDays);
      const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads?maxResults=25&q=${encodeURIComponent(query)}`;

      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        throw new Error(`Gmail API returned HTTP ${res.status}: ${res.statusText}`);
      }

      const listData = (await res.json()) as { threads?: Array<{ id: string; snippet?: string }> };
      const threads = listData.threads || [];
      let count = 0;

      for (const th of threads) {
        // Fetch thread details
        const thRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${th.id}?format=metadata`, {
          headers: { Authorization: `Bearer ${this.accessToken}` },
        });

        if (!thRes.ok) continue;

        const thData = (await thRes.json()) as {
          messages?: Array<{
            id: string;
            payload?: {
              headers?: Array<{ name: string; value: string }>;
              parts?: Array<Record<string, unknown>>;
            };
            snippet?: string;
          }>;
        };

        const firstMsg = thData.messages?.[0];
        if (!firstMsg) continue;

        // Parse headers
        const headerMap: Record<string, string> = {};
        for (const h of firstMsg.payload?.headers || []) {
          headerMap[h.name.toLowerCase()] = h.value;
        }

        const from = headerMap["from"] || "unknown@unknown.com";
        const subject = headerMap["subject"] || "No Subject";

        // Triage machine vs human
        const triage = classifyEmailType(headerMap, from, subject);
        if (triage.category === "BULK_IGNORE") {
          continue; // Drop bulk marketing
        }

        // Defang attachments
        const attachments = defangAttachments(firstMsg.payload?.parts || []);

        // Sanitize snippet
        const sanitizedSnippet = stripInvisibleUnicode(stripHtmlToPlainText(th.snippet || ""));

        // Extract sender name and email
        const emailMatch = from.match(/<([^>]+)>/);
        const senderEmail = emailMatch ? emailMatch[1].trim() : from.trim();
        const senderName = from.replace(/<[^>]+>/, "").trim() || senderEmail;

        if (triage.category === "HUMAN") {
          // Hydrate Person node (tagged untrusted since from external email)
          const personEntity: IngestedEntity = {
            id: `person:${senderEmail.toLowerCase()}`,
            type: "PERSON",
            name: senderName,
            channelId: "gmail",
            properties: {
              email: senderEmail,
              lastThreadId: th.id,
              attachmentCount: attachments.length,
            },
            untrusted: true,
          };

          if (this.onEntityIngested) {
            this.onEntityIngested(personEntity);
          }
        }

        // Also record as ingested thread document
        const threadDoc: IngestedDocument = {
          id: `gmail:thread:${th.id}`,
          channelId: "gmail",
          title: subject,
          body: sanitizedSnippet,
          tags: [triage.category.toLowerCase(), "gmail"],
          wikilinks: [],
          metadata: {
            from: senderEmail,
            attachments,
            triageCategory: triage.category,
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
          untrusted: true,
        };

        count++;
        if (this.onEntityIngested) {
          this.onEntityIngested(threadDoc);
        }
      }

      this.status.status = "connected";
      this.status.itemCount = count;
      this.status.lastSyncAt = new Date().toISOString();
      this.status.error = undefined;

      return {
        channelId: "gmail",
        itemsSynced: count,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      this.status.status = "error";
      this.status.error = err instanceof Error ? err.message : String(err);
      return {
        channelId: "gmail",
        itemsSynced: 0,
        durationMs: Date.now() - start,
        error: this.status.error,
      };
    }
  }

  private async syncOfflineMbox(start: number): Promise<SyncResult> {
    try {
      const dir = this.offlineMboxDir!;
      const entries = await readdir(dir, { withFileTypes: true });
      let count = 0;

      for (const entry of entries) {
        if (entry.isFile() && (extname(entry.name) === ".eml" || extname(entry.name) === ".txt")) {
          const content = await readFile(join(dir, entry.name), "utf-8");
          const sanitized = stripInvisibleUnicode(stripHtmlToPlainText(content.slice(0, 4000)));

          const doc: IngestedDocument = {
            id: `gmail:offline:${entry.name}`,
            channelId: "gmail",
            title: entry.name,
            body: sanitized,
            tags: ["offline-email"],
            wikilinks: [],
            metadata: { sourcePath: join(dir, entry.name) },
            createdAt: Date.now(),
            updatedAt: Date.now(),
            untrusted: true,
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
        channelId: "gmail",
        itemsSynced: count,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      this.status.status = "error";
      this.status.error = err instanceof Error ? err.message : String(err);
      return {
        channelId: "gmail",
        itemsSynced: 0,
        durationMs: Date.now() - start,
        error: this.status.error,
      };
    }
  }

  async disconnect(): Promise<void> {
    this.accessToken = undefined;
    this.offlineMboxDir = undefined;
    this.status.status = "disconnected";
  }

  dispose(): void {
    this.accessToken = undefined;
  }
}
