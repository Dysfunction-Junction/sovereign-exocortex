import { Preferences } from "@capacitor/preferences";
import { Capacitor } from "@capacitor/core";
import { getCredentialStore } from "./credentialStore";
import { validateBaseUrl } from "./urlPolicy";

// Dual-profile connection (Plan A LAN / Plan B Remote Gateway):
//  - Plan A (LAN / USB): fast local path, e.g. http://192.168.1.x:8787
//  - Plan B (Remote gateway): automatic fallback via Tailscale, e.g.
//    https://pieces.yourdomain.com  (a device JWT, not the LAN bearer)
// api.ts / flush.ts try Plan A first, fall over to Plan B on timeout, refused
// connection, 401/403, or 5xx. Either profile alone is a valid config.
//
// URLs and UI flags live in Capacitor Preferences. The two bearer tokens are credentials and go
// through credentialStore.ts (Android Keystore-backed on device) instead; tokens left in Preferences
// by older builds are migrated on first read.

const PROXY_BASE_URL_KEY = "pieces-android:proxyBaseUrl";
const PROXY_TOKEN_KEY = "pieces-android:proxyToken";
const REMOTE_GATEWAY_URL_KEY = "pieces-android:remoteGatewayUrl";
const REMOTE_GATEWAY_TOKEN_KEY = "pieces-android:remoteGatewayToken";
const SCREEN_CONTEXT_ENABLED_KEY = "pieces-android:screenContextEnabled";
const NOTIFICATION_CAPTURE_ENABLED_KEY = "pieces-android:notificationCaptureEnabled";
const SMS_BACKFILL_HIGH_WATER_KEY = "pieces-android:smsBackfillHighWater";

/** Cleartext loopback is a desktop/dev convenience; the release phone app talks https only. */
function urlPolicyOptions(): { allowLoopbackHttp: boolean } {
  return { allowLoopbackHttp: isDesktopApp() || import.meta.env.DEV === true };
}

/** Human-readable problem with a candidate connection URL, or null if it passes the policy. */
export function checkConnectionUrl(url: string): string | null {
  const check = validateBaseUrl(url, urlPolicyOptions());
  return check.ok ? null : `Cannot use ${url.trim() || "an empty address"}: ${check.reason}.`;
}

/** An empty string clears the profile; anything else must pass the URL policy. */
function checkedUrlForSave(url: string): string {
  if (url.trim() === "") return "";
  const check = validateBaseUrl(url, urlPolicyOptions());
  if (!check.ok) throw new Error(`Cannot use ${url.trim()}: ${check.reason}.`);
  return check.url;
}

export class InsecureConnectionError extends Error {
  readonly rejected: Array<{ url: string; reason: string }>;

  constructor(rejected: Array<{ url: string; reason: string }>) {
    super(
      "Refusing to send credentials over an insecure connection. " +
        rejected.map((r) => `${r.url}: ${r.reason}`).join("; ") +
        ". Update the address in Settings.",
    );
    this.rejected = rejected;
    this.name = "InsecureConnectionError";
  }
}

export async function getProxyBaseUrl(): Promise<string | null> {
  const { value } = await Preferences.get({ key: PROXY_BASE_URL_KEY });
  return value;
}

export async function setProxyBaseUrl(url: string): Promise<void> {
  await Preferences.set({ key: PROXY_BASE_URL_KEY, value: checkedUrlForSave(url) });
}

/**
 * Moves a token an older build left in plaintext Preferences into the credential store:
 * write, read back and compare, and only then delete the plaintext. If the encrypted copy
 * already exists (interrupted earlier run) it wins and the leftover plaintext is removed.
 * Any failure leaves the legacy value in place and throws, so the only working credential is
 * never erased first.
 */
async function migrateLegacyToken(key: string): Promise<void> {
  const { value: legacy } = await Preferences.get({ key });
  if (legacy === null || legacy === undefined) return;
  const store = getCredentialStore();
  if ((await store.get(key)) !== null) {
    await Preferences.remove({ key });
    return;
  }
  await store.set(key, legacy);
  if ((await store.get(key)) !== legacy) {
    throw new Error(`Credential migration failed verification for ${key}; the existing token was kept`);
  }
  await Preferences.remove({ key });
}

async function readToken(key: string): Promise<string | null> {
  await migrateLegacyToken(key);
  return getCredentialStore().get(key);
}

async function writeToken(key: string, token: string): Promise<void> {
  await getCredentialStore().set(key, token);
  await Preferences.remove({ key });
}

export async function getProxyToken(): Promise<string | null> {
  return readToken(PROXY_TOKEN_KEY);
}

export async function setProxyToken(token: string): Promise<void> {
  await writeToken(PROXY_TOKEN_KEY, token);
}

export async function getRemoteGatewayUrl(): Promise<string | null> {
  const { value } = await Preferences.get({ key: REMOTE_GATEWAY_URL_KEY });
  return value;
}

export async function setRemoteGatewayUrl(url: string): Promise<void> {
  await Preferences.set({ key: REMOTE_GATEWAY_URL_KEY, value: checkedUrlForSave(url) });
}

export async function getRemoteGatewayToken(): Promise<string | null> {
  return readToken(REMOTE_GATEWAY_TOKEN_KEY);
}

export async function setRemoteGatewayToken(token: string): Promise<void> {
  await writeToken(REMOTE_GATEWAY_TOKEN_KEY, token);
}

export interface ConnectionTarget {
  baseUrl: string;
  token: string;
  mode: "lan" | "remote";
}

export function isDesktopApp(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(
    (window as any).__TAURI_INTERNALS__ ||
    (window as any).__TAURI__ ||
    !Capacitor.isNativePlatform()
  );
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

    // 0. Primary desktop path: Use native Tauri IPC to fetch loopback credentials without WebView Origin restrictions
    if ((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__) {
      try {
        const invoke = (window as any).__TAURI__?.core?.invoke ?? (window as any).__TAURI_INTERNALS__?.invoke;
        if (typeof invoke === "function") {
          const raw = await invoke("get_local_config", {});
          const data = typeof raw === "string" ? JSON.parse(raw) : raw;
          if (data && data.ok) {
            const pUrl = data.proxyBaseUrl || "http://127.0.0.1:8787";
            const pToken = data.proxyToken || "";
            const rUrl = data.remoteGatewayUrl || "http://127.0.0.1:8788";
            const rToken = data.remoteGatewayToken || "";
            await Promise.all([
              setProxyBaseUrl(pUrl),
              setProxyToken(pToken),
              setRemoteGatewayUrl(rUrl),
              setRemoteGatewayToken(rToken),
            ]);
            return true;
          }
        }
      } catch (err) {
        console.warn("[auto-connect] Native IPC bridge failed, falling back to HTTP fetch:", err);
      }
    }

    // Check candidate endpoints:
    // 1. Relative (if web dashboard served directly by the daemon or reverse proxy)
    // 2. Default local daemon port 8788
    // 3. Localhost 8788
    const origin = window.location?.origin;
    const candidates = [
      ...(origin && origin.startsWith("http") && !origin.includes("tauri.localhost") ? [`${origin}/mobile/local-config`] : []),
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
        if (data && data.ok) {
          const pUrl = data.proxyBaseUrl || "http://127.0.0.1:8787";
          const pToken = data.proxyToken || "";
          const rUrl = data.remoteGatewayUrl || "http://127.0.0.1:8788";
          const rToken = data.remoteGatewayToken || "";
          await Promise.all([
            setProxyBaseUrl(pUrl),
            setProxyToken(pToken),
            setRemoteGatewayUrl(rUrl),
            setRemoteGatewayToken(rToken),
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

  // On desktop / PC browser, automatically pair with the local daemon and proxy
  if (isDesktopApp()) {
    if (!lanToken || !remoteToken) {
      const autoConnected = await tryAutoConnectLocalPc().catch(() => false);
      if (autoConnected) {
        [lanUrl, lanToken, remoteUrl, remoteToken] = await Promise.all([
          getProxyBaseUrl(), getProxyToken(), getRemoteGatewayUrl(), getRemoteGatewayToken(),
        ]);
      }
    }
    // Guaranteed local defaults when running on PC
    if (!lanUrl) lanUrl = "http://127.0.0.1:8787";
    remoteUrl = "http://127.0.0.1:8788";
  }

  const candidates: ConnectionTarget[] = [];
  if (lanUrl && (lanToken || isDesktopApp())) {
    candidates.push({ baseUrl: lanUrl, token: lanToken ?? "", mode: "lan" });
  }
  if (remoteUrl && (remoteToken || isDesktopApp())) {
    candidates.push({ baseUrl: remoteUrl, token: remoteToken ?? "", mode: "remote" });
  }

  // Re-check at the point of use: values saved by older builds were never validated, and no
  // request (or Authorization header) may be built from a target that fails the policy.
  const opts = urlPolicyOptions();
  const targets: ConnectionTarget[] = [];
  const rejected: Array<{ url: string; reason: string }> = [];
  for (const c of candidates) {
    const check = validateBaseUrl(c.baseUrl, opts);
    if (check.ok) targets.push({ ...c, baseUrl: check.url });
    else rejected.push({ url: c.baseUrl, reason: check.reason });
  }
  if (targets.length === 0 && rejected.length > 0) throw new InsecureConnectionError(rejected);
  return targets;
}

export async function isConfigured(): Promise<boolean> {
  if (isDesktopApp()) return true;
  return (await getConnectionTargets()).length > 0;
}

export async function clearConfig(): Promise<void> {
  const store = getCredentialStore();
  await Promise.all([
    Preferences.remove({ key: PROXY_BASE_URL_KEY }),
    Preferences.remove({ key: PROXY_TOKEN_KEY }),
    Preferences.remove({ key: REMOTE_GATEWAY_URL_KEY }),
    Preferences.remove({ key: REMOTE_GATEWAY_TOKEN_KEY }),
    store.remove(PROXY_TOKEN_KEY),
    store.remove(REMOTE_GATEWAY_TOKEN_KEY),
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
