package com.pieces.android.companion;

import android.app.AppOpsManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.util.Log;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Turns Android's app-usage events into telemetry.
 *
 * 1. One compact summary per sync window (legacy route): NativeTelemetrySync.queueAppTransitions() with package
 *    "android.usage". The text lists only app labels, foreground time and open counts; no screen content.
 * 2. One v3 event per foreground arrival and per screen/keyguard state change (queueArrivalsIfDue), only while the
 *    "app_switches" consent toggle is on.
 *
 * Privacy-excluded apps (AccessibilityPlugin.isPrivacyExcluded) are never named by either path. Both do nothing
 * unless Usage Access is granted.
 */
final class UsageSummary {
    private static final String TAG = "UsageSummary";
    private static final String PREFS = "usage_summary";
    private static final String KEY_LAST = "last_end_ms";
    private static final long MIN_GAP_MS = 14L * 60_000L; // job runs every ~15 minutes
    private static final long MAX_LOOKBACK_MS = 6L * 60L * 60_000L;
    private static final long MIN_APP_MS = 20_000L;
    private static final int MAX_APPS = 12;

    private UsageSummary() {}

    static boolean hasUsageAccess(Context ctx) {
        AppOpsManager appOps = (AppOpsManager) ctx.getSystemService(Context.APP_OPS_SERVICE);
        return appOps != null
            && appOps.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, android.os.Process.myUid(), ctx.getPackageName())
                == AppOpsManager.MODE_ALLOWED;
    }

    // ---- Foreground arrivals: one v3 event per app arrival (ANDROID_SENSOR_SPEC_2026-10-29.md section A3) ----

    private static final String KEY_ARR_TS = "last_arrival_ts";
    private static final String KEY_ARR_PKG = "last_pkg";
    private static final String KEY_ARR_PKG_TS = "last_arrival_pkg_ts";
    private static final String KEY_ARR_RUN = "arrivals_last_run_ms";
    private static final long ARRIVALS_MIN_GAP_MS = 60_000L;
    private static final long ARRIVALS_FIRST_LOOKBACK_MS = 15L * 60_000L;
    static final int MAX_ARRIVALS_PER_CALL = 500;
    // UsageEvents.Event.MOVE_TO_FOREGROUND and SCREEN_INTERACTIVE..KEYGUARD_HIDDEN (the latter are API 28+; plain
    // literals keep minSdk 26 code valid, and older devices simply never report those types).
    static final int EV_FOREGROUND = 1;
    static final int EV_SCREEN_INTERACTIVE = 15;
    static final int EV_SCREEN_NON_INTERACTIVE = 16;
    static final int EV_KEYGUARD_SHOWN = 17;
    static final int EV_KEYGUARD_HIDDEN = 18;

    /** A UsageEvents entry reduced to what the arrival logic needs. */
    static final class RawEvent {
        final String pkg;
        final int type;
        final long ts;
        RawEvent(String pkg, int type, long ts) {
            this.pkg = pkg;
            this.type = type;
            this.ts = ts;
        }
    }

    /** Package metadata lookup; a seam so the arrival logic runs without a PackageManager. */
    interface AppInfo {
        String label(String pkg);
        String category(String pkg);
    }

    /** Cursor persisted between calls. Re-querying (cursor, now] never re-emits or alters an event. */
    static final class ArrivalState {
        long lastArrivalTs = 0L;
        String lastPkg = null;
        long lastArrivalPkgTs = 0L;
    }

    static final class Emitted {
        final String eventId;
        final long ts;
        final JSONObject payload;
        Emitted(String eventId, long ts, JSONObject payload) {
            this.eventId = eventId;
            this.ts = ts;
            this.payload = payload;
        }
    }

    static final class ArrivalResult {
        final List<Emitted> events = new ArrayList<>();
        int dropped = 0;
    }

    /**
     * Pure: turns time-ordered UsageEvents into app_foreground / screen_session events and advances `st`.
     * A privacy-excluded app is emitted only as category "excluded", with no package and no label, on both the `to`
     * and `from` ends. Noise apps (launcher, system UI...) map to category home/system and keep their package.
     */
    static ArrivalResult buildArrivals(List<RawEvent> raw, ArrivalState st, AppInfo info) {
        ArrivalResult out = new ArrivalResult();
        for (RawEvent ev : raw) {
            if (ev.ts <= st.lastArrivalTs) continue; // strictly after the cursor
            try {
                if (ev.type == EV_FOREGROUND) {
                    if (ev.pkg == null || ev.pkg.equals(st.lastPkg)) {
                        st.lastArrivalTs = ev.ts;
                        continue;
                    }
                    out.events.add(arrival(ev, st, info));
                    st.lastPkg = ev.pkg;
                    st.lastArrivalPkgTs = ev.ts;
                } else if (ev.type >= EV_SCREEN_INTERACTIVE && ev.type <= EV_KEYGUARD_HIDDEN) {
                    String state = ev.type == EV_SCREEN_INTERACTIVE ? "interactive"
                        : ev.type == EV_SCREEN_NON_INTERACTIVE ? "non_interactive"
                        : ev.type == EV_KEYGUARD_SHOWN ? "keyguard_shown" : "keyguard_hidden";
                    JSONObject p = new JSONObject();
                    p.put("type", "screen_session");
                    p.put("state", state);
                    p.put("src", "usage_stats");
                    out.events.add(new Emitted("ss-" + ev.ts + "-" + state, ev.ts, p));
                }
            } catch (Exception ignored) {}
            st.lastArrivalTs = ev.ts;
        }
        while (out.events.size() > MAX_ARRIVALS_PER_CALL) { // oldest dropped, counted
            out.events.remove(0);
            out.dropped++;
        }
        return out;
    }

    private static Emitted arrival(RawEvent ev, ArrivalState st, AppInfo info) throws Exception {
        String pkg = ev.pkg;
        String label = info.label(pkg);
        boolean excluded = AccessibilityPlugin.isPrivacyExcluded(pkg, label);
        JSONObject p = new JSONObject();
        p.put("type", "app_foreground");
        p.put("event", "APP_TRANSITION");
        if (excluded) {
            p.put("category", "excluded");
        } else {
            p.put("to", pkg);
            p.put("category", AccessibilityPlugin.isNoise(pkg) ? AccessibilityPlugin.noiseCategory(pkg) : info.category(pkg));
            p.put("app_label", label);
        }
        if (st.lastPkg != null) {
            if (AccessibilityPlugin.isPrivacyExcluded(st.lastPkg, info.label(st.lastPkg))) {
                p.put("from_category", "excluded");
            } else {
                p.put("from", st.lastPkg);
                p.put("from_category", AccessibilityPlugin.isNoise(st.lastPkg)
                    ? AccessibilityPlugin.noiseCategory(st.lastPkg) : info.category(st.lastPkg));
            }
            p.put("dwell_prev_ms", Math.max(0L, ev.ts - st.lastArrivalPkgTs));
        }
        p.put("excluded", excluded);
        p.put("src", "usage_stats");
        // Excluded apps hash a constant so the id cannot be dictionary-matched back to a package.
        String idKey = excluded ? "excluded" : pkg;
        return new Emitted("fg-" + ev.ts + "-" + NativeTelemetrySync.sha1Hex(idKey + "|x").substring(0, 8), ev.ts, p);
    }

    /**
     * Queues arrival and screen-session events since the last call, at most once a minute. Does nothing unless the
     * master and "app_switches" consent toggles are on and Usage Access is granted. The cursor only advances past
     * events that were processed, and re-processing is idempotent (deterministic ids and payloads).
     */
    static synchronized void queueArrivalsIfDue(Context ctx) {
        try {
            if (!SensorConsentPlugin.isEnabled(ctx, SensorCapabilities.KEY_APP_SWITCHES)) return;
            if (!hasUsageAccess(ctx)) return;
            SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            long now = System.currentTimeMillis();
            if (now - prefs.getLong(KEY_ARR_RUN, 0L) < ARRIVALS_MIN_GAP_MS) return;
            UsageStatsManager usm = (UsageStatsManager) ctx.getSystemService(Context.USAGE_STATS_SERVICE);
            if (usm == null) return;

            ArrivalState st = new ArrivalState();
            st.lastArrivalTs = prefs.getLong(KEY_ARR_TS, 0L);
            st.lastPkg = prefs.getString(KEY_ARR_PKG, null);
            st.lastArrivalPkgTs = prefs.getLong(KEY_ARR_PKG_TS, 0L);
            long start = st.lastArrivalTs == 0L ? now - ARRIVALS_FIRST_LOOKBACK_MS
                : Math.max(st.lastArrivalTs + 1L, now - MAX_LOOKBACK_MS);

            List<RawEvent> raw = new ArrayList<>();
            UsageEvents events = usm.queryEvents(start, now);
            UsageEvents.Event ev = new UsageEvents.Event();
            while (events.hasNextEvent()) {
                events.getNextEvent(ev);
                raw.add(new RawEvent(ev.getPackageName(), ev.getEventType(), ev.getTimeStamp()));
            }
            final PackageManager pm = ctx.getPackageManager();
            final Map<String, String> labels = new HashMap<>();
            ArrivalResult res = buildArrivals(raw, st, new AppInfo() {
                @Override public String label(String pkg) {
                    String l = labels.get(pkg);
                    if (l == null) {
                        l = UsageSummary.label(pm, pkg);
                        labels.put(pkg, l);
                    }
                    return l;
                }
                @Override public String category(String pkg) {
                    try {
                        return AccessibilityPlugin.categoryLabel(pm.getApplicationInfo(pkg, 0).category);
                    } catch (PackageManager.NameNotFoundException e) {
                        return "Uncategorized";
                    }
                }
            });
            for (Emitted e : res.events) {
                NativeTelemetrySync.queueV3Event(ctx, e.eventId, e.ts, e.payload);
            }
            if (res.dropped > 0) Log.w(TAG, "Dropped " + res.dropped + " oldest arrivals over the per-call cap");
            prefs.edit()
                .putLong(KEY_ARR_TS, st.lastArrivalTs)
                .putString(KEY_ARR_PKG, st.lastPkg)
                .putLong(KEY_ARR_PKG_TS, st.lastArrivalPkgTs)
                .putLong(KEY_ARR_RUN, now)
                .apply();
        } catch (Exception e) {
            Log.e(TAG, "queueArrivalsIfDue failed", e);
        }
    }

    // ---- Legacy per-window summary ----

    /** Called from the periodic sync job. Queues a summary for the time since the last one, at most every ~14 minutes. */
    static void queueIfDue(Context ctx) {
        queueArrivalsIfDue(ctx);
        try {
            SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            long now = System.currentTimeMillis();
            long last = prefs.getLong(KEY_LAST, 0L);
            if (last != 0L && now - last < MIN_GAP_MS) return;
            long start = last == 0L ? now - 15L * 60_000L : Math.max(last, now - MAX_LOOKBACK_MS);
            queue(ctx, start, now, prefs);
        } catch (Exception e) {
            Log.e(TAG, "queueIfDue failed", e);
        }
    }

    /** Test/diagnostic entry point: summarise the last `minutes` minutes now. Returns "queued" or a reason. */
    static String queueNow(Context ctx, int minutes) {
        try {
            long now = System.currentTimeMillis();
            return queue(ctx, now - minutes * 60_000L, now, ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE));
        } catch (Exception e) {
            Log.e(TAG, "queueNow failed", e);
            return "error";
        }
    }

    private static String queue(Context ctx, long start, long end, SharedPreferences prefs) {
        if (!hasUsageAccess(ctx)) return "no-usage-access";
        UsageStatsManager usm = (UsageStatsManager) ctx.getSystemService(Context.USAGE_STATS_SERVICE);
        if (usm == null) return "unavailable";

        PackageManager pm = ctx.getPackageManager();
        Map<String, Long> resumedAt = new HashMap<>();
        Map<String, Long> millis = new HashMap<>();
        Map<String, Integer> opens = new HashMap<>();
        int switches = 0;
        String lastPkg = null;
        long lastResumedAt = 0L;
        List<JSONObject> recentTransitions = new ArrayList<>();

        UsageEvents events = usm.queryEvents(start, end);
        UsageEvents.Event ev = new UsageEvents.Event();
        while (events.hasNextEvent()) {
            events.getNextEvent(ev);
            String pkg = ev.getPackageName();
            if (pkg == null) continue;
            int type = ev.getEventType();
            if (type == UsageEvents.Event.MOVE_TO_FOREGROUND) {
                if (!resumedAt.containsKey(pkg)) {
                    long nowTs = ev.getTimeStamp();
                    resumedAt.put(pkg, nowTs);
                    opens.put(pkg, (opens.containsKey(pkg) ? opens.get(pkg) : 0) + 1);
                    if (lastPkg != null && !lastPkg.equals(pkg) && !lastPkg.equals(ctx.getPackageName()) && !pkg.equals(ctx.getPackageName())) {
                        switches++;
                        long dwellMs = lastResumedAt > 0L ? Math.max(0L, nowTs - lastResumedAt) : 0L;
                        // A privacy-excluded app still counts as a switch but is never named in the transitions.
                        boolean hidden = AccessibilityPlugin.isPrivacyExcluded(lastPkg, label(pm, lastPkg))
                            || AccessibilityPlugin.isPrivacyExcluded(pkg, label(pm, pkg));
                        if (!hidden) {
                            try {
                                JSONObject tr = new JSONObject();
                                tr.put("from", lastPkg);
                                tr.put("to", pkg);
                                tr.put("dwell_ms", dwellMs);
                                tr.put("ts", nowTs);
                                Calendar cal = Calendar.getInstance();
                                cal.setTimeInMillis(nowTs);
                                tr.put("hour", cal.get(Calendar.HOUR_OF_DAY));
                                recentTransitions.add(tr);
                                if (recentTransitions.size() > 30) {
                                    recentTransitions.remove(0);
                                }
                            } catch (Exception ignored) {}
                        }
                    }
                    lastPkg = pkg;
                    lastResumedAt = nowTs;
                }
            } else if (type == UsageEvents.Event.MOVE_TO_BACKGROUND) {
                Long from = resumedAt.remove(pkg);
                if (from != null && ev.getTimeStamp() >= from) {
                    millis.put(pkg, (millis.containsKey(pkg) ? millis.get(pkg) : 0L) + (ev.getTimeStamp() - from));
                }
            }
        }
        for (Map.Entry<String, Long> open : resumedAt.entrySet()) { // still in the foreground at the window end
            String pkg = open.getKey();
            millis.put(pkg, (millis.containsKey(pkg) ? millis.get(pkg) : 0L) + Math.max(0L, end - open.getValue()));
        }

        List<Map.Entry<String, Long>> ranked = new ArrayList<>();
        for (Map.Entry<String, Long> e : millis.entrySet()) {
            if (e.getValue() >= MIN_APP_MS && !e.getKey().equals(ctx.getPackageName())
                && !AccessibilityPlugin.isPrivacyExcluded(e.getKey(), label(pm, e.getKey()))) {
                ranked.add(e);
            }
        }
        Collections.sort(ranked, (a, b) -> Long.compare(b.getValue(), a.getValue()));
        // Advance the window even when nothing was used, so idle stretches are not re-scanned.
        prefs.edit().putLong(KEY_LAST, end).apply();
        if (ranked.isEmpty()) return "idle";

        SimpleDateFormat hm = new SimpleDateFormat("HH:mm", Locale.US);
        hm.setTimeZone(TimeZone.getDefault());
        StringBuilder sb = new StringBuilder();
        sb.append("App usage ").append(hm.format(new Date(start))).append("-").append(hm.format(new Date(end)))
            .append(" (").append(switches).append(" app switches)\n");
        long total = 0L;
        for (int i = 0; i < ranked.size() && i < MAX_APPS; i++) {
            Map.Entry<String, Long> e = ranked.get(i);
            total += e.getValue();
            sb.append("- ").append(label(pm, e.getKey())).append(": ").append(fmt(e.getValue()))
                .append(", ").append(opens.containsKey(e.getKey()) ? opens.get(e.getKey()) : 1).append(" opens\n");
        }
        sb.append("Total foreground ").append(fmt(total));
        JSONArray transitions = new JSONArray();
        for (JSONObject tr : recentTransitions) {
            transitions.put(tr);
        }
        NativeTelemetrySync.queueAppTransitions(ctx, transitions, sb.toString(), switches);
        return "queued";
    }

    private static String label(PackageManager pm, String pkg) {
        try {
            ApplicationInfo info = pm.getApplicationInfo(pkg, 0);
            CharSequence l = pm.getApplicationLabel(info);
            return l != null ? l.toString() : pkg;
        } catch (PackageManager.NameNotFoundException e) {
            return pkg;
        }
    }

    private static String fmt(long ms) {
        long s = ms / 1000L;
        return s >= 60 ? (s / 60) + "m " + (s % 60) + "s" : s + "s";
    }
}
