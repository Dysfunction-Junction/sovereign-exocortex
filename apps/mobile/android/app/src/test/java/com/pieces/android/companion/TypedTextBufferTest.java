package com.pieces.android.companion;

import static org.junit.Assert.*;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Before;
import org.junit.Test;

public class TypedTextBufferTest {

    static class FakeClock implements TypedTextBuffer.Clock {
        long current = 100_000L;
        @Override public long now() { return current; }
    }

    static class FlushedItem {
        final String category;
        final String text;
        final long ts;

        FlushedItem(String category, char[] chars, long ts) {
            this.category = category;
            this.text = new String(chars);
            this.ts = ts;
        }
    }

    private FakeClock clock;
    private List<FlushedItem> flushes;
    private int evictions;
    private TypedTextBuffer buffer;

    @Before
    public void setUp() {
        clock = new FakeClock();
        flushes = new ArrayList<>();
        evictions = 0;
        buffer = new TypedTextBuffer(
            clock,
            (cat, chars, ts) -> flushes.add(new FlushedItem(cat, chars, ts)),
            () -> evictions++
        );
    }

    @Test
    public void cutsLongerTextToLast4000Chars() {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 5000; i++) {
            sb.append((char) ('a' + (i % 26)));
        }
        buffer.update("pkg.test", 1, 10, sb.toString(), "notes");

        clock.current += TypedTextBuffer.IDLE_FLUSH_MS;
        buffer.checkIdleAndMaxAgeFlushes();

        assertEquals(1, flushes.size());
        assertEquals(4000, flushes.get(0).text.length());
        assertEquals(sb.substring(1000), flushes.get(0).text);
    }

    @Test
    public void evictsLruWhenExceedingCapacity() {
        // Fill 8 buffers
        for (int i = 1; i <= 8; i++) {
            buffer.update("pkg." + i, i, i, "content " + i, "notes");
            clock.current += 10;
        }
        assertEquals(8, buffer.size());
        assertEquals(0, evictions);

        // 9th buffer triggers LRU eviction of buffer 1
        buffer.update("pkg.9", 9, 9, "content 9", "notes");
        assertEquals(8, buffer.size());
        assertEquals(1, evictions);
    }

    @Test
    public void flushesOnIdleTimeout() {
        buffer.update("pkg.test", 1, 10, "hello world", "email");
        assertEquals(0, flushes.size());

        // 7999 ms -> not flushed yet
        clock.current += 7999;
        buffer.checkIdleAndMaxAgeFlushes();
        assertEquals(0, flushes.size());

        // 8000 ms -> flushed
        clock.current += 1;
        buffer.checkIdleAndMaxAgeFlushes();
        assertEquals(1, flushes.size());
        assertEquals("hello world", flushes.get(0).text);
        assertEquals("email", flushes.get(0).category);
    }

    @Test
    public void flushesOnMaxAgeTimeout() {
        buffer.update("pkg.test", 1, 10, "start", "docs");

        // Continuously update every 5 seconds so idle timeout is never reached
        for (int i = 0; i < 23; i++) {
            clock.current += 5000;
            buffer.update("pkg.test", 1, 10, "typing " + i, "docs");
            buffer.checkIdleAndMaxAgeFlushes();
            assertEquals(0, flushes.size());
        }

        // At 120,000 ms since first change -> max age trigger flushes it
        clock.current += 5000; // total 120,000 ms
        buffer.checkIdleAndMaxAgeFlushes();
        assertEquals(1, flushes.size());
        assertEquals("typing 22", flushes.get(0).text);
    }

    @Test
    public void flushesOnWindowChange() {
        buffer.update("pkg.test", 1, 10, "window 1 text", "browser");
        buffer.update("pkg.test", 2, 20, "window 2 text", "browser");

        // Window changes to 2 -> window 1 flushes, window 2 stays
        buffer.onWindowChanged(2);
        assertEquals(1, flushes.size());
        assertEquals("window 1 text", flushes.get(0).text);

        // Window changes to 3 -> window 2 flushes
        buffer.onWindowChanged(3);
        assertEquals(2, flushes.size());
        assertEquals("window 2 text", flushes.get(1).text);
    }

    @Test
    public void flushesOnFocusChange() {
        buffer.update("pkg.test", 1, 10, "field 10", "notes");

        // Focus changes to view 20 in same window -> field 10 flushes
        buffer.onFocusChanged(1, 20);
        assertEquals(1, flushes.size());
        assertEquals("field 10", flushes.get(0).text);
    }

    @Test
    public void clearZeroFillsAndEmpties() {
        buffer.update("pkg.test", 1, 10, "secret to erase", "notes");
        assertEquals(1, buffer.size());

        buffer.clear();
        assertEquals(0, buffer.size());

        clock.current += TypedTextBuffer.IDLE_FLUSH_MS;
        buffer.checkIdleAndMaxAgeFlushes();
        assertEquals(0, flushes.size());
    }
}
