package com.pieces.android.companion;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Kill switch and generation barrier for typed-text capture (A5-1 Section 4.2).
 */
final class TypedTextGate {
    private static final String PREFS_NAME = "sensor_consent_prefs";
    private static final String KEY_TYPED_TEXT = "typed_text";

    static volatile boolean on = false;
    static volatile int generation = 0;
    static final Object COMMIT_LOCK = new Object();

    private TypedTextGate() {}

    static void init(Context ctx) {
        if (ctx == null) return;
        on = SensorConsentPlugin.isTypedTextOn(ctx);
    }

    static boolean isOn() {
        return on;
    }

    static int getGeneration() {
        return generation;
    }

    static void turnOn(Context ctx) {
        synchronized (COMMIT_LOCK) {
            on = true;
            generation++;
            if (ctx != null) {
                SharedPreferences prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                prefs.edit().putBoolean(KEY_TYPED_TEXT, true).commit();
                TypedTextCapture.onConsentChanged(ctx);
            }
        }
    }

    /**
     * Executes the strict kill switch shutdown sequence in exact order (Section 4.2).
     * Synchronized on COMMIT_LOCK to atomically prevent any pending worker write.
     */
    static void turnOff(Context ctx) {
        synchronized (COMMIT_LOCK) {
            // (1) on = false
            on = false;

            // (2) TypedTextCapture.removeTextEvents
            TypedTextCapture.removeTextEvents();

            // (3) TypedTextBuffer.clearAll() (zero-fill)
            TypedTextBuffer.clearAll();

            // (4) generation++
            generation++;

            // (5) TypedTextSummaryQueue.clear() (zero-fill active & queued items)
            TypedTextSummaryQueue.clear();

            // (6) SummaryStore.zeroFillActiveKek() and TypedTextPlugin.lockAuditSession()
            SummaryStore.zeroFillActiveKek();
            TypedTextPlugin.lockAuditSession();

            // (7) Terminally close the summarizer / engine if present
            if (TypedTextSummaryQueue.getInstance() != null) {
                TypedTextSummaryQueue.getInstance().releaseSummarizer();
            }

            // (8) commit the pref with commit(), not apply()
            if (ctx != null) {
                SharedPreferences prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                prefs.edit().putBoolean(KEY_TYPED_TEXT, false).commit();
                TypedTextCapture.onConsentChanged(ctx);
            }
        }
    }
}
