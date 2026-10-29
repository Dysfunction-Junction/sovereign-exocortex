package com.pieces.android.companion;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONObject;

/**
 * Wi-Fi place recognition (ANDROID_SENSITIVE_CAPTURE_DESIGN section 3). Every 5 minutes it reads the connected
 * network and the cached scan results, hashes the BSSIDs with a per-install Keystore key, and feeds {@link PlaceModel}.
 *
 * - No GPS, and never `startScan`: it only reads what the system already scanned.
 * - SSIDs are never read into the model, stored, logged or sent.
 * - The PC receives only place id, label and dwell (`place_window`, `place_event`). No hashes, AP counts, RSSI,
 *   coordinates or trail.
 * - Needs precise location to read BSSIDs. Without it, nothing is emitted.
 *
 * {@link Core} is pure behind seams so it is unit-tested; the Android wiring is at the bottom.
 */
final class PlaceSampler {
    static final long WINDOW_MS = 5L * 60_000L;
    static final long MAX_SCAN_AGE_MS = 3L * 60_000L;
    static final int MAX_APS = 10;

    static final class Ap {
        final String bssid;
        final int rssi;
        final long ageMs;

        Ap(String bssid, int rssi, long ageMs) {
            this.bssid = bssid;
            this.rssi = rssi;
            this.ageMs = ageMs;
        }
    }

    interface WifiSource {
        /** BSSID of the connected network, or null. May be a placeholder; the hasher rejects those. */
        String connectedBssid();

        /** Cached scan results; never triggers a scan. */
        List<Ap> cachedScan();
    }

    interface Env {
        long now();
        void emit(String eventId, long tsDevice, JSONObject payload);
    }

    interface Store {
        PlaceModel load();
        void save(PlaceModel model);
    }

    interface Log {
        void w(String message);
    }

    static final class Core {
        private final WifiSource wifi;
        private final PlaceHasher.MacFn mac;
        private final Env env;
        private final Store store;
        private final Log log;

        Core(WifiSource wifi, PlaceHasher.MacFn mac, Env env, Store store, Log log) {
            this.wifi = wifi;
            this.mac = mac;
            this.env = env;
            this.store = store;
            this.log = log;
        }

        /** The hashed fingerprint for this tick. Placeholder and locally administered BSSIDs are dropped. */
        PlaceModel.Observation observe() {
            String connected = PlaceHasher.hash(mac, wifi.connectedBssid());
            List<Ap> fresh = new ArrayList<>();
            for (Ap ap : wifi.cachedScan()) {
                if (ap.ageMs <= MAX_SCAN_AGE_MS && PlaceHasher.usableBssid(ap.bssid)) fresh.add(ap);
            }
            Collections.sort(fresh, new Comparator<Ap>() {
                @Override public int compare(Ap a, Ap b) {
                    return b.rssi != a.rssi ? Integer.compare(b.rssi, a.rssi) : a.bssid.compareTo(b.bssid);
                }
            });
            Set<String> aps = new LinkedHashSet<>();
            for (Ap ap : fresh) {
                if (aps.size() >= MAX_APS) break;
                aps.add(PlaceHasher.hash(mac, ap.bssid));
            }
            return new PlaceModel.Observation(connected, aps);
        }

        void tick() {
            try {
                long now = env.now();
                long end = now - Math.floorMod(now, WINDOW_MS);
                PlaceModel model = store.load();
                PlaceModel.Result r = model.tick(observe(), now);
                store.save(model);

                for (PlaceModel.Event e : r.events) {
                    env.emit("pe-" + e.ts + "-" + e.placeId, e.ts, eventPayload(e));
                }
                env.emit("pw-" + end, end, windowPayload(end - WINDOW_MS, end, r));
            } catch (Exception e) {
                log.w("place tick failed: " + e.getClass().getSimpleName());
            }
        }

        static JSONObject windowPayload(long start, long end, PlaceModel.Result r) throws Exception {
            JSONObject p = new JSONObject();
            p.put("type", "place_window");
            p.put("window_start", start);
            p.put("window_end", end);
            p.put("place_id", r.placeId == null ? "unknown" : r.placeId);
            p.put("label", r.placeId == null ? "unknown" : r.label);
            p.put("dwell_ms", r.dwellMs);
            p.put("conf", Math.round(r.conf * 100.0) / 100.0);
            p.put("src", r.src);
            return p;
        }

        static JSONObject eventPayload(PlaceModel.Event e) throws Exception {
            JSONObject p = new JSONObject();
            p.put("type", "place_event");
            p.put("event", e.type);
            p.put("place_id", e.placeId);
            p.put("label", e.label);
            p.put("ts", e.ts);
            return p;
        }
    }

    // ---- store (phone-only; holds hashes, never sent) ----

    /** Place model persistence. Reads and writes are serialized so a label change is not lost to a tick. */
    static final class PrefsStore implements Store {
        private static final String PREFS = "place_model_prefs";
        private static final String KEY = "model";
        private static final Object LOCK = new Object();
        private static final SecureRandom RNG = new SecureRandom();

        private final Context ctx;

        PrefsStore(Context ctx) {
            this.ctx = ctx.getApplicationContext();
        }

        private SharedPreferences prefs() {
            return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        }

        static PlaceModel.Ids ids() {
            return new PlaceModel.Ids() {
                @Override public String next() {
                    byte[] b = new byte[5];
                    RNG.nextBytes(b);
                    return "pl_" + PlaceHasher.base32(b).substring(0, 8);
                }
            };
        }

        @Override public PlaceModel load() {
            synchronized (LOCK) {
                try {
                    String raw = prefs().getString(KEY, null);
                    if (raw != null) return PlaceModel.fromJson(new JSONObject(raw), ids());
                } catch (Exception ignored) {
                    // corrupt model: start empty rather than crash the service
                }
                return new PlaceModel(ids());
            }
        }

        @Override public void save(PlaceModel model) {
            synchronized (LOCK) {
                try {
                    prefs().edit().putString(KEY, model.toJson().toString()).commit();
                } catch (Exception ignored) {
                    // keep the old model
                }
            }
        }

        /** Applies a change to the stored model under the same lock the sampler uses. */
        boolean update(java.util.function.Function<PlaceModel, Boolean> change) {
            synchronized (LOCK) {
                PlaceModel m = load();
                boolean changed = change.apply(m);
                if (changed) save(m);
                return changed;
            }
        }

        /** "Forget places": erase the model and the hashing key (crypto-shred). */
        void forget() {
            synchronized (LOCK) {
                prefs().edit().clear().commit();
                PlaceHasher.deleteKey();
            }
        }
    }

    // ---- Android wiring ----

    private static final Object LOCK = new Object();
    private static Core core;
    private static HandlerThread thread;
    private static Handler handler;

    private PlaceSampler() {}

    static void start(Context ctx) {
        onConsentChanged(ctx);
    }

    static void stop() {
        synchronized (LOCK) {
            stopLocked();
        }
    }

    /** Starts when `places` is on and the service is bound; stops in the same main-looper turn when it is off. */
    static void onConsentChanged(Context ctx) {
        Context app = ctx.getApplicationContext();
        synchronized (LOCK) {
            boolean want = SensorConsentPlugin.isEnabled(app, SensorCapabilities.KEY_PLACES)
                && PiecesAccessibilityService.isRunning
                && app.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION)
                    == android.content.pm.PackageManager.PERMISSION_GRANTED;
            if (!want) {
                stopLocked();
                return;
            }
            if (core != null) return;
            try {
                core = new Core(new AndroidWifi(app), PlaceHasher.keystore(), new AndroidEnv(app), new PrefsStore(app), new AndroidLog());
            } catch (Exception e) {
                android.util.Log.w("PlaceSampler", "keystore unavailable: " + e.getClass().getSimpleName());
                return;
            }
            thread = new HandlerThread("place-sampler");
            thread.start();
            handler = new Handler(thread.getLooper());
            scheduleNext();
        }
    }

    /** Next tick just after the next 5-minute grid boundary, so windows line up with the other 5-minute events. */
    private static void scheduleNext() {
        long now = System.currentTimeMillis();
        long delay = WINDOW_MS - Math.floorMod(now, WINDOW_MS) + 5_000L;
        handler.postDelayed(TICK, delay);
    }

    private static final Runnable TICK = new Runnable() {
        @Override public void run() {
            Core c;
            synchronized (LOCK) {
                c = core;
            }
            if (c == null) return;
            c.tick();
            synchronized (LOCK) {
                if (core == c && handler != null) scheduleNext();
            }
        }
    };

    private static void stopLocked() {
        core = null;
        if (handler != null) handler.removeCallbacksAndMessages(null);
        if (thread != null) thread.quitSafely();
        thread = null;
        handler = null;
    }

    private static final class AndroidLog implements Log {
        @Override public void w(String message) {
            android.util.Log.w("PlaceSampler", message);
        }
    }

    private static final class AndroidEnv implements Env {
        private final Context ctx;

        AndroidEnv(Context ctx) {
            this.ctx = ctx;
        }

        @Override public long now() {
            return System.currentTimeMillis();
        }

        @Override public void emit(String eventId, long tsDevice, JSONObject payload) {
            if (!SensorConsentPlugin.isEnabled(ctx, SensorCapabilities.KEY_PLACES)) return; // revoked mid-tick
            NativeTelemetrySync.queueV3Event(ctx, eventId, tsDevice, payload);
        }
    }

    @SuppressWarnings("deprecation")
    private static final class AndroidWifi implements WifiSource {
        private final WifiManager wm;

        AndroidWifi(Context ctx) {
            this.wm = (WifiManager) ctx.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        }

        // getConnectionInfo is deprecated but still returns the BSSID to a location-permitted app. Whether it works
        // from the service with another app on top is phone spike S4-1; a placeholder BSSID is rejected downstream.
        @Override public String connectedBssid() {
            try {
                WifiInfo info = wm == null ? null : wm.getConnectionInfo();
                return info == null ? null : info.getBSSID();
            } catch (SecurityException e) {
                return null;
            }
        }

        @Override public List<Ap> cachedScan() {
            List<Ap> out = new ArrayList<>();
            try {
                List<ScanResult> results = wm == null ? null : wm.getScanResults();
                if (results == null) return out;
                long nowUs = SystemClock.elapsedRealtime() * 1000L;
                for (ScanResult r : results) {
                    long ageMs = Math.max(0L, (nowUs - r.timestamp) / 1000L);
                    out.add(new Ap(r.BSSID, r.level, ageMs));
                }
            } catch (SecurityException ignored) {
                // no location permission: empty scan reads as "unknown"
            }
            return out;
        }
    }
}
