import { Capacitor, registerPlugin } from "@capacitor/core";

// Phone permissions the exocortex uses (see DevicePermissionsPlugin.java).
//
// Two kinds:
//  - runtime prompts ("activity", "calendar", "callLog"): requestRuntime() shows the system dialog
//  - special grants (usage access, battery exemption, DND, notification access, accessibility): Android
//    only allows these from Settings, so openSetting() takes the user to the right screen

export type RuntimePermission = "activity" | "calendar" | "callLog";
export type SettingsPermission = "usageAccess" | "battery" | "dnd" | "notificationAccess" | "accessibility";
export type PermissionName = RuntimePermission | SettingsPermission;

export type PermissionStatus = Record<PermissionName, boolean>;

interface DevicePermissionsNative {
  status(): Promise<PermissionStatus>;
  requestRuntime(options: { name: RuntimePermission }): Promise<PermissionStatus>;
  openSetting(options: { name: SettingsPermission | "app" }): Promise<void>;
  sendUsageSnapshot(options?: { minutes?: number }): Promise<{ queued: boolean; result: string }>;
}

export const DevicePermissions = registerPlugin<DevicePermissionsNative>("DevicePermissions");

export interface PermissionInfo {
  name: PermissionName;
  title: string;
  why: string;
  kind: "runtime" | "settings";
  optional: boolean;
}

/** Display order: what fixes or feeds the telemetry stream first, optional extras last. */
export const PERMISSIONS: PermissionInfo[] = [
  { name: "accessibility", title: "Accessibility service", why: "Foreground-app capture. Android turns this off after updates.", kind: "settings", optional: false },
  { name: "notificationAccess", title: "Notification access", why: "Notification capture and triage.", kind: "settings", optional: false },
  { name: "battery", title: "Battery: unrestricted", why: "Keeps the 15-minute sync job alive under Doze.", kind: "settings", optional: false },
  { name: "usageAccess", title: "Usage access", why: "Per-app foreground time and app switches.", kind: "settings", optional: false },
  { name: "activity", title: "Activity recognition", why: "Still, walking or driving, for the focus gate.", kind: "runtime", optional: false },
  { name: "dnd", title: "Do Not Disturb access", why: "Read your focus and DND state.", kind: "settings", optional: true },
  { name: "calendar", title: "Calendar (read)", why: "Meetings and free time.", kind: "runtime", optional: true },
  { name: "callLog", title: "Call log (read)", why: "Live calls instead of the Fi export.", kind: "runtime", optional: true },
];

export const isNative = (): boolean => Capacitor.isNativePlatform();

/** Current state of every permission, or null off-device (browser/dev server). */
export async function getPermissionStatus(): Promise<PermissionStatus | null> {
  if (!isNative()) return null;
  return DevicePermissions.status();
}

/** Ask for one permission: a system dialog for runtime ones, the right Settings screen for special ones. */
export async function requestPermission(name: PermissionName): Promise<PermissionStatus | null> {
  if (!isNative()) return null;
  const info = PERMISSIONS.find((p) => p.name === name);
  if (!info) throw new Error(`unknown permission: ${name}`);
  if (info.kind === "runtime") return DevicePermissions.requestRuntime({ name: name as RuntimePermission });
  await DevicePermissions.openSetting({ name: name as SettingsPermission });
  return null; // the user returns from Settings; call getPermissionStatus() again on resume
}

/** Queue an app-usage summary now (diagnostic; the sync job also does this every ~15 minutes). */
export async function sendUsageSnapshot(minutes = 15): Promise<{ queued: boolean; result: string } | null> {
  if (!isNative()) return null;
  return DevicePermissions.sendUsageSnapshot({ minutes });
}
