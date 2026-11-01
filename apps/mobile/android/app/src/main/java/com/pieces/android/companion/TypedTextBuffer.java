package com.pieces.android.companion;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * In-memory ring of field buffers for typed-text capture (A5-1 Section 4.4).
 * Bounded to 8 live buffers of max 4000 characters; zero-filled on flush, eviction, or kill-switch.
 */
final class TypedTextBuffer {
    static final int MAX_CHARS = 4000;
    static final int MAX_BUFFERS = 8;
    static final long IDLE_FLUSH_MS = 8000L;
    static final long MAX_AGE_MS = 120_000L;

    interface Clock {
        long now();
    }

    interface QueueSink {
        void enqueue(String appCategory, char[] textChars, long timestamp);
    }

    interface EvictionListener {
        void onEvicted();
    }

    static final class BufferKey {
        final String pkg;
        final int windowId;
        final int viewId;

        BufferKey(String pkg, int windowId, int viewId) {
            this.pkg = pkg != null ? pkg : "";
            this.windowId = windowId;
            this.viewId = viewId;
        }

        @Override
        public boolean equals(Object o) {
            if (this == o) return true;
            if (o == null || getClass() != o.getClass()) return false;
            BufferKey bufferKey = (BufferKey) o;
            return windowId == bufferKey.windowId &&
                   viewId == bufferKey.viewId &&
                   pkg.equals(bufferKey.pkg);
        }

        @Override
        public int hashCode() {
            return Objects.hash(pkg, windowId, viewId);
        }
    }

    private static final class BufferEntry {
        final char[] buf = new char[MAX_CHARS];
        int len = 0;
        long firstChangeMs = 0;
        long lastChangeMs = 0;
        String appCategory = "other";

        void zeroFill() {
            Arrays.fill(buf, '\0');
            len = 0;
        }
    }

    private final Clock clock;
    private final QueueSink sink;
    private final EvictionListener evictionListener;
    // accessOrder = true for LRU eviction
    private final LinkedHashMap<BufferKey, BufferEntry> buffers = new LinkedHashMap<BufferKey, BufferEntry>(16, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<BufferKey, BufferEntry> eldest) {
            if (size() > MAX_BUFFERS) {
                eldest.getValue().zeroFill();
                if (evictionListener != null) {
                    evictionListener.onEvicted();
                }
                return true;
            }
            return false;
        }
    };

    private static TypedTextBuffer sInstance;

    static synchronized TypedTextBuffer getInstance() {
        if (sInstance == null) {
            sInstance = new TypedTextBuffer(
                System::currentTimeMillis,
                (category, text, ts) -> TypedTextSummaryQueue.getInstance().enqueue(category, text, ts),
                () -> TypedTextCounters.bump("evicted")
            );
        }
        return sInstance;
    }

    static synchronized void clearAll() {
        if (sInstance != null) {
            sInstance.clear();
        }
    }

    TypedTextBuffer(Clock clock, QueueSink sink, EvictionListener evictionListener) {
        this.clock = clock != null ? clock : System::currentTimeMillis;
        this.sink = sink;
        this.evictionListener = evictionListener;
    }

    synchronized void update(String pkg, int windowId, int viewId, CharSequence fullText, String category) {
        long now = clock.now();
        BufferKey key = new BufferKey(pkg, windowId, viewId);
        BufferEntry entry = buffers.get(key);
        if (entry == null) {
            entry = new BufferEntry();
            entry.firstChangeMs = now;
            entry.appCategory = category != null ? category : "other";
            buffers.put(key, entry);
        }

        entry.lastChangeMs = now;
        entry.appCategory = category != null ? category : "other";

        int textLen = fullText != null ? fullText.length() : 0;
        int copyStart = Math.max(0, textLen - MAX_CHARS);
        int copyLen = textLen - copyStart;

        Arrays.fill(entry.buf, '\0');
        if (fullText != null && copyLen > 0) {
            for (int i = 0; i < copyLen; i++) {
                entry.buf[i] = fullText.charAt(copyStart + i);
            }
        }
        entry.len = copyLen;
    }

    synchronized void checkIdleAndMaxAgeFlushes() {
        long now = clock.now();
        List<BufferKey> toFlush = new ArrayList<>();
        for (Map.Entry<BufferKey, BufferEntry> e : buffers.entrySet()) {
            BufferEntry entry = e.getValue();
            if (entry.len > 0) {
                if ((now - entry.lastChangeMs >= IDLE_FLUSH_MS) || (now - entry.firstChangeMs >= MAX_AGE_MS)) {
                    toFlush.add(e.getKey());
                }
            }
        }
        for (BufferKey key : toFlush) {
            flushEntry(key, now);
        }
    }

    synchronized void onWindowChanged(int currentWindowId) {
        long now = clock.now();
        List<BufferKey> toFlush = new ArrayList<>();
        for (Map.Entry<BufferKey, BufferEntry> e : buffers.entrySet()) {
            if (e.getKey().windowId != currentWindowId && e.getValue().len > 0) {
                toFlush.add(e.getKey());
            }
        }
        for (BufferKey key : toFlush) {
            flushEntry(key, now);
        }
    }

    synchronized void onFocusChanged(int currentWindowId, int currentViewId) {
        long now = clock.now();
        List<BufferKey> toFlush = new ArrayList<>();
        for (Map.Entry<BufferKey, BufferEntry> e : buffers.entrySet()) {
            BufferKey k = e.getKey();
            if ((k.windowId != currentWindowId || k.viewId != currentViewId) && e.getValue().len > 0) {
                toFlush.add(k);
            }
        }
        for (BufferKey key : toFlush) {
            flushEntry(key, now);
        }
    }

    private void flushEntry(BufferKey key, long now) {
        BufferEntry entry = buffers.get(key);
        if (entry == null || entry.len == 0) return;

        char[] copy = Arrays.copyOf(entry.buf, entry.len);
        try {
            if (sink != null) {
                sink.enqueue(entry.appCategory, copy, now);
            }
        } finally {
            entry.zeroFill();
            buffers.remove(key);
        }
    }

    synchronized void clear() {
        for (BufferEntry e : buffers.values()) {
            e.zeroFill();
        }
        buffers.clear();
    }

    synchronized void clear(String pkg, int viewId) {
        if (pkg == null) return;
        Iterator<Map.Entry<BufferKey, BufferEntry>> it = buffers.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<BufferKey, BufferEntry> entry = it.next();
            BufferKey k = entry.getKey();
            if (pkg.equals(k.pkg) && (viewId == 0 || k.viewId == viewId)) {
                entry.getValue().zeroFill();
                it.remove();
            }
        }
    }

    synchronized int size() {
        return buffers.size();
    }
}
