import { Capacitor, registerPlugin } from "@capacitor/core";

// Opt-in switches for phone sensor and app-switch telemetry (see SensorConsentPlugin.java).
//
// Everything is OFF until flipped. A sensor runs only while the master switch AND its own switch are on.
// Turning one off stops it immediately and deletes its unsent events on the phone; data already sent
// stays in the PC's append-only log.

export type SensorKey =
  | "motion" | "rotation" | "steps" | "sig_motion" | "activity"
  | "pressure" | "light" | "proximity" | "ambient_temp" | "battery"
  | "app_switches"
  | "mic_speech" | "places" | "typing_rhythm";

/** Typed-text summaries: a consent key, but not a sensor. Master OFF forces it off; master ON never turns it on. */
export type ConsentKey = SensorKey | "typed_text";

export interface SensorState {
  master: boolean;
  toggles: Record<SensorKey, boolean>;
  /** Hardware present, per key. app_switches is not hardware and is absent here. */
  caps: Partial<Record<SensorKey, boolean>>;
  /** ACTIVITY_RECOGNITION runtime permission, needed by steps and activity. */
  activityPermission: boolean;
  /** RECORD_AUDIO, needed by mic_speech. */
  micPermission: boolean;
  /** Precise location (ACCESS_FINE_LOCATION): Android requires it to read Wi-Fi scan results for places. */
  fineLocation: boolean;
  /** "Allow all the time" location, so places keep working with the screen off. */
  backgroundLocation: boolean;
  /** Effective typed-text state (master AND its own switch). */
  typedText: boolean;
}

interface SensorConsentNative {
  getState(): Promise<SensorState>;
  setToggle(options: { key: ConsentKey; enabled: boolean }): Promise<SensorState>;
  requestPermission(options: { name: SensorPermission }): Promise<SensorState>;
  setMaster(options: { enabled: boolean }): Promise<SensorState>;
  refresh(): Promise<SensorState>;
}

export type SensorPermission = "mic" | "fineLocation" | "backgroundLocation";

export const SensorConsent = registerPlugin<SensorConsentNative>("SensorConsent");

const STAYS = "Stays between your phone and your PC. Off stops collection immediately; data already sent stays in your log.";

export interface SensorInfo {
  key: SensorKey;
  title: string;
  /** Consent copy shown under the switch. */
  copy: string;
  needsActivityPermission?: boolean;
  /** Runtime permissions this item needs before it can run, asked in order. */
  needsPermissions?: SensorPermission[];
}

export const MASTER_COPY =
  "Master switch for every item below. Off stops all sensor and app-switch collection at once; each item also needs its own switch.";

/** Display order. Magnetometer is deliberately not here. Typed text is a consent key, listed in TYPED_TEXT. */
export const SENSORS: SensorInfo[] = [
  { key: "app_switches", title: "App switches", copy: `Which app you opened and when. Banking, password, authenticator and health apps are recorded only as 'excluded'. ${STAYS}` },
  { key: "motion", title: "Motion", copy: `Motion: how much the phone moved in each 5-minute window (a number, not a recording). ${STAYS}` },
  { key: "rotation", title: "Orientation", copy: `Orientation: whether the phone is flat, upright or tilted, and how much it turns in each 5-minute window (a label, not a recording). ${STAYS}` },
  { key: "steps", title: "Steps", copy: `Steps: how many steps in each 5-minute window (a count). ${STAYS}`, needsActivityPermission: true },
  { key: "sig_motion", title: "Significant motion", copy: `Significant motion: whether the phone was picked up and carried during each 5-minute window (yes or no). ${STAYS}` },
  { key: "activity", title: "Activity", copy: `Activity: still, walking, running or in a vehicle, guessed on the phone from motion and steps. ${STAYS}`, needsActivityPermission: true },
  { key: "pressure", title: "Air pressure", copy: `Pressure: whether air pressure rose, fell or held steady in each 5-minute window (never the reading itself). Changes in air pressure can reveal stairs, elevators and travel. ${STAYS}` },
  { key: "light", title: "Light", copy: `Light: dark, dim, indoor, bright or sun for each 5-minute window (a bucket, not a lux reading). ${STAYS}` },
  { key: "proximity", title: "Proximity", copy: `Proximity: the share of each 5-minute window the phone was covered or against something (a fraction). ${STAYS}` },
  { key: "ambient_temp", title: "Ambient temperature", copy: `Ambient temperature: the room temperature the phone reports, if it has that sensor. ${STAYS}` },
  { key: "battery", title: "Battery", copy: `Battery: charge level, whether it is plugged in, and battery temperature at the end of each 5-minute window. ${STAYS}` },
  {
    key: "mic_speech", title: "Speech nearby",
    copy: "Listens for 5 seconds every 2 minutes, only while your screen is on and the phone is not in a pocket, to tell whether someone is speaking (yes/no). No audio is saved or sent and nothing is transcribed. Calls are detected from the phone's call state, not the mic. You will see the mic indicator each time. Off stops it immediately; data already sent stays in your log.",
    needsPermissions: ["mic"],
  },
  {
    key: "places", title: "Places",
    copy: "Recognizes places you return to from nearby Wi-Fi, never GPS. Network names are never stored; networks become scrambled ids that work on this phone only. Your PC receives only a place id, your label (home/work/other) and how long you stayed. Needs precise location permission to read Wi-Fi. Off stops it immediately; 'Forget places' erases what the phone learned.",
    needsPermissions: ["fineLocation", "backgroundLocation"],
  },
  { key: "typing_rhythm", title: "Typing rhythm", copy: `How much and how fast you type in each 5-minute window: counts only, never letters or words. ${STAYS}` },
];

export interface TypedTextInfo { key: "typed_text"; title: string; copy: string }

/** Shown in its own Setup section, not in the sensor list. The summarizer is a bundled on-device Gemma model (decision D1). */
export const TYPED_TEXT: TypedTextInfo = {
  key: "typed_text",
  title: "Typed-text summaries",
  copy: "Text you type, except in excluded apps (banking, passwords, authenticators, health, Signal, Telegram, WhatsApp, dating), is summarized on this phone by an on-device model into a short note. The text itself is never saved, shown or sent. Notes stay on this phone, encrypted, for 7 days, and open only with your fingerprint. Email and text messages are included. Incognito browser tabs may not be detected. Turn it off instantly with the Accessibility button or the Quick Settings tile.",
};

export const isNative = (): boolean => Capacitor.isNativePlatform();

/** Current consent and hardware state, or null off-device (browser/dev server). */
export async function getSensorState(): Promise<SensorState | null> {
  if (!isNative()) return null;
  return SensorConsent.getState();
}

export async function setSensorToggle(key: SensorKey, enabled: boolean): Promise<SensorState | null> {
  if (!isNative()) return null;
  if (!SENSORS.some((s) => s.key === key)) throw new Error(`unknown sensor: ${key}`);
  return SensorConsent.setToggle({ key, enabled });
}

/** Typed-text summaries on/off. Needs the master switch on first; master off forces this off on the phone. */
export async function setTypedText(enabled: boolean): Promise<SensorState | null> {
  if (!isNative()) return null;
  return SensorConsent.setToggle({ key: "typed_text", enabled });
}

/** System prompt for one runtime permission. Granting does not switch anything on. */
export async function requestSensorPermission(name: SensorPermission): Promise<SensorState | null> {
  if (!isNative()) return null;
  return SensorConsent.requestPermission({ name });
}

export async function setSensorMaster(enabled: boolean): Promise<SensorState | null> {
  if (!isNative()) return null;
  return SensorConsent.setMaster({ enabled });
}

/** Re-apply stored consent, e.g. after the user grants Activity Recognition. */
export async function refreshSensors(): Promise<SensorState | null> {
  if (!isNative()) return null;
  return SensorConsent.refresh();
}

/** A sensor is collecting only when master and its own switch are both on. */
export function isCollecting(state: SensorState, key: SensorKey): boolean {
  return state.master && state.toggles[key] === true;
}

/** False when the probe says the hardware is missing. app_switches and unprobed keys count as available. */
export function isAvailable(state: SensorState, key: SensorKey): boolean {
  return state.caps[key] !== false;
}

/** The first permission a switched-on item still lacks, or null. Location is asked fine first, then all-the-time. */
export function missingPermission(state: SensorState, info: SensorInfo): SensorPermission | null {
  if (!info.needsPermissions || state.toggles[info.key] !== true) return null;
  const granted: Record<SensorPermission, boolean> = {
    mic: state.micPermission, fineLocation: state.fineLocation, backgroundLocation: state.backgroundLocation,
  };
  return info.needsPermissions.find((p) => !granted[p]) ?? null;
}

/** The activity-permission hint applies to a sensor that is switched on but cannot run yet. */
export function needsActivityPermissionNow(state: SensorState, info: SensorInfo): boolean {
  return !!info.needsActivityPermission && state.toggles[info.key] === true && !state.activityPermission;
}
