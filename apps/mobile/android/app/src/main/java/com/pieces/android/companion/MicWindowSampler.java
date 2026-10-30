package com.pieces.android.companion;

import android.annotation.SuppressLint;
import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioRecordingConfiguration;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.PowerManager;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/**
 * Speech-present yes/no, one `mic_window` v3 event per 5-minute window (ANDROID_SENSITIVE_CAPTURE_DESIGN section 2).
 *
 * Every 2 minutes a tick runs the gates in order (permission, screen on, not in a call, not in a pocket, mic not in
 * use by another app). Only if all pass does it record 5 seconds, ask the {@link Vad} one boolean, and zero the
 * buffer. Audio exists only in that buffer for those 5 seconds: it is never logged, written, transcribed or sent.
 * Only counts leave this class.
 *
 * It runs inside the bound accessibility service process with no foreground service (Android 14+ refuses a
 * microphone foreground service started from the background). Whether in-service capture is actually allowed is
 * phone spike S3-1; a denied or silenced capture reads as `perm` or `silenced`, never as "no speech".
 *
 * The core ({@link Core}) is pure Java behind seams so it is unit-tested; the Android wiring is at the bottom.
 */
final class MicWindowSampler {
    static final long WINDOW_MS = 5L * 60_000L;
    static final long PERIOD_MS = 2L * 60_000L;
    static final int SAMPLE_MS = 5_000;
    static final int SAMPLE_RATE = 16_000;
    /** MediaRecorder.AudioSource.HOTWORD is a hidden constant; "Hey Google" style listeners are not a recording. */
    static final int AUDIO_SOURCE_HOTWORD = 1999;

    /** One boolean per sample. Bump {@link #version()} when the rule changes. */
    interface Vad {
        String version();
        boolean isSpeech(short[] pcm, int len, int sampleRate);
    }

    /** The microphone. {@link #read} blocks until it has filled `len` samples or fails (negative). */
    interface AudioSource {
        boolean start();
        int read(short[] buf, int len);
        void stop();
        /** True when Android feeds this capture zeros (privacy toggle, or another app holds the mic). */
        boolean silenced();
    }

    /** Every skip reason the design lists. `pocket` returns "ok", "pocket" or "unknown". */
    interface Gates {
        boolean permGranted();
        boolean interactive();
        boolean inCall();
        String pocket();
        boolean micBusy();
    }

    interface Env {
        long now();
        void emit(String eventId, long tsDevice, JSONObject payload);
    }

    /** Logs exception classes and counts only, never samples. */
    interface Log {
        void w(String message);
    }

    /** Pure sampling logic: gates, one capture, window accounting. Single-threaded except {@link #abort}. */
    static final class Core {
        private final AudioSource audio;
        private final Gates gates;
        private final Env env;
        private final Vad vad;
        private final Log log;
        private final short[] buf = new short[SAMPLE_RATE * SAMPLE_MS / 1000];

        private volatile boolean aborted;
        private long windowStart = -1;
        private int ticks;
        private int samples;
        private int speechSamples;
        private int callTicks;
        private final int[] skipped = new int[SKIP_KEYS.length];

        static final String[] SKIP_KEYS = {"screen_off", "pocket", "unknown", "in_call", "mic_busy", "silenced", "perm"};
        private static final int SCREEN_OFF = 0, POCKET = 1, UNKNOWN = 2, IN_CALL = 3, MIC_BUSY = 4, SILENCED = 5, PERM = 6;

        Core(AudioSource audio, Gates gates, Env env, Vad vad, Log log) {
            this.audio = audio;
            this.gates = gates;
            this.env = env;
            this.vad = vad;
            this.log = log;
        }

        /** One tick: close the previous window if the grid moved on, run the gates, maybe capture. */
        void tick() {
            long now = env.now();
            long start = now - Math.floorMod(now, WINDOW_MS);
            if (windowStart >= 0 && start != windowStart) flushWindow();
            windowStart = start;
            aborted = false;
            ticks++;

            if (!gates.permGranted()) { skipped[PERM]++; return; }
            if (!gates.interactive()) { skipped[SCREEN_OFF]++; return; }
            if (gates.inCall()) { callTicks++; skipped[IN_CALL]++; return; }
            String pocket = gates.pocket();
            if ("pocket".equals(pocket)) { skipped[POCKET]++; return; }
            if (!"ok".equals(pocket)) { skipped[UNKNOWN]++; return; }
            if (gates.micBusy()) { skipped[MIC_BUSY]++; return; }
            capture();
        }

        private void capture() {
            boolean started = false;
            int n = -1;
            try {
                started = audio.start();
                if (!started) { skipped[MIC_BUSY]++; return; }
                n = audio.read(buf, buf.length);
                if (aborted) return; // consent revoked mid-capture: count nothing
                if (n <= 0) { skipped[MIC_BUSY]++; return; }
                if (audio.silenced() || allZero(buf, n)) { skipped[SILENCED]++; return; }
                samples++;
                if (vad.isSpeech(buf, n, SAMPLE_RATE)) speechSamples++;
            } catch (Exception e) {
                skipped[MIC_BUSY]++;
                log.w("mic capture failed: " + e.getClass().getSimpleName());
            } finally {
                Arrays.fill(buf, (short) 0);
                if (started) {
                    try {
                        audio.stop();
                    } catch (Exception e) {
                        log.w("mic stop failed: " + e.getClass().getSimpleName());
                    }
                }
            }
        }

        /** Revocation: stop an in-flight capture now, zero the buffer, drop the open window. Safe from any thread. */
        void abort() {
            aborted = true;
            try {
                audio.stop();
            } catch (Exception e) {
                log.w("mic stop failed: " + e.getClass().getSimpleName());
            }
            Arrays.fill(buf, (short) 0);
            reset();
        }

        /** Closes the open window, sending it only if at least one tick ran. */
        void flushWindow() {
            if (windowStart >= 0 && ticks > 0) {
                long end = windowStart + WINDOW_MS;
                try {
                    env.emit("mw-" + end, end, payload(windowStart, end));
                } catch (Exception e) {
                    log.w("mic window emit failed: " + e.getClass().getSimpleName());
                }
            }
            reset();
        }

        private void reset() {
            windowStart = -1;
            ticks = 0;
            samples = 0;
            speechSamples = 0;
            callTicks = 0;
            Arrays.fill(skipped, 0);
        }

        JSONObject payload(long start, long end) throws Exception {
            JSONObject skip = new JSONObject();
            for (int i = 0; i < SKIP_KEYS.length; i++) skip.put(SKIP_KEYS[i], skipped[i]);
            JSONObject p = new JSONObject();
            p.put("type", "mic_window");
            p.put("window_start", start);
            p.put("window_end", end);
            p.put("dur_ms", WINDOW_MS);
            p.put("vad", vad.version());
            p.put("sample_ms", SAMPLE_MS);
            p.put("period_ms", PERIOD_MS);
            p.put("samples", samples);
            p.put("speech_samples", speechSamples);
            // Omitted when nothing was heard, so "did not listen" differs from "no speech".
            if (samples > 0) p.put("speech_frac", round2(speechSamples / (double) samples));
            p.put("call_frac", ticks == 0 ? 0.0 : round2(callTicks / (double) ticks));
            p.put("skipped", skip);
            return p;
        }

        private static double round2(double v) {
            return Math.round(v * 100.0) / 100.0;
        }

        static boolean allZero(short[] b, int n) {
            for (int i = 0; i < n; i++) if (b[i] != 0) return false;
            return true;
        }
    }

    // ---- Android wiring ----

    private static final Object LOCK = new Object();
    private static Core core;
    private static HandlerThread thread;
    private static Handler handler;

    private MicWindowSampler() {}

    static void start(Context ctx) {
        onConsentChanged(ctx);
    }

    static void stop() {
        synchronized (LOCK) {
            stopLocked();
        }
    }

    /** Starts when mic_speech is on and the service is bound; stops in the same main-looper turn when it is off. */
    static void onConsentChanged(Context ctx) {
        Context app = ctx.getApplicationContext();
        synchronized (LOCK) {
            boolean want = SensorConsentPlugin.isEnabled(app, SensorCapabilities.KEY_MIC_SPEECH)
                && PiecesAccessibilityService.isRunning;
            if (!want) {
                stopLocked();
                return;
            }
            if (core != null) return;
            core = new Core(new AndroidAudioSource(app), new AndroidGates(app), new AndroidEnv(app), new SpeechVad(), new AndroidLog());
            thread = new HandlerThread("mic-window");
            thread.start();
            handler = new Handler(thread.getLooper());
            handler.postDelayed(TICK, 10_000L);
        }
    }

    private static final Runnable TICK = new Runnable() {
        @Override public void run() {
            Core c;
            Handler h;
            synchronized (LOCK) {
                c = core;
                h = handler;
            }
            if (c == null || h == null) return;
            try {
                c.tick();
            } catch (Exception e) {
                android.util.Log.w("MicWindowSampler", "tick failed: " + e.getClass().getSimpleName());
            }
            synchronized (LOCK) {
                if (core == c && handler == h) h.postDelayed(this, PERIOD_MS);
            }
        }
    };

    private static void stopLocked() {
        if (core != null) core.abort();
        core = null;
        if (handler != null) handler.removeCallbacksAndMessages(null);
        if (thread != null) thread.quitSafely();
        thread = null;
        handler = null;
    }

    private static final class AndroidLog implements Log {
        @Override public void w(String message) {
            android.util.Log.w("MicWindowSampler", message);
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
            if (!SensorConsentPlugin.isEnabled(ctx, SensorCapabilities.KEY_MIC_SPEECH)) return; // revoked since the window opened
            NativeTelemetrySync.queueV3Event(ctx, eventId, tsDevice, payload);
        }
    }

    private static final class AndroidGates implements Gates {
        private final Context ctx;
        AndroidGates(Context ctx) {
            this.ctx = ctx;
        }

        @Override public boolean permGranted() {
            return ctx.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
        }

        @Override public boolean interactive() {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isInteractive();
        }

        @Override public boolean inCall() {
            AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return false;
            int mode = am.getMode();
            return mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_IN_COMMUNICATION;
        }

        /** First proximity and light values within about 300 ms; values are gate-only and never emitted. */
        @Override public String pocket() {
            SensorManager sm = (SensorManager) ctx.getSystemService(Context.SENSOR_SERVICE);
            if (sm == null) return "unknown";
            Sensor prox = sm.getDefaultSensor(Sensor.TYPE_PROXIMITY);
            Sensor light = sm.getDefaultSensor(Sensor.TYPE_LIGHT);
            if (prox == null || light == null) return "unknown";
            final float[] proxVal = {-1f};
            final float[] lux = {-1f};
            final CountDownLatch gotProx = new CountDownLatch(1);
            final CountDownLatch gotLight = new CountDownLatch(1);
            HandlerThread t = new HandlerThread("mic-pocket");
            t.start();
            SensorEventListener l = new SensorEventListener() {
                @Override public void onSensorChanged(SensorEvent e) {
                    if (e.sensor.getType() == Sensor.TYPE_PROXIMITY && gotProx.getCount() > 0) {
                        proxVal[0] = e.values[0];
                        gotProx.countDown();
                    } else if (e.sensor.getType() == Sensor.TYPE_LIGHT && gotLight.getCount() > 0) {
                        lux[0] = e.values[0];
                        gotLight.countDown();
                    }
                }
                @Override public void onAccuracyChanged(Sensor sensor, int accuracy) {}
            };
            try {
                Handler h = new Handler(t.getLooper());
                sm.registerListener(l, prox, SensorManager.SENSOR_DELAY_FASTEST, h);
                sm.registerListener(l, light, SensorManager.SENSOR_DELAY_FASTEST, h);
                long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(300);
                boolean p = gotProx.await(Math.max(1, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
                boolean g = gotLight.await(Math.max(1, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
                boolean known = p && g;
                if ((ctx.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
                    // Debug builds only, numbers only (never audio, never emitted): to tune the pocket gate on a phone.
                    android.util.Log.d("PocketGate", "prox=" + (p ? proxVal[0] : "none") + " max=" + prox.getMaximumRange()
                        + " lux=" + (g ? lux[0] : "none"));
                }
                return NativeHardwareTelemetry.pocketGate(
                    known && NativeHardwareTelemetry.isNear(proxVal[0], prox.getMaximumRange()),
                    known && NativeHardwareTelemetry.isDark(lux[0]),
                    known);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return "unknown";
            } finally {
                sm.unregisterListener(l);
                t.quitSafely();
            }
        }

        /** Another non-hotword app is recording right now (we are not recording at gate time). */
        @Override public boolean micBusy() {
            AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return false;
            List<AudioRecordingConfiguration> active = am.getActiveRecordingConfigurations();
            if (active == null) return false;
            for (AudioRecordingConfiguration c : active) {
                if (c.getAudioSource() != AUDIO_SOURCE_HOTWORD) return true;
            }
            return false;
        }
    }

    private static final class AndroidAudioSource implements AudioSource {
        private final Context ctx;
        private AudioRecord rec;

        AndroidAudioSource(Context ctx) {
            this.ctx = ctx;
        }

        @SuppressLint("MissingPermission")
        @Override public boolean start() {
            int min = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (min <= 0) return false;
            rec = new AudioRecord(MediaRecorder.AudioSource.MIC, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT, Math.max(min, SAMPLE_RATE / 2));
            if (rec.getState() != AudioRecord.STATE_INITIALIZED) {
                rec.release();
                rec = null;
                return false;
            }
            rec.startRecording();
            return rec.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING;
        }

        @Override public int read(short[] buf, int len) {
            AudioRecord r = rec;
            if (r == null) return -1;
            int total = 0;
            while (total < len) {
                int got = r.read(buf, total, len - total);
                if (got <= 0) return total > 0 ? total : got;
                total += got;
            }
            return total;
        }

        @Override public void stop() {
            AudioRecord r = rec;
            rec = null;
            if (r == null) return;
            try {
                r.stop();
            } catch (IllegalStateException ignored) {
                // already stopped
            }
            r.release();
        }

        @Override public boolean silenced() {
            AudioRecord r = rec;
            if (r == null || Build.VERSION.SDK_INT < 29) return false;
            AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return false;
            for (AudioRecordingConfiguration c : am.getActiveRecordingConfigurations()) {
                if (c.getClientAudioSessionId() == r.getAudioSessionId() && c.isClientSilenced()) return true;
            }
            return false;
        }
    }
}
