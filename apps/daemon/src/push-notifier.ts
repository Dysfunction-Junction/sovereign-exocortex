// FCM HTTP v1 push for newly SURFACED proposals. Data-only message {type:"proposal", proposal_id}:
// no nonce, summary or any other proposal content ever leaves the PC through Google. The phone then
// fetches GET /v3/proposals/pending over its authenticated channel.
//
// Config: FCM_PROJECT_ID + GOOGLE_APPLICATION_CREDENTIALS (service-account JSON path). Without both this
// is a no-op that logs once. OAuth2 JWT-bearer flow uses node:crypto only.

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ExocortexDatabase } from "@exocortex/core/db";

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
  private readonly seen = new Set<string>();
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
    if (this.seen.has(proposalId)) return { sent: 0, skipped: "already notified" };
    this.seen.add(proposalId);
    const acct = this.loadAccount();
    if (!acct) {
      if (!this.warned) {
        this.warned = true;
        this.log("[push-notifier] FCM_PROJECT_ID / GOOGLE_APPLICATION_CREDENTIALS not configured: push disabled");
      }
      return { sent: 0, skipped: "not configured" };
    }
    let sent = 0;
    try {
      const db = this.opts.getDb();
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
              notification: { title: "Approval requested", body: "Open Exocortex to review." },
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
        } else {
          this.log(`[push-notifier] FCM HTTP ${res.status} for device ${t.device_id}`);
        }
      }
    } catch (err) {
      this.log(`[push-notifier] send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { sent };
  }

  /** Notify any SURFACED, unexpired proposal not yet seen. */
  async pollOnce(): Promise<number> {
    let fresh: string[] = [];
    try {
      fresh = this.opts
        .getDb()
        .listProposalsByState(["SURFACED"], this.now())
        .map((p) => p.proposal_id)
        .filter((id) => !this.seen.has(id));
    } catch {
      return 0;
    }
    for (const id of fresh) await this.notifyProposalSurfaced(id);
    return fresh.length;
  }

  /** Prime with proposals that are already SURFACED (no push storm on restart), then poll. */
  start(intervalMs = 5000): void {
    if (this.timer) return;
    try {
      for (const p of this.opts.getDb().listProposalsByState(["SURFACED"])) this.seen.add(p.proposal_id);
    } catch {
      /* db not ready: first poll will treat existing rows as new */
    }
    this.timer = setInterval(() => void this.pollOnce(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const defaultPushNotifier = new PushNotifier({ getDb: () => getDefaultDb() });

import { getDatabase } from "./db-host.js";
function getDefaultDb(): ExocortexDatabase {
  return getDatabase();
}

/** Hook for any in-process producer: call when a proposal becomes SURFACED. */
export function notifyProposalSurfaced(proposalId: string): Promise<{ sent: number; skipped?: string }> {
  return defaultPushNotifier.notifyProposalSurfaced(proposalId);
}
