import { describe, it, expect } from "vitest";
import { parseConnectionQrPayload, InvalidConnectionQrError } from "./connectionQr";

describe("parseConnectionQrPayload", () => {
  it("parses valid standard connection QR payload", () => {
    const raw = JSON.stringify({
      baseUrl: "http://192.168.1.50:8787",
      token: "secret-bearer-123",
    });

    const parsed = parseConnectionQrPayload(raw);
    expect(parsed.baseUrl).toBe("http://192.168.1.50:8787");
    expect(parsed.token).toBe("secret-bearer-123");
    expect(parsed.pairingToken).toBeUndefined();
    expect(parsed.isPairingToken).toBe(false);
  });

  it("parses valid pairing QR payload with explicit pairingToken", () => {
    const raw = JSON.stringify({
      baseUrl: "http://100.64.0.1:8788/",
      pairingToken: "pt_abcdef0123456789",
    });

    const parsed = parseConnectionQrPayload(raw);
    expect(parsed.baseUrl).toBe("http://100.64.0.1:8788");
    expect(parsed.pairingToken).toBe("pt_abcdef0123456789");
    expect(parsed.isPairingToken).toBe(true);
  });

  it("identifies pt_ prefixed token as a pairing token for backwards compatibility", () => {
    const raw = JSON.stringify({
      baseUrl: "http://100.64.0.1:8788",
      token: "pt_secret_token_456",
    });

    const parsed = parseConnectionQrPayload(raw);
    expect(parsed.pairingToken).toBe("pt_secret_token_456");
    expect(parsed.isPairingToken).toBe(true);
  });

  it("parses IP and port shape into full baseUrl", () => {
    const raw = JSON.stringify({
      ip: "100.80.90.100",
      port: 8788,
      pairingToken: "pt_cdef123456",
    });

    const parsed = parseConnectionQrPayload(raw);
    expect(parsed.baseUrl).toBe("http://100.80.90.100:8788");
    expect(parsed.pairingToken).toBe("pt_cdef123456");
    expect(parsed.isPairingToken).toBe(true);
  });

  it("supports tailscaleIp property name and defaults port to 8788", () => {
    const raw = JSON.stringify({
      tailscaleIp: "100.64.1.2",
      token: "jwt-token-xyz",
    });

    const parsed = parseConnectionQrPayload(raw);
    expect(parsed.baseUrl).toBe("http://100.64.1.2:8788");
    expect(parsed.token).toBe("jwt-token-xyz");
    expect(parsed.isPairingToken).toBe(false);
  });

  it("rejects host injection via ip property with username/at symbol", () => {
    const raw = JSON.stringify({
      ip: "100.1.1.1@evil.com",
      port: 8788,
      token: "tok",
    });
    expect(() => parseConnectionQrPayload(raw)).toThrow(
      "must be a bare host or IP address"
    );
  });

  it("rejects host injection via ip property with path or hash", () => {
    const raw = JSON.stringify({
      ip: "100.1.1.1/evil#fragment",
      port: 8788,
      token: "tok",
    });
    expect(() => parseConnectionQrPayload(raw)).toThrow(InvalidConnectionQrError);
  });

  it("rejects invalid ports", () => {
    expect(() =>
      parseConnectionQrPayload(JSON.stringify({ ip: "100.1.1.1", port: 0, token: "tok" }))
    ).toThrow('"port" must be an integer between 1 and 65535');

    expect(() =>
      parseConnectionQrPayload(JSON.stringify({ ip: "100.1.1.1", port: 70000, token: "tok" }))
    ).toThrow('"port" must be an integer between 1 and 65535');

    expect(() =>
      parseConnectionQrPayload(JSON.stringify({ ip: "100.1.1.1", port: 80.5, token: "tok" }))
    ).toThrow('"port" must be an integer between 1 and 65535');

    expect(() =>
      parseConnectionQrPayload(JSON.stringify({ ip: "100.1.1.1", port: "8788", token: "tok" }))
    ).toThrow('"port" must be an integer between 1 and 65535');
  });

  it("throws on invalid JSON", () => {
    expect(() => parseConnectionQrPayload("not-json")).toThrow(InvalidConnectionQrError);
    expect(() => parseConnectionQrPayload("{ bad json")).toThrow(InvalidConnectionQrError);
  });

  it("throws on non-object JSON", () => {
    expect(() => parseConnectionQrPayload("123")).toThrow("expected a JSON object");
    expect(() => parseConnectionQrPayload("\"hello\"")).toThrow("expected a JSON object");
    expect(() => parseConnectionQrPayload("null")).toThrow("expected a JSON object");
    expect(() => parseConnectionQrPayload("[]")).toThrow("expected a JSON object");
  });

  it("throws when both baseUrl and IP are missing", () => {
    expect(() => parseConnectionQrPayload(JSON.stringify({ token: "tok" }))).toThrow(
      "missing or empty \"baseUrl\""
    );
  });

  it("throws on unsupported URL protocols", () => {
    expect(() =>
      parseConnectionQrPayload(JSON.stringify({ baseUrl: "ftp://100.64.0.1:21", token: "tok" }))
    ).toThrow("\"baseUrl\" must be http(s)");
  });

  it("throws when neither token nor pairingToken is supplied", () => {
    expect(() =>
      parseConnectionQrPayload(JSON.stringify({ baseUrl: "http://100.64.0.1:8788" }))
    ).toThrow("missing token or pairingToken in payload");

    expect(() =>
      parseConnectionQrPayload(JSON.stringify({ baseUrl: "http://100.64.0.1:8788", token: "  " }))
    ).toThrow("missing token or pairingToken in payload");
  });
});
