package com.pieces.android.companion;

import android.app.ActivityManager;
import android.content.*;
import android.os.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.util.function.BooleanSupplier;

/** Spike engine; production capture remains model-free until the hardware gates pass. */
public final class LiteRtSummarizer implements Summarizer, AutoCloseable {
    enum State { UNINIT, INITIALIZING, READY, BUSY, RELEASING, CLOSED, WEDGED }
    static final int MAX_TOTAL_TOKENS = 1024, MAX_OUT_TOKENS = 64;
    // Byte fallback is a conservative upper bound; reserve 128 tokens for chat-template framing.
    static final int MAX_PROMPT_BYTES = MAX_TOTAL_TOKENS - MAX_OUT_TOKENS - 128;
    static final long MAX_PSS_BYTES = 1_800_000_000L, MIN_AVAIL_BYTES = 2_200_000_000L;
    static final long DEADLINE_MS = 30_000, IDLE_MS = 60_000;
    interface Environment {
        long now();
        long availableBytes();
        long pssBytes();
        int thermal();
        boolean lowPower();
        boolean mainThread();
    }
    private final Object lock = new Object();
    private final LlmBackend backend;
    private final BooleanSupplier verifyModel;
    private final Environment env;
    private final ThreadPoolExecutor owner = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<>(1), r -> daemon(r, "litertlm-owner"), new ThreadPoolExecutor.AbortPolicy());
    private final ScheduledExecutorService monitor = Executors.newSingleThreadScheduledExecutor(
            r -> daemon(r, "litertlm-monitor"));
    private volatile State state = State.UNINIT;
    private long lastUse, retryAt, backoffMs = 30_000;
    private boolean nativeLoaded;
    private final ComponentCallbacks2 callbacks;
    private final Context context;

    public LiteRtSummarizer(Context context, ModelProvisioner provisioner) {
        this(new LiteRtBridge(() -> provisioner.modelFile().getAbsolutePath(),
                new java.io.File(context.getCacheDir(), "litertlm").getAbsolutePath(), MAX_TOTAL_TOKENS, 0),
                provisioner::verifyForLoad, new AndroidEnvironment(context), context.getApplicationContext());
    }
    LiteRtSummarizer(LlmBackend backend, BooleanSupplier verifyModel, Environment env) {
        this(backend, verifyModel, env, null);
    }
    private LiteRtSummarizer(LlmBackend backend, BooleanSupplier verifyModel, Environment env, Context ctx) {
        this.backend = backend; this.verifyModel = verifyModel; this.env = env; this.context = ctx;
        lastUse = env.now();
        callbacks = new ComponentCallbacks2() {
            public void onTrimMemory(int level) {
                if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) release();
            }
            public void onLowMemory() { release(); }
            public void onConfigurationChanged(android.content.res.Configuration c) { }
        };
        if (ctx != null) ctx.registerComponentCallbacks(callbacks);
        monitor.scheduleWithFixedDelay(this::monitorResources, 100, 100, TimeUnit.MILLISECONDS);
    }
    private static Thread daemon(Runnable r, String name) {
        Thread t = new Thread(r, name); t.setDaemon(true); return t;
    }
    State state() { return state; }
    @Override public boolean isReady() { return state == State.READY; }
    private SummarizerException error(SummarizerException.Reason r) { return new SummarizerException(r); }
    private void terminalCheck() throws SummarizerException {
        if (state == State.CLOSED) throw error(SummarizerException.Reason.CLOSED);
        if (state == State.WEDGED) throw error(SummarizerException.Reason.WEDGED);
    }
    private void resourceCheck() throws SummarizerException {
        if (env.pssBytes() > MAX_PSS_BYTES) {
            release(); throw error(SummarizerException.Reason.OOM);
        }
        int thermal = env.thermal();
        if (thermal >= PowerManager.THERMAL_STATUS_SEVERE) {
            release(); throw error(SummarizerException.Reason.THERMAL);
        }
        if (env.now() < retryAt) throw error(SummarizerException.Reason.THERMAL);
        if (thermal >= PowerManager.THERMAL_STATUS_MODERATE) {
            retryAt = env.now() + backoffMs;
            backoffMs = Math.min(600_000, backoffMs * 2);
            throw error(SummarizerException.Reason.THERMAL);
        }
        backoffMs = 30_000;
        if (env.lowPower()) throw error(SummarizerException.Reason.POWER);
    }
    @Override public String summarize(String prompt, long timeoutMs) throws SummarizerException {
        if (env.mainThread()) throw new IllegalStateException("WORKER_THREAD_REQUIRED");
        Future<String> result;
        CountDownLatch exited = new CountDownLatch(1);
        synchronized (lock) {
            terminalCheck();
            if (prompt == null || prompt.length() > MAX_PROMPT_BYTES
                    || prompt.getBytes(StandardCharsets.UTF_8).length > MAX_PROMPT_BYTES)
                throw error(SummarizerException.Reason.PROMPT_TOO_LONG);
            if (timeoutMs <= 0) throw error(SummarizerException.Reason.TIMEOUT);
            if (state == State.UNINIT) {
                state = State.INITIALIZING;
                owner.execute(this::initialize);
                throw error(SummarizerException.Reason.WARMING);
            }
            if (state == State.INITIALIZING) throw error(SummarizerException.Reason.WARMING);
            resourceCheck();
            if (state != State.READY) throw error(SummarizerException.Reason.BUSY);
            state = State.BUSY;
            // CAS-equivalent admission under lock: concurrent prompts are never queued.
            result = owner.submit(() -> {
                try {
                    synchronized (lock) { terminalCheck(); if (state != State.BUSY) throw error(SummarizerException.Reason.UNAVAILABLE); }
                    String output = backend.generate(prompt, MAX_OUT_TOKENS);
                    synchronized (lock) {
                        terminalCheck(); resourceCheck();
                        if (state != State.BUSY) throw error(SummarizerException.Reason.UNAVAILABLE);
                    }
                    return output;
                } finally {
                    synchronized (lock) {
                        lastUse = env.now();
                    }
                    exited.countDown();
                }
            });
        }
        try {
            String output = result.get(Math.min(timeoutMs, DEADLINE_MS), TimeUnit.MILLISECONDS);
            synchronized (lock) { terminalCheck(); }
            return output;
        } catch (TimeoutException e) {
            cancel();
            boolean stopped = false;
            try { stopped = exited.await(2, TimeUnit.SECONDS); }
            catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
            synchronized (lock) {
                if (!stopped && state != State.CLOSED) state = State.WEDGED;
            }
            if (!stopped) { result.cancel(true); enqueueClose(); }
            throw error(stopped ? SummarizerException.Reason.TIMEOUT : SummarizerException.Reason.WEDGED);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt(); release();
            throw error(SummarizerException.Reason.BLOCKED);
        } catch (ExecutionException e) {
            if (e.getCause() instanceof SummarizerException) throw (SummarizerException)e.getCause();
            release();
            throw error(e.getCause() instanceof OutOfMemoryError ? SummarizerException.Reason.OOM : SummarizerException.Reason.FAILED);
        } catch (CancellationException e) { throw error(SummarizerException.Reason.UNAVAILABLE); }
        finally {
            synchronized (lock) {
                if (state == State.BUSY && exited.getCount() == 0) state = State.READY;
            }
        }
    }
    private void initialize() {
        try {
            if (!verifyModel.getAsBoolean()) throw error(SummarizerException.Reason.UNAVAILABLE);
            synchronized (lock) {
                if (state != State.INITIALIZING) return;
                if (env.availableBytes() < MIN_AVAIL_BYTES) throw error(SummarizerException.Reason.OOM);
                resourceCheck();
            }
            // Set before init so partial failures get an owner-thread close.
            nativeLoaded = true;
            backend.init();
            synchronized (lock) {
                resourceCheck();
                if (state == State.INITIALIZING) { state = State.READY; lastUse = env.now(); }
            }
        } catch (Exception | LinkageError | OutOfMemoryError e) {
            closeNative();
            synchronized (lock) { if (state == State.INITIALIZING) state = State.UNINIT; }
        }
    }
    private void cancel() { try { backend.cancelCurrent(); } catch (Exception ignored) { } }
    private void closeNative() {
        if (nativeLoaded) {
            try { backend.close(); } catch (Exception | LinkageError | OutOfMemoryError ignored) { }
            finally { nativeLoaded = false; }
        }
    }
    private void enqueueClose() {
        try {
            owner.execute(() -> {
                closeNative();
                synchronized (lock) { if (state == State.RELEASING) state = State.UNINIT; }
            });
        } catch (RejectedExecutionException ignored) { /* A prior terminal close already owns cleanup. */ }
    }
    @Override public void release() {
        synchronized (lock) {
            if (state == State.UNINIT || state == State.RELEASING || state == State.CLOSED || state == State.WEDGED) return;
            state = State.RELEASING;
            cancel(); enqueueClose();
        }
    }
    @Override public void close() {
        synchronized (lock) {
            if (state == State.CLOSED) return;
            state = State.CLOSED;
            cancel(); enqueueClose(); owner.shutdown(); monitor.shutdownNow();
        }
        if (context != null) context.unregisterComponentCallbacks(callbacks);
    }
    void monitorResources() {
        try {
            synchronized (lock) {
                if (state == State.READY && env.now() - lastUse >= IDLE_MS
                        || (state == State.READY || state == State.BUSY || state == State.INITIALIZING)
                        && (env.pssBytes() > MAX_PSS_BYTES || env.thermal() >= PowerManager.THERMAL_STATUS_SEVERE)) release();
            }
        } catch (Exception ignored) { release(); }
    }
    private static final class AndroidEnvironment implements Environment {
        private final Context ctx;
        AndroidEnvironment(Context ctx) { this.ctx = ctx.getApplicationContext(); }
        public long now() { return SystemClock.elapsedRealtime(); }
        public long availableBytes() {
            ActivityManager.MemoryInfo m = new ActivityManager.MemoryInfo();
            ctx.getSystemService(ActivityManager.class).getMemoryInfo(m); return m.availMem;
        }
        public long pssBytes() { return Debug.getPss() * 1024L; }
        public int thermal() {
            return Build.VERSION.SDK_INT >= 29 ? ctx.getSystemService(PowerManager.class).getCurrentThermalStatus() : PowerManager.THERMAL_STATUS_SEVERE;
        }
        public boolean lowPower() {
            Intent battery = ctx.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (battery == null) return true;
            int scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            int level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int status = battery.getIntExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_UNKNOWN);
            return scale <= 0 || level < 0 || level * 100L < scale * 15L
                    && status != BatteryManager.BATTERY_STATUS_CHARGING && status != BatteryManager.BATTERY_STATUS_FULL;
        }
        public boolean mainThread() { return Looper.myLooper() == Looper.getMainLooper(); }
    }
}
