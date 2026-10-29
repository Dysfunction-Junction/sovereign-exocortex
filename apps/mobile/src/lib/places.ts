import { Capacitor, registerPlugin } from "@capacitor/core";

// Wi-Fi place recognition, phone side (see PlaceLabelPlugin.java). Places are random ids the phone learned from
// nearby Wi-Fi; no network name, coordinates or trail is ever shown here or sent anywhere. The PC receives only the
// place id, your label and how long you stayed.

export type PlaceLabelName = "home" | "work" | "other" | "unlabeled";

export interface CurrentPlace {
  /** Null when the phone cannot tell where you are ("unknown"). */
  placeId: string | null;
  label: PlaceLabelName | "unknown";
  dwellMs: number;
}

interface PlaceLabelNative {
  current(): Promise<CurrentPlace>;
  setLabel(options: { placeId: string; label: PlaceLabelName }): Promise<CurrentPlace>;
  forget(): Promise<void>;
}

export const PlaceLabel = registerPlugin<PlaceLabelNative>("PlaceLabel");

export const LABELS: { value: PlaceLabelName; title: string }[] = [
  { value: "home", title: "Home" },
  { value: "work", title: "Work" },
  { value: "other", title: "Other" },
  { value: "unlabeled", title: "Clear" },
];

const isNative = (): boolean => Capacitor.isNativePlatform();

/** Where the phone thinks you are, or null off-device. */
export async function getCurrentPlace(): Promise<CurrentPlace | null> {
  if (!isNative()) return null;
  return PlaceLabel.current();
}

export async function labelPlace(placeId: string, label: PlaceLabelName): Promise<CurrentPlace | null> {
  if (!isNative()) return null;
  if (!LABELS.some((l) => l.value === label)) throw new Error(`unknown label: ${label}`);
  return PlaceLabel.setLabel({ placeId, label });
}

/** Erases every learned place and the key that scrambles network ids. Cannot be undone. */
export async function forgetPlaces(): Promise<boolean> {
  if (!isNative()) return false;
  await PlaceLabel.forget();
  return true;
}

/** "2 h 10 m", "45 m", "under a minute". */
export function formatDwell(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / 60_000);
  if (mins < 1) return "under a minute";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} m`;
  return m === 0 ? `${h} h` : `${h} h ${m} m`;
}

/** The status line under the Places switch. Never contains a network name. */
export function describePlace(p: CurrentPlace | null): string {
  if (!p || !p.placeId) return "Place unknown right now.";
  const name = p.label === "unlabeled" || p.label === "unknown" ? p.placeId : `${p.label} (${p.placeId})`;
  return `You are at ${name} (dwell ${formatDwell(p.dwellMs)}).`;
}
