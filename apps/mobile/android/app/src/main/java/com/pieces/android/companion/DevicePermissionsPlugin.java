package com.pieces.android.companion;

import android.Manifest;
import android.app.AppOpsManager;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * One place to see and grant the phone permissions the exocortex uses.
 *
 * JS name: "DevicePermissions".
 *   status()                      -> every permission's current state
 *   requestRuntime({name})        -> system prompt for "activity" | "calendar" | "callLog"
 *   openSetting({name})           -> opens the settings screen for the special grants:
 *                                    "usageAccess" | "battery" | "dnd" | "notificationAccess" | "accessibility" | "app"
 *   sendUsageSnapshot({minutes})  -> queues an app-usage summary now (needs Usage Access)
 *
 * Special grants (usage access, battery exemption, DND access, notification access, accessibility) cannot be
 * granted by a dialog; Android requires the user to flip them in Settings, so openSetting() takes them there.
 */
@CapacitorPlugin(
    name = "DevicePermissions",
    permissions = {
        @Permission(alias = "activity", strings = { Manifest.permission.ACTIVITY_RECOGNITION }),
        @Permission(alias = "calendar", strings = { Manifest.permission.READ_CALENDAR }),
        @Permission(alias = "callLog", strings = { Manifest.permission.READ_CALL_LOG })
    }
)
public class DevicePermissionsPlugin extends Plugin {

    private JSObject buildStatus() {
        Context ctx = getContext();
        String pkg = ctx.getPackageName();
        JSObject out = new JSObject();

        AppOpsManager appOps = (AppOpsManager) ctx.getSystemService(Context.APP_OPS_SERVICE);
        int usageMode = appOps.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, android.os.Process.myUid(), pkg);
        out.put("usageAccess", usageMode == AppOpsManager.MODE_ALLOWED);

        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        out.put("battery", pm != null && pm.isIgnoringBatteryOptimizations(pkg));

        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        out.put("dnd", nm != null && nm.isNotificationPolicyAccessGranted());

        out.put("notificationAccess", NotificationManagerCompat.getEnabledListenerPackages(ctx).contains(pkg));

        String enabled = Settings.Secure.getString(ctx.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        out.put("accessibility", enabled != null && enabled.contains(pkg + "/"));

        out.put("activity", Build.VERSION.SDK_INT < 29 || runtimeGranted(Manifest.permission.ACTIVITY_RECOGNITION));
        out.put("calendar", runtimeGranted(Manifest.permission.READ_CALENDAR));
        out.put("callLog", runtimeGranted(Manifest.permission.READ_CALL_LOG));
        return out;
    }

    private boolean runtimeGranted(String permission) {
        return getContext().checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(buildStatus());
    }

    @PluginMethod
    public void requestRuntime(PluginCall call) {
        String name = call.getString("name", "");
        if (!"activity".equals(name) && !"calendar".equals(name) && !"callLog".equals(name)) {
            call.reject("name must be activity, calendar or callLog");
            return;
        }
        if (getPermissionState(name) == PermissionState.GRANTED || buildStatus().getBool(name)) {
            call.resolve(buildStatus());
            return;
        }
        requestPermissionForAlias(name, call, "runtimeResult");
    }

    @PermissionCallback
    private void runtimeResult(PluginCall call) {
        call.resolve(buildStatus());
    }

    @PluginMethod
    public void openSetting(PluginCall call) {
        String name = call.getString("name", "");
        Context ctx = getContext();
        Intent intent;
        switch (name) {
            case "usageAccess":
                intent = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS);
                break;
            case "battery":
                intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + ctx.getPackageName()));
                break;
            case "dnd":
                intent = new Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS);
                break;
            case "notificationAccess":
                intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
                break;
            case "accessibility":
                intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
                break;
            case "app":
                intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + ctx.getPackageName()));
                break;
            default:
                call.reject("unknown setting: " + name);
                return;
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(intent);
        } catch (ActivityNotFoundException e) {
            if ("battery".equals(name)) {
                // Some builds lack the one-tap dialog; fall back to the general battery-optimization list.
                Intent fallback = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    ctx.startActivity(fallback);
                } catch (ActivityNotFoundException e2) {
                    call.reject("settings screen unavailable");
                    return;
                }
            } else {
                call.reject("settings screen unavailable");
                return;
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void sendUsageSnapshot(PluginCall call) {
        int minutes = call.getInt("minutes", 15);
        String result = UsageSummary.queueNow(getContext(), Math.max(1, Math.min(minutes, 24 * 60)));
        JSObject out = new JSObject();
        out.put("queued", "queued".equals(result));
        out.put("result", result);
        call.resolve(out);
    }
}
