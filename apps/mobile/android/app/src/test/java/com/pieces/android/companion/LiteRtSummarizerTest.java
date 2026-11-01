package com.pieces.android.companion;

import org.junit.*;
import static org.junit.Assert.*;
import java.util.concurrent.*;
import java.util.function.BooleanSupplier;

public class LiteRtSummarizerTest {
    static final class Hardware implements LiteRtSummarizer.Environment {
        volatile long now, pss, available = 3_000_000_000L;
        volatile int thermal;
        volatile boolean low, main;
        public long now() { return now; }
        public long availableBytes() { return available; }
        public long pssBytes() { return pss; }
        public int thermal() { return thermal; }
        public boolean lowPower() { return low; }
        public boolean mainThread() { return main; }
    }
    private final FakeBackend backend = new FakeBackend();
    private final Hardware hw = new Hardware();
    private final LiteRtSummarizer summarizer = new LiteRtSummarizer(backend, () -> true, hw);
    @After public void cleanup() throws Exception {
        backend.unblock.countDown(); summarizer.close();
        await(() -> backend.closes >= backend.inits);
        assertTrue(backend.nativeThreads.stream().allMatch("litertlm-owner"::equals));
    }
    static void await(BooleanSupplier condition) throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(4);
        while (!condition.getAsBoolean() && System.nanoTime() < end) Thread.sleep(5);
        assertTrue("Lifecycle did not settle", condition.getAsBoolean());
    }
    private void reason(SummarizerException.Reason expected) throws Exception {
        try { summarizer.summarize("synthetic", 1000); fail("Expected refusal"); }
        catch (SummarizerException e) { assertEquals(expected, e.reason); }
    }
    private void ready() throws Exception {
        reason(SummarizerException.Reason.WARMING);
        await(summarizer::isReady);
    }
    @Test public void lazyInitReleaseAndTerminalClose() throws Exception {
        ready(); assertEquals("{}", summarizer.summarize("synthetic", 1000));
        summarizer.release(); summarizer.release();
        await(() -> summarizer.state() == LiteRtSummarizer.State.UNINIT);
        ready(); assertEquals(2, backend.inits);
        summarizer.close(); summarizer.close();
        reason(SummarizerException.Reason.CLOSED);
        assertEquals(2, backend.inits);
    }
    @Test public void idleAndMemoryRelease() throws Exception {
        ready(); hw.now = 60_000; summarizer.monitorResources();
        await(() -> summarizer.state() == LiteRtSummarizer.State.UNINIT);
        ready(); hw.pss = LiteRtSummarizer.MAX_PSS_BYTES + 1;
        summarizer.monitorResources();
        await(() -> summarizer.state() == LiteRtSummarizer.State.UNINIT);
        reason(SummarizerException.Reason.WARMING);
        await(() -> summarizer.state() == LiteRtSummarizer.State.UNINIT);
        assertEquals(2, backend.inits);
    }
    @Test public void thermalBackoffPowerAndSevereRelease() throws Exception {
        ready(); hw.thermal = 2; reason(SummarizerException.Reason.THERMAL);
        hw.thermal = 0; hw.now = 29_999; reason(SummarizerException.Reason.THERMAL);
        hw.now = 30_000; hw.thermal = 2; reason(SummarizerException.Reason.THERMAL);
        hw.thermal = 0; hw.now = 89_999; reason(SummarizerException.Reason.THERMAL);
        hw.now = 90_000; hw.low = true; reason(SummarizerException.Reason.POWER);
        hw.low = false; hw.thermal = 3; reason(SummarizerException.Reason.THERMAL);
        await(() -> summarizer.state() == LiteRtSummarizer.State.UNINIT);
    }
    @Test public void busyRejectsWithoutQueueingAndKillSwitchDiscardsOutput() throws Exception {
        ready(); backend.block = true;
        ExecutorService caller = Executors.newSingleThreadExecutor();
        try {
            Future<?> active = caller.submit(() -> {
                try { summarizer.summarize("synthetic", 5000); fail("Closed output escaped"); }
                catch (SummarizerException e) { assertEquals(SummarizerException.Reason.CLOSED, e.reason); }
            });
            assertTrue(backend.entered.await(1, TimeUnit.SECONDS));
            reason(SummarizerException.Reason.BUSY);
            summarizer.close(); active.get(2, TimeUnit.SECONDS);
            assertEquals(1, backend.generations);
        } finally { caller.shutdownNow(); }
    }
    @Test public void timeoutCancelsAndRecovers() throws Exception {
        ready(); backend.block = true;
        try { summarizer.summarize("synthetic", 10); fail(); }
        catch (SummarizerException e) { assertEquals(SummarizerException.Reason.TIMEOUT, e.reason); }
        assertTrue(backend.cancels > 0);
        assertEquals("{}", summarizer.summarize("synthetic", 1000));
    }
    @Test public void unresponsiveNativeCallWedgesPermanently() throws Exception {
        ready(); backend.block = true; backend.ignoreCancel = true;
        try { summarizer.summarize("synthetic", 10); fail(); }
        catch (SummarizerException e) { assertEquals(SummarizerException.Reason.WEDGED, e.reason); }
        reason(SummarizerException.Reason.WEDGED);
        backend.unblock.countDown();
        await(() -> backend.closes == 1);
        reason(SummarizerException.Reason.WEDGED);
    }
    @Test public void promptNeverTruncatedAndMainThreadRejected() throws Exception {
        try { summarizer.summarize("x".repeat(833), 100); fail(); }
        catch (SummarizerException e) { assertEquals(SummarizerException.Reason.PROMPT_TOO_LONG, e.reason); }
        assertEquals(0, backend.inits);
        hw.main = true;
        try { summarizer.summarize("synthetic", 100); fail(); }
        catch (IllegalStateException e) { assertEquals("WORKER_THREAD_REQUIRED", e.getMessage()); }
    }
    @Test public void invalidModelAndLowAvailableMemoryNeverInit() throws Exception {
        try (LiteRtSummarizer invalid = new LiteRtSummarizer(backend, () -> false, hw)) {
            try { invalid.summarize("synthetic", 100); fail(); } catch (SummarizerException expected) { }
            await(() -> invalid.state() == LiteRtSummarizer.State.UNINIT);
            assertEquals(0, backend.inits);
        }
        hw.available = 1;
        reason(SummarizerException.Reason.WARMING);
        await(() -> summarizer.state() == LiteRtSummarizer.State.UNINIT);
        assertEquals(0, backend.inits);
    }
    @Test public void failedInitializationClosesPartialEngine() throws Exception {
        backend.failInit = true; reason(SummarizerException.Reason.WARMING);
        await(() -> summarizer.state() == LiteRtSummarizer.State.UNINIT);
        assertEquals(1, backend.closes);
    }
}
