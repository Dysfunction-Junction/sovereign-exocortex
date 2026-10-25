// FCM HTTP v1 push for newly SURFACED proposals. Data-only message {type:"proposal", proposal_id}:
// no nonce, summary or any other proposal content ever leaves the PC through Google. The phone then
// fetches GET /v3/proposals/pending over its authenticated channel.
//
// Config: FCM_PROJECT_ID + GOOGLE_APPLICATION_CREDENTIALS (service-account JSON path). Without both this
// is a no-op that logs once. OAuth2 JWT-bearer flow uses node:crypto only.

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ExocortexDatabase } from "@exocortex/core/db";
import { getDatabase } from "./db-host.js";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

export interface PushNotifierOptions {
  getDb: () => ExocortexDatabase;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  readFile?: (path: string) => string;
  now?: () => number;
  log?: (msg: string) => void;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

function b64url(b: Buffer | string): string {
  return Buffer.from(b).toString("base64url");
}

export class PushNotifier {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly readFile: (p: string) => string;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly inFlight = new Set<string>();
  private warned = false;
  private account: ServiceAccount | null | undefined;
  private cached: { token: string; expiresAt: number } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: PushNotifierOptions) {
    this.env = opts.env ?? process.env;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.readFile = opts.readFile ?? ((p) => readFileSync(p, "utf8"));
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(m));
  }

  private loadAccount(): ServiceAccount | null {
    if (this.account !== undefined) return this.account;
    const path = this.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!this.env.FCM_PROJECT_ID || !path) {
      this.account = null;
    } else {
      try {
        const j = JSON.parse(this.readFile(path));
        this.account =
          typeof j.client_email === "string" && typeof j.private_key === "string" ? (j as ServiceAccount) : null;
      } catch {
        this.account = null;
      }
    }
    return this.account;
  }

  isConfigured(): boolean {
    return this.loadAccount() !== null;
  }

  private async accessToken(acct: ServiceAccount): Promise<string> {
    const nowMs = this.now();
    if (this.cached && this.cached.expiresAt - 60_000 > nowMs) return this.cached.token;
    const iat = Math.floor(nowMs / 1000);
    const tokenUri = acct.token_uri || DEFAULT_TOKEN_URI;
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(JSON.stringify({ iss: acct.client_email, scope: FCM_SCOPE, aud: tokenUri, iat, exp: iat + 3600 }));
    const signer = createSign("RSA-SHA256");
    signer.update(`${head}.${claims}`);
    const assertion = `${head}.${claims}.${b64url(signer.sign(acct.private_key))}`;
    const res = await this.fetchImpl(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`oauth token HTTP ${res.status}`);
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new Error("oauth token response missing access_token");
    this.cached = { token: j.access_token, expiresAt: nowMs + (j.expires_in ?? 3600) * 1000 };
    return j.access_token;
  }

  /** Send the data push for one proposal to every registered, non-revoked device. Never throws. */
  async notifyProposalSurfaced(proposalId: string): Promise<{ sent: number; skipped?: string }> {
    if (this.inFlight.has(proposalId)) return { sent: 0, skipped: "notification in progress" };
    const acct = this.loadAccount();
    if (!acct) {
      if (!this.warned) {
        this.warned = true;
        this.log("[push-notifier] FCM_PROJECT_ID / GOOGLE_APPLICATION_CREDENTIALS not configured: push disabled");
      }
      return { sent: 0, skipped: "not configured" };
    }
    let db: ExocortexDatabase;
    try {
      db = this.opts.getDb();
      if (!db.listUnnotifiedSurfacedProposalIds(this.now()).includes(proposalId)) {
        return { sent: 0, skipped: "already notified or proposal is not surfaced" };
      }
    } catch (err) {
      this.log(`[push-notifier] could not check proposal ${proposalId}: ${err instanceof Error ? err.message : String(err)}`);
      return { sent: 0, skipped: "database unavailable" };
    }
    let sent = 0;
    let allDelivered = true;
    this.inFlight.add(proposalId);
    try {
      const tokens = db.listActivePushTokens();
      if (tokens.length === 0) return { sent: 0, skipped: "no registered tokens" };
      const access = await this.accessToken(acct);
      const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.env.FCM_PROJECT_ID!)}/messages:send`;
      for (const t of tokens) {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: {
              token: t.token,
              // Generic text only: a data-only push shows nothing while the app is backgrounded. The proposal
              // itself (summary, nonce) is still fetched over the authenticated channel after the user taps.
              notification: { title: "Your assistant has a suggestion", body: "It noticed something you do often and can help with it. Tap to see what, then choose Yes or No. Nothing happens unless you say Yes." },
              data: { type: "proposal", proposal_id: proposalId },
              android: { priority: "HIGH" },
            },
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) sent++;
        else if (res.status === 404 || res.status === 400) {
          const text = await res.text().catch(() => "");
          if (/UNREGISTERED|NOT_FOUND|INVALID_ARGUMENT/.test(text)) db.deleteDevicePushToken(t.device_id);
          else allDelivered = false;
        } else {
          allDelivered = false;
          this.log(`[push-notifier] FCM HTTP ${res.status} for device ${t.device_id}`);
        }
      }
    } catch (err) {
      allDelivered = false;
      this.log(`[push-notifier] send failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.inFlight.delete(proposalId);
    }
    if (sent > 0 && allDelivered) {
      try {
        db.markProposalNotified(proposalId, this.now());
      } catch (err) {
        this.log(`[push-notifier] could not mark proposal ${proposalId} notified: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { sent };
  }

  /**
   * Plain notice with no question attached (e.g. "your phone has not checked in"). Unlike a proposal push it
   * carries no proposal id and nothing is marked notified. `sent` is the number of devices FCM accepted.
   */
  async sendNotice(title: string, body: string): Promise<{ sent: number }> {
    const acct = this.loadAccount();
    if (!acct) return { sent: 0 };
    let sent = 0;
    try {
      const db = this.opts.getDb();
      const tokens = db.listActivePushTokens();
      if (tokens.length === 0) return { sent: 0 };
      const access = await this.accessToken(acct);
      const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.env.FCM_PROJECT_ID!)}/messages:send`;
      for (const t of tokens) {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: { token: t.token, notification: { title, body }, data: { type: "notice" }, android: { priority: "HIGH" } },
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) sent++;
        else if (res.status === 404 || res.status === 400) {
          const text = await res.text().catch(() => "");
          if (/UNREGISTERED|NOT_FOUND|INVALID_ARGUMENT/.test(text)) db.deleteDevicePushToken(t.device_id);
        } else {
          this.log(`[push-notifier] FCM HTTP ${res.status} for device ${t.device_id}`);
        }
      }
    } catch (err) {
      this.log(`[push-notifier] notice failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { sent };
  }

  /** Notify any SURFACED, unexpired proposal not yet marked notified in SQLite. */
  async pollOnce(): Promise<number> {
    let fresh: string[] = [];
    try {
      fresh = this.opts.getDb().listUnnotifiedSurfacedProposalIds(this.now());
    } catch {
      return 0;
    }
    for (const id of fresh) await this.notifyProposalSurfaced(id);
    return fresh.length;
  }

  /** Poll surfaced proposals, including any created while the daemon was offline. */
  start(intervalMs = 5000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollOnce(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const defaultPushNotifier = new PushNotifier({ getDb: () => getDefaultDb() });

function getDefaultDb(): ExocortexDatabase {
  return getDatabase();
}

/** Hook for any in-process producer: call when a proposal becomes SURFACED. */
export function notifyProposalSurfaced(proposalId: string): Promise<{ sent: number; skipped?: string }> {
  return defaultPushNotifier.notifyProposalSurfaced(proposalId);
}
