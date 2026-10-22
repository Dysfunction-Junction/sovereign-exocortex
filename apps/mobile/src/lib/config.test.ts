import { describe, it, expect, vi, beforeEach } from "vitest";
import { Capacitor } from "@capacitor/core";
import {
  clearConfig,
  getConnectionTargets,
  getProxyBaseUrl,
  getProxyToken,
  getRemoteGatewayUrl,
  getRemoteGatewayToken,
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
