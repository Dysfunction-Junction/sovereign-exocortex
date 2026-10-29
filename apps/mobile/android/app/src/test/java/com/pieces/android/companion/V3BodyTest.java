package com.pieces.android.companion;

import static org.junit.Assert.*;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class V3BodyTest {
    private static String v3Row(String id, long ts, Object payload) throws Exception {
        JSONObject v3 = new JSONObject();
        v3.put("kind", "telemetry");
        v3.put("ts_device", ts);
        v3.put("schema_ver", 1);
        v3.put("payload", payload);
        JSONObject row = new JSONObject();
        row.put("id", id);
        row.put("package", "android.v3");
        row.put("timestamp", "2026-10-29T00:00:00.000Z");
        row.put("telemetry", "app_foreground");
        row.put("v3", v3);
        return row.toString();
    }

    private static JSONObject fgPayload(String pad) throws Exception {
        JSONObject p = new JSONObject();
        p.put("type", "app_foreground");
        p.put("to", "com.example");
        p.put("pad", pad);
        return p;
    }

    private static String usageRow(String id) throws Exception {
        JSONObject row = new JSONObject();
        row.put("id", id);
        row.put("package", "android.usage");
        row.put("app_label", "App Usage");
        row.put("timestamp", "2026-10-29T00:00:00.000Z");
        row.put("telemetry", "App usage 10:00-10:15");
        return row.toString();
    }

    @Test
    public void chunksStayWithinOneHundredEventsAndTheByteCap() throws Exception {
        List<String> rows = new ArrayList<>();
        for (int i = 0; i < 250; i++) rows.add(v3Row("fg-" + i, 1000 + i, fgPayload("x")));
        NativeTelemetrySync.V3Build b = NativeTelemetrySync.buildV3Body(rows, "opaque-lan-token");
        assertEquals(3, b.bodies.size());
        int total = 0;
        for (String body : b.bodies) {
            int n = new JSONObject(body).getJSONArray("events").length();
            assertTrue(n <= 100);
            assertTrue(body.getBytes(StandardCharsets.UTF_8).length <= 256 * 1024);
            total += n;
        }
        assertEquals(250, total);

        // Fat events force byte-based splitting well below 100 per chunk.
        StringBuilder pad = new StringBuilder();
        for (int i = 0; i < 10_000; i++) pad.append('p');
        List<String> fat = new ArrayList<>();
        for (int i = 0; i < 60; i++) fat.add(v3Row("fg-fat-" + i, 1000 + i, fgPayload(pad.toString())));
        NativeTelemetrySync.V3Build fb = NativeTelemetrySync.buildV3Body(fat, "t");
        assertTrue(fb.bodies.size() > 1);
        int fatTotal = 0;
        for (String body : fb.bodies) {
            assertTrue(body.getBytes(StandardCharsets.UTF_8).length <= 256 * 1024);
            fatTotal += new JSONObject(body).getJSONArray("events").length();
        }
        assertEquals(60, fatTotal);
    }

    @Test
    public void invalidEventsAreReportedForQuarantineNotSent() throws Exception {
        StringBuilder longId = new StringBuilder("fg-");
        for (int i = 0; i < 130; i++) longId.append('z');
        List<String> rows = new ArrayList<>();
        rows.add(v3Row("fg-ok", 1000, fgPayload("x")));
        rows.add(v3Row(longId.toString(), 1000, fgPayload("x")));          // event_id > 128 chars
        rows.add(v3Row("fg-array", 1000, new JSONArray().put(1)));          // payload not a plain object
        rows.add(v3Row("fg-badtype", 1000, new JSONObject().put("type", "nope")));
        NativeTelemetrySync.V3Build b = NativeTelemetrySync.buildV3Body(rows, "t");
        assertEquals(3, b.invalid.size());
        assertEquals(1, b.bodies.size());
        JSONArray sent = new JSONObject(b.bodies.get(0)).getJSONArray("events");
        assertEquals(1, sent.length());
        assertEquals("fg-ok", sent.getJSONObject(0).getString("event_id"));
        assertEquals("telemetry", sent.getJSONObject(0).getString("kind"));
        assertEquals(1000L, sent.getJSONObject(0).getLong("ts_device"));
    }

    @Test
    public void usageSummariesStillConvertAndLegacyRowsAreIgnored() throws Exception {
        List<String> rows = new ArrayList<>();
        rows.add(usageRow("native-usage-1"));
        rows.add("{\"id\":\"screen-1\",\"package\":\"com.x\",\"telemetry\":\"t\",\"timestamp\":\"2026-10-29T00:00:00.000Z\"}");
        NativeTelemetrySync.V3Build b = NativeTelemetrySync.buildV3Body(rows, "t");
        assertEquals(1, b.bodies.size());
        JSONObject ev = new JSONObject(b.bodies.get(0)).getJSONArray("events").getJSONObject(0);
        assertEquals("native-usage-1", ev.getString("event_id"));
        assertEquals("system_telemetry", ev.getJSONObject("payload").getString("type"));
        assertTrue(b.invalid.isEmpty());
        assertEquals("device_phone_galaxy", new JSONObject(b.bodies.get(0)).getString("device_id"));
    }

    @Test
    public void v3OnlyRowsAreNotForTheLegacyRoute() throws Exception {
        assertTrue(NativeTelemetrySync.isV3Only(v3Row("fg-1", 1, fgPayload("x"))));
        assertFalse(NativeTelemetrySync.isV3Only(usageRow("u")));
        assertFalse(NativeTelemetrySync.isV3Only("not json"));
    }

    @Test
    public void stripSensorRemovesOnlyThatSensorAndDropsEmptyWindows() throws Exception {
        JSONObject sensors = new JSONObject();
        sensors.put("motion", new JSONObject().put("energy_class", "still"));
        sensors.put("light", new JSONObject().put("bucket", "dim"));
        JSONObject payload = new JSONObject().put("type", "sensor_window").put("sensors", sensors);
        String row = v3Row("sw-1", 1, payload);
        String after = NativeTelemetrySync.stripSensor(row, "motion");
        assertNotNull(after);
        JSONObject remaining = new JSONObject(after).getJSONObject("v3").getJSONObject("payload").getJSONObject("sensors");
        assertFalse(remaining.has("motion"));
        assertTrue(remaining.has("light"));
        assertNull(NativeTelemetrySync.stripSensor(after, "light")); // nothing left: delete the row
    }

    @Test
    public void sha1HexMatchesKnownVector() {
        assertEquals("a9993e364706816aba3e25717850c26c9cd0d89d", NativeTelemetrySync.sha1Hex("abc"));
    }
}
