package com.pieces.android.companion;

import static org.junit.Assert.*;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;

public class PlaceSamplerTest {
    static final class FakeWifi implements PlaceSampler.WifiSource {
        String connected;
        List<PlaceSampler.Ap> scan = new ArrayList<>();
        int scansTriggered; // never incremented: the interface has no way to start a scan
        @Override public String connectedBssid() { return connected; }
        @Override public List<PlaceSampler.Ap> cachedScan() { return scan; }
    }

    static final class MemStore implements PlaceSampler.Store {
        PlaceModel model = new PlaceModel(new PlaceModel.Ids() { int i; public String next() { return "pl_" + (++i); } });
        @Override public PlaceModel load() { return model; }
        @Override public void save(PlaceModel m) { model = m; }
    }

    static final class FakeEnv implements PlaceSampler.Env {
        long now = 3_000_000_000L - (3_000_000_000L % PlaceSampler.WINDOW_MS) + 1000;
        final List<String> ids = new ArrayList<>();
        final List<JSONObject> events = new ArrayList<>();
        @Override public long now() { return now; }
        @Override public void emit(String id, long ts, JSONObject p) { ids.add(id); events.add(p); }
    }

    private final FakeWifi wifi = new FakeWifi();
    private final FakeEnv env = new FakeEnv();
    private final MemStore store = new MemStore();
    private final List<String> logs = new ArrayList<>();
    private final PlaceSampler.Core core =
        new PlaceSampler.Core(wifi, PlaceHasherTest.keyed("k"), env, store, logs::add);

    private static String mac(int i) {
        return String.format("a0:b1:c2:d3:e4:%02x", i);
    }

    private void homeScan() {
        wifi.scan = new ArrayList<>();
        for (int i = 1; i <= 5; i++) wifi.scan.add(new PlaceSampler.Ap(mac(i), -40 - i, 10_000));
    }

    private void tick() {
        env.now += PlaceSampler.WINDOW_MS;
        core.tick();
    }

    @Test
    public void placeholderAndLocallyAdministeredAddressesMakeNoPlace() throws Exception {
        wifi.connected = "02:00:00:00:00:00";
        wifi.scan = new ArrayList<>(Arrays.asList(
            new PlaceSampler.Ap("02:00:00:00:00:00", -40, 1000),
            new PlaceSampler.Ap("fa:12:34:56:78:9a", -41, 1000),
            new PlaceSampler.Ap("fa:12:34:56:78:9b", -42, 1000)));
        tick();
        tick();
        assertTrue(store.model.places.isEmpty());
        JSONObject w = env.events.get(env.events.size() - 1);
        assertEquals("unknown", w.getString("place_id"));
        assertEquals("unknown", w.getString("label"));
        assertEquals("none", w.getString("src"));
    }

    @Test
    public void oldScanResultsAreIgnored() {
        wifi.scan = new ArrayList<>();
        for (int i = 1; i <= 5; i++) wifi.scan.add(new PlaceSampler.Ap(mac(i), -50, PlaceSampler.MAX_SCAN_AGE_MS + 1));
        tick();
        tick();
        assertTrue(store.model.places.isEmpty());
    }

    @Test
    public void onlyTheTopTenBySignalAreKept() {
        wifi.scan = new ArrayList<>();
        for (int i = 1; i <= 15; i++) wifi.scan.add(new PlaceSampler.Ap(mac(i), -30 - i, 1000));
        assertEquals(PlaceSampler.MAX_APS, core.observe().aps.size());
    }

    @Test
    public void arrivalEmitsOneEventAndWindowsCarryOnlyAllowedKeys() throws Exception {
        homeScan();
        tick();
        tick(); // second matching tick: arrive
        int arrive = 0;
        for (JSONObject e : env.events) {
            String type = e.optString("type");
            assertNull(type, NativeTelemetrySync.allowlistProblem(type, e));
            if ("place_event".equals(type)) {
                arrive++;
                assertEquals("arrive", e.getString("event"));
            }
        }
        assertEquals(1, arrive);
        JSONObject w = env.events.get(env.events.size() - 1);
        assertEquals("place_window", w.getString("type"));
        assertEquals("pl_1", w.getString("place_id"));
        assertEquals("unlabeled", w.getString("label"));
        assertEquals("wifi_scan", w.getString("src"));
        assertEquals(w.getLong("window_start") + 300_000L, w.getLong("window_end"));
        assertTrue(env.ids.get(env.ids.size() - 1).startsWith("pw-"));
        assertTrue(env.ids.get(0).startsWith("pe-") || env.ids.get(0).startsWith("pw-"));
    }

    @Test
    public void noMacShapedStringOrHashLeavesInEvents() throws Exception {
        wifi.connected = mac(1);
        homeScan();
        tick();
        tick();
        for (JSONObject e : env.events) {
            String s = e.toString();
            assertFalse(s, s.matches(".*[0-9a-f]{2}(:[0-9a-f]{2}){5}.*"));
            assertFalse(s, s.contains("ssid") || s.contains("bssid") || s.contains("hash"));
        }
    }

    @Test
    public void tickFailureIsLoggedAsAClassNameOnly() {
        PlaceSampler.Core bad = new PlaceSampler.Core(wifi, PlaceHasherTest.keyed("k"), env, new PlaceSampler.Store() {
            @Override public PlaceModel load() { throw new IllegalStateException("secret-bssid-a0:b1"); }
            @Override public void save(PlaceModel m) {}
        }, logs::add);
        bad.tick();
        assertEquals(1, logs.size());
        assertEquals("place tick failed: IllegalStateException", logs.get(0));
    }
}
