package com.pieces.android.companion;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Pure place clustering from hashed Wi-Fi fingerprints (ANDROID_SENSITIVE_CAPTURE_DESIGN section 3). No Android types,
 * no clock, no randomness of its own, so a scan sequence plus an id source always gives the same places.
 *
 * - A place is a weighted set of hashed BSSIDs plus any hashed connected networks. Ids are random ("pl_" + 8 base32),
 *   never derived from a hash.
 * - A tick matches when its connected network is known to the place, otherwise when the weighted Jaccard similarity of
 *   the fingerprint is at least {@link #MATCH_JACCARD}.
 * - Hysteresis: a new place is created after 2 consecutive unmatched usable ticks, you arrive after 2 matching ticks,
 *   and you depart after 2 non-matching ticks or 15 minutes without usable input.
 * - Nothing usable (no connected network and fewer than 3 access points) reads as "unknown", never as a place.
 */
final class PlaceModel {
    static final double MATCH_JACCARD = 0.35;
    static final int CONFIRM_TICKS = 2;
    static final long NO_INPUT_DEPART_MS = 15L * 60_000L;
    static final long STALE_MS = 30L * 24 * 3600_000L;
    static final int MIN_APS = 3;
    private static final double EMA = 0.2;
    private static final double DECAY = 0.98;
    private static final double DROP_BELOW = 0.05;

    static final String UNLABELED = "unlabeled";

    interface Ids {
        String next();
    }

    /** One tick's hashed fingerprint. `connected` is null when there is no usable connected network. */
    static final class Observation {
        final String connected;
        final Set<String> aps;

        Observation(String connected, Set<String> aps) {
            this.connected = connected;
            this.aps = aps;
        }

        boolean usable() {
            return connected != null || aps.size() >= MIN_APS;
        }
    }

    static final class Place {
        final String id;
        String label = UNLABELED;
        final Map<String, Double> weights = new HashMap<>();
        final Map<String, Long> seen = new HashMap<>();
        final Set<String> connected = new HashSet<>();

        Place(String id) {
            this.id = id;
        }
    }

    static final class Event {
        final String type; // arrive | depart
        final String placeId;
        final String label;
        final long ts;

        Event(String type, String placeId, String label, long ts) {
            this.type = type;
            this.placeId = placeId;
            this.label = label;
            this.ts = ts;
        }
    }

    static final class Result {
        /** Null means "unknown place". */
        final String placeId;
        final String label;
        final long dwellMs;
        final double conf;
        final String src; // wifi_connected | wifi_scan | none
        final List<Event> events;

        Result(String placeId, String label, long dwellMs, double conf, String src, List<Event> events) {
            this.placeId = placeId;
            this.label = label;
            this.dwellMs = dwellMs;
            this.conf = conf;
            this.src = src;
            this.events = events;
        }
    }

    private final Ids ids;
    final Map<String, Place> places = new HashMap<>();

    private String current;
    private long arrivedAt;
    private int missTicks;
    private long noInputSince = -1;
    private String candidate;
    private int candidateTicks;
    private Observation pending;
    private int pendingTicks;

    PlaceModel(Ids ids) {
        this.ids = ids;
    }

    // ---- matching ----

    /** Similarity of an observation to a place, 0..1. A known connected network is a full match. */
    static double score(Place p, Observation o) {
        if (o.connected != null && p.connected.contains(o.connected)) return 1.0;
        if (o.aps.isEmpty() || p.weights.isEmpty()) return 0.0;
        double inter = 0;
        double union = 0;
        for (double w : p.weights.values()) union += w;
        for (String ap : o.aps) {
            Double w = p.weights.get(ap);
            if (w != null) inter += w;
            else union += 1.0;
        }
        return union <= 0 ? 0.0 : inter / union;
    }

    private Place best(Observation o, double[] outScore) {
        Place best = null;
        double bestScore = 0;
        for (Place p : places.values()) {
            double s = score(p, o);
            boolean beats = s > bestScore || (s == bestScore && best != null && p.id.compareTo(best.id) < 0);
            if (s >= MATCH_JACCARD && (best == null || beats)) {
                best = p;
                bestScore = s;
            }
        }
        outScore[0] = bestScore;
        return best;
    }

    private static boolean similar(Observation a, Observation b) {
        if (a.connected != null && a.connected.equals(b.connected)) return true;
        if (a.aps.isEmpty() || b.aps.isEmpty()) return false;
        Set<String> inter = new HashSet<>(a.aps);
        inter.retainAll(b.aps);
        Set<String> union = new HashSet<>(a.aps);
        union.addAll(b.aps);
        return inter.size() / (double) union.size() >= MATCH_JACCARD;
    }

    private void learn(Place p, Observation o, long now) {
        for (String ap : o.aps) {
            Double w = p.weights.get(ap);
            p.weights.put(ap, w == null ? EMA : w + EMA * (1.0 - w));
            p.seen.put(ap, now);
        }
        for (Iterator<Map.Entry<String, Double>> it = p.weights.entrySet().iterator(); it.hasNext(); ) {
            Map.Entry<String, Double> e = it.next();
            if (!o.aps.contains(e.getKey())) e.setValue(e.getValue() * DECAY);
            Long last = p.seen.get(e.getKey());
            boolean stale = last != null && now - last > STALE_MS;
            if (stale || e.getValue() < DROP_BELOW) {
                p.seen.remove(e.getKey());
                it.remove();
            }
        }
        if (o.connected != null) p.connected.add(o.connected);
    }

    private Place create(Observation o, long now) {
        Place p = new Place(ids.next());
        for (String ap : o.aps) {
            p.weights.put(ap, 1.0);
            p.seen.put(ap, now);
        }
        if (o.connected != null) p.connected.add(o.connected);
        places.put(p.id, p);
        return p;
    }

    // ---- the tick ----

    Result tick(Observation o, long now) {
        List<Event> events = new ArrayList<>();
        String src = o.connected != null ? "wifi_connected" : (o.aps.size() >= MIN_APS ? "wifi_scan" : "none");
        double conf = 0;

        if (!o.usable()) {
            if (noInputSince < 0) noInputSince = now;
            if (current != null && now - noInputSince >= NO_INPUT_DEPART_MS) depart(now, events);
            return unknown(events);
        }
        noInputSince = -1;

        double[] sc = new double[1];
        Place match = best(o, sc);
        if (match != null) {
            pending = null;
            pendingTicks = 0;
            learn(match, o, now);
            conf = sc[0];
            if (match.id.equals(current)) {
                missTicks = 0;
                candidate = null;
                candidateTicks = 0;
            } else {
                if (current != null) missTicks++;
                if (match.id.equals(candidate)) candidateTicks++;
                else {
                    candidate = match.id;
                    candidateTicks = 1;
                }
                if (candidateTicks >= CONFIRM_TICKS) {
                    if (current != null) depart(now, events);
                    arrive(match, now, events);
                } else if (current != null && missTicks >= CONFIRM_TICKS) {
                    depart(now, events);
                }
            }
        } else {
            candidate = null;
            candidateTicks = 0;
            if (current != null) {
                missTicks++;
                if (missTicks >= CONFIRM_TICKS) depart(now, events);
            }
            if (pending != null && similar(pending, o)) pendingTicks++;
            else {
                pending = o;
                pendingTicks = 1;
            }
            if (pendingTicks >= CONFIRM_TICKS) {
                Place created = create(o, now);
                pending = null;
                pendingTicks = 0;
                if (current != null) depart(now, events);
                arrive(created, now, events); // two unmatched ticks already confirmed it
                conf = 1.0;
            }
        }

        Place cur = current == null ? null : places.get(current);
        if (cur == null) return new Result(null, "unknown", 0, 0, src, events);
        return new Result(cur.id, cur.label, now - arrivedAt, conf, src, events);
    }

    private Result unknown(List<Event> events) {
        return new Result(null, "unknown", 0, 0, "none", events);
    }

    private void arrive(Place p, long now, List<Event> events) {
        current = p.id;
        arrivedAt = now;
        missTicks = 0;
        candidate = null;
        candidateTicks = 0;
        events.add(new Event("arrive", p.id, p.label, now));
    }

    private void depart(long now, List<Event> events) {
        Place p = places.get(current);
        if (p != null) events.add(new Event("depart", p.id, p.label, now));
        current = null;
        missTicks = 0;
    }

    // ---- state for the UI ----

    String currentPlaceId() {
        return current;
    }

    long currentArrivedAt() {
        return arrivedAt;
    }

    boolean setLabel(String placeId, String label) {
        Place p = places.get(placeId);
        if (p == null || !isLabel(label)) return false;
        p.label = label;
        return true;
    }

    static boolean isLabel(String s) {
        return "home".equals(s) || "work".equals(s) || "other".equals(s) || UNLABELED.equals(s);
    }

    // ---- persistence (stays on the phone; hashes never leave it) ----

    JSONObject toJson() throws Exception {
        JSONArray arr = new JSONArray();
        for (Place p : places.values()) {
            JSONObject o = new JSONObject();
            o.put("id", p.id);
            o.put("label", p.label);
            JSONObject w = new JSONObject();
            for (Map.Entry<String, Double> e : p.weights.entrySet()) {
                JSONArray pair = new JSONArray().put(e.getValue()).put(p.seen.containsKey(e.getKey()) ? p.seen.get(e.getKey()) : 0L);
                w.put(e.getKey(), pair);
            }
            o.put("aps", w);
            o.put("conn", new JSONArray(p.connected));
            arr.put(o);
        }
        JSONObject root = new JSONObject();
        root.put("places", arr);
        if (current != null) {
            root.put("current", current);
            root.put("arrived_at", arrivedAt);
        }
        return root;
    }

    static PlaceModel fromJson(JSONObject root, Ids ids) throws Exception {
        PlaceModel m = new PlaceModel(ids);
        JSONArray arr = root.optJSONArray("places");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                Place p = new Place(o.getString("id"));
                String label = o.optString("label", UNLABELED);
                p.label = isLabel(label) ? label : UNLABELED;
                JSONObject w = o.optJSONObject("aps");
                if (w != null) {
                    for (Iterator<String> it = w.keys(); it.hasNext(); ) {
                        String k = it.next();
                        JSONArray pair = w.getJSONArray(k);
                        p.weights.put(k, pair.getDouble(0));
                        p.seen.put(k, pair.getLong(1));
                    }
                }
                JSONArray conn = o.optJSONArray("conn");
                if (conn != null) for (int j = 0; j < conn.length(); j++) p.connected.add(conn.getString(j));
                m.places.put(p.id, p);
            }
        }
        String cur = root.optString("current", "");
        if (!cur.isEmpty() && m.places.containsKey(cur)) {
            m.current = cur;
            m.arrivedAt = root.optLong("arrived_at", 0L);
        }
        return m;
    }
}
