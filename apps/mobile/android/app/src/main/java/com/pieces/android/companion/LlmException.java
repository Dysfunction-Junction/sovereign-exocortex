package com.pieces.android.companion;

/** Deliberately excludes native messages/causes, which may contain input text. */
public final class LlmException extends Exception {
    public enum Kind { NOT_INIT, FAILED }
    public final Kind kind;
    public LlmException(Kind kind) { super(kind.name()); this.kind = kind; }
}
