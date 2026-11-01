import { registerPlugin, Capacitor } from "@capacitor/core";

export type KillSwitchControl =
  | "accessibility_button"
  | "quick_settings_tile"
  | "in_app"
  | "button"
  | "tile"
  | "app";

export type PreferredControl = KillSwitchControl;

export const CONTROL_LABELS: Record<string, string> = {
  accessibility_button: "Accessibility button",
  quick_settings_tile: "Quick Settings tile",
  in_app: "In-app switch only",
  button: "Accessibility button",
  tile: "Quick Settings tile",
  app: "In-app switch only",
};

export const DEFAULT_CONTROL: KillSwitchControl = "accessibility_button";

export interface TypedTextCounters {
  captured: number;
  flushed: number;
  stored: number;
  dropped: number;
  dropped_reasons?: Record<string, number>;
  stripped_reasons?: Record<string, number>;
  [key: string]: any;
}

export interface TypedNote {
  id: string;
  epoch_id: number;
  created_at: number;
  expires_at: number;
  app_category: string;
  source: "typed" | "speech";
  unlocked: boolean;
  intent?: string;
  topics?: string[];
  entity_types?: string[];
  summary?: string;
  stripped_reason?: string;
}

export interface TypedTextPluginInterface {
  setSecureWindow(options?: { secure?: boolean }): Promise<void>;
  getCounters(): Promise<TypedTextCounters>;
  isGateOn(): Promise<{ on: boolean }>;
  toggleGate(options?: { enabled?: boolean }): Promise<{ on: boolean }>;
  setPreferredControl(options: { control: KillSwitchControl }): Promise<{ control: KillSwitchControl }>;
  getPreferredControl(): Promise<{ control: KillSwitchControl }>;
  listNotes(options?: { epoch?: number }): Promise<{ notes: TypedNote[] }>;
  unlock(options: { epoch: number }): Promise<{ ok: boolean; epoch_id: number }>;
  lockAuditSession(): Promise<{ ok: boolean }>;
  deleteNote(options: { id: string }): Promise<{ ok: boolean }>;
  deleteAll(): Promise<{ ok: boolean }>;
}

export const TypedText = registerPlugin<TypedTextPluginInterface>("TypedText", {
  web: {
    setSecureWindow: async () => {},
    getCounters: async () => ({
      captured: 0,
      flushed: 0,
      stored: 0,
      dropped: 0,
      dropped_reasons: {},
      stripped_reasons: {}
    }),
    isGateOn: async () => ({ on: false }),
    toggleGate: async (opts?: { enabled?: boolean }) => ({ on: opts?.enabled ?? false }),
    setPreferredControl: async (opts: { control: KillSwitchControl }) => ({ control: opts.control }),
    getPreferredControl: async () => ({ control: DEFAULT_CONTROL }),
    listNotes: async () => ({ notes: [] }),
    unlock: async (opts: { epoch: number }) => ({ ok: true, epoch_id: opts.epoch }),
    lockAuditSession: async () => ({ ok: true }),
    deleteNote: async () => ({ ok: true }),
    deleteAll: async () => ({ ok: true })
  }
});

export const isNative = (): boolean => Capacitor.isNativePlatform();

export async function setSecureWindow(secure: boolean = true): Promise<void> {
  if (!isNative()) return;
  await TypedText.setSecureWindow({ secure });
}

export async function getTypedCounters(): Promise<TypedTextCounters> {
  return TypedText.getCounters();
}

export async function isTypedGateOn(): Promise<boolean> {
  const res = await TypedText.isGateOn();
  return res.on;
}

export async function toggleTypedGate(enabled?: boolean): Promise<boolean> {
  const res = await TypedText.toggleGate(enabled !== undefined ? { enabled } : undefined);
  return res.on;
}

export async function setPreferredControl(control: KillSwitchControl): Promise<KillSwitchControl> {
  if (!isNative()) return control;
  const res = await TypedText.setPreferredControl({ control });
  return res.control;
}

export async function getPreferredControl(): Promise<KillSwitchControl> {
  if (!isNative()) return DEFAULT_CONTROL;
  try {
    const res = await TypedText.getPreferredControl();
    return res.control;
  } catch {
    return DEFAULT_CONTROL;
  }
}

export async function listTypedNotes(epoch?: number): Promise<TypedNote[]> {
  const res = await TypedText.listNotes(epoch !== undefined ? { epoch } : undefined);
  return res.notes || [];
}

export async function unlockEpoch(epoch: number): Promise<boolean> {
  const res = await TypedText.unlock({ epoch });
  return res.ok;
}

export async function lockAuditSession(): Promise<boolean> {
  const res = await TypedText.lockAuditSession();
  return res.ok;
}

export async function deleteTypedNote(id: string): Promise<boolean> {
  const res = await TypedText.deleteNote({ id });
  return res.ok;
}

export async function deleteAllTypedNotes(): Promise<boolean> {
  const res = await TypedText.deleteAll();
  return res.ok;
}
