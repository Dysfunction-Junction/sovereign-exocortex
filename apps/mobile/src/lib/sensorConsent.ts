import { Capacitor, registerPlugin } from "@capacitor/core";

// Opt-in switches for phone sensor and app-switch telemetry (see SensorConsentPlugin.java).
//
// Everything is OFF until flipped. A sensor runs only while the master switch AND its own switch are on.
// Turning one off stops it immediately and deletes its unsent events on the phone; data already sent
// stays in the PC's append-only log.

export type SensorKey =
  | "motion" | "rotation" | "steps" | "sig_motion" | "activity"
  | "pressure" | "light" | "proximity" | "ambient_temp" | "battery"
  | "app_switches";

export interface SensorState {
  master: boolean;
  toggles: Record<SensorKey, boolean>;
  /** Hardware present, per key. app_switches is not hardware and is absent here. */
  caps: Partial<Record<SensorKey, boolean>>;
  /** ACTIVITY_RECOGNITION runtime permission, needed by steps and activity. */
  activityPermission: boolean;
}

interface SensorConsentNative {
  getState(): Promise<SensorState>;
  setToggle(options: { key: SensorKey; enabled: boolean }): Promise<SensorState>;
  setMaster(options: { enabled: boolean }): Promise<SensorState>;
  refresh(): Promise<SensorState>;
}

export const SensorConsent = registerPlugin<SensorConsentNative>("SensorConsent");

const STAYS = "Stays between your phone and your PC. Off stops collection immediately; data already sent stays in your log.";

export interface SensorInfo {
  key: SensorKey;
  title: string;
  /** Consent copy shown under the switch. */
  copy: string;
  needsActivityPermission?: boolean;
}

export const MASTER_COPY =
  "Master switch for every item below. Off stops all sensor and app-switch collection at once; each item also needs its own switch.";

/** Display order. Magnetometer, microphone, location and typed text are deliberately not here. */
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
];

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

/** The activity-permission hint applies to a sensor that is switched on but cannot run yet. */
export function needsActivityPermissionNow(state: SensorState, info: SensorInfo): boolean {
  return !!info.needsActivityPermission && state.toggles[info.key] === true && !state.activityPermission;
}
