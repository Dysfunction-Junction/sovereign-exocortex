import { afterEach, describe, expect, test, vi } from "vitest";
import { fireAndForget, logRejection } from "./fireAndForget";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fireAndForget", () => {
  test("a rejected promise is logged, never left unhandled", async () => {
    // vitest fails the run on any unhandled rejection, so reaching the
    // assertion also proves nothing leaked.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fireAndForget(Promise.reject(new Error("storage full")), "test.label");
    await new Promise((r) => setTimeout(r, 10));
    expect(warn).toHaveBeenCalledWith("[test.label]", "storage full");
  });

  test("tolerates a non-promise return value without throwing", () => {
    expect(() => fireAndForget(undefined, "stub")).not.toThrow();
  });

  test("a resolved promise logs nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fireAndForget(Promise.resolve(1), "ok");
    await new Promise((r) => setTimeout(r, 5));
    expect(warn).not.toHaveBeenCalled();
  });

  test("logRejection tolerates non-Error reasons", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logRejection("x")("plain string");
    expect(warn).toHaveBeenCalledWith("[x]", "plain string");
  });
});
