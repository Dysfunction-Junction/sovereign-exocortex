import { Preferences } from "@capacitor/preferences";
import { Capacitor } from "@capacitor/core";

// Dual-profile connection (Plan A LAN / Plan B Remote Gateway):
//  - Plan A (LAN / USB): fast local path, e.g. http://192.168.1.x:8787
//  - Plan B (Remote gateway): automatic fallback via Tailscale, e.g.
//    https://pieces.yourdomain.com  (a device JWT, not the LAN bearer)
// api.ts / flush.ts try Plan A first, fall over to Plan B on timeout, refused
// connection, 401/403, or 5xx. Either profile alone is a valid config.
//
// Uses Capacitor's Preferences plugin (native storage) rather than
// localStorage — these tokens are real credentials, not UI state.

const PROXY_BASE_URL_KEY = "pieces-android:proxyBaseUrl";
const PROXY_TOKEN_KEY = "pieces-android:proxyToken";
const REMOTE_GATEWAY_URL_KEY = "pieces-android:remoteGatewayUrl";
const REMOTE_GATEWAY_TOKEN_KEY = "pieces-android:remoteGatewayToken";
const SCREEN_CONTEXT_ENABLED_KEY = "pieces-android:screenContextEnabled";
const NOTIFICATION_CAPTURE_ENABLED_KEY = "pieces-android:notificationCaptureEnabled";
const SMS_BACKFILL_HIGH_WATER_KEY = "pieces-android:smsBackfillHighWater";

export async function getProxyBaseUrl(): Promise<string | null> {
  const { value } = await Preferences.get({ key: PROXY_BASE_URL_KEY });
  return value;
}

export async function setProxyBaseUrl(url: string): Promise<void> {
  await Preferences.set({ key: PROXY_BASE_URL_KEY, value: url.replace(/\/$/, "") });
}

export async function getProxyToken(): Promise<string | null> {
  const { value } = await Preferences.get({ key: PROXY_TOKEN_KEY });
  return value;
}

export async function setProxyToken(token: string): Promise<void> {
  await Preferences.set({ key: PROXY_TOKEN_KEY, value: token });
}

export async function getRemoteGatewayUrl(): Promise<string | null> {
  const { value } = await Preferences.get({ key: REMOTE_GATEWAY_URL_KEY });
  return value;
}

export async function setRemoteGatewayUrl(url: string): Promise<void> {
  await Preferences.set({ key: REMOTE_GATEWAY_URL_KEY, value: url.replace(/\/$/, "") });
}

export async function getRemoteGatewayToken(): Promise<string | null> {
  const { value } = await Preferences.get({ key: REMOTE_GATEWAY_TOKEN_KEY });
  return value;
}

export async function setRemoteGatewayToken(token: string): Promise<void> {
  await Preferences.set({ key: REMOTE_GATEWAY_TOKEN_KEY, value: token });
}

export interface ConnectionTarget {
  baseUrl: string;
  token: string;
  mode: "lan" | "remote";
}

let autoConnectPromise: Promise<boolean> | null = null;

/**
 * Attempts one-shot auto-discovery of the local PC daemon and proxy.
 * Safe to call on web/desktop environments. Automatically saves credentials to Preferences.
 */
export async function tryAutoConnectLocalPc(): Promise<boolean> {
  if (autoConnectPromise) return autoConnectPromise;
  autoConnectPromise = (async () => {
    if (typeof window === "undefined") return false;

    // Check candidate endpoints:
    // 1. Relative (if web dashboard served directly by the daemon or reverse proxy)
    // 2. Default local daemon port 8788
    // 3. Localhost 8788
    const origin = window.location?.origin;
    const candidates = [
      ...(origin && origin.startsWith("http") ? [`${origin}/mobile/local-config`] : []),
      "http://127.0.0.1:8788/mobile/local-config",
      "http://localhost:8788/mobile/local-config",
    ];

    const uniqueCandidates = [...new Set(candidates)];

    for (const endpoint of uniqueCandidates) {
      try {
        const res = await fetch(endpoint, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(2000),
        });
        if (!res.ok) continue;
        const data = (await res.json()) as {
          ok?: boolean;
          proxyBaseUrl?: string;
          proxyToken?: string;
          remoteGatewayUrl?: string;
          remoteGatewayToken?: string;
        };
        if (data && data.ok && data.proxyBaseUrl && data.remoteGatewayUrl) {
          await Promise.all([
            setProxyBaseUrl(data.proxyBaseUrl),
            setProxyToken(data.proxyToken ?? ""),
            setRemoteGatewayUrl(data.remoteGatewayUrl),
            setRemoteGatewayToken(data.remoteGatewayToken ?? ""),
          ]);
          return true;
        }
      } catch {
        // try next candidate
      }
    }
    return false;
  })().finally(() => {
    autoConnectPromise = null;
  });
  return autoConnectPromise;
}

/** Ordered [Plan A, Plan B], each included only if both its URL and token are set. */
export async function getConnectionTargets(): Promise<ConnectionTarget[]> {
  let [lanUrl, lanToken, remoteUrl, remoteToken] = await Promise.all([
    getProxyBaseUrl(), getProxyToken(), getRemoteGatewayUrl(), getRemoteGatewayToken(),
  ]);

  // On desktop / PC browser, if credentials are unconfigured, auto-connect to the local daemon
  if ((!lanUrl || !lanToken) && (!remoteUrl || !remoteToken) && !Capacitor.isNativePlatform()) {
    const autoConnected = await tryAutoConnectLocalPc().catch(() => false);
    if (autoConnected) {
      [lanUrl, lanToken, remoteUrl, remoteToken] = await Promise.all([
        getProxyBaseUrl(), getProxyToken(), getRemoteGatewayUrl(), getRemoteGatewayToken(),
      ]);
    }
  }

  const targets: ConnectionTarget[] = [];
  if (lanUrl && lanToken) targets.push({ baseUrl: lanUrl, token: lanToken, mode: "lan" });
  if (remoteUrl && remoteToken) targets.push({ baseUrl: remoteUrl, token: remoteToken, mode: "remote" });
  return targets;
}

export async function isConfigured(): Promise<boolean> {
  return (await getConnectionTargets()).length > 0;
}

export async function clearConfig(): Promise<void> {
  await Promise.all([
    Preferences.remove({ key: PROXY_BASE_URL_KEY }),
    Preferences.remove({ key: PROXY_TOKEN_KEY }),
    Preferences.remove({ key: REMOTE_GATEWAY_URL_KEY }),
    Preferences.remove({ key: REMOTE_GATEWAY_TOKEN_KEY }),
  ]);
}

// Screen-context capture only needs Android's standard Accessibility Service
// permission — a manual one-time toggle in system Settings, same mechanism
// screen readers and password managers use. Off by default: this is powerful
// enough that it must be an explicit, informed opt-in.
export async function isScreenContextEnabled(): Promise<boolean> {
  const { value } = await Preferences.get({ key: SCREEN_CONTEXT_ENABLED_KEY });
  return value === "true";
}

export async function setScreenContextEnabled(enabled: boolean): Promise<void> {
  await Preferences.set({ key: SCREEN_CONTEXT_ENABLED_KEY, value: String(enabled) });
}

// Part 1: notification listener master switch. Off by default, same reasoning
// as the others — this captures every app's notification content, so it must
// be an explicit opt-in, and the native service also fail-closes on this flag.
export async function isNotificationCaptureEnabled(): Promise<boolean> {
  const { value } = await Preferences.get({ key: NOTIFICATION_CAPTURE_ENABLED_KEY });
  return value === "true";
}

export async function setNotificationCaptureEnabled(enabled: boolean): Promise<void> {
  await Preferences.set({ key: NOTIFICATION_CAPTURE_ENABLED_KEY, value: String(enabled) });
}

// Part 2: SMS backfill high-water mark (epoch millis of the newest message
// already ingested). 0 = nothing backfilled yet, next run pulls all history.
// Advanced page-by-page so a crash mid-backfill resumes rather than restarts.
export async function getSmsBackfillHighWater(): Promise<number> {
  const { value } = await Preferences.get({ key: SMS_BACKFILL_HIGH_WATER_KEY });
  const n = value ? Number(value) : 0;
  return Number.isFinite(n) ? n : 0;
}

export async function setSmsBackfillHighWater(millis: number): Promise<void> {
  await Preferences.set({ key: SMS_BACKFILL_HIGH_WATER_KEY, value: String(millis) });
}
