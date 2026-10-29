package com.pieces.android.companion;

import static org.junit.Assert.*;

import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

public class UsageArrivalsTest {
    private static final UsageSummary.AppInfo INFO = new UsageSummary.AppInfo() {
        @Override public String label(String pkg) {
            switch (pkg) {
                case "com.acme.app": return "Acme Bank";            // keyword "bank"
                case "com.spotify.music": return "Spotify";
                case "com.android.chrome": return "Chrome";
                case "com.vendor.vitals": return "Vitals Health";     // keyword "health"
                default: return pkg;
            }
        }
        @Override public String category(String pkg) {
            return pkg.equals("com.spotify.music") ? "Audio" : "Uncategorized";
        }
    };

    private static UsageSummary.RawEvent fg(String pkg, long ts) {
        return new UsageSummary.RawEvent(pkg, UsageSummary.EV_FOREGROUND, ts);
    }

    @Test
    public void keywordMatchedLabelRemovesPackageAndLabelOnBothEnds() throws Exception {
        List<UsageSummary.RawEvent> raw = new ArrayList<>();
        raw.add(fg("com.spotify.music", 1000));
        raw.add(fg("com.acme.app", 2000));     // to = excluded
        raw.add(fg("com.android.chrome", 3000)); // from = excluded
        UsageSummary.ArrivalResult r = UsageSummary.buildArrivals(raw, new UsageSummary.ArrivalState(), INFO);
        assertEquals(3, r.events.size());

        org.json.JSONObject toExcluded = r.events.get(1).payload;
        assertEquals("excluded", toExcluded.getString("category"));
        assertTrue(toExcluded.getBoolean("excluded"));
        assertFalse(toExcluded.has("to"));
        assertFalse(toExcluded.has("app_label"));
        assertEquals("Audio", toExcluded.getString("from_category"));
        assertEquals("com.spotify.music", toExcluded.getString("from"));

        org.json.JSONObject fromExcluded = r.events.get(2).payload;
        assertFalse(fromExcluded.has("from"));
        assertEquals("excluded", fromExcluded.getString("from_category"));
        assertEquals("com.android.chrome", fromExcluded.getString("to"));

        // Nothing about the excluded app survives anywhere in the event, including its id.
        for (UsageSummary.Emitted e : r.events.subList(1, 3)) {
            String all = (e.eventId + e.payload).toLowerCase();
            assertFalse(all, all.contains("acme"));
        }
    }

    @Test
    public void packagePrefixAndHealthAreExcludedEvenWithAnInnocentLabel() throws Exception {
        List<UsageSummary.RawEvent> raw = new ArrayList<>();
        raw.add(fg("com.sec.android.app.shealth", 1000)); // health prefix added for A2
        raw.add(fg("com.vendor.vitals", 2000));           // health keyword in label
        UsageSummary.ArrivalResult r = UsageSummary.buildArrivals(raw, new UsageSummary.ArrivalState(), INFO);
        for (UsageSummary.Emitted e : r.events) {
            assertEquals("excluded", e.payload.getString("category"));
            assertFalse(e.payload.has("to"));
        }
    }

    @Test
    public void noiseAppsMapToHomeOrSystemAndKeepTheirPackage() throws Exception {
        List<UsageSummary.RawEvent> raw = new ArrayList<>();
        raw.add(fg("com.sec.android.app.launcher", 1000));
        raw.add(fg("com.android.systemui", 2000));
        UsageSummary.ArrivalResult r = UsageSummary.buildArrivals(raw, new UsageSummary.ArrivalState(), INFO);
        assertEquals("home", r.events.get(0).payload.getString("category"));
        assertEquals("com.sec.android.app.launcher", r.events.get(0).payload.getString("to"));
        assertEquals("system", r.events.get(1).payload.getString("category"));
        assertEquals("home", r.events.get(1).payload.getString("from_category"));
        assertEquals(1000L, r.events.get(1).payload.getLong("dwell_prev_ms"));
    }

    @Test
    public void rerunningTheSameRangeIsByteIdenticalAndAdvancingTheCursorEmitsNothing() {
        List<UsageSummary.RawEvent> raw = new ArrayList<>();
        raw.add(fg("com.spotify.music", 1000));
        raw.add(fg("com.android.chrome", 5000));
        raw.add(new UsageSummary.RawEvent(null, UsageSummary.EV_SCREEN_NON_INTERACTIVE, 6000));

        UsageSummary.ArrivalState s1 = new UsageSummary.ArrivalState();
        UsageSummary.ArrivalState s2 = new UsageSummary.ArrivalState();
        UsageSummary.ArrivalResult a = UsageSummary.buildArrivals(raw, s1, INFO);
        UsageSummary.ArrivalResult b = UsageSummary.buildArrivals(raw, s2, INFO);
        assertEquals(3, a.events.size());
        for (int i = 0; i < a.events.size(); i++) {
            assertEquals(a.events.get(i).eventId, b.events.get(i).eventId);
            assertEquals(a.events.get(i).payload.toString(), b.events.get(i).payload.toString());
        }
        assertEquals(6000L, s1.lastArrivalTs);

        // Re-query over the same range with the persisted cursor: nothing is re-emitted.
        assertTrue(UsageSummary.buildArrivals(raw, s1, INFO).events.isEmpty());
        assertTrue(a.events.get(0).eventId.startsWith("fg-1000-"));
        assertEquals("ss-6000-non_interactive", a.events.get(2).eventId);
    }

    @Test
    public void resumingTheSameAppIsNotAnArrival() {
        List<UsageSummary.RawEvent> raw = new ArrayList<>();
        raw.add(fg("com.spotify.music", 1000));
        raw.add(fg("com.spotify.music", 2000));
        assertEquals(1, UsageSummary.buildArrivals(raw, new UsageSummary.ArrivalState(), INFO).events.size());
    }

    @Test
    public void capsAtFiveHundredDroppingOldest() {
        List<UsageSummary.RawEvent> raw = new ArrayList<>();
        for (int i = 1; i <= 600; i++) raw.add(fg(i % 2 == 0 ? "com.android.chrome" : "com.spotify.music", i * 10L));
        UsageSummary.ArrivalResult r = UsageSummary.buildArrivals(raw, new UsageSummary.ArrivalState(), INFO);
        assertEquals(500, r.events.size());
        assertEquals(100, r.dropped);
        assertEquals(1010L, r.events.get(0).ts); // the first 100 (ts 10..1000) were dropped
    }
}
