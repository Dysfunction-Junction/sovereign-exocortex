import { Capacitor, registerPlugin } from "@capacitor/core";

// Typed-text summaries, phone side (see TypedTextPlugin.java). The package that builds the summarizer owns this file;
// the shared package only fixes the surface Setup and the /typed-text page call. Summaries never leave the phone.

export type KillSwitchControl = "accessibility_button" | "quick_settings_tile" | "in_app";

export interface TypedTextAuditItem {
  /** Epoch ms the note was written. */
  ts: number;
  /** Coarse app category, never a package name or text. */
  category: string;
  summary: string;
}

interface TypedTextNative {
  getPreferredControl(): Promise<{ control: KillSwitchControl }>;
  setPreferredControl(options: { control: KillSwitchControl }): Promise<{ control: KillSwitchControl }>;
  /** Needs a fresh fingerprint. Rejects when the prompt is cancelled. */
  listSummaries(): Promise<{ items: TypedTextAuditItem[] }>;
  eraseSummaries(): Promise<void>;
}

export const TypedText = registerPlugin<TypedTextNative>("TypedText");

export const CONTROL_LABELS: Record<KillSwitchControl, string> = {
  accessibility_button: "Accessibility button",
  quick_settings_tile: "Quick Settings tile",
  in_app: "In-app switch only",
};

export const DEFAULT_CONTROL: KillSwitchControl = "accessibility_button";

const isNative = (): boolean => Capacitor.isNativePlatform();

/** The control the user prefers for the instant off gesture; the default until the summarizer package lands. */
export async function getPreferredControl(): Promise<KillSwitchControl> {
  if (!isNative()) return DEFAULT_CONTROL;
  try {
    return (await TypedText.getPreferredControl()).control;
  } catch {
    return DEFAULT_CONTROL;
  }
}

export async function setPreferredControl(control: KillSwitchControl): Promise<KillSwitchControl> {
  if (!isNative()) return control;
  return (await TypedText.setPreferredControl({ control })).control;
}
