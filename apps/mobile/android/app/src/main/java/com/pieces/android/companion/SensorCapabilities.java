package com.pieces.android.companion;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.hardware.Sensor;
import android.hardware.SensorManager;
import android.os.Build;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONObject;

/**
 * Consent keys and the capability probe (ANDROID_SENSOR_SPEC_2026-10-29.md section B1).
 *
 * The probe reports what the phone has, never assumes it, and never reads a sample. It is only sent while the master
 * toggle is on, so a user who has not opted in sends nothing about their sensors either.
 */
final class SensorCapabilities {
    static final String KEY_MOTION = "motion";
    static final String KEY_ROTATION = "rotation";
    static final String KEY_STEPS = "steps";
    static final String KEY_SIG_MOTION = "sig_motion";
    static final String KEY_ACTIVITY = "activity";
    static final String KEY_PRESSURE = "pressure";
    static final String KEY_LIGHT = "light";
    static final String KEY_PROXIMITY = "proximity";
    static final String KEY_AMBIENT_TEMP = "ambient_temp";
    static final String KEY_BATTERY = "battery";
    /** Not a hardware sensor: gates app_foreground and screen_session events. */
    static final String KEY_APP_SWITCHES = "app_switches";
    /** Not hardware sensors: mic speech-present yes/no, Wi-Fi place recognition, typing counts (no content). */
    static final String KEY_MIC_SPEECH = "mic_speech";
    static final String KEY_PLACES = "places";
    static final String KEY_TYPING_RHYTHM = "typing_rhythm";
    /**
     * Typed-text summaries. A consent key (stored in the same prefs file) but NOT in ALL_KEYS: it is not a sensor, it
     * is never part of the sensor_caps toggles, and master ON never enables it.
     */
    static final String KEY_TYPED_TEXT = "typed_text";
    /** Magnetometer is deliberately absent: it is an indoor-position fingerprint and is never collected. */

    static final List<String> SENSOR_KEYS = Arrays.asList(
        KEY_MOTION, KEY_ROTATION, KEY_STEPS, KEY_SIG_MOTION, KEY_ACTIVITY,
        KEY_PRESSURE, KEY_LIGHT, KEY_PROXIMITY, KEY_AMBIENT_TEMP, KEY_BATTERY);
    static final List<String> ALL_KEYS = Arrays.asList(
        KEY_MOTION, KEY_ROTATION, KEY_STEPS, KEY_SIG_MOTION, KEY_ACTIVITY,
        KEY_PRESSURE, KEY_LIGHT, KEY_PROXIMITY, KEY_AMBIENT_TEMP, KEY_BATTERY, KEY_APP_SWITCHES,
        KEY_MIC_SPEECH, KEY_PLACES, KEY_TYPING_RHYTHM);

    private SensorCapabilities() {}

    static boolean isKnownKey(String key) {
        return key != null && ALL_KEYS.contains(key);
    }

    /** What the probe learned about one sensor. */
    static final class Info {
        final boolean present;
        final double powerMa;
        final int fifoMax;
        final boolean wakeup;
        final int minDelayUs;
        Info(boolean present, double powerMa, int fifoMax, boolean wakeup, int minDelayUs) {
            this.present = present;
            this.powerMa = powerMa;
            this.fifoMax = fifoMax;
            this.wakeup = wakeup;
            this.minDelayUs = minDelayUs;
        }
        static final Info ABSENT = new Info(false, 0, 0, false, 0);
    }

    /** Pure: the sensor_caps payload. Same inputs give the same JSON, so the event id is stable. */
    static JSONObject buildPayload(Map<String, Info> infos, boolean permActivityRecognition, Map<String, Boolean> toggles) {
        try {
            JSONObject sensors = new JSONObject();
            for (String key : SENSOR_KEYS) {
                Info i = infos.containsKey(key) ? infos.get(key) : Info.ABSENT;
                JSONObject o = new JSONObject();
                o.put("present", i.present);
                if (i.present) {
                    o.put("power_ma", i.powerMa);
                    o.put("fifo_max", i.fifoMax);
                    o.put("wakeup", i.wakeup);
                    o.put("min_delay_us", i.minDelayUs);
                }
                sensors.put(key, o);
            }
            JSONObject t = new JSONObject();
            for (Map.Entry<String, Boolean> e : toggles.entrySet()) t.put(e.getKey(), e.getValue());
            JSONObject p = new JSONObject();
            p.put("type", "sensor_caps");
            p.put("sensors", sensors);
            p.put("perm_activity_recognition", permActivityRecognition);
            p.put("toggles", t);
            return p;
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static String eventId(JSONObject payload) {
        return "caps-" + NativeTelemetrySync.sha1Hex(payload.toString()).substring(0, 12);
    }

    static boolean hasActivityPermission(Context ctx) {
        return Build.VERSION.SDK_INT < 29
            || ctx.checkSelfPermission(Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED;
    }

    private static Info info(SensorManager sm, int type) {
        Sensor s = sm == null ? null : sm.getDefaultSensor(type);
        if (s == null) return Info.ABSENT;
        return new Info(true, s.getPower(), s.getFifoMaxEventCount(), s.isWakeUpSensor(), s.getMinDelay());
    }

    /** Probe the hardware (no sampling). */
    static Map<String, Info> probe(Context ctx) {
        SensorManager sm = (SensorManager) ctx.getSystemService(Context.SENSOR_SERVICE);
        Map<String, Info> m = new LinkedHashMap<>();
        Info accel = info(sm, Sensor.TYPE_ACCELEROMETER);
        m.put(KEY_MOTION, accel);
        m.put(KEY_ROTATION, info(sm, Sensor.TYPE_GYROSCOPE));
        m.put(KEY_STEPS, info(sm, Sensor.TYPE_STEP_COUNTER));
        m.put(KEY_SIG_MOTION, info(sm, Sensor.TYPE_SIGNIFICANT_MOTION));
        m.put(KEY_ACTIVITY, accel.present ? new Info(true, 0, 0, false, 0) : Info.ABSENT); // derived, needs motion
        m.put(KEY_PRESSURE, info(sm, Sensor.TYPE_PRESSURE));
        m.put(KEY_LIGHT, info(sm, Sensor.TYPE_LIGHT));
        m.put(KEY_PROXIMITY, info(sm, Sensor.TYPE_PROXIMITY));
        m.put(KEY_AMBIENT_TEMP, info(sm, Sensor.TYPE_AMBIENT_TEMPERATURE));
        m.put(KEY_BATTERY, new Info(true, 0, 0, false, 0)); // battery broadcast, always there
        return m;
    }

    /** Sends sensor_caps at start and on every toggle change, but only while the master toggle is on. */
    static void probeAndQueue(Context ctx) {
        try {
            if (!SensorConsentPlugin.isMasterOn(ctx)) return;
            JSONObject p = buildPayload(probe(ctx), hasActivityPermission(ctx), SensorConsentPlugin.toggles(ctx));
            NativeTelemetrySync.queueV3Event(ctx, eventId(p), System.currentTimeMillis(), p);
        } catch (Exception ignored) {}
    }
}
