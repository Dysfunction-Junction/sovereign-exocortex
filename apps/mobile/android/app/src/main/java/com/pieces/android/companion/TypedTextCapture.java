package com.pieces.android.companion;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.Looper;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import java.lang.ref.WeakReference;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Capture hook for typed-text summaries and typing rhythm (A5-1 Section 4.9).
 * Consumes TYPE_VIEW_TEXT_CHANGED events; gates on consent, keyguard, policy, and field type.
 */
final class TypedTextCapture {
    private static WeakReference<AccessibilityService> sServiceRef;
    private static Handler sFlushHandler;
    private static final long IDLE_POLL_INTERVAL_MS = 2000L;

    private static final Runnable sIdleCheckRunnable = new Runnable() {
        @Override
        public void run() {
            try {
                TypedTextBuffer.getInstance().checkIdleAndMaxAgeFlushes();
            } catch (Exception ignored) {}
            if (sFlushHandler != null) {
                sFlushHandler.postDelayed(this, IDLE_POLL_INTERVAL_MS);
            }
        }
    };

    private TypedTextCapture() {}

    static synchronized void start(Context ctx) {
        if (ctx == null) return;
        TypedTextGate.init(ctx);
        TypedTextCounters.init(ctx);
        if (ctx instanceof AccessibilityService) {
            sServiceRef = new WeakReference<>((AccessibilityService) ctx);
        }
        if (sFlushHandler == null) {
            sFlushHandler = new Handler(Looper.getMainLooper());
            sFlushHandler.postDelayed(sIdleCheckRunnable, IDLE_POLL_INTERVAL_MS);
        }
        applyServiceInfo(ctx);
    }

    static synchronized void stop() {
        if (sFlushHandler != null) {
            sFlushHandler.removeCallbacksAndMessages(null);
            sFlushHandler = null;
        }
        TypedTextBuffer.clearAll();
    }

    static synchronized void onConsentChanged(Context ctx) {
        if (ctx == null) return;
        TypedTextGate.init(ctx);
        applyServiceInfo(ctx);
    }

    static void setService(AccessibilityService service) {
        sServiceRef = new WeakReference<>(service);
        applyServiceInfo(service);
    }

    static void removeTextEvents() {
        if (sServiceRef != null) {
            AccessibilityService svc = sServiceRef.get();
            if (svc != null) {
                boolean rhythmOn = SensorConsentPlugin.isEnabled(svc, SensorCapabilities.KEY_TYPING_RHYTHM);
                if (!rhythmOn) {
                    modifyServiceEventTypes(svc, false);
                }
            }
        }
    }

    private static void applyServiceInfo(Context ctx) {
        if (sServiceRef == null) return;
        AccessibilityService svc = sServiceRef.get();
        if (svc == null) return;

        boolean textOn = TypedTextGate.isOn();
        boolean rhythmOn = SensorConsentPlugin.isEnabled(ctx, SensorCapabilities.KEY_TYPING_RHYTHM);
        modifyServiceEventTypes(svc, textOn || rhythmOn);
    }

    private static void modifyServiceEventTypes(AccessibilityService svc, boolean enableTextChange) {
        try {
            AccessibilityServiceInfo info = svc.getServiceInfo();
            if (info != null) {
                int oldTypes = info.eventTypes;
                if (enableTextChange) {
                    info.eventTypes |= AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED;
                } else {
                    info.eventTypes &= ~AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED;
                }
                if (info.eventTypes != oldTypes) {
                    svc.setServiceInfo(info);
                }
            }
        } catch (Exception ignored) {}
    }

    private static final Map<String, String> sAppLabelCache = new ConcurrentHashMap<>();

    private static String getAppLabel(Context context, String pkg) {
        if (pkg == null || pkg.isEmpty() || context == null) return "";
        String cached = sAppLabelCache.get(pkg);
        if (cached != null) return cached;
        try {
            PackageManager pm = context.getPackageManager();
            ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
            CharSequence label = pm.getApplicationLabel(ai);
            String str = label != null ? label.toString() : "";
            sAppLabelCache.put(pkg, str);
            return str;
        } catch (Exception e) {
            sAppLabelCache.put(pkg, "");
            return "";
        }
    }

    /**
     * Intercepts accessibility events before getSource() or extraction.
     * Consumes TYPE_VIEW_TEXT_CHANGED by returning true. Window state and focus events return false.
     */
    static boolean intercept(AccessibilityService service, AccessibilityEvent event) {
        if (event == null || service == null) return false;
        if (sServiceRef == null || sServiceRef.get() == null) {
            sServiceRef = new WeakReference<>(service);
        }

        int eventType = event.getEventType();

        if (eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            TypedTextBuffer.getInstance().onWindowChanged(event.getWindowId());
            return false;
        }

        if (eventType == AccessibilityEvent.TYPE_VIEW_FOCUSED) {
            TypedTextBuffer.getInstance().onFocusChanged(event.getWindowId(), event.getSource() != null ? event.getSource().hashCode() : 0);
            return false;
        }

        if (eventType != AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED) {
            return false;
        }

        // Gate 1: Both typed_text and typing_rhythm off -> do not consume
        boolean typedTextOn = TypedTextGate.isOn();
        boolean typingRhythmOn = SensorConsentPlugin.isEnabled(service, SensorCapabilities.KEY_TYPING_RHYTHM);
        if (!typedTextOn && !typingRhythmOn) {
            return false;
        }

        // Gate 2: Keyguard locked -> drop
        KeyguardManager km = (KeyguardManager) service.getSystemService(Context.KEYGUARD_SERVICE);
        if (km != null && km.isKeyguardLocked()) {
            return true;
        }

        // Gate 3: Package validity & password event check
        if (event.getPackageName() == null) {
            return true;
        }
        String pkg = event.getPackageName().toString().trim();
        if (pkg.isEmpty()) {
            return true;
        }

        if (event.isPassword()) {
            return true;
        }

        // Gate 4: Resolve app label and apply exclusion policy
        String label = getAppLabel(service, pkg);
        if (TypedTextPolicy.excluded(pkg, label)) {
            AccessibilityNodeInfo src = event.getSource();
            int viewId = src != null ? src.hashCode() : 0;
            TypedTextBuffer.getInstance().clear(pkg, viewId);
            return true;
        }

        // Gate 5: If only typing_rhythm is on, read counts only, never text
        if (!typedTextOn && typingRhythmOn) {
            int added = event.getAddedCount();
            int removed = event.getRemovedCount();
            // Rhythm processing only (counts only, no content)
            return true;
        }

        // Gate 6: Reject unknown sources (fail closed if AccessibilityNodeInfo unavailable)
        AccessibilityNodeInfo source = event.getSource();
        if (source == null) {
            return true;
        }

        String className = source.getClassName() != null ? source.getClassName().toString() : "";
        CharSequence hint = source.getHintText();
        String hintText = hint != null ? hint.toString() : "";
        TypedTextPolicy.FieldInfo fi = new TypedTextPolicy.FieldInfo(
            className,
            source.getInputType(),
            source.isPassword(),
            hintText
        );
        int viewId = source.hashCode();
        if (TypedTextPolicy.fieldSkipped(fi)) {
            TypedTextBuffer.getInstance().clear(pkg, viewId);
            return true;
        }

        // Text extraction and buffering
        List<CharSequence> texts = event.getText();
        if (texts == null || texts.isEmpty()) {
            // Field cleared: wipe buffered entry immediately
            TypedTextBuffer.getInstance().clear(pkg, viewId);
            return true;
        }

        CharSequence text = texts.get(0);
        if (text == null || text.length() == 0) {
            // User erased/deleted text: erase buffer immediately
            TypedTextBuffer.getInstance().clear(pkg, viewId);
            return true;
        }

        int windowId = event.getWindowId();
        String category = TypedTextPolicy.category(pkg);
        TypedTextCounters.bump("captured");
        TypedTextBuffer.getInstance().update(pkg, windowId, viewId, text, category);

        return true;
    }
}
