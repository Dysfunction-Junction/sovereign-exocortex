package com.pieces.android.companion;

/**
 * Test double for Summarizer (A5-1 Section 4.1).
 * Lives strictly in src/test; never ships in production.
 */
final class FakeSummarizer implements Summarizer {
    boolean ready = true;
    boolean released = false;
    String response = "{\"intent\":\"plan\",\"topics\":[\"planning\"],\"entity_types\":[\"product\"],\"summary\":\"Plan a trip\"}";
    SummarizerException throwOnSummarize;
    long lastTimeoutMs;
    String lastPrompt;
    int summarizeCalls = 0;
    Runnable onSummarizeHook;

    @Override
    public String summarize(String prompt, long timeoutMs) throws SummarizerException {
        summarizeCalls++;
        lastPrompt = prompt;
        lastTimeoutMs = timeoutMs;
        if (onSummarizeHook != null) {
            onSummarizeHook.run();
        }
        if (throwOnSummarize != null) {
            throw throwOnSummarize;
        }
        return response;
    }

    @Override
    public boolean isReady() {
        return ready && !released;
    }

    @Override
    public void release() {
        released = true;
    }
}
