import { describe, it, expect, vi, afterEach } from "vitest";
import { exchangePairingToken } from "./pairing";

describe("exchangePairingToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("successfully exchanges a pairing token for a device token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        token: "jwt-device-token-abc",
        deviceId: "dev_123",
        label: "Android Companion",
      }),
    } as Response);

    const result = await exchangePairingToken("http://127.0.0.1:8788", "pt_valid_token");
    expect(result.ok).toBe(true);
    expect(result.token).toBe("jwt-device-token-abc");
    expect(result.deviceId).toBe("dev_123");
  });

  it("handles trailing slashes on baseUrl", async () => {
    let capturedUrl = "";
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (input) => {
      capturedUrl = String(input);
      return {
        ok: true,
        json: async () => ({
          ok: true,
          token: "jwt-device-token-abc",
          deviceId: "dev_123",
        }),
      } as Response;
    });

    await exchangePairingToken("http://127.0.0.1:8788///", "pt_valid_token");
    expect(capturedUrl).toBe("http://127.0.0.1:8788/mobile/pair");
  });

  it("throws when server returns an HTTP error status with JSON reason", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ reason: "token expired" }),
    } as Response);

    await expect(exchangePairingToken("http://127.0.0.1:8788", "pt_expired")).rejects.toThrow(
      "Pairing failed: token expired"
    );
  });

  it("throws when server returns ok: false or missing token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: false, reason: "invalid token" }),
    } as Response);

    await expect(exchangePairingToken("http://127.0.0.1:8788", "pt_bad")).rejects.toThrow(
      "Pairing failed: invalid token"
    );
  });
});
