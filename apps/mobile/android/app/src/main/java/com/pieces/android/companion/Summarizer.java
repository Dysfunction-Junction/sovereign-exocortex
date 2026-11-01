package com.pieces.android.companion;

/**
 * Common seam for on-device text summarization.
 * In A5-1 this is model-free; FakeSummarizer is used in tests, and release runs fail safe.
 */
interface Summarizer {
    /** Blocking, called on the worker thread only. Returns raw model text, or throws SummarizerException. */
    String summarize(String prompt, long timeoutMs) throws SummarizerException;

    /** Cheap, non-blocking. False means every flush is dropped with reason summarizer_unavailable. */
    boolean isReady();

    /** Free native memory. Safe to call repeatedly. */
    void release();
}

final class SummarizerException extends Exception {
    enum Reason { UNAVAILABLE, BUSY, TIMEOUT, BLOCKED, OOM, THERMAL, FAILED,
        WARMING, CLOSED, WEDGED, POWER, PROMPT_TOO_LONG }
    final Reason reason;

    SummarizerException(Reason reason) {
        super(reason.name());
        this.reason = reason;
    }

    SummarizerException(Reason reason, String message) {
        super(message);
        this.reason = reason;
    }

    SummarizerException(Reason reason, Throwable cause) {
        super(reason.name(), cause);
        this.reason = reason;
    }
}
