package com.pieces.android.companion;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.hardware.TriggerEvent;
import android.hardware.TriggerEventListener;
import android.os.BatteryManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import org.json.JSONObject;

/**
 * Turns the toggled-on sensors into one 5-minute `sensor_window` v3 event (ANDROID_SENSOR_SPEC_2026-10-29.md B2/B3).
 *
 * - Only sensors the user switched on are registered; with every toggle off no listener exists at all.
 * - Raw samples never leave this class: each window is reduced to coarse aggregates (classes, deltas, buckets).
 *   No absolute pressure, no magnetometer, no location.
 * - applyConsent() runs on the main looper and unregisters revoked sensors in the same turn.
 * - Windows are aligned to the wall-clock 5-minute grid and stamped ts_device = window_end.
 *
 * The aggregation functions are static and pure so they are unit-tested; the hardware sits behind Backend.
 */
final class SensorWindowSampler {
    static final long WINDOW_MS = 5L * 60_000L;

    /** Hardware registration seam (a fake in tests). One call per hardware key, see HW_KEYS. */
    interface Backend {
        /** Starts delivering samples for `hwKey` via SensorWindowSampler.onSample. False if absent or not permitted. */
        boolean register(String hwKey);
        void unregister(String hwKey);
    }

    /** Clock, battery snapshot and event sink; a seam so a window can be closed in a test. */
    interface Env {
        JSONObject battery();
        void emit(String eventId, long tsDevice, JSONObject payload);
    }

    /** Hardware registrations; activity has none of its own (it reads motion, steps and sig_motion). */
    static final Set<String> HW_KEYS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        SensorCapabilities.KEY_MOTION, SensorCapabilities.KEY_ROTATION, SensorCapabilities.KEY_STEPS,
        SensorCapabilities.KEY_SIG_MOTION, SensorCapabilities.KEY_PRESSURE, SensorCapabilities.KEY_LIGHT,
        SensorCapabilities.KEY_PROXIMITY, SensorCapabilities.KEY_AMBIENT_TEMP)));

    // ---- pure aggregation ----

    static String energyClass(double rms) {
        if (rms < 0.15) return "still";
        if (rms < 0.8) return "light";
        if (rms < 2.0) return "moderate";
        return "vigorous";
    }

    /** Orientation of one gravity vector (m/s^2, device axes: z out of the screen, y up the screen). */
    static String orientOf(double gx, double gy, double gz) {
        double g = Math.sqrt(gx * gx + gy * gy + gz * gz);
        if (g < 1e-6) return "tilted";
        double nz = gz / g;
        double ny = gy / g;
        if (nz > 0.8) return "flat_up";
        if (nz < -0.8) return "flat_down";
        if (Math.abs(ny) > 0.8) return "upright";
        return "tilted";
    }

    /** One label when it covers at least 70% of the samples, otherwise "mixed". Null for no samples. */
    static String orientWindow(Map<String, Integer> counts) {
        int total = 0;
        String top = null;
        int topN = 0;
        for (Map.Entry<String, Integer> e : counts.entrySet()) {
            total += e.getValue();
            if (e.getValue() > topN || (top != null && e.getValue() == topN && e.getKey().compareTo(top) < 0)) {
                top = e.getKey();
                topN = e.getValue();
            }
        }
        if (total == 0) return null;
        return topN * 10 >= total * 7 ? top : "mixed";
    }

    /** Mean angular speed in rad/s. */
    static String rotClass(double meanRadPerSec) {
        if (meanRadPerSec < 0.1) return "steady";
        if (meanRadPerSec < 1.0) return "turning";
        return "rotating";
    }

    static String pressureTrend(double deltaHpa) {
        if (deltaHpa >= 0.1) return "rising";
        if (deltaHpa <= -0.1) return "falling";
        return "steady";
    }

    static String luxBucket(double lux) {
        if (lux < 10) return "dark";
        if (lux < 100) return "dim";
        if (lux < 2000) return "indoor";
        if (lux < 20000) return "bright";
        return "sun";
    }

    /** Step-counter delta; the counter resets at reboot, so a smaller value means "count since reboot". */
    static long stepsDelta(long base, long now) {
        return now >= base ? now - base : now;
    }

    static double cadenceSpm(long delta, long durMs) {
        return durMs <= 0 ? 0.0 : delta * 60_000.0 / durMs;
    }

    static final class Activity {
        final String state;
        final double conf;
        Activity(String state, double conf) {
            this.state = state;
            this.conf = conf;
        }
    }

    /** On-device heuristic from energy class, step cadence and significant-motion; no Play Services. */
    static Activity activityState(String energyClass, boolean hasSteps, double cadenceSpm, boolean sigMotion) {
        if (energyClass == null) return new Activity("unknown", 0.0);
        if (hasSteps) {
            if (cadenceSpm >= 130) return new Activity("running", 0.7);
            if (cadenceSpm >= 40) return new Activity("walking", 0.7);
            if (energyClass.equals("still") && cadenceSpm < 5) return new Activity("still", 0.9);
            if (!energyClass.equals("still") && cadenceSpm < 10 && sigMotion) return new Activity("vehicle", 0.5);
            return new Activity("unknown", 0.3);
        }
        return energyClass.equals("still") ? new Activity("still", 0.7) : new Activity("unknown", 0.3);
    }

    /** Which hardware must be registered for a set of enabled consent keys (activity pulls in its three inputs). */
    static Set<String> hardwareNeeded(Set<String> enabledKeys) {
        Set<String> hw = new HashSet<>();
        for (String k : enabledKeys) {
            if (HW_KEYS.contains(k)) hw.add(k);
        }
        if (enabledKeys.contains(SensorCapabilities.KEY_ACTIVITY)) {
            hw.add(SensorCapabilities.KEY_MOTION);
            hw.add(SensorCapabilities.KEY_STEPS);
            hw.add(SensorCapabilities.KEY_SIG_MOTION);
        }
        return hw;
    }

    private static double round(double v, int places) {
        double f = Math.pow(10, places);
        return Math.round(v * f) / f;
    }

    // ---- window state ----

    private final Backend backend;
    private final Env env;
    private final Set<String> enabled = new HashSet<>();
    private final Set<String> registered = new HashSet<>();
    private double proximityMax = 5.0;

    private double motionSumSq;
    private long motionN;
    private final Map<String, Integer> orientCounts = new HashMap<>();
    private double gyroSum;
    private long gyroN;
    private Long stepFirst;
    private Long stepLast;
    private Long stepBase; // counter value at the previous window close
    private boolean sigFired;
    private Double pressureFirst;
    private Double pressureLast;
    private double luxSum;
    private long luxN;
    private long proxNear;
    private long proxN;
    private Double ambientLast;

    SensorWindowSampler(Backend backend, Env env) {
        this.backend = backend;
        this.env = env;
    }

    synchronized void setProximityMax(double max) {
        proximityMax = max;
    }

    synchronized int registeredCount() {
        return registered.size();
    }

    synchronized Set<String> registeredKeys() {
        return new HashSet<>(registered);
    }

    /**
     * Makes the registrations match `enabledKeys` (consent keys, already ANDed with the master toggle).
     * Call on the main looper: revoked sensors are unregistered before this returns and their window state dropped.
     */
    synchronized void applyConsent(Set<String> enabledKeys) {
        enabled.clear();
        enabled.addAll(enabledKeys);
        Set<String> need = hardwareNeeded(enabledKeys);
        for (String hw : new HashSet<>(registered)) {
            if (!need.contains(hw)) {
                backend.unregister(hw);
                registered.remove(hw);
                clearState(hw);
            }
        }
        for (String hw : need) {
            if (!registered.contains(hw) && backend.register(hw)) registered.add(hw);
        }
    }

    private void clearState(String hw) {
        switch (hw) {
            case SensorCapabilities.KEY_MOTION: motionSumSq = 0; motionN = 0; break;
            case SensorCapabilities.KEY_ROTATION: orientCounts.clear(); gyroSum = 0; gyroN = 0; break;
            case SensorCapabilities.KEY_STEPS: stepFirst = null; stepLast = null; stepBase = null; break;
            case SensorCapabilities.KEY_SIG_MOTION: sigFired = false; break;
            case SensorCapabilities.KEY_PRESSURE: pressureFirst = null; pressureLast = null; break;
            case SensorCapabilities.KEY_LIGHT: luxSum = 0; luxN = 0; break;
            case SensorCapabilities.KEY_PROXIMITY: proxNear = 0; proxN = 0; break;
            case SensorCapabilities.KEY_AMBIENT_TEMP: ambientLast = null; break;
            default: break;
        }
    }

    /** A raw sample from the backend. Ignored unless that hardware is currently registered. */
    synchronized void onSample(String key, float[] v) {
        switch (key) {
            case "motion": {
                if (!registered.contains(SensorCapabilities.KEY_MOTION)) return;
                double mag = Math.sqrt((double) v[0] * v[0] + (double) v[1] * v[1] + (double) v[2] * v[2]);
                double dyn = mag - 9.80665;
                motionSumSq += dyn * dyn;
                motionN++;
                break;
            }
            case "rot_grav": {
                if (!registered.contains(SensorCapabilities.KEY_ROTATION)) return;
                orientCounts.merge(orientOf(v[0], v[1], v[2]), 1, Integer::sum);
                break;
            }
            case "rot_gyro": {
                if (!registered.contains(SensorCapabilities.KEY_ROTATION)) return;
                gyroSum += Math.sqrt((double) v[0] * v[0] + (double) v[1] * v[1] + (double) v[2] * v[2]);
                gyroN++;
                break;
            }
            case "steps": {
                if (!registered.contains(SensorCapabilities.KEY_STEPS)) return;
                long c = (long) v[0];
                if (stepFirst == null) stepFirst = c;
                stepLast = c;
                break;
            }
            case "sig_motion":
                if (registered.contains(SensorCapabilities.KEY_SIG_MOTION)) sigFired = true;
                break;
            case "pressure": {
                if (!registered.contains(SensorCapabilities.KEY_PRESSURE)) return;
                if (pressureFirst == null) pressureFirst = (double) v[0];
                pressureLast = (double) v[0];
                break;
            }
            case "light":
                if (!registered.contains(SensorCapabilities.KEY_LIGHT)) return;
                luxSum += v[0];
                luxN++;
                break;
            case "proximity":
                if (!registered.contains(SensorCapabilities.KEY_PROXIMITY)) return;
                proxN++;
                if (v[0] < proximityMax) proxNear++;
                break;
            case "ambient_temp":
                if (registered.contains(SensorCapabilities.KEY_AMBIENT_TEMP)) ambientLast = (double) v[0];
                break;
            default:
                break;
        }
    }

    /**
     * Reduces the current accumulators to a sensor_window payload and resets them. Only enabled sensors that produced
     * data appear. Returns null when there is nothing to send.
     */
    synchronized JSONObject closeWindow(long windowStart, long windowEnd) {
        long dur = Math.max(0L, windowEnd - windowStart);
        try {
            JSONObject sensors = new JSONObject();
            String energy = motionN > 0 ? energyClass(Math.sqrt(motionSumSq / motionN)) : null;
            boolean hasSteps = stepLast != null;
            long stepDelta = 0L;
            if (hasSteps) {
                stepDelta = stepsDelta(stepBase != null ? stepBase : stepFirst, stepLast);
            }
            double cadence = cadenceSpm(stepDelta, dur);

            if (enabled.contains(SensorCapabilities.KEY_MOTION) && energy != null) {
                JSONObject o = new JSONObject();
                o.put("energy_rms", round(Math.sqrt(motionSumSq / motionN), 3));
                o.put("energy_class", energy);
                sensors.put(SensorCapabilities.KEY_MOTION, o);
            }
            if (enabled.contains(SensorCapabilities.KEY_ROTATION) && (gyroN > 0 || !orientCounts.isEmpty())) {
                JSONObject o = new JSONObject();
                String orient = orientWindow(orientCounts);
                if (orient != null) o.put("orient", orient);
                if (gyroN > 0) o.put("rot_class", rotClass(gyroSum / gyroN));
                sensors.put(SensorCapabilities.KEY_ROTATION, o);
            }
            if (enabled.contains(SensorCapabilities.KEY_STEPS) && hasSteps) {
                JSONObject o = new JSONObject();
                o.put("delta", stepDelta);
                o.put("cadence_spm", round(cadence, 1));
                sensors.put(SensorCapabilities.KEY_STEPS, o);
            }
            if (enabled.contains(SensorCapabilities.KEY_SIG_MOTION) && registered.contains(SensorCapabilities.KEY_SIG_MOTION)) {
                JSONObject o = new JSONObject();
                o.put("fired", sigFired);
                sensors.put(SensorCapabilities.KEY_SIG_MOTION, o);
            }
            if (enabled.contains(SensorCapabilities.KEY_ACTIVITY) && energy != null) {
                Activity a = activityState(energy, hasSteps, cadence, sigFired);
                JSONObject o = new JSONObject();
                o.put("state", a.state);
                o.put("conf", round(a.conf, 2));
                o.put("src", "heuristic");
                sensors.put(SensorCapabilities.KEY_ACTIVITY, o);
            }
            if (enabled.contains(SensorCapabilities.KEY_PRESSURE) && pressureFirst != null && pressureLast != null) {
                double delta = pressureLast - pressureFirst; // never the absolute value
                JSONObject o = new JSONObject();
                o.put("delta_hpa", round(delta, 2));
                o.put("trend", pressureTrend(delta));
                sensors.put(SensorCapabilities.KEY_PRESSURE, o);
            }
            if (enabled.contains(SensorCapabilities.KEY_LIGHT) && luxN > 0) {
                JSONObject o = new JSONObject();
                o.put("bucket", luxBucket(luxSum / luxN));
                sensors.put(SensorCapabilities.KEY_LIGHT, o);
            }
            if (enabled.contains(SensorCapabilities.KEY_PROXIMITY) && proxN > 0) {
                JSONObject o = new JSONObject();
                o.put("near_frac", round((double) proxNear / proxN, 2));
                sensors.put(SensorCapabilities.KEY_PROXIMITY, o);
            }
            if (enabled.contains(SensorCapabilities.KEY_AMBIENT_TEMP) && ambientLast != null) {
                JSONObject o = new JSONObject();
                o.put("c", round(ambientLast, 1));
                sensors.put(SensorCapabilities.KEY_AMBIENT_TEMP, o);
            }
            if (enabled.contains(SensorCapabilities.KEY_BATTERY)) {
                JSONObject b = env.battery();
                if (b != null) sensors.put(SensorCapabilities.KEY_BATTERY, b);
            }

            if (hasSteps) stepBase = stepLast;
            stepFirst = null;
            stepLast = null;
            motionSumSq = 0; motionN = 0;
            orientCounts.clear(); gyroSum = 0; gyroN = 0;
            sigFired = false;
            pressureFirst = null; pressureLast = null;
            luxSum = 0; luxN = 0;
            proxNear = 0; proxN = 0;
            ambientLast = null;

            if (sensors.length() == 0) return null;
            JSONObject p = new JSONObject();
            p.put("type", "sensor_window");
            p.put("window_start", windowStart);
            p.put("window_end", windowEnd);
            p.put("dur_ms", dur);
            p.put("sensors", sensors);
            return p;
        } catch (Exception e) {
            return null;
        }
    }

    /** Closes the window ending at `windowEnd` and hands it to the sink. */
    synchronized void flushWindow(long windowStart, long windowEnd) {
        JSONObject p = closeWindow(windowStart, windowEnd);
        if (p != null) env.emit("sw-" + windowEnd, windowEnd, p); // stamped with window_end, never the start
    }

    // ---- wiring (accessibility service lifetime) ----

    private static SensorWindowSampler active;
    private static Handler mainHandler;
    private static Runnable tick;
    private static long windowStart;

    /** Starts the sampler: registers consented sensors and schedules the 5-minute grid. Main looper. */
    static synchronized void start(Context context) {
        if (active != null) return;
        final Context ctx = context.getApplicationContext() != null ? context.getApplicationContext() : context;
        AndroidBackend backend = new AndroidBackend(ctx);
        final SensorWindowSampler s = new SensorWindowSampler(backend, new Env() {
            @Override public JSONObject battery() { return batterySnapshot(ctx); }
            @Override public void emit(String id, long ts, JSONObject payload) {
                NativeTelemetrySync.queueV3Event(ctx, id, ts, payload);
            }
        });
        backend.sampler = s;
        active = s;
        mainHandler = new Handler(Looper.getMainLooper());
        windowStart = System.currentTimeMillis();
        s.applyConsent(SensorConsentPlugin.enabledKeys(ctx));
        SensorCapabilities.probeAndQueue(ctx);
        tick = new Runnable() {
            @Override public void run() {
                long now = System.currentTimeMillis();
                long end = now / WINDOW_MS * WINDOW_MS;
                if (end > windowStart) {
                    s.flushWindow(windowStart, end);
                    windowStart = end;
                }
                mainHandler.postDelayed(this, end + WINDOW_MS - now);
            }
        };
        mainHandler.postDelayed(tick, WINDOW_MS - (windowStart % WINDOW_MS));
    }

    static synchronized void stop() {
        if (active == null) return;
        if (mainHandler != null && tick != null) mainHandler.removeCallbacks(tick);
        active.applyConsent(Collections.<String>emptySet());
        active = null;
    }

    /** Re-applies the stored consent. Main looper: revoked sensors are unregistered before this returns. */
    static synchronized void onConsentChanged(Context ctx) {
        if (active != null) active.applyConsent(SensorConsentPlugin.enabledKeys(ctx));
    }

    private static JSONObject batterySnapshot(Context ctx) {
        try {
            Intent i = ctx.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (i == null) return null;
            int level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            int plugged = i.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
            int tenths = i.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1);
            JSONObject b = new JSONObject();
            if (level >= 0 && scale > 0) b.put("pct", Math.round(level * 100.0 / scale));
            b.put("plugged", plugged != 0);
            if (tenths > 0) b.put("batt_temp_c", tenths / 10.0);
            return b;
        } catch (Exception e) {
            return null;
        }
    }

    /** Real SensorManager registrations. Low-drain: hardware FIFO batching, no wake-up sensors. */
    private static final class AndroidBackend implements Backend {
        private static final int HZ5_US = 200_000;
        private static final int HZ1_US = 1_000_000;
        private static final int HZ25_US = 40_000;
        private static final int BATCH_US = 60_000_000;

        private final Context ctx;
        private final SensorManager sm;
        private final Object lock = new Object();
        private final Set<String> live = new HashSet<>();
        private HandlerThread thread;
        private Handler handler;
        private boolean rotationLive;
        volatile SensorWindowSampler sampler;

        AndroidBackend(Context ctx) {
            this.ctx = ctx;
            this.sm = (SensorManager) ctx.getSystemService(Context.SENSOR_SERVICE);
        }

        private final SensorEventListener listener = new SensorEventListener() {
            @Override public void onSensorChanged(SensorEvent e) {
                SensorWindowSampler s = sampler;
                if (s == null) return;
                String key;
                switch (e.sensor.getType()) {
                    case Sensor.TYPE_ACCELEROMETER: key = "motion"; break;
                    case Sensor.TYPE_GYROSCOPE: key = "rot_gyro"; break;
                    case Sensor.TYPE_GRAVITY: key = "rot_grav"; break;
                    case Sensor.TYPE_STEP_COUNTER: key = "steps"; break;
                    case Sensor.TYPE_PRESSURE: key = "pressure"; break;
                    case Sensor.TYPE_LIGHT: key = "light"; break;
                    case Sensor.TYPE_PROXIMITY: key = "proximity"; break;
                    case Sensor.TYPE_AMBIENT_TEMPERATURE: key = "ambient_temp"; break;
                    default: return;
                }
                s.onSample(key, e.values.clone());
            }
            @Override public void onAccuracyChanged(Sensor sensor, int accuracy) {}
        };

        private final TriggerEventListener trigger = new TriggerEventListener() {
            @Override public void onTrigger(TriggerEvent event) {
                SensorWindowSampler s = sampler;
                if (s != null) s.onSample("sig_motion", new float[]{1f});
                synchronized (lock) { // one-shot: re-arm while still consented
                    if (live.contains(SensorCapabilities.KEY_SIG_MOTION) && sm != null) {
                        Sensor sig = sm.getDefaultSensor(Sensor.TYPE_SIGNIFICANT_MOTION);
                        if (sig != null) sm.requestTriggerSensor(this, sig);
                    }
                }
            }
        };

        private final Runnable burstOn = new Runnable() {
            @Override public void run() {
                synchronized (lock) {
                    if (!rotationLive || handler == null) return;
                    reg(Sensor.TYPE_GYROSCOPE, HZ25_US, 0);
                    reg(Sensor.TYPE_GRAVITY, HZ25_US, 0);
                    handler.postDelayed(burstOff, 10_000L);
                }
            }
        };
        private final Runnable burstOff = new Runnable() {
            @Override public void run() {
                synchronized (lock) {
                    unreg(Sensor.TYPE_GYROSCOPE);
                    unreg(Sensor.TYPE_GRAVITY);
                    if (rotationLive && handler != null) handler.postDelayed(burstOn, 50_000L);
                }
            }
        };

        private boolean reg(int type, int periodUs, int latencyUs) {
            Sensor s = sm == null ? null : sm.getDefaultSensor(type);
            if (s == null) return false;
            return sm.registerListener(listener, s, periodUs, latencyUs, handler);
        }

        private void unreg(int type) {
            Sensor s = sm == null ? null : sm.getDefaultSensor(type);
            if (s != null) sm.unregisterListener(listener, s);
        }

        @Override public boolean register(String hwKey) {
            if (sm == null) return false;
            synchronized (lock) {
                if (thread == null) {
                    thread = new HandlerThread("sensor-window");
                    thread.start();
                    handler = new Handler(thread.getLooper());
                }
                boolean ok;
                switch (hwKey) {
                    case SensorCapabilities.KEY_MOTION: ok = reg(Sensor.TYPE_ACCELEROMETER, HZ5_US, BATCH_US); break;
                    case SensorCapabilities.KEY_ROTATION:
                        ok = sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE) != null;
                        if (ok) {
                            rotationLive = true;
                            handler.post(burstOn);
                        }
                        break;
                    case SensorCapabilities.KEY_STEPS:
                        ok = SensorCapabilities.hasActivityPermission(ctx) && reg(Sensor.TYPE_STEP_COUNTER, HZ1_US, BATCH_US);
                        break;
                    case SensorCapabilities.KEY_SIG_MOTION: {
                        Sensor sig = sm.getDefaultSensor(Sensor.TYPE_SIGNIFICANT_MOTION);
                        ok = sig != null && sm.requestTriggerSensor(trigger, sig);
                        break;
                    }
                    case SensorCapabilities.KEY_PRESSURE: ok = reg(Sensor.TYPE_PRESSURE, HZ1_US, BATCH_US); break;
                    case SensorCapabilities.KEY_LIGHT: ok = reg(Sensor.TYPE_LIGHT, SensorManager.SENSOR_DELAY_NORMAL, 0); break;
                    case SensorCapabilities.KEY_PROXIMITY: {
                        Sensor prox = sm.getDefaultSensor(Sensor.TYPE_PROXIMITY);
                        if (prox != null && sampler != null) sampler.setProximityMax(prox.getMaximumRange());
                        ok = reg(Sensor.TYPE_PROXIMITY, SensorManager.SENSOR_DELAY_NORMAL, 0);
                        break;
                    }
                    case SensorCapabilities.KEY_AMBIENT_TEMP: ok = reg(Sensor.TYPE_AMBIENT_TEMPERATURE, SensorManager.SENSOR_DELAY_NORMAL, 0); break;
                    default: ok = false;
                }
                if (ok) live.add(hwKey);
                else if (live.isEmpty()) quitThread();
                return ok;
            }
        }

        @Override public void unregister(String hwKey) {
            if (sm == null) return;
            synchronized (lock) {
                live.remove(hwKey);
                switch (hwKey) {
                    case SensorCapabilities.KEY_MOTION: unreg(Sensor.TYPE_ACCELEROMETER); break;
                    case SensorCapabilities.KEY_ROTATION:
                        rotationLive = false;
                        if (handler != null) {
                            handler.removeCallbacks(burstOn);
                            handler.removeCallbacks(burstOff);
                        }
                        unreg(Sensor.TYPE_GYROSCOPE);
                        unreg(Sensor.TYPE_GRAVITY);
                        break;
                    case SensorCapabilities.KEY_STEPS: unreg(Sensor.TYPE_STEP_COUNTER); break;
                    case SensorCapabilities.KEY_SIG_MOTION: {
                        Sensor sig = sm.getDefaultSensor(Sensor.TYPE_SIGNIFICANT_MOTION);
                        if (sig != null) sm.cancelTriggerSensor(trigger, sig);
                        break;
                    }
                    case SensorCapabilities.KEY_PRESSURE: unreg(Sensor.TYPE_PRESSURE); break;
                    case SensorCapabilities.KEY_LIGHT: unreg(Sensor.TYPE_LIGHT); break;
                    case SensorCapabilities.KEY_PROXIMITY: unreg(Sensor.TYPE_PROXIMITY); break;
                    case SensorCapabilities.KEY_AMBIENT_TEMP: unreg(Sensor.TYPE_AMBIENT_TEMPERATURE); break;
                    default: break;
                }
                if (live.isEmpty()) quitThread();
            }
        }

        private void quitThread() {
            if (thread != null) {
                thread.quitSafely();
                thread = null;
                handler = null;
            }
        }
    }
}
