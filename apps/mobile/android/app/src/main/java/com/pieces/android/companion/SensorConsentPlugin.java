package com.pieces.android.companion;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
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
@CapacitorPlugin(
    name = "SensorConsent",
    permissions = {
        @Permission(alias = "mic", strings = { android.Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "fineLocation", strings = { android.Manifest.permission.ACCESS_FINE_LOCATION, android.Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "backgroundLocation", strings = { android.Manifest.permission.ACCESS_BACKGROUND_LOCATION })
    }
)
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

    /** Typed-text summaries: master AND its own toggle. Master ON never enables it; master OFF forces it off. */
    static boolean isTypedTextOn(Context ctx) {
        return isEnabled(ctx, SensorCapabilities.KEY_TYPED_TEXT);
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
        SharedPreferences.Editor ed = prefs(app).edit().putBoolean(key == null ? MASTER : key, enabled);
        if (key == null && !enabled) ed.putBoolean(SensorCapabilities.KEY_TYPED_TEXT, false); // master off => typed text off
        ed.commit();
        SensorWindowSampler.onConsentChanged(app);
        MicWindowSampler.onConsentChanged(app);
        PlaceSampler.onConsentChanged(app);
        TypedTextCapture.onConsentChanged(app);
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
        if (all || SensorCapabilities.KEY_MIC_SPEECH.equals(key)) NativeTelemetrySync.purgeUnsentV3(app, "mw-", null);
        if (all || SensorCapabilities.KEY_PLACES.equals(key)) {
            NativeTelemetrySync.purgeUnsentV3(app, "pw-", null);
            NativeTelemetrySync.purgeUnsentV3(app, "pe-", null);
        }
        if (all || SensorCapabilities.KEY_TYPING_RHYTHM.equals(key)) NativeTelemetrySync.purgeUnsentV3(app, "tw-", null);
        if (all) {
            NativeTelemetrySync.purgeUnsentV3(app, "sw-", null);
        } else if (SensorCapabilities.SENSOR_KEYS.contains(key)) {
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
        out.put("micPermission", ctx.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED);
        out.put("fineLocation", ctx.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED);
        out.put("backgroundLocation", ctx.checkSelfPermission(android.Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED);
        out.put("typedText", isTypedTextOn(ctx));
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
        boolean known = SensorCapabilities.isKnownKey(key) || SensorCapabilities.KEY_TYPED_TEXT.equals(key);
        if (!known || enabled == null) {
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

    /**
     * System prompt for "mic" | "fineLocation" | "backgroundLocation". Background location is asked separately, after
     * fine location (Android 11+ refuses to grant both in one dialog). Granting does not switch anything on.
     */
    @PluginMethod
    public void requestPermission(PluginCall call) {
        String name = call.getString("name", "");
        if (!"mic".equals(name) && !"fineLocation".equals(name) && !"backgroundLocation".equals(name)) {
            call.reject("name must be mic, fineLocation or backgroundLocation");
            return;
        }
        if ("backgroundLocation".equals(name) && getPermissionState("fineLocation") != PermissionState.GRANTED) {
            call.reject("grant precise location first");
            return;
        }
        if (getPermissionState(name) == PermissionState.GRANTED) {
            call.resolve(state());
            return;
        }
        requestPermissionForAlias(name, call, "permissionResult");
    }

    @PermissionCallback
    private void permissionResult(PluginCall call) {
        new Handler(Looper.getMainLooper()).post(() -> {
            // A grant may let a consented sampler start; a denial leaves it counting "perm" skips.
            MicWindowSampler.onConsentChanged(getContext());
            PlaceSampler.onConsentChanged(getContext());
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
