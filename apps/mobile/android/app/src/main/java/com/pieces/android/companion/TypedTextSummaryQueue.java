package com.pieces.android.companion;

import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.PowerManager;
import android.os.Process;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Deque;

/**
 * Bounded background queue and worker for summarizing typed text (A5-1 Section 4.5).
 * Max 4 items in memory; oldest evicted when 5th arrives; zero-filled after inference or drop.
 */
final class TypedTextSummaryQueue {
    static final int CAPACITY = 4;
    static final long MAX_AGE_MS = 120_000L;
    static final long TIMEOUT_MS = 30_000L;

    interface HardwareCheck {
        boolean isLocked();
        boolean isLowBattery();
        boolean isThermalThrottled();
    }

    interface Dispatcher {
        void dispatch(Runnable r);
    }

    static final class QueueItem {
        final String appCategory;
        final char[] textChars;
        final long enqueueTime;
        final int generation;

        QueueItem(String appCategory, char[] textChars, long enqueueTime, int generation) {
            this.appCategory = appCategory != null ? appCategory : "other";
            this.textChars = textChars;
            this.enqueueTime = enqueueTime;
            this.generation = generation;
        }

        void zeroFill() {
            if (textChars != null) {
                Arrays.fill(textChars, '\0');
            }
        }
    }

    private static TypedTextSummaryQueue sInstance;

    static synchronized TypedTextSummaryQueue getInstance() {
        if (sInstance == null) {
            sInstance = new TypedTextSummaryQueue();
        }
        return sInstance;
    }

    static synchronized void clear() {
        if (sInstance != null) {
            sInstance.clearQueue();
        }
    }

    private final Deque<QueueItem> queue = new ArrayDeque<>(CAPACITY);
    private HandlerThread workerThread;
    private Handler workerHandler;
    private Dispatcher dispatcher;
    private Context context;
    private volatile Summarizer summarizer;
    private final Object summarizerLock = new Object();
    private volatile QueueItem activeItem;
    private HardwareCheck hardwareCheck;
    private SummaryStore store;

    TypedTextSummaryQueue() {
        initWorkerThread();
        this.dispatcher = r -> {
            if (workerHandler != null) {
                workerHandler.post(r);
            }
        };
    }

    // Constructor for testing
    TypedTextSummaryQueue(Summarizer summarizer, HardwareCheck hardwareCheck, SummaryStore store) {
        this(summarizer, hardwareCheck, store, Runnable::run);
    }

    TypedTextSummaryQueue(Summarizer summarizer, HardwareCheck hardwareCheck, SummaryStore store, Dispatcher dispatcher) {
        this.summarizer = summarizer;
        this.hardwareCheck = hardwareCheck;
        this.store = store;
        this.dispatcher = dispatcher != null ? dispatcher : Runnable::run;
    }

    private synchronized void initWorkerThread() {
        if (workerThread == null) {
            workerThread = new HandlerThread("typed-summary", Process.THREAD_PRIORITY_BACKGROUND);
            workerThread.start();
            workerHandler = new Handler(workerThread.getLooper());
        }
    }

    synchronized void init(Context ctx, Summarizer s, SummaryStore st) {
        this.context = ctx != null ? ctx.getApplicationContext() : null;
        if (s != null) this.summarizer = s;
        if (st != null) this.store = st;
        if (this.hardwareCheck == null && context != null) {
            this.hardwareCheck = new DefaultHardwareCheck(context);
        }
    }

    void setSummarizer(Summarizer s) {
        synchronized (summarizerLock) {
            this.summarizer = s;
        }
    }

    void releaseSummarizer() {
        synchronized (summarizerLock) {
            if (summarizer != null) {
                try {
                    summarizer.release();
                } catch (Exception ignored) {}
                summarizer = null;
            }
        }
    }

    synchronized void enqueue(String appCategory, char[] textChars, long timestamp) {
        if (textChars == null || textChars.length == 0) return;

        TypedTextCounters.bump("flushed");

        // If at capacity, drop oldest with queue_full
        if (queue.size() >= CAPACITY) {
            QueueItem oldest = queue.pollFirst();
            if (oldest != null) {
                oldest.zeroFill();
                TypedTextCounters.bumpDropped("queue_full");
            }
        }

        QueueItem item = new QueueItem(appCategory, textChars, timestamp, TypedTextGate.getGeneration());
        queue.addLast(item);

        if (dispatcher != null) {
            dispatcher.dispatch(this::processNext);
        }
    }

    private void processNext() {
        QueueItem item;
        synchronized (this) {
            item = queue.pollFirst();
            activeItem = item;
        }
        if (item == null) return;

        try {
            long now = System.currentTimeMillis();

            // 1. Max age check
            if (now - item.enqueueTime > MAX_AGE_MS) {
                TypedTextCounters.bumpDropped("stale");
                return;
            }

            // 2. Gate / generation check
            if (!TypedTextGate.isOn() || item.generation != TypedTextGate.getGeneration()) {
                TypedTextCounters.bumpDropped("gate_off");
                return;
            }

            // 3. Hardware gates
            if (hardwareCheck != null) {
                if (hardwareCheck.isLocked()) {
                    TypedTextCounters.bumpDropped("locked");
                    return;
                }
                if (hardwareCheck.isLowBattery()) {
                    TypedTextCounters.bumpDropped("battery");
                    return;
                }
                if (hardwareCheck.isThermalThrottled()) {
                    TypedTextCounters.bumpDropped("thermal");
                    return;
                }
            }

            // 4. Summarizer availability & serialized inference execution
            String prompt = SummaryPrompt.build(item.appCategory, item.textChars);
            String modelOutput;
            synchronized (summarizerLock) {
                if (summarizer == null || !summarizer.isReady() || !TypedTextGate.isOn() || item.generation != TypedTextGate.getGeneration()) {
                    TypedTextCounters.bumpDropped("summarizer_unavailable");
                    return;
                }
                try {
                    modelOutput = summarizer.summarize(prompt, TIMEOUT_MS);
                } catch (SummarizerException se) {
                    TypedTextCounters.bumpDropped(se.reason != null ? se.reason.name() : "FAILED");
                    return;
                } catch (Throwable t) {
                    TypedTextCounters.bumpDropped("FAILED");
                    return;
                }
            }

            // Check generation again after inference before running guard
            if (!TypedTextGate.isOn() || item.generation != TypedTextGate.getGeneration()) {
                TypedTextCounters.bumpDropped("gate_off");
                return;
            }

            // 5. Guard check
            SummaryGuard.GuardResult guardResult = SummaryGuard.check(modelOutput, item.textChars);
            if (!guardResult.isOk) {
                TypedTextCounters.bumpDropped(guardResult.rejectReason != null ? guardResult.rejectReason : "guard_error");
                return;
            }

            SummaryGuard.Summary summary = guardResult.summary;
            if (summary.strippedReason != null) {
                TypedTextCounters.bumpStripped(summary.strippedReason);
            }

            // 6. Store summary under COMMIT_LOCK barrier
            synchronized (TypedTextGate.COMMIT_LOCK) {
                if (!TypedTextGate.isOn() || item.generation != TypedTextGate.getGeneration()) {
                    TypedTextCounters.bumpDropped("gate_off");
                    return;
                }
                if (store != null) {
                    boolean saved = store.saveSummary(item.appCategory, "typed", summary);
                    if (saved) {
                        TypedTextCounters.bump("stored");
                    } else {
                        TypedTextCounters.bumpDropped("store_error");
                    }
                } else {
                    // If store is null (e.g. in unit tests), count as stored
                    TypedTextCounters.bump("stored");
                }
            }

        } finally {
            item.zeroFill();
            synchronized (this) {
                if (activeItem == item) {
                    activeItem = null;
                }
            }
        }
    }

    synchronized void clearQueue() {
        for (QueueItem item : queue) {
            item.zeroFill();
        }
        queue.clear();
        QueueItem active = activeItem;
        if (active != null) {
            active.zeroFill();
        }
        if (workerHandler != null) {
            workerHandler.removeCallbacksAndMessages(null);
        }
    }

    synchronized int queueSize() {
        return queue.size();
    }

    private static class DefaultHardwareCheck implements HardwareCheck {
        private final Context ctx;

        DefaultHardwareCheck(Context ctx) {
            this.ctx = ctx;
        }

        @Override
        public boolean isLocked() {
            try {
                KeyguardManager km = (KeyguardManager) ctx.getSystemService(Context.KEYGUARD_SERVICE);
                return km != null && km.isKeyguardLocked();
            } catch (Exception e) {
                return false;
            }
        }

        @Override
        public boolean isLowBattery() {
            try {
                IntentFilter ifilter = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
                Intent b = ctx.registerReceiver(null, ifilter);
                if (b == null) return false;
                int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
                int scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
                int status = b.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
                boolean isCharging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                                     status == BatteryManager.BATTERY_STATUS_FULL;
                if (scale > 0) {
                    float pct = (level * 100f) / scale;
                    return pct < 15f && !isCharging;
                }
            } catch (Exception ignored) {}
            return false;
        }

        @Override
        public boolean isThermalThrottled() {
            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
                    return pm != null && pm.getCurrentThermalStatus() >= PowerManager.THERMAL_STATUS_MODERATE;
                }
            } catch (Exception ignored) {}
            return false;
        }
    }
}
