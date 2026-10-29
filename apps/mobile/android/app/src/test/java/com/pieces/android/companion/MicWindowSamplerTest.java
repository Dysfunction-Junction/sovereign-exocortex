package com.pieces.android.companion;

import static org.junit.Assert.*;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;

public class MicWindowSamplerTest {
    static final class FakeAudio implements MicWindowSampler.AudioSource {
        int starts, stops;
        boolean startOk = true, silenced = false, throwOnRead = false;
        short fill = 1000;
        Runnable duringRead;
        short[] seen;
        @Override public boolean start() { starts++; return startOk; }
        @Override public int read(short[] buf, int len) {
            seen = buf;
            if (duringRead != null) duringRead.run();
            if (throwOnRead) throw new IllegalStateException("boom");
            Arrays.fill(buf, 0, len, fill);
            return len;
        }
        @Override public void stop() { stops++; }
        @Override public boolean silenced() { return silenced; }
    }

    static final class FakeGates implements MicWindowSampler.Gates {
        boolean perm = true, interactive = true, inCall = false, busy = false;
        String pocket = "ok";
        @Override public boolean permGranted() { return perm; }
        @Override public boolean interactive() { return interactive; }
        @Override public boolean inCall() { return inCall; }
        @Override public String pocket() { return pocket; }
        @Override public boolean micBusy() { return busy; }
    }

    static final class FakeEnv implements MicWindowSampler.Env {
        long now = 1_000_000_000L - (1_000_000_000L % MicWindowSampler.WINDOW_MS);
        final List<JSONObject> events = new ArrayList<>();
        final List<String> ids = new ArrayList<>();
        @Override public long now() { return now; }
        @Override public void emit(String id, long ts, JSONObject p) { ids.add(id); events.add(p); }
    }

    static final class RecordingLog implements MicWindowSampler.Log {
        final List<String> lines = new ArrayList<>();
        @Override public void w(String m) { lines.add(m); }
    }

    private final FakeAudio audio = new FakeAudio();
    private final FakeGates gates = new FakeGates();
    private final FakeEnv env = new FakeEnv();
    private final RecordingLog log = new RecordingLog();
    private boolean speech = true;
    private final MicWindowSampler.Vad vad = new MicWindowSampler.Vad() {
        @Override public String version() { return "ezc-1"; }
        @Override public boolean isSpeech(short[] pcm, int len, int sr) { return speech; }
    };
    private final MicWindowSampler.Core core = new MicWindowSampler.Core(audio, gates, env, vad, log);

    private JSONObject closeWindow() throws Exception {
        env.now += MicWindowSampler.WINDOW_MS;
        core.tick(); // first tick of the next window closes the previous one
        assertFalse(env.events.isEmpty());
        return env.events.get(env.events.size() - 1);
    }

    @Test
    public void passingGatesCaptureOnceAndCountSpeech() throws Exception {
        core.tick();
        env.now += MicWindowSampler.PERIOD_MS;
        speech = false;
        core.tick();
        assertEquals(2, audio.starts);
        JSONObject w = closeWindow();
        assertEquals("mic_window", w.getString("type"));
        assertEquals(2, w.getInt("samples"));
        assertEquals(1, w.getInt("speech_samples"));
        assertEquals(0.5, w.getDouble("speech_frac"), 1e-9);
        assertEquals("ezc-1", w.getString("vad"));
        assertTrue(env.ids.get(0).startsWith("mw-"));
    }

    private void assertSkipped(String key, Runnable setup) throws Exception {
        setup.run();
        core.tick();
        assertEquals(key + ": no capture", 0, audio.starts);
        JSONObject w = closeWindow();
        assertEquals(key, 1, w.getJSONObject("skipped").getInt(key));
        assertEquals(0, w.getInt("samples"));
        assertFalse("did not listen => no speech_frac", w.has("speech_frac"));
    }

    @Test public void permissionGate() throws Exception { assertSkipped("perm", () -> gates.perm = false); }
    @Test public void screenOffGate() throws Exception { assertSkipped("screen_off", () -> gates.interactive = false); }
    @Test public void pocketGate() throws Exception { assertSkipped("pocket", () -> gates.pocket = "pocket"); }
    @Test public void unknownPocketGate() throws Exception { assertSkipped("unknown", () -> gates.pocket = "unknown"); }
    @Test public void micBusyGate() throws Exception { assertSkipped("mic_busy", () -> gates.busy = true); }

    @Test
    public void inCallSkipsAndCountsCallFraction() throws Exception {
        gates.inCall = true;
        core.tick();
        env.now += MicWindowSampler.PERIOD_MS;
        gates.inCall = false;
        core.tick();
        assertEquals(1, audio.starts);
        JSONObject w = closeWindow();
        assertEquals(1, w.getJSONObject("skipped").getInt("in_call"));
        assertTrue(w.getDouble("call_frac") > 0);
    }

    @Test
    public void allZeroBufferIsSilencedNotNoSpeech() throws Exception {
        audio.fill = 0;
        core.tick();
        JSONObject w = closeWindow();
        assertEquals(1, w.getJSONObject("skipped").getInt("silenced"));
        assertEquals(0, w.getInt("samples"));
        assertEquals(0, w.getInt("speech_samples"));
    }

    @Test
    public void clientSilencedFlagIsSilenced() throws Exception {
        audio.silenced = true;
        core.tick();
        assertEquals(1, closeWindow().getJSONObject("skipped").getInt("silenced"));
    }

    @Test
    public void bufferIsZeroAfterEverySampleEvenWhenReadThrows() throws Exception {
        core.tick();
        assertTrue(MicWindowSampler.Core.allZero(audio.seen, audio.seen.length));
        audio.throwOnRead = true;
        env.now += MicWindowSampler.PERIOD_MS;
        core.tick();
        assertTrue(MicWindowSampler.Core.allZero(audio.seen, audio.seen.length));
        assertEquals(audio.starts, audio.stops); // always released
        assertEquals(1, log.lines.size());
        assertEquals("mic capture failed: IllegalStateException", log.lines.get(0));
    }

    @Test
    public void startFailureIsMicBusyAndNeverStops() throws Exception {
        audio.startOk = false;
        core.tick();
        assertEquals(0, audio.stops);
        assertEquals(1, closeWindow().getJSONObject("skipped").getInt("mic_busy"));
    }

    @Test
    public void abortMidCaptureStopsBeforeReturningAndDropsTheWindow() {
        audio.duringRead = core::abort; // consent revoked while the 5 s capture is running
        core.tick();
        assertTrue("stop() called by abort", audio.stops >= 1);
        assertTrue(MicWindowSampler.Core.allZero(audio.seen, audio.seen.length));
        core.flushWindow();
        assertTrue("revoked window is never sent", env.events.isEmpty());
    }

    @Test
    public void payloadKeysStayWithinTheAllowlistAndLogNeverSeesSamples() throws Exception {
        core.tick();
        JSONObject w = closeWindow();
        assertNull(NativeTelemetrySync.allowlistProblem("mic_window", w));
        assertTrue(log.lines.isEmpty());
        assertEquals(300_000L, w.getLong("dur_ms"));
        assertEquals(w.getLong("window_start") + 300_000L, w.getLong("window_end"));
    }

    @Test
    public void nothingIsSentForAWindowWithNoTicks() {
        core.flushWindow();
        assertTrue(env.events.isEmpty());
    }
}
