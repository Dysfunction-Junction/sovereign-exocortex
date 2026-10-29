package com.pieces.android.companion;

import android.content.Context;

/** A3 owns this (mic speech-present yes/no, ANDROID_SENSITIVE_CAPTURE_DESIGN section 2). SH stub: signatures only. */
final class MicWindowSampler {
    private MicWindowSampler() {}

    static void start(Context ctx) {}

    static void stop() {}

    /** Called on every consent change; must stop within the same main-looper turn when mic_speech goes off. */
    static void onConsentChanged(Context ctx) {}
}
