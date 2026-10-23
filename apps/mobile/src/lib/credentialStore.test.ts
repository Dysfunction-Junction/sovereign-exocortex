import { describe, it, expect, beforeEach, vi } from "vitest";
import { Preferences } from "@capacitor/preferences";
import {
  createMemoryCredentialStore,
  createNativeCredentialStore,
  setCredentialStoreForTests,
  type CredentialStore,
  type SecureCredentialsNative,
} from "./credentialStore";
import {
  clearConfig,
  getProxyToken,
  getRemoteGatewayToken,
  setProxyToken,
  setRemoteGatewayToken,
} from "./config";

const PROXY_KEY = "pieces-android:proxyToken";
const REMOTE_KEY = "pieces-android:remoteGatewayToken";

async function legacyGet(key: string): Promise<string | null> {
  return (await Preferences.get({ key })).value;
}

describe("credential stores", () => {
  it("memory store round-trips, overwrites and removes", async () => {
    const s = createMemoryCredentialStore();
    expect(await s.get("a")).toBeNull();
    await s.set("a", "1");
    await s.set("a", "2");
    expect(await s.get("a")).toBe("2");
    await s.remove("a");
    expect(await s.get("a")).toBeNull();
  });

  it("native adapter delegates to the plugin and maps a missing value to null", async () => {
    const plugin: SecureCredentialsNative = {
      get: vi.fn(async ({ key }) => ({ value: key === "k" ? "secret" : null })),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    };
    const s = createNativeCredentialStore(plugin);
    expect(await s.get("k")).toBe("secret");
    expect(await s.get("missing")).toBeNull();
    await s.set("k", "v");
    expect(plugin.set).toHaveBeenCalledWith({ key: "k", value: "v" });
    await s.remove("k");
    expect(plugin.remove).toHaveBeenCalledWith({ key: "k" });
  });

  it("native adapter lets plugin failures propagate (no plaintext fallback)", async () => {
    const plugin: SecureCredentialsNative = {
      get: vi.fn(async () => {
        throw new Error("keystore unavailable");
      }),
      set: vi.fn(async () => {
        throw new Error("keystore unavailable");
      }),
      remove: vi.fn(async () => {}),
    };
    const s = createNativeCredentialStore(plugin);
    await expect(s.get("k")).rejects.toThrow("keystore unavailable");
    await expect(s.set("k", "v")).rejects.toThrow("keystore unavailable");
  });
});

describe("config tokens go through the credential store", () => {
  let store: CredentialStore;

  beforeEach(async () => {
    store = createMemoryCredentialStore();
    setCredentialStoreForTests(store);
    await clearConfig();
  });

  it("setProxyToken / setRemoteGatewayToken store in the credential store, never in Preferences", async () => {
    await setProxyToken("proxy-secret");
    await setRemoteGatewayToken("gateway-secret");
    expect(await store.get(PROXY_KEY)).toBe("proxy-secret");
    expect(await store.get(REMOTE_KEY)).toBe("gateway-secret");
    expect(await legacyGet(PROXY_KEY)).toBeNull();
    expect(await legacyGet(REMOTE_KEY)).toBeNull();
    expect(await getProxyToken()).toBe("proxy-secret");
    expect(await getRemoteGatewayToken()).toBe("gateway-secret");
  });

  it("migrates a legacy plaintext token: encrypt, verify by read-back, then delete the plaintext", async () => {
    await Preferences.set({ key: PROXY_KEY, value: "legacy-token" });
    expect(await getProxyToken()).toBe("legacy-token");
    expect(await store.get(PROXY_KEY)).toBe("legacy-token");
    expect(await legacyGet(PROXY_KEY)).toBeNull();
  });

  it("keeps the legacy value and surfaces an error when verification fails", async () => {
    await Preferences.set({ key: PROXY_KEY, value: "legacy-token" });
    setCredentialStoreForTests({
      get: async () => null, // write "succeeds" but cannot be read back
      set: async () => {},
      remove: async () => {},
    });
    await expect(getProxyToken()).rejects.toThrow(/migration/i);
    expect(await legacyGet(PROXY_KEY)).toBe("legacy-token");
  });

  it("keeps the legacy value when the store write fails", async () => {
    await Preferences.set({ key: PROXY_KEY, value: "legacy-token" });
    setCredentialStoreForTests({
      get: async () => null,
      set: async () => {
        throw new Error("keystore unavailable");
      },
      remove: async () => {},
    });
    await expect(getProxyToken()).rejects.toThrow("keystore unavailable");
    expect(await legacyGet(PROXY_KEY)).toBe("legacy-token");
  });

  it("after an interrupted migration the encrypted copy wins and the leftover plaintext is removed", async () => {
    await store.set(PROXY_KEY, "encrypted-copy");
    await Preferences.set({ key: PROXY_KEY, value: "stale-legacy" });
    expect(await getProxyToken()).toBe("encrypted-copy");
    expect(await legacyGet(PROXY_KEY)).toBeNull();
  });

  it("setProxyToken drops any leftover legacy plaintext copy", async () => {
    await Preferences.set({ key: PROXY_KEY, value: "old-plaintext" });
    await setProxyToken("fresh");
    expect(await legacyGet(PROXY_KEY)).toBeNull();
    expect(await getProxyToken()).toBe("fresh");
  });

  it("a failing store never falls back to plaintext Preferences on set", async () => {
    setCredentialStoreForTests({
      get: async () => null,
      set: async () => {
        throw new Error("keystore unavailable");
      },
      remove: async () => {},
    });
    await expect(setProxyToken("must-not-leak")).rejects.toThrow("keystore unavailable");
    expect(await legacyGet(PROXY_KEY)).toBeNull();
  });

  it("clearConfig removes the encrypted and the legacy copies", async () => {
    await setProxyToken("a");
    await Preferences.set({ key: REMOTE_KEY, value: "legacy" });
    await clearConfig();
    expect(await store.get(PROXY_KEY)).toBeNull();
    expect(await legacyGet(REMOTE_KEY)).toBeNull();
    expect(await getProxyToken()).toBeNull();
  });

  it("returns null for a token that was never set", async () => {
    expect(await getRemoteGatewayToken()).toBeNull();
  });
});
