import { describe, expect, it } from "vitest";
import { decodeJwtForDisplay } from "./jwtDisplay";

const b64 = (s: string) => btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

describe("decodeJwtForDisplay", () => {
  it("returns null (not a TypeError) when the payload decodes to JSON null", () => {
    expect(decodeJwtForDisplay(`h.${b64("null")}.s`)).toBeNull();
  });

  it("still reads exp/iat from a normal payload", () => {
    const info = decodeJwtForDisplay(`h.${b64('{"exp":2000000000,"iat":1000000000}')}.s`);
    expect(info?.expiresAt?.getTime()).toBe(2_000_000_000_000);
    expect(info?.issuedAt?.getTime()).toBe(1_000_000_000_000);
  });
});
