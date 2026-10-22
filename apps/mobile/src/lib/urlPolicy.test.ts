import { describe, it, expect } from "vitest";
import { validateBaseUrl } from "./urlPolicy";

describe("validateBaseUrl", () => {
  it("accepts https and normalizes the trailing slash", () => {
    expect(validateBaseUrl("https://pieces.example.com/")).toEqual({ ok: true, url: "https://pieces.example.com" });
    expect(validateBaseUrl("https://gw.example.com:8788")).toEqual({ ok: true, url: "https://gw.example.com:8788" });
  });

  it("rejects http to a LAN address with an actionable reason", () => {
    const r = validateBaseUrl("http://192.168.1.5:8787");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/https/i);
  });

  it("rejects http to a public host", () => {
    expect(validateBaseUrl("http://pieces.example.com").ok).toBe(false);
  });

  it("does not treat a hostname merely containing 'localhost' as loopback", () => {
    expect(validateBaseUrl("http://localhost.evil.com", { allowLoopbackHttp: true }).ok).toBe(false);
    expect(validateBaseUrl("http://evil-localhost", { allowLoopbackHttp: true }).ok).toBe(false);
    expect(validateBaseUrl("http://127.0.0.1.evil.com", { allowLoopbackHttp: true }).ok).toBe(false);
  });

  it("allows literal loopback http only when the caller opts in", () => {
    for (const u of ["http://127.0.0.1:8787", "http://localhost:8788", "http://[::1]:8788"]) {
      expect(validateBaseUrl(u).ok).toBe(false);
      expect(validateBaseUrl(u, { allowLoopbackHttp: true }).ok).toBe(true);
    }
  });

  it("rejects embedded credentials", () => {
    expect(validateBaseUrl("https://user:pw@example.com").ok).toBe(false);
    expect(validateBaseUrl("https://user@example.com").ok).toBe(false);
  });

  it("rejects unsupported schemes", () => {
    for (const u of ["ftp://example.com", "file:///etc/passwd", "javascript:alert(1)", "ws://example.com"]) {
      expect(validateBaseUrl(u).ok).toBe(false);
    }
  });

  it("rejects paths, queries and fragments (base URLs are origins)", () => {
    for (const u of ["https://example.com/api", "https://example.com/?a=1", "https://example.com/#x"]) {
      expect(validateBaseUrl(u).ok).toBe(false);
    }
  });

  it("rejects garbage and empty input", () => {
    expect(validateBaseUrl("").ok).toBe(false);
    expect(validateBaseUrl("not a url").ok).toBe(false);
    expect(validateBaseUrl("   ").ok).toBe(false);
  });
});
