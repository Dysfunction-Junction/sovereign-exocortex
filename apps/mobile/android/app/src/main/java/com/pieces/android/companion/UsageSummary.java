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
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

/**
 * Turns Android's app-usage events into one compact telemetry event per sync window.
 *
 * Output goes through NativeTelemetrySync.queueScreenCapture() with package "android.usage", so it rides the same
 * durable outbox and reaches the daemon as a normal system_telemetry event. The text lists only app labels, foreground
 * time and open counts; no screen content. It does nothing unless Usage Access is granted.
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

    /** Called from the periodic sync job. Queues a summary for the time since the last one, at most every ~14 minutes. */
    static void queueIfDue(Context ctx) {
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

        Map<String, Long> resumedAt = new HashMap<>();
        Map<String, Long> millis = new HashMap<>();
        Map<String, Integer> opens = new HashMap<>();
        int switches = 0;
        String lastPkg = null;

        UsageEvents events = usm.queryEvents(start, end);
        UsageEvents.Event ev = new UsageEvents.Event();
        while (events.hasNextEvent()) {
            events.getNextEvent(ev);
            String pkg = ev.getPackageName();
            if (pkg == null) continue;
            int type = ev.getEventType();
            if (type == UsageEvents.Event.MOVE_TO_FOREGROUND) {
                if (!resumedAt.containsKey(pkg)) {
                    resumedAt.put(pkg, ev.getTimeStamp());
                    opens.put(pkg, (opens.containsKey(pkg) ? opens.get(pkg) : 0) + 1);
                    if (lastPkg != null && !lastPkg.equals(pkg)) switches++;
                    lastPkg = pkg;
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
            if (e.getValue() >= MIN_APP_MS && !e.getKey().equals(ctx.getPackageName())) ranked.add(e);
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
        PackageManager pm = ctx.getPackageManager();
        for (int i = 0; i < ranked.size() && i < MAX_APPS; i++) {
            Map.Entry<String, Long> e = ranked.get(i);
            total += e.getValue();
            sb.append("- ").append(label(pm, e.getKey())).append(": ").append(fmt(e.getValue()))
                .append(", ").append(opens.containsKey(e.getKey()) ? opens.get(e.getKey()) : 1).append(" opens\n");
        }
        sb.append("Total foreground ").append(fmt(total));
        NativeTelemetrySync.queueScreenCapture(ctx, "android.usage", "App usage summary", sb.toString());
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
