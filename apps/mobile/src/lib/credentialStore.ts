import { Capacitor, registerPlugin } from "@capacitor/core";

/**
 * Storage for bearer tokens. Kept apart from UI preferences so credentials can use a stronger
 * backend than Capacitor Preferences.
 *
 *  - Android (native): Keystore-backed AES-GCM via the SecureCredentials plugin.
 *  - Browser / Tauri desktop: memory only. Those platforms re-pair with the local daemon on
 *    every start (tryAutoConnectLocalPc), and no web storage there is credential-grade, so
 *    nothing is persisted.
 *
 * There is deliberately no fallback to plaintext Preferences: if the secure backend fails, the
 * call fails.
 */
export interface CredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface SecureCredentialsNative {
  get(opts: { key: string }): Promise<{ value: string | null }>;
  set(opts: { key: string; value: string }): Promise<void>;
  remove(opts: { key: string }): Promise<void>;
}

export function createMemoryCredentialStore(): CredentialStore {
  const map = new Map<string, string>();
  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async remove(key) {
      map.delete(key);
    },
  };
}

export function createNativeCredentialStore(plugin: SecureCredentialsNative): CredentialStore {
  return {
    async get(key) {
      const { value } = await plugin.get({ key });
      return value ?? null;
    },
    async set(key, value) {
      await plugin.set({ key, value });
    },
    async remove(key) {
      await plugin.remove({ key });
    },
  };
}

const SecureCredentials = registerPlugin<SecureCredentialsNative>("SecureCredentials");
const sessionStore = createMemoryCredentialStore();
let override: CredentialStore | null = null;
let nativeStore: CredentialStore | null = null;

export function getCredentialStore(): CredentialStore {
  if (override) return override;
  if (Capacitor.isNativePlatform()) {
    nativeStore ??= createNativeCredentialStore(SecureCredentials);
    return nativeStore;
  }
  return sessionStore;
}

/** Test seam: pass null to restore platform selection. */
export function setCredentialStoreForTests(store: CredentialStore | null): void {
  override = store;
}
