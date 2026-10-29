package com.pieces.android.companion;

import static org.junit.Assert.*;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONObject;
import org.junit.Test;

public class PlaceModelTest {
    private int n;
    private final PlaceModel.Ids ids = () -> "pl_test" + (++n);
    private PlaceModel model = new PlaceModel(ids);
    private long t = 1_000_000L;

    private static Set<String> aps(String... a) {
        return new LinkedHashSet<>(Arrays.asList(a));
    }

    private static PlaceModel.Observation scan(String... a) {
        return new PlaceModel.Observation(null, aps(a));
    }

    private static final String[] HOME = {"h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8", "h9", "h10"};
    private static final String[] WORK = {"w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8", "w9", "w10"};

    private PlaceModel.Result tick(PlaceModel.Observation o) {
        t += 300_000L;
        return model.tick(o, t);
    }

    private static List<String> types(PlaceModel.Result r) {
        List<String> out = new ArrayList<>();
        for (PlaceModel.Event e : r.events) out.add(e.type);
        return out;
    }

    @Test
    public void nothingUsableIsUnknown() {
        PlaceModel.Result r = tick(scan("a", "b")); // fewer than 3 APs and not connected
        assertNull(r.placeId);
        assertEquals("unknown", r.label);
        assertEquals("none", r.src);
        assertTrue(model.places.isEmpty());
        r = tick(scan());
        assertNull(r.placeId);
    }

    @Test
    public void creatingAndArrivingNeedTwoTicks() {
        PlaceModel.Result first = tick(scan(HOME));
        assertNull("first tick: not yet a place", first.placeId);
        assertTrue(model.places.isEmpty());
        PlaceModel.Result second = tick(scan(HOME));
        assertEquals("pl_test1", second.placeId);
        assertEquals(Arrays.asList("arrive"), types(second));
        assertEquals("wifi_scan", second.src);
    }

    @Test
    public void ownedPlaceMatchesOnLaterVisitsAndNeedsTwoTicksToArriveAgain() {
        tick(scan(HOME));
        tick(scan(HOME));
        // leave to somewhere with no usable input; 15 minutes after the first empty tick the place departs
        tick(scan());
        tick(scan());
        PlaceModel.Result still = tick(scan());
        assertEquals("10 minutes without input is not yet a departure", "pl_test1", model.currentPlaceId());
        assertNull("no input reads as unknown meanwhile", still.placeId);
        PlaceModel.Result gone = tick(scan());
        assertNull(gone.placeId);
        assertEquals(Arrays.asList("depart"), types(gone));
        PlaceModel.Result back1 = tick(scan(HOME));
        assertNull("one matching tick is not an arrival", back1.placeId);
        PlaceModel.Result back2 = tick(scan(HOME));
        assertEquals("pl_test1", back2.placeId);
        assertEquals(1, model.places.size());
    }

    @Test
    public void departNeedsTwoNonMatchingTicks() {
        tick(scan(HOME));
        tick(scan(HOME));
        PlaceModel.Result miss1 = tick(scan(WORK));
        assertEquals("one miss keeps the place", "pl_test1", miss1.placeId);
        assertTrue(miss1.events.isEmpty());
        PlaceModel.Result miss2 = tick(scan(WORK));
        assertTrue(types(miss2).contains("depart"));
    }

    @Test
    public void disjointFingerprintsMakeTwoPlaces() {
        tick(scan(HOME));
        tick(scan(HOME));
        tick(scan(WORK));
        tick(scan(WORK));
        assertEquals(2, model.places.size());
        assertEquals("pl_test2", model.currentPlaceId());
    }

    @Test
    public void eightyPercentOverlapMatches() {
        tick(scan(HOME));
        tick(scan(HOME));
        String[] overlap = {"h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8"};
        PlaceModel.Result r = tick(new PlaceModel.Observation(null, aps(overlap)));
        assertEquals("pl_test1", r.placeId);
        assertEquals(1, model.places.size());
        assertTrue(r.conf >= 0.7);
    }

    @Test
    public void knownConnectedNetworkIsAFullMatchEvenWithFewAps() {
        PlaceModel.Observation home = new PlaceModel.Observation("conn-home", aps("h1", "h2"));
        tick(home);
        PlaceModel.Result r = tick(home);
        assertEquals("pl_test1", r.placeId);
        assertEquals("wifi_connected", r.src);
        // later, no scan results at all, still at home by the connected network
        PlaceModel.Result still = tick(new PlaceModel.Observation("conn-home", aps()));
        assertEquals("pl_test1", still.placeId);
        assertEquals(1.0, still.conf, 1e-9);
    }

    @Test
    public void sameScanSequenceGivesTheSamePlaces() {
        PlaceModel a = new PlaceModel(new PlaceModel.Ids() { int i; public String next() { return "pl_" + (++i); } });
        PlaceModel b = new PlaceModel(new PlaceModel.Ids() { int i; public String next() { return "pl_" + (++i); } });
        String[][] seq = {HOME, HOME, WORK, WORK, WORK, HOME, HOME};
        long now = 5_000_000L;
        for (String[] s : seq) {
            now += 300_000L;
            PlaceModel.Result ra = a.tick(scan(s), now);
            PlaceModel.Result rb = b.tick(scan(s), now);
            assertEquals(ra.placeId, rb.placeId);
        }
        assertEquals(a.places.keySet(), b.places.keySet());
    }

    @Test
    public void labelsRoundTripAndRejectUnknownLabels() throws Exception {
        tick(scan(HOME));
        tick(scan(HOME));
        assertTrue(model.setLabel("pl_test1", "home"));
        assertFalse(model.setLabel("pl_test1", "my-ssid"));
        assertFalse(model.setLabel("nope", "work"));
        PlaceModel loaded = PlaceModel.fromJson(new JSONObject(model.toJson().toString()), ids);
        assertEquals("pl_test1", loaded.currentPlaceId());
        assertEquals("home", loaded.places.get("pl_test1").label);
        PlaceModel.Result r = loaded.tick(scan(HOME), t + 300_000L);
        assertEquals("home", r.label);
    }

    @Test
    public void staleAccessPointsAreDropped() {
        tick(scan(HOME));
        tick(scan(HOME));
        long far = t + PlaceModel.STALE_MS + 1;
        model.tick(scan("h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8"), far); // matches; h9 and h10 not seen for 30+ days
        assertFalse(model.places.get("pl_test1").weights.containsKey("h9"));
        assertTrue(model.places.get("pl_test1").weights.containsKey("h1"));
    }
}
