import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Preferences } from "@capacitor/preferences";
import { Capacitor } from "@capacitor/core";
import {
  checkConnectionUrl,
  clearConfig,
  getConnectionTargets,
  getProxyBaseUrl,
  getProxyToken,
  getRemoteGatewayUrl,
  getRemoteGatewayToken,
  setProxyBaseUrl,
  setProxyToken,
  setRemoteGatewayToken,
  setRemoteGatewayUrl,
  tryAutoConnectLocalPc,
} from "./config";
import { createMemoryCredentialStore, setCredentialStoreForTests } from "./credentialStore";

describe("config auto-discovery", () => {
  beforeEach(async () => {
    await clearConfig();
    vi.restoreAllMocks();
  });

  it("tryAutoConnectLocalPc stores credentials when local endpoint answers", async () => {
    const mockConfig = {
      ok: true,
      proxyBaseUrl: "http://127.0.0.1:8787",
      proxyToken: "test-proxy-token",
      remoteGatewayUrl: "http://127.0.0.1:8788",
      remoteGatewayToken: "test-jwt-token",
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => mockConfig,
    } as Response);

    const connected = await tryAutoConnectLocalPc();
    expect(connected).toBe(true);
    expect(await getProxyBaseUrl()).toBe("http://127.0.0.1:8787");
    expect(await getProxyToken()).toBe("test-proxy-token");
    expect(await getRemoteGatewayUrl()).toBe("http://127.0.0.1:8788");
    expect(await getRemoteGatewayToken()).toBe("test-jwt-token");
  });

  it("tryAutoConnectLocalPc returns false gracefully if endpoints fail", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const connected = await tryAutoConnectLocalPc();
    expect(connected).toBe(false);
    expect(await getProxyBaseUrl()).toBeNull();
  });

  it("getConnectionTargets automatically connects on web when unconfigured", async () => {
    const mockConfig = {
      ok: true,
      proxyBaseUrl: "http://127.0.0.1:8787",
      proxyToken: "auto-proxy-token",
      remoteGatewayUrl: "http://127.0.0.1:8788",
      remoteGatewayToken: "auto-remote-token",
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => mockConfig,
    } as Response);

    const targets = await getConnectionTargets();
    expect(targets).toHaveLength(2);
    expect(targets[0]).toEqual({
      baseUrl: "http://127.0.0.1:8787",
      token: "auto-proxy-token",
      mode: "lan",
    });
    expect(targets[1]).toEqual({
      baseUrl: "http://127.0.0.1:8788",
      token: "auto-remote-token",
      mode: "remote",
    });
  });

  it("getConnectionTargets does not auto-connect when running on native platform", async () => {
    // Pin the store so the single mocked `true` below is seen by isDesktopApp(), not by store selection.
    setCredentialStoreForTests(createMemoryCredentialStore());
    vi.mocked(Capacitor.isNativePlatform).mockReturnValueOnce(true);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const targets = await getConnectionTargets();
    expect(targets).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("connection URL policy", () => {
  beforeEach(async () => {
    setCredentialStoreForTests(createMemoryCredentialStore());
    await clearConfig();
    vi.mocked(Capacitor.isNativePlatform).mockImplementation(() => true);
    vi.stubEnv("DEV", false); // behave like a release build
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(Capacitor.isNativePlatform).mockImplementation(() => false);
  });

  it("setProxyBaseUrl refuses a cleartext LAN address", async () => {
    await expect(setProxyBaseUrl("http://192.168.1.5:8787")).rejects.toThrow(/https/i);
    expect(await getProxyBaseUrl()).toBeNull();
  });

  it("setRemoteGatewayUrl refuses cleartext and accepts https", async () => {
    await expect(setRemoteGatewayUrl("http://gw.example.com")).rejects.toThrow(/https/i);
    await setRemoteGatewayUrl("https://gw.example.com/");
    expect(await getRemoteGatewayUrl()).toBe("https://gw.example.com");
  });

  it("an empty url still clears a profile", async () => {
    await setProxyBaseUrl("");
    expect(await getProxyBaseUrl()).toBe("");
  });

  it("a legacy stored http LAN profile yields no target and a migration error, before any token is used", async () => {
    await Preferences.set({ key: "pieces-android:proxyBaseUrl", value: "http://192.168.1.5:8787" });
    await setProxyToken("lan-secret");
    await expect(getConnectionTargets()).rejects.toThrow(/https/i);
  });

  it("falls over to the https profile when only the LAN profile is cleartext", async () => {
    await Preferences.set({ key: "pieces-android:proxyBaseUrl", value: "http://192.168.1.5:8787" });
    await setProxyToken("lan-secret");
    await Preferences.set({ key: "pieces-android:remoteGatewayUrl", value: "https://gw.example.com" });
    await setRemoteGatewayToken("gw-secret");
    const targets = await getConnectionTargets();
    expect(targets).toEqual([{ baseUrl: "https://gw.example.com", token: "gw-secret", mode: "remote" }]);
  });

  it("loopback http is refused on the native app but allowed on desktop", async () => {
    await Preferences.set({ key: "pieces-android:proxyBaseUrl", value: "http://127.0.0.1:8787" });
    await setProxyToken("t");
    await expect(getConnectionTargets()).rejects.toThrow();
    vi.mocked(Capacitor.isNativePlatform).mockImplementation(() => false);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const targets = await getConnectionTargets();
    expect(targets.some((t) => t.baseUrl === "http://127.0.0.1:8787")).toBe(true);
  });

  it("checkConnectionUrl returns null for an acceptable url and a message for a rejected one", () => {
    expect(checkConnectionUrl("https://gw.example.com")).toBeNull();
    expect(checkConnectionUrl("http://192.168.1.5:8787")).toMatch(/https/i);
    expect(checkConnectionUrl("")).toMatch(/empty/i);
  });
});
