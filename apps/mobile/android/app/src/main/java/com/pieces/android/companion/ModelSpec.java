package com.pieces.android.companion;

public final class ModelSpec {
    public static final String FILE = "gemma3-1b-it-int4.litertlm";
    // Awaiting the user's licensed artifact. Never substitute a fabricated pin.
    public static final long EXPECTED_SIZE = 584417280L;
    public static final String EXPECTED_SHA256 = "";
    final long size;
    final String sha256;

    public ModelSpec() { this(EXPECTED_SIZE, EXPECTED_SHA256); }
    public ModelSpec(long size, String sha256) { this.size = size; this.sha256 = sha256; }
    public boolean valid() {
        return size > 0 && sha256 != null && sha256.matches("[0-9a-f]{64}")
                && !sha256.matches("(.)\\1{63}");
    }
    String internalName() {
        if (!valid()) throw new IllegalStateException("MODEL_PIN_REQUIRED");
        return "gemma3-1b-it-int4." + sha256.substring(0, 8) + ".litertlm";
    }
}
