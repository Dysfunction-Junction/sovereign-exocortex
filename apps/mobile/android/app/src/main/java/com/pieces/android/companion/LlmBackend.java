package com.pieces.android.companion;

/** Blocking port. init/generate/close belong to litertlm-owner; cancellation is cross-thread. */
public interface LlmBackend extends AutoCloseable {
    void init() throws LlmException;
    String generate(String prompt, int maxOutTokens) throws LlmException;
    void cancelCurrent();
    @Override void close();
}
