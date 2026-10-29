import { beforeEach, describe, expect, it, vi } from "vitest";
import { Capacitor } from "@capacitor/core";
import {
  LABELS, PlaceLabel, describePlace, forgetPlaces, formatDwell, getCurrentPlace, labelPlace, type CurrentPlace,
} from "./places";

// registerPlugin is stubbed to {} in test/setup.ts; attach the native methods here.
const native = PlaceLabel as unknown as Record<string, ReturnType<typeof vi.fn>>;
const HERE: CurrentPlace = { placeId: "pl_k3f9a2xq", label: "unlabeled", dwellMs: 130 * 60_000 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
  native.current = vi.fn().mockResolvedValue(HERE);
  native.setLabel = vi.fn().mockResolvedValue({ ...HERE, label: "home" });
  native.forget = vi.fn().mockResolvedValue(undefined);
});

describe("places", () => {
  it("offers Home, Work, Other and Clear, and nothing that could carry a network name", () => {
    expect(LABELS.map((l) => l.title)).toEqual(["Home", "Work", "Other", "Clear"]);
  });

  it("does nothing off-device", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    expect(await getCurrentPlace()).toBeNull();
    expect(await labelPlace("pl_x", "home")).toBeNull();
    expect(await forgetPlaces()).toBe(false);
    expect(native.current).not.toHaveBeenCalled();
    expect(native.forget).not.toHaveBeenCalled();
  });

  it("passes labels and forget through to native", async () => {
    expect((await labelPlace("pl_k3f9a2xq", "home"))?.label).toBe("home");
    expect(native.setLabel).toHaveBeenCalledWith({ placeId: "pl_k3f9a2xq", label: "home" });
    expect(await forgetPlaces()).toBe(true);
    expect(native.forget).toHaveBeenCalledOnce();
  });

  it("rejects an unknown label before calling native", async () => {
    await expect(labelPlace("pl_x", "my-wifi" as never)).rejects.toThrow(/unknown label/);
    expect(native.setLabel).not.toHaveBeenCalled();
  });

  it("formats dwell time", () => {
    expect(formatDwell(0)).toBe("under a minute");
    expect(formatDwell(45 * 60_000)).toBe("45 m");
    expect(formatDwell(120 * 60_000)).toBe("2 h");
    expect(formatDwell(130 * 60_000)).toBe("2 h 10 m");
  });

  it("describes the current place by id and label, or as unknown", () => {
    expect(describePlace(HERE)).toBe("You are at pl_k3f9a2xq (dwell 2 h 10 m).");
    expect(describePlace({ ...HERE, label: "home" })).toBe("You are at home (pl_k3f9a2xq) (dwell 2 h 10 m).");
    expect(describePlace({ placeId: null, label: "unknown", dwellMs: 0 })).toBe("Place unknown right now.");
    expect(describePlace(null)).toBe("Place unknown right now.");
  });
});
