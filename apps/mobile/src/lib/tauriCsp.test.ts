import { describe, it, expect } from "vitest";
import confRaw from "../../../desktop/src-tauri/tauri.conf.json?raw";

const conf = JSON.parse(confRaw) as { app: { security: { csp: string | null; devCsp?: string | null } } };

function directives(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out.set(name, values);
  }
  return out;
}

describe("desktop production CSP", () => {
  const csp = conf.app.security.csp;

  it("is enabled", () => {
    expect(typeof csp).toBe("string");
  });

  const d = directives(csp ?? "");

  it("allows only same-origin scripts, with no eval or inline script", () => {
    expect(d.get("script-src")).toEqual(["'self'"]);
  });

  it("locks down object, base, frame and form targets", () => {
    expect(d.get("object-src")).toEqual(["'none'"]);
    expect(d.get("base-uri")).toEqual(["'self'"]);
    expect(d.get("frame-src")).toEqual(["'none'"]);
    expect(d.get("form-action")).toEqual(["'none'"]);
  });

  it("restricts connect-src to explicit origins plus Tauri IPC", () => {
    const connect = d.get("connect-src") ?? [];
    expect(connect).toContain("'self'");
    expect(connect).toContain("ipc:");
    expect(connect).toContain("http://ipc.localhost");
    expect(connect).toContain("http://127.0.0.1:8788");
    expect(connect).not.toContain("*");
    expect(connect.some((v) => v === "http:" || v === "https:" || v === "ws:" || v === "wss:")).toBe(false);
  });

  it("never uses unsafe-eval anywhere", () => {
    expect(csp ?? "").not.toContain("unsafe-eval");
  });

  it("keeps HMR permissions in a separate dev policy", () => {
    expect(conf.app.security.devCsp).toBeTruthy();
    expect(csp ?? "").not.toMatch(/ws:\/\/|localhost:\*/);
  });
});
