package com.pieces.android.companion;

import static org.junit.Assert.*;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.Before;
import org.junit.Test;

public class TypedTextSummaryQueueTest {

    static class FakeHardwareCheck implements TypedTextSummaryQueue.HardwareCheck {
        boolean locked = false;
        boolean lowBattery = false;
        boolean thermal = false;

        @Override public boolean isLocked() { return locked; }
        @Override public boolean isLowBattery() { return lowBattery; }
        @Override public boolean isThermalThrottled() { return thermal; }
    }

    private FakeSummarizer summarizer;
    private FakeHardwareCheck hardware;
    private TypedTextSummaryQueue queue;

    @Before
    public void setUp() {
        TypedTextCounters.resetAll();
        TypedTextGate.on = true;
        TypedTextGate.generation = 1;

        summarizer = new FakeSummarizer();
        hardware = new FakeHardwareCheck();
        queue = new TypedTextSummaryQueue(summarizer, hardware, null);
    }

    @Test
    public void capacityDropsOldestOnOverflow() {
        // Holding dispatcher: do not process so items queue up
        TypedTextSummaryQueue holdQueue = new TypedTextSummaryQueue(summarizer, hardware, null, r -> {});
        // Enqueue 4 items
        for (int i = 1; i <= 4; i++) {
            holdQueue.enqueue("notes", ("text " + i).toCharArray(), System.currentTimeMillis());
        }
        assertEquals(0, TypedTextCounters.get("dropped:queue_full"));

        // 5th item drops the oldest
        holdQueue.enqueue("notes", "text 5".toCharArray(), System.currentTimeMillis());
        assertEquals(1, TypedTextCounters.get("dropped:queue_full"));
    }

    @Test
    public void dropsWhenGateIsOff() throws Exception {
        TypedTextGate.on = false;
        queue.enqueue("notes", "some text".toCharArray(), System.currentTimeMillis());

        // Wait briefly for worker thread
        Thread.sleep(100);
        assertEquals(1, TypedTextCounters.get("dropped:gate_off"));
        assertEquals(0, summarizer.summarizeCalls);
    }

    @Test
    public void dropsWhenLocked() throws Exception {
        hardware.locked = true;
        queue.enqueue("notes", "some text".toCharArray(), System.currentTimeMillis());

        Thread.sleep(100);
        assertEquals(1, TypedTextCounters.get("dropped:locked"));
        assertEquals(0, summarizer.summarizeCalls);
    }

    @Test
    public void dropsWhenLowBattery() throws Exception {
        hardware.lowBattery = true;
        queue.enqueue("notes", "some text".toCharArray(), System.currentTimeMillis());

        Thread.sleep(100);
        assertEquals(1, TypedTextCounters.get("dropped:battery"));
        assertEquals(0, summarizer.summarizeCalls);
    }

    @Test
    public void dropsWhenThermalThrottled() throws Exception {
        hardware.thermal = true;
        queue.enqueue("notes", "some text".toCharArray(), System.currentTimeMillis());

        Thread.sleep(100);
        assertEquals(1, TypedTextCounters.get("dropped:thermal"));
        assertEquals(0, summarizer.summarizeCalls);
    }

    @Test
    public void dropsWhenSummarizerUnavailable() throws Exception {
        summarizer.ready = false;
        queue.enqueue("notes", "some text".toCharArray(), System.currentTimeMillis());

        Thread.sleep(100);
        assertEquals(1, TypedTextCounters.get("dropped:summarizer_unavailable"));
        assertEquals(0, summarizer.summarizeCalls);
    }

    @Test
    public void mapsSummarizerExceptionReasonDirectlyToCounter() throws Exception {
        summarizer.throwOnSummarize = new SummarizerException(SummarizerException.Reason.TIMEOUT);
        queue.enqueue("notes", "some text".toCharArray(), System.currentTimeMillis());

        Thread.sleep(100);
        assertEquals(1, TypedTextCounters.get("dropped:TIMEOUT"));
    }

    @Test
    public void successfulInferenceStoresAndIncrementsCounter() throws Exception {
        queue.enqueue("notes", "Plan trip to Chicago".toCharArray(), System.currentTimeMillis());

        Thread.sleep(100);
        assertEquals(1, summarizer.summarizeCalls);
        assertEquals(1, TypedTextCounters.get("stored"));
    }

    @Test
    public void turnOffPreventsCommitEvenIfInferenceWasRunning() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch proceed = new CountDownLatch(1);
        summarizer.onSummarizeHook = () -> {
            started.countDown();
            try {
                proceed.await(5, TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {}
        };

        ExecutorService executor = Executors.newSingleThreadExecutor();
        try {
            TypedTextSummaryQueue asyncQueue = new TypedTextSummaryQueue(summarizer, hardware, null, executor::execute);

            // Enqueue item asynchronously
            asyncQueue.enqueue("notes", "Planning a trip".toCharArray(), System.currentTimeMillis());

            // Wait until worker thread starts inside summarize()
            assertTrue(started.await(5, TimeUnit.SECONDS));

            // While inference is in-flight on worker thread, kill switch fires
            TypedTextGate.turnOff(null);

            // Now release inference so worker attempts to commit
            proceed.countDown();

            executor.shutdown();
            assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS));

            // Verify that commit barrier rejected write and dropped with gate_off
            assertEquals(1, TypedTextCounters.get("dropped:gate_off"));
            assertEquals(0, TypedTextCounters.get("stored"));
        } finally {
            executor.shutdownNow();
        }
    }
}
