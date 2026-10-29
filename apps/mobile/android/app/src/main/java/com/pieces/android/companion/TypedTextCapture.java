package com.pieces.android.companion;

import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.view.accessibility.AccessibilityEvent;

/** A5 owns this (typed-text summaries and typing counts, ANDROID_SENSITIVE_CAPTURE_DESIGN section 4). SH stub. */
final class TypedTextCapture {
    private TypedTextCapture() {}

    /** True when the event was consumed. The stub never consumes, so existing behavior is unchanged. */
    static boolean intercept(AccessibilityService service, AccessibilityEvent event) {
        return false;
    }

    static void start(Context ctx) {}

    static void stop() {}

    static void onConsentChanged(Context ctx) {}
}
