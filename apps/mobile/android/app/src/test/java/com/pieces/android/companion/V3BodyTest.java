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

    private static JSONObject sensitive(String type) throws Exception {
        JSONObject p = new JSONObject().put("type", type);
        switch (type) {
            case "mic_window":
                p.put("window_start", 0).put("window_end", 300000).put("dur_ms", 300000).put("vad", "ezc-1")
                    .put("samples", 2).put("speech_samples", 1).put("speech_frac", 0.5)
                    .put("skipped", new JSONObject().put("pocket", 1));
                break;
            case "place_window":
                p.put("window_start", 0).put("window_end", 300000).put("place_id", "pl_1").put("label", "home")
                    .put("dwell_ms", 300000).put("conf", 0.9).put("src", "wifi_connected");
                break;
            case "place_event":
                p.put("event", "arrive").put("place_id", "pl_1").put("label", "home").put("ts", 5);
                break;
            default:
                p.put("window_start", 0).put("window_end", 300000).put("dur_ms", 300000).put("events", 40)
                    .put("chars_added", 120).put("chars_deleted", 8).put("bursts", 3).put("active_ms", 41000)
                    .put("median_gap_ms", 180);
        }
        return p;
    }

    @Test
    public void sensitiveTypesPassWithTheirOwnKeys() throws Exception {
        List<String> rows = new ArrayList<>();
        for (String t : new String[]{"mic_window", "place_window", "place_event", "typing_window"}) {
            rows.add(v3Row("x-" + t, 1000, sensitive(t)));
        }
        NativeTelemetrySync.V3Build b = NativeTelemetrySync.buildV3Body(rows, "t");
        assertTrue(b.invalid.isEmpty());
        assertEquals(4, new JSONObject(b.bodies.get(0)).getJSONArray("events").length());
    }

    @Test
    public void contentKeysQuarantineSensitiveEvents() throws Exception {
        List<String> rows = new ArrayList<>();
        rows.add(v3Row("pw-ssid", 1000, sensitive("place_window").put("ssid", "HomeWifi")));
        rows.add(v3Row("pw-bssid", 1000, sensitive("place_window").put("bssid", "aa:bb:cc:dd:ee:ff")));
        rows.add(v3Row("pw-text", 1000, sensitive("place_window").put("text", "hi")));
        rows.add(v3Row("tw-text", 1000, sensitive("typing_window").put("text", "hello")));
        rows.add(v3Row("tw-summary", 1000, sensitive("typing_window").put("summary", "asked about X")));
        rows.add(v3Row("mw-audio", 1000, sensitive("mic_window").put("transcript", "hey")));
        rows.add(v3Row("pw-ok", 1000, sensitive("place_window")));
        NativeTelemetrySync.V3Build b = NativeTelemetrySync.buildV3Body(rows, "t");
        assertEquals(6, b.invalid.size());
        for (String[] bad : b.invalid) assertTrue(bad[1], bad[1].startsWith("key not allowed"));
        JSONArray sent = new JSONObject(b.bodies.get(0)).getJSONArray("events");
        assertEquals(1, sent.length());
        assertEquals("pw-ok", sent.getJSONObject(0).getString("event_id"));
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

    @Test
    public void noV3PayloadContainsTypedSummaryFields() throws Exception {
        List<String> rows = new ArrayList<>();
        rows.add(v3Row("row-1", 1000, fgPayload("pad")));
        rows.add(usageRow("u-1"));
        NativeTelemetrySync.V3Build b = NativeTelemetrySync.buildV3Body(rows, "token");
        for (String body : b.bodies) {
            JSONObject root = new JSONObject(body);
            JSONArray events = root.getJSONArray("events");
            for (int i = 0; i < events.length(); i++) {
                JSONObject payload = events.getJSONObject(i).getJSONObject("payload");
                assertFalse("V3 payload must never contain summary", payload.has("summary"));
                assertFalse("V3 payload must never contain raw text", payload.has("text"));
                assertFalse("V3 payload must never contain topics", payload.has("topics"));
                assertFalse("V3 payload must never contain intent", payload.has("intent"));
            }
        }
    }
}
