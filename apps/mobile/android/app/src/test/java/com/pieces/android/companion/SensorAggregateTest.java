package com.pieces.android.companion;

import static org.junit.Assert.*;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONObject;
import org.junit.Test;

public class SensorAggregateTest {
    /** Fake SensorManager seam: records which hardware is registered. */
    private static final class FakeBackend implements SensorWindowSampler.Backend {
        final Set<String> live = new HashSet<>();
        final List<String> registerCalls = new ArrayList<>();
        final Set<String> absent = new HashSet<>();
        @Override public boolean register(String hwKey) {
            registerCalls.add(hwKey);
            if (absent.contains(hwKey)) return false;
            live.add(hwKey);
            return true;
        }
        @Override public void unregister(String hwKey) {
            live.remove(hwKey);
        }
    }

    private static final class FakeEnv implements SensorWindowSampler.Env {
        JSONObject battery;
        final Map<String, JSONObject> emitted = new LinkedHashMap<>();
        final Map<String, Long> emittedTs = new HashMap<>();
        @Override public JSONObject battery() { return battery; }
        @Override public void emit(String id, long ts, JSONObject payload) {
            emitted.put(id, payload);
            emittedTs.put(id, ts);
        }
    }

    private static Set<String> keys(String... k) {
        return new HashSet<>(Arrays.asList(k));
    }

    // ---- pure aggregation: fixed outputs for fixed inputs ----

    @Test
    public void energyClassBoundaries() {
        assertEquals("still", SensorWindowSampler.energyClass(0.0));
        assertEquals("still", SensorWindowSampler.energyClass(0.149));
        assertEquals("light", SensorWindowSampler.energyClass(0.15));
        assertEquals("moderate", SensorWindowSampler.energyClass(0.8));
        assertEquals("vigorous", SensorWindowSampler.energyClass(2.0));
    }

    @Test
    public void orientationClasses() {
        assertEquals("flat_up", SensorWindowSampler.orientOf(0, 0, 9.8));
        assertEquals("flat_down", SensorWindowSampler.orientOf(0, 0, -9.8));
        assertEquals("upright", SensorWindowSampler.orientOf(0, 9.8, 0));
        assertEquals("upright", SensorWindowSampler.orientOf(0, -9.8, 0));
        assertEquals("tilted", SensorWindowSampler.orientOf(6.9, 6.9, 0));
        assertEquals("tilted", SensorWindowSampler.orientOf(0, 0, 0));
        Map<String, Integer> c = new HashMap<>();
        c.put("flat_up", 8);
        c.put("tilted", 2);
        assertEquals("flat_up", SensorWindowSampler.orientWindow(c));
        c.put("tilted", 4);
        assertEquals("mixed", SensorWindowSampler.orientWindow(c));
        assertNull(SensorWindowSampler.orientWindow(new HashMap<String, Integer>()));
    }

    @Test
    public void rotationPressureLuxStepsAndActivity() {
        assertEquals("steady", SensorWindowSampler.rotClass(0.05));
        assertEquals("turning", SensorWindowSampler.rotClass(0.5));
        assertEquals("rotating", SensorWindowSampler.rotClass(3.0));
        assertEquals("rising", SensorWindowSampler.pressureTrend(0.1));
        assertEquals("falling", SensorWindowSampler.pressureTrend(-0.25));
        assertEquals("steady", SensorWindowSampler.pressureTrend(0.05));
        assertEquals("dark", SensorWindowSampler.luxBucket(3));
        assertEquals("dim", SensorWindowSampler.luxBucket(50));
        assertEquals("indoor", SensorWindowSampler.luxBucket(400));
        assertEquals("bright", SensorWindowSampler.luxBucket(5000));
        assertEquals("sun", SensorWindowSampler.luxBucket(50000));
        assertEquals(30L, SensorWindowSampler.stepsDelta(1000, 1030));
        assertEquals(12L, SensorWindowSampler.stepsDelta(5000, 12)); // reboot reset
        assertEquals(120.0, SensorWindowSampler.cadenceSpm(600, 300_000), 1e-9);
        assertEquals("walking", SensorWindowSampler.activityState("light", true, 100, false).state);
        assertEquals("running", SensorWindowSampler.activityState("vigorous", true, 150, false).state);
        assertEquals("still", SensorWindowSampler.activityState("still", true, 0, false).state);
        assertEquals("vehicle", SensorWindowSampler.activityState("light", true, 0, true).state);
        assertEquals("unknown", SensorWindowSampler.activityState(null, true, 0, false).state);
    }

    // ---- toggle off registers nothing ----

    @Test
    public void everythingOffRegistersZeroListeners() {
        FakeBackend be = new FakeBackend();
        SensorWindowSampler s = new SensorWindowSampler(be, new FakeEnv());
        s.applyConsent(Collections.<String>emptySet());
        assertEquals(0, be.registerCalls.size());
        assertEquals(0, be.live.size());
        assertEquals(0, s.registeredCount());
        // app_switches and battery have no hardware listener either
        s.applyConsent(keys("app_switches", "battery"));
        assertEquals(0, be.registerCalls.size());
    }

    @Test
    public void onlyToggledSensorsRegisterAndRevocationUnregistersInTheSameCall() {
        FakeBackend be = new FakeBackend();
        SensorWindowSampler s = new SensorWindowSampler(be, new FakeEnv());
        s.applyConsent(keys("motion", "pressure"));
        assertEquals(keys("motion", "pressure"), be.live);
        s.applyConsent(keys("pressure")); // motion revoked
        assertEquals(keys("pressure"), be.live);
        assertEquals(1, s.registeredCount());
        s.applyConsent(Collections.<String>emptySet()); // master off
        assertEquals(0, be.live.size());
        assertEquals(0, s.registeredCount());
    }

    @Test
    public void activityPullsInItsInputsAndAbsentHardwareIsNotCounted() {
        FakeBackend be = new FakeBackend();
        be.absent.add("steps");
        SensorWindowSampler s = new SensorWindowSampler(be, new FakeEnv());
        s.applyConsent(keys("activity"));
        assertEquals(keys("motion", "sig_motion"), be.live);
        assertEquals(keys("motion", "sig_motion"), s.registeredKeys());
    }

    @Test
    public void legacyProximityLightGravityListenersFollowConsent() {
        assertTrue(NativeHardwareTelemetry.legacyListenerPlan(k -> false).isEmpty());
        assertEquals(keys("light"), NativeHardwareTelemetry.legacyListenerPlan(k -> k.equals("light")));
        assertEquals(keys("proximity", "light", "gravity"), NativeHardwareTelemetry.legacyListenerPlan(k -> true));
        assertEquals(keys("gravity"), NativeHardwareTelemetry.legacyListenerPlan(k -> k.equals("rotation")));
    }

    // ---- window assembly ----

    @Test
    public void windowCarriesOnlyEnabledSensorsAndNoAbsolutePressure() throws Exception {
        FakeBackend be = new FakeBackend();
        FakeEnv env = new FakeEnv();
        env.battery = new JSONObject().put("pct", 80).put("plugged", false);
        SensorWindowSampler s = new SensorWindowSampler(be, env);
        s.applyConsent(keys("motion", "pressure", "battery"));
        for (int i = 0; i < 10; i++) s.onSample("motion", new float[]{0f, 0f, 9.80665f}); // exactly gravity: dyn 0
        s.onSample("pressure", new float[]{1013.25f});
        s.onSample("pressure", new float[]{1012.75f});
        s.onSample("light", new float[]{500f}); // light is not enabled: dropped

        s.flushWindow(0, 300_000);
        JSONObject w = env.emitted.get("sw-300000");
        assertNotNull(w);
        assertEquals(300_000L, (long) env.emittedTs.get("sw-300000")); // stamped with window_end
        assertEquals("sensor_window", w.getString("type"));
        JSONObject sensors = w.getJSONObject("sensors");
        assertEquals(keys("motion", "pressure", "battery"), jsonKeys(sensors));
        assertEquals("still", sensors.getJSONObject("motion").getString("energy_class"));
        assertEquals("falling", sensors.getJSONObject("pressure").getString("trend"));
        assertEquals(-0.5, sensors.getJSONObject("pressure").getDouble("delta_hpa"), 1e-9);
        assertFalse(w.toString().contains("1013")); // never the absolute reading
        assertFalse(w.toString().contains("1012"));
    }

    @Test
    public void emptyWindowEmitsNothingAndStepsUsePreviousBase() throws Exception {
        FakeEnv env = new FakeEnv();
        SensorWindowSampler s = new SensorWindowSampler(new FakeBackend(), env);
        s.applyConsent(keys("steps"));
        s.flushWindow(0, 300_000);
        assertTrue(env.emitted.isEmpty());

        s.onSample("steps", new float[]{1000f});
        s.onSample("steps", new float[]{1100f});
        s.flushWindow(300_000, 600_000);
        assertEquals(100L, env.emitted.get("sw-600000").getJSONObject("sensors").getJSONObject("steps").getLong("delta"));
        s.onSample("steps", new float[]{1250f});
        s.flushWindow(600_000, 900_000);
        assertEquals(150L, env.emitted.get("sw-900000").getJSONObject("sensors").getJSONObject("steps").getLong("delta"));
    }

    @Test
    public void revokedSensorStopsAccumulatingAndLeavesTheNextWindow() throws Exception {
        FakeEnv env = new FakeEnv();
        SensorWindowSampler s = new SensorWindowSampler(new FakeBackend(), env);
        s.applyConsent(keys("light", "proximity"));
        s.onSample("light", new float[]{3f});
        s.onSample("proximity", new float[]{0f});
        s.applyConsent(keys("light")); // proximity revoked mid-window
        s.onSample("proximity", new float[]{0f}); // late callback after unregister is ignored
        s.flushWindow(0, 300_000);
        JSONObject sensors = env.emitted.get("sw-300000").getJSONObject("sensors");
        assertEquals(keys("light"), jsonKeys(sensors));
        assertEquals("dark", sensors.getJSONObject("light").getString("bucket"));
    }

    @Test
    public void capabilityPayloadIsDeterministicSoTheIdIsStable() throws Exception {
        Map<String, SensorCapabilities.Info> infos = new LinkedHashMap<>();
        infos.put("motion", new SensorCapabilities.Info(true, 0.2, 3000, false, 5000));
        Map<String, Boolean> toggles = new LinkedHashMap<>();
        toggles.put("master", true);
        toggles.put("motion", true);
        JSONObject a = SensorCapabilities.buildPayload(infos, false, toggles);
        JSONObject b = SensorCapabilities.buildPayload(infos, false, toggles);
        assertEquals(SensorCapabilities.eventId(a), SensorCapabilities.eventId(b));
        assertTrue(SensorCapabilities.eventId(a).matches("caps-[0-9a-f]{12}"));
        assertFalse(a.getJSONObject("sensors").getJSONObject("pressure").getBoolean("present"));
        assertEquals(0.2, a.getJSONObject("sensors").getJSONObject("motion").getDouble("power_ma"), 1e-9);
        toggles.put("motion", false);
        assertNotEquals(SensorCapabilities.eventId(a), SensorCapabilities.eventId(SensorCapabilities.buildPayload(infos, false, toggles)));
        assertFalse(SensorCapabilities.ALL_KEYS.contains("magnetometer"));
    }

    private static Set<String> jsonKeys(JSONObject o) {
        Set<String> out = new HashSet<>();
        java.util.Iterator<String> it = o.keys();
        while (it.hasNext()) out.add(it.next());
        return out;
    }
}
