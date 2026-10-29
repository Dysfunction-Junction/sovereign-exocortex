package com.pieces.android.companion;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import org.json.JSONObject;

/**
 * Opt-in switches for sensor and app-switch telemetry (ANDROID_SENSOR_SPEC_2026-10-29.md section C).
 *
 * JS name: "SensorConsent".
 *   getState()               -> { master, toggles:{key:bool}, caps:{key:present}, activityPermission }
 *   setToggle({key,enabled}) -> one sensor key, see SensorCapabilities.ALL_KEYS
 *   setMaster({enabled})     -> everything at once
 *   refresh()                -> re-apply after the user grants Activity Recognition
 *
 * Everything is OFF by default, and a sensor runs only while master AND its own toggle are on. Turning something off,
 * in one main-looper turn: (1) store it, (2) unregister the listeners, (3) delete that type's unsent events from the
 * outbox, (4) queue a sensor_consent event so the daemon stops using later windows for that key.
 * Data already sent cannot be deleted (the event log is append-only).
 */
@CapacitorPlugin(name = "SensorConsent")
public class SensorConsentPlugin extends Plugin {
    private static final String PREFS = "sensor_consent_prefs";
    private static final String MASTER = "master";

    static boolean isMasterOn(Context ctx) {
        return prefs(ctx).getBoolean(MASTER, false);
    }

    /** True only when the master toggle and this key's toggle are both on. */
    static boolean isEnabled(Context ctx, String key) {
        SharedPreferences p = prefs(ctx);
        return p.getBoolean(MASTER, false) && p.getBoolean(key, false);
    }

    /** Per-key toggles plus master, as stored (not ANDed). */
    static Map<String, Boolean> toggles(Context ctx) {
        SharedPreferences p = prefs(ctx);
        Map<String, Boolean> m = new LinkedHashMap<>();
        m.put(MASTER, p.getBoolean(MASTER, false));
        for (String k : SensorCapabilities.ALL_KEYS) m.put(k, p.getBoolean(k, false));
        return m;
    }

    /** Keys that are effectively on (master AND own toggle). */
    static Set<String> enabledKeys(Context ctx) {
        Set<String> out = new HashSet<>();
        for (String k : SensorCapabilities.ALL_KEYS) {
            if (isEnabled(ctx, k)) out.add(k);
        }
        return out;
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * Applies one change. MUST run on the main looper so unregistering happens in the same turn as the write.
     * `key` null means the master toggle.
     */
    static void applyChange(Context ctx, String key, boolean enabled) {
        Context app = ctx.getApplicationContext();
        prefs(app).edit().putBoolean(key == null ? MASTER : key, enabled).commit();
        SensorWindowSampler.onConsentChanged(app);
        NativeHardwareTelemetry.refreshSensors(app);
        if (!enabled) purgeUnsent(app, key);
        try {
            JSONObject p = new JSONObject();
            p.put("type", "sensor_consent");
            p.put("key", key == null ? MASTER : key);
            p.put("enabled", enabled);
            long now = System.currentTimeMillis();
            NativeTelemetrySync.queueV3Event(app, "consent-" + now + "-" + (key == null ? MASTER : key), now, p);
        } catch (Exception ignored) {}
        SensorCapabilities.probeAndQueue(app);
    }

    /** Deletes unsent events of the revoked type(s). Queued after anything already appended (single disk thread). */
    private static void purgeUnsent(Context app, String key) {
        boolean all = key == null;
        if (all || SensorCapabilities.KEY_APP_SWITCHES.equals(key)) {
            NativeTelemetrySync.purgeUnsentV3(app, "fg-", null);
            NativeTelemetrySync.purgeUnsentV3(app, "ss-", null);
        }
        if (all) {
            NativeTelemetrySync.purgeUnsentV3(app, "sw-", null);
        } else if (!SensorCapabilities.KEY_APP_SWITCHES.equals(key)) {
            NativeTelemetrySync.purgeUnsentV3(app, "sw-", key); // strips just this sensor from queued windows
        }
    }

    private JSObject state() {
        Context ctx = getContext();
        JSObject out = new JSObject();
        JSObject t = new JSObject();
        for (Map.Entry<String, Boolean> e : toggles(ctx).entrySet()) {
            if (!MASTER.equals(e.getKey())) t.put(e.getKey(), e.getValue());
        }
        JSObject caps = new JSObject();
        Map<String, SensorCapabilities.Info> probe = SensorCapabilities.probe(ctx);
        for (Map.Entry<String, SensorCapabilities.Info> e : probe.entrySet()) caps.put(e.getKey(), e.getValue().present);
        out.put("master", isMasterOn(ctx));
        out.put("toggles", t);
        out.put("caps", caps);
        out.put("activityPermission", SensorCapabilities.hasActivityPermission(ctx));
        return out;
    }

    @PluginMethod
    public void getState(PluginCall call) {
        call.resolve(state());
    }

    @PluginMethod
    public void setToggle(PluginCall call) {
        final String key = call.getString("key");
        final Boolean enabled = call.getBoolean("enabled");
        if (!SensorCapabilities.isKnownKey(key) || enabled == null) {
            call.reject("unknown sensor key or missing enabled");
            return;
        }
        new Handler(Looper.getMainLooper()).post(() -> {
            applyChange(getContext(), key, enabled);
            call.resolve(state());
        });
    }

    @PluginMethod
    public void setMaster(PluginCall call) {
        final Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) {
            call.reject("missing enabled");
            return;
        }
        new Handler(Looper.getMainLooper()).post(() -> {
            applyChange(getContext(), null, enabled);
            call.resolve(state());
        });
    }

    @PluginMethod
    public void refresh(PluginCall call) {
        new Handler(Looper.getMainLooper()).post(() -> {
            SensorWindowSampler.onConsentChanged(getContext());
            NativeHardwareTelemetry.refreshSensors(getContext());
            SensorCapabilities.probeAndQueue(getContext());
            call.resolve(state());
        });
    }
}
