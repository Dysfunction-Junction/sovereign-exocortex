package com.pieces.android.companion;

import java.util.*;
import java.util.concurrent.*;

final class FakeBackend implements LlmBackend {
    final List<String> nativeThreads = Collections.synchronizedList(new ArrayList<>());
    final CountDownLatch entered = new CountDownLatch(1), unblock = new CountDownLatch(1);
    volatile int inits, generations, closes, cancels;
    volatile boolean block, ignoreCancel, failInit;
    private void nativeCall() { nativeThreads.add(Thread.currentThread().getName()); }
    public void init() throws LlmException {
        nativeCall(); inits++;
        if (failInit) throw new LlmException(LlmException.Kind.FAILED);
    }
    public String generate(String prompt, int maxOutTokens) {
        nativeCall(); generations++; entered.countDown();
        if (block) {
            boolean done = false;
            while (!done) {
                try { unblock.await(); done = true; }
                catch (InterruptedException e) { if (!ignoreCancel) done = true; }
            }
        }
        return "{}";
    }
    public void cancelCurrent() { cancels++; if (!ignoreCancel) unblock.countDown(); }
    public void close() { nativeCall(); closes++; }
}
