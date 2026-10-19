import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isSynapticAudioEnabled,
  setSynapticAudioEnabled,
  playActionPotential,
  playSynapticCascade,
  playLateralInhibitionRelax,
} from "./synapticAudio";

describe("synapticAudio", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await setSynapticAudioEnabled(true);
  });

  it("defaults to enabled", async () => {
    const enabled = await isSynapticAudioEnabled();
    expect(enabled).toBe(true);
  });

  it("persists enabled state when toggled", async () => {
    await setSynapticAudioEnabled(false);
    expect(await isSynapticAudioEnabled()).toBe(false);

    await setSynapticAudioEnabled(true);
    expect(await isSynapticAudioEnabled()).toBe(true);
  });

  it("handles audio calls safely without throwing in headless environments", async () => {
    await expect(playActionPotential()).resolves.toBeUndefined();
    await expect(playSynapticCascade(1)).resolves.toBeUndefined();
    await expect(playSynapticCascade(2)).resolves.toBeUndefined();
    await expect(playLateralInhibitionRelax()).resolves.toBeUndefined();
  });

  it("does not trigger audio synthesis when disabled", async () => {
    await setSynapticAudioEnabled(false);
    await expect(playActionPotential()).resolves.toBeUndefined();
    await expect(playSynapticCascade(1)).resolves.toBeUndefined();
    await expect(playLateralInhibitionRelax()).resolves.toBeUndefined();
  });
});
