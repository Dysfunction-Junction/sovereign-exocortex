package com.pieces.android.companion;

import android.app.Notification;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import org.json.JSONArray;
import org.json.JSONObject;

import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.Deque;

/**
 * Part 1 of the capture stack: a system-wide notification listener.
 *
 * Breadth over depth — one stream of every app's notifications (SMS, chat,
 * email, Slack…), forward-only and event-driven. Preview text only; thread
 * history and collapsed-group detail are lost (that's what READ_SMS backfill
 * is for, on texts specifically).
 *
 * Same trust model as PiecesAccessibilityService:
 *  - fail-closed on a master pref (notification_capture_enabled)
 *  - AccessibilityPlugin.isExcluded() denylist applies (banking OTPs, 2FA, etc.)
 *  - forwarded to JS only via a volatile listener set by NotificationPlugin;
 *    null listener = capture silently skipped.
 *
 * Enabling the listener itself is the OS grant
 * (enabled_notification_listeners) — done via the system settings screen
 * (NotificationPlugin.openSettings). This service does nothing until that
 * grant exists AND the pref is on.
 */
public class NotificationCaptureService extends NotificationListenerService {

    private static final int DEDUPE_HISTORY_SIZE = 30;
    private static final int MAX_TEXT_CHARS = 4_000;

    private static final java.util.regex.Pattern OTP_KEYWORD_PATTERN = java.util.regex.Pattern.compile(
        "\\b(?:code|otp|verification|verify|pin|password|token|auth|login|security)\\b",
        java.util.regex.Pattern.CASE_INSENSITIVE
    );

    private static final java.util.regex.Pattern OTP_CODE_PATTERN = java.util.regex.Pattern.compile(
        "\\b(?:[Gg]-)?\\d{3,4}[- ]?\\d{3,4}\\b|\\b\\d{4,8}\\b"
    );

    private static String redactOtpIfContextMatches(String text, boolean contextHasOtpKeyword) {
        if (text == null || text.isEmpty()) return "";
        if (!contextHasOtpKeyword && !OTP_KEYWORD_PATTERN.matcher(text).find()) {
            return text;
        }
        return OTP_CODE_PATTERN.matcher(text).replaceAll("[REDACTED_OTP]");
    }

    public interface NotificationCaptureListener {
        void onNotification(String packageName, String appLabel, String title, String text, long postedAt);
    }
    public static volatile NotificationCaptureListener listener;

    private final Deque<String> recentHashes = new ArrayDeque<>(DEDUPE_HISTORY_SIZE);

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        if (sbn == null) return;
        if (!isCaptureEnabled()) return;

        final Notification n = sbn.getNotification();
        if (n == null) return;

        // Skip the noise: ongoing (music, downloads), foreground-service, and
        // group-summary rows (the summary carries no real content; the child
        // notifications do).
        if (sbn.isOngoing()) return;
        if ((n.flags & Notification.FLAG_FOREGROUND_SERVICE) != 0) return;
        if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;
        if (Notification.CATEGORY_SERVICE.equals(n.category)) return;
        if (Notification.CATEGORY_TRANSPORT.equals(n.category)) return;
        if (Notification.CATEGORY_PROGRESS.equals(n.category)) return;

        final String pkg = sbn.getPackageName();
        if (pkg == null || pkg.isEmpty()) return;
        if (pkg.equals(getPackageName())) return;

        final String label = appLabel(pkg);

        // The one privacy guard for this source — the accessibility service's
        // "foreground app only" containment does not apply here.
        if (AccessibilityPlugin.isExcluded(pkg, label)) return;

        // Optional narrowing: if the user picked specific apps in the picker,
        // honor that here too unless they flipped the "all apps" widen toggle.
        if (!captureAllApps() && !isInAllowlist(pkg)) return;

        // Privacy / Lock Screen Defense: Secret notifications must NEVER be captured
        if (n.visibility == Notification.VISIBILITY_SECRET) return;

        Bundle extras = n.extras;
        if (extras == null) return;

        final String rawTitle = str(extras.getCharSequence(Notification.EXTRA_TITLE));
        String rawText = str(extras.getCharSequence(Notification.EXTRA_BIG_TEXT));
        if (rawText.isEmpty()) rawText = str(extras.getCharSequence(Notification.EXTRA_TEXT));
        final String sub = str(extras.getCharSequence(Notification.EXTRA_SUB_TEXT));

        if (rawTitle.isEmpty() && rawText.isEmpty()) return;

        String rawBody = rawText;
        if (!sub.isEmpty()) rawBody = sub + " \u2014 " + rawBody;
        if (rawBody.length() > MAX_TEXT_CHARS) rawBody = rawBody.substring(0, MAX_TEXT_CHARS);

        // Security / PII Defense: Context-aware redaction of one-time passwords and verification codes
        boolean hasOtpContext = OTP_KEYWORD_PATTERN.matcher(rawTitle).find() || OTP_KEYWORD_PATTERN.matcher(rawBody).find();
        final String title = redactOtpIfContextMatches(rawTitle, hasOtpContext);
        final String body = redactOtpIfContextMatches(rawBody, hasOtpContext);

        // Notifications re-post on every update (typing indicator, edited
        // message, +1 unread). Dedupe on (pkg, key, content) within a recent
        // window — same approach as PiecesAccessibilityService.recentPushHashes.
        final String hash = sha256(pkg + "|" + sbn.getKey() + "|" + title + "|" + body);
        if (recentHashes.contains(hash)) return;
        recentHashes.addLast(hash);
        while (recentHashes.size() > DEDUPE_HISTORY_SIZE) recentHashes.removeFirst();

        JSONArray actionsArray = new JSONArray();
        if (n.actions != null) {
            int maxActions = Math.min(n.actions.length, 8);
            for (int i = 0; i < maxActions; i++) {
                Notification.Action action = n.actions[i];
                if (action == null || action.actionIntent == null) continue;
                CharSequence actionTitle = action.title;
                if (actionTitle == null || actionTitle.length() == 0) continue;
                String actTitle = actionTitle.toString().trim();
                if (actTitle.length() > 64) actTitle = actTitle.substring(0, 64);
                String actionId = "act_" + java.util.UUID.randomUUID().toString().substring(0, 12);
                NotificationActionRegistry.register(actionId, action.actionIntent);
                try {
                    JSONObject actObj = new JSONObject();
                    actObj.put("action_id", actionId);
                    actObj.put("title", actTitle);
                    actionsArray.put(actObj);
                } catch (Exception ignored) {}
            }
        }

        final NotificationCaptureListener l = listener;
        if (l != null) l.onNotification(pkg, label, title, body, sbn.getPostTime());

        // Native durable outbox + background HTTP sync (independent of whether UI app is open)
        NativeTelemetrySync.queueNotification(this, pkg, label, title, body, sbn.getPostTime(), actionsArray);
    }

    @Override
    public void onListenerConnected() {
        super.onListenerConnected();
        NativeTelemetrySync.warmUpDatabaseAsync(this);
        NativeTelemetrySync.flushAsync(this);
    }

    // We don't act on removals — forward-only by design.
    @Override
    public void onNotificationRemoved(StatusBarNotification sbn) { }

    private boolean isCaptureEnabled() {
        return prefs().getBoolean(NotificationPlugin.CAPTURE_ENABLED_KEY, false);
    }

    private boolean captureAllApps() {
        return prefs().getBoolean(NotificationPlugin.CAPTURE_ALL_APPS_KEY, false);
    }

    private boolean isInAllowlist(String pkg) {
        return prefs().getStringSet(AccessibilityPlugin.ALLOWLIST_KEY, new java.util.HashSet<>()).contains(pkg);
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(AccessibilityPlugin.PREFS_NAME, MODE_PRIVATE);
    }

    private final java.util.Map<String, String> labelCache = new java.util.HashMap<>();

    private String appLabel(String pkg) {
        String cached = labelCache.get(pkg);
        if (cached != null || labelCache.containsKey(pkg)) return cached != null ? cached : pkg;
        String label = pkg;
        try {
            android.content.pm.PackageManager pm = getPackageManager();
            label = pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString();
        } catch (android.content.pm.PackageManager.NameNotFoundException ignored) {}
        labelCache.put(pkg, label);
        return label;
    }

    private static String str(CharSequence cs) {
        return cs == null ? "" : cs.toString().trim();
    }

    private static String sha256(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] h = md.digest(s.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : h) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return s;
        }
    }
}
