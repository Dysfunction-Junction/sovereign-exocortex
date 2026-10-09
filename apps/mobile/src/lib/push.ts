import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import { postPushToken } from "./api";

// FCM wake-up channel. The push payload carries only {type:"proposal", proposal_id}; the proposal itself
// (nonce, summary) is always fetched from the daemon over the authenticated channel (proposalPoller).
// Everything here degrades silently on web/tests and when Firebase is not configured (no google-services.json).

let listenersAdded = false;
let lastPostedToken: string | null = null;
let pendingToken: string | null = null;
let postingToken: string | null = null;

export function isProposalPush(data: unknown): boolean {
  return !!data && typeof data === "object" && (data as Record<string, unknown>).type === "proposal";
}

async function postTokenOnce(token: string): Promise<void> {
  if (token === lastPostedToken || token === postingToken) return;
  postingToken = token;
  try {
    await postPushToken(token);
    lastPostedToken = token;
    pendingToken = null;
  } catch {
    pendingToken = token; // not enrolled yet / PC offline: retried on next registerPush()
  } finally {
    postingToken = null;
  }
}

/**
 * Asks for notification permission, registers with FCM and uploads the token. Idempotent; call on startup and
 * on resume (a token that failed to upload is retried). `onProposal` fires for a {type:"proposal"} message.
 */
export async function registerPush(onProposal: () => void): Promise<void> {
  try {
    if (!Capacitor.isNativePlatform()) return;

    if (!listenersAdded) {
      listenersAdded = true;
      await PushNotifications.addListener("registration", (t) => {
        void postTokenOnce(t.value);
      });
      await PushNotifications.addListener("registrationError", () => {
        // FCM unconfigured or unavailable: nothing to do, polling still works.
      });
      await PushNotifications.addListener("pushNotificationReceived", (n) => {
        if (isProposalPush(n?.data)) onProposal();
      });
      // Tapping a background notification opens the app; the resume handler polls, but poll here too.
      await PushNotifications.addListener("pushNotificationActionPerformed", (a) => {
        if (isProposalPush(a?.notification?.data)) onProposal();
      });
    }

    if (pendingToken) await postTokenOnce(pendingToken);

    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") {
      perm = await PushNotifications.requestPermissions();
    }
    if (perm.receive !== "granted") return;
    await PushNotifications.register();
  } catch {
    // never let push setup break the app
  }
}

/** @internal test-only */
export function __resetPushState(): void {
  listenersAdded = false;
  lastPostedToken = null;
  pendingToken = null;
  postingToken = null;
}
