import { describe, it, expect, vi, beforeEach } from "vitest";
import { Capacitor } from "@capacitor/core";
import {
  getTypedCounters,
  isTypedGateOn,
  toggleTypedGate,
  setPreferredControl,
  getPreferredControl,
  listTypedNotes,
  unlockEpoch,
  lockAuditSession,
  deleteTypedNote,
  deleteAllTypedNotes,
  TypedText
} from "./typedText";

const native = TypedText as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe("typedText TS library", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
  });

  it("getCounters delegates to plugin", async () => {
    const mockCounters = {
      captured: 10,
      flushed: 5,
      stored: 4,
      dropped: 1,
      dropped_reasons: { locked: 1 },
      stripped_reasons: {}
    };
    native.getCounters = vi.fn().mockResolvedValue(mockCounters);

    const res = await getTypedCounters();
    expect(res).toEqual(mockCounters);
  });

  it("isTypedGateOn returns boolean", async () => {
    native.isGateOn = vi.fn().mockResolvedValue({ on: true });
    expect(await isTypedGateOn()).toBe(true);

    native.isGateOn = vi.fn().mockResolvedValue({ on: false });
    expect(await isTypedGateOn()).toBe(false);
  });

  it("toggleTypedGate passes option", async () => {
    native.toggleGate = vi.fn().mockResolvedValue({ on: true });
    expect(await toggleTypedGate(true)).toBe(true);
    expect(native.toggleGate).toHaveBeenCalledWith({ enabled: true });
  });

  it("preferredControl getters and setters work", async () => {
    native.setPreferredControl = vi.fn().mockResolvedValue({ control: "quick_settings_tile" });
    expect(await setPreferredControl("quick_settings_tile")).toBe("quick_settings_tile");

    native.getPreferredControl = vi.fn().mockResolvedValue({ control: "quick_settings_tile" });
    expect(await getPreferredControl()).toBe("quick_settings_tile");
  });

  it("listTypedNotes returns array", async () => {
    const mockNotes = [
      {
        id: "note-1",
        epoch_id: 1,
        created_at: 1000,
        expires_at: 2000,
        app_category: "notes",
        source: "typed" as const,
        unlocked: true,
        intent: "plan",
        topics: ["planning"],
        entity_types: ["task"],
        summary: "Plan weekend project"
      }
    ];
    native.listNotes = vi.fn().mockResolvedValue({ notes: mockNotes });

    const notes = await listTypedNotes(1);
    expect(notes).toEqual(mockNotes);
  });

  it("unlockEpoch calls plugin unlock", async () => {
    native.unlock = vi.fn().mockResolvedValue({ ok: true, epoch_id: 42 });
    expect(await unlockEpoch(42)).toBe(true);
    expect(native.unlock).toHaveBeenCalledWith({ epoch: 42 });
  });

  it("delete operations delegate correctly", async () => {
    native.deleteNote = vi.fn().mockResolvedValue({ ok: true });
    expect(await deleteTypedNote("note-1")).toBe(true);
    expect(native.deleteNote).toHaveBeenCalledWith({ id: "note-1" });

    native.deleteAll = vi.fn().mockResolvedValue({ ok: true });
    expect(await deleteAllTypedNotes()).toBe(true);
    expect(native.deleteAll).toHaveBeenCalled();
  });

  it("lockAuditSession delegates to plugin", async () => {
    native.lockAuditSession = vi.fn().mockResolvedValue({ ok: true });
    expect(await lockAuditSession()).toBe(true);
    expect(native.lockAuditSession).toHaveBeenCalled();
  });
});
