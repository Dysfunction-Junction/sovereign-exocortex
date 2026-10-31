package com.pieces.android.companion;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;

/**
 * Metric counters for typed text capture (A5-1 Section 9).
 * Preserves privacy: holds integer counts and drop reasons only, zero text, zero package names.
 */
final class TypedTextCounters {
    private static final String PREFS_NAME = "typed_text_counters";
    private static final Map<String, AtomicInteger> COUNTERS = new ConcurrentHashMap<>();
    private static Context sContext;

    private TypedTextCounters() {}

    static synchronized void init(Context context) {
        if (context != null) {
            sContext = context.getApplicationContext();
            loadFromPrefs();
        }
    }

    private static void loadFromPrefs() {
        if (sContext == null) return;
        try {
            SharedPreferences prefs = sContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            for (Map.Entry<String, ?> entry : prefs.getAll().entrySet()) {
                if (entry.getValue() instanceof Integer) {
                    COUNTERS.put(entry.getKey(), new AtomicInteger((Integer) entry.getValue()));
                }
            }
        } catch (Exception ignored) {}
    }

    static void bump(String key) {
        if (key == null || key.isEmpty()) return;
        COUNTERS.computeIfAbsent(key, k -> new AtomicInteger(0)).incrementAndGet();
        persist(key);
    }

    static void bumpDropped(String reason) {
        bump("dropped");
        if (reason != null && !reason.isEmpty()) {
            bump("dropped:" + reason);
        }
    }

    static void bumpStripped(String reason) {
        if (reason != null && !reason.isEmpty()) {
            bump("summary_stripped:" + reason);
        }
    }

    private static void persist(String key) {
        if (sContext == null) return;
        try {
            int val = get(key);
            sContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putInt(key, val)
                .apply();
        } catch (Exception ignored) {}
    }

    static int get(String key) {
        AtomicInteger ai = COUNTERS.get(key);
        return ai != null ? ai.get() : 0;
    }

    static JSONObject getCountersJson() {
        JSONObject root = new JSONObject();
        try {
            root.put("captured", get("captured"));
            root.put("flushed", get("flushed"));
            root.put("stored", get("stored"));
            root.put("dropped", get("dropped"));

            JSONObject droppedMap = new JSONObject();
            JSONObject strippedMap = new JSONObject();

            for (Map.Entry<String, AtomicInteger> entry : COUNTERS.entrySet()) {
                String k = entry.getKey();
                int v = entry.getValue().get();
                if (k.startsWith("dropped:")) {
                    droppedMap.put(k.substring("dropped:".length()), v);
                } else if (k.startsWith("summary_stripped:")) {
                    strippedMap.put(k.substring("summary_stripped:".length()), v);
                } else if (!k.equals("captured") && !k.equals("flushed") && !k.equals("stored") && !k.equals("dropped")) {
                    root.put(k, v);
                }
            }
            root.put("dropped_reasons", droppedMap);
            root.put("stripped_reasons", strippedMap);
        } catch (Exception ignored) {}
        return root;
    }

    static synchronized void resetAll() {
        COUNTERS.clear();
        if (sContext != null) {
            try {
                sContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().clear().apply();
            } catch (Exception ignored) {}
        }
    }
}
