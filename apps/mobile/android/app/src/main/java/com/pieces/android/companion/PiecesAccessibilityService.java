package com.pieces.android.companion;

import android.accessibilityservice.AccessibilityService;
import android.app.KeyguardManager;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.textclassifier.TextClassification;
import android.view.textclassifier.TextClassificationManager;
import android.view.textclassifier.TextClassifier;
import android.view.textclassifier.TextLinks;
import org.json.JSONArray;
import org.json.JSONObject;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class PiecesAccessibilityService extends AccessibilityService {

    public static volatile boolean isRunning = false;

    // A static buffer to hold the most recently extracted text blocks across the OS
    public static List<String> lastCapturedText = new ArrayList<>();
    public static String lastCapturedPackage = "";

    // Tracking state for system suggestion decisions (acceptance rate and dwell latency)
    private volatile long lastSuggestionShownAt = 0;
    private volatile String lastSuggestedAction = null;
    private volatile String lastSuggestionPackage = null;
    private final Set<String> lastSuggestedEntityValues = new HashSet<>();

    // Debounce settle time for passive mode: wait this long after the last
    // accessibility event before treating the screen as "settled" and
    // considering a push. Avoids firing on every keystroke/scroll.
    private static final long DEBOUNCE_MS = 2000;

    // Bounds on extractText: without these, a deeply nested or huge webview
    // tree produces an unbounded string that gets hashed and pushed whole.
    private static final int MAX_NODE_DEPTH = 40;
    private static final int MAX_TEXT_CHARS = 20_000;

    // How many recent (package, hash) pushes to remember per debounce cycle.
    // A single "last pushed" value is defeated by flicker between two states
    // (e.g. bouncing between two scroll positions); a small ring buffer
    // catches repeats within a short recent window instead of just the
    // immediately-previous one.
    private static final int DEDUPE_HISTORY_SIZE = 15;

    private final Handler debounceHandler = new Handler(Looper.getMainLooper());
    private Runnable pendingPush;
    private final Deque<String> recentPushHashes = new ArrayDeque<>(DEDUPE_HISTORY_SIZE);

    // Set by AccessibilityPlugin when the JS layer wants passive-mode pushes
    // delivered as they're debounced, instead of only on-demand via
    // getActiveScreenText(). Null when nobody's listening (e.g. plugin not
    // yet initialized) — pushes are simply skipped, buffer still updates.
    public interface PassiveCaptureListener {
        void onCapture(String packageName, String text);
    }
    public static volatile PassiveCaptureListener passiveListener;

    private ClipboardManager clipboardManager;
    private ClipboardManager.OnPrimaryClipChangedListener clipListener;
    private String lastClipContentHash = null;

    private static final Pattern UPS_TRACKING_PATTERN = Pattern.compile("\\b(1Z[0-9A-Z]{16})\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern USPS_TRACKING_PATTERN = Pattern.compile("\\b(9[234]\\d{20}|94\\d{20}|70\\d{18})\\b");
    private static final Pattern FEDEX_TRACKING_PATTERN = Pattern.compile("\\b(\\d{12}|\\d{15}|\\d{20}|\\d{22})\\b");
    private static final Pattern URL_PATTERN = Pattern.compile("^(https?://[\\w\\-\\.]+(?:[/?#]\\S*)?)$", Pattern.CASE_INSENSITIVE);
    private static final Pattern EMAIL_PATTERN = Pattern.compile("^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$");
    private static final Pattern PHONE_PATTERN = Pattern.compile("^(\\+?[0-9\\s\\-\\(\\)]{10,20})$");

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null || event.getSource() == null) return;

        // Master switch mirrored from the JS-side Setup toggle (config.ts's
        // screenContextEnabled) — fail-closed if the flag has never been
        // written, so a fresh install captures nothing until explicitly
        // opted in from Setup, not just because Accessibility is granted.
        if (!isScreenContextEnabled()) return;

        // Never capture off the lock screen — notification previews (SMS,
        // email, chat) render as real accessibility content there even
        // though the user hasn't unlocked or interacted with anything.
        if (isLocked()) return;

        String packageName = event.getPackageName() != null ? event.getPackageName().toString() : "";
        if (!isAllowed(packageName)) return;

        // If this is a click event, check whether it constitutes accepting an active suggestion
        if (event.getEventType() == AccessibilityEvent.TYPE_VIEW_CLICKED) {
            AccessibilityNodeInfo source = event.getSource();
            if (source != null && source.isPassword()) {
                source.recycle();
                return;
            }
            if (source != null) {
                source.recycle();
            }

            if (lastSuggestionShownAt > 0 && lastSuggestedAction != null && lastSuggestionPackage != null) {
                long dwellMs = SystemClock.elapsedRealtime() - lastSuggestionShownAt;
                if (dwellMs >= 0 && dwellMs < 300_000 && lastSuggestionPackage.equals(packageName)) {
                    CharSequence eventText = (event.getText() != null && !event.getText().isEmpty()) ? event.getText().get(0) : null;
                    String cd = event.getContentDescription() != null ? event.getContentDescription().toString() : "";
                    boolean matched = false;
                    synchronized (lastSuggestedEntityValues) {
                        for (String val : lastSuggestedEntityValues) {
                            if (val != null && !val.isEmpty()) {
                                String lowerVal = val.toLowerCase(Locale.ROOT);
                                if ((eventText != null && eventText.toString().toLowerCase(Locale.ROOT).contains(lowerVal))
                                        || cd.toLowerCase(Locale.ROOT).contains(lowerVal)) {
                                    matched = true;
                                    break;
                                }
                            }
                        }
                    }
                    if (matched) {
                        String appLabel = labelCache.get(packageName);
                        if (appLabel == null) appLabel = packageName;
                        NativeTelemetrySync.queueSuggestionDecision(
                            this,
                            lastSuggestionPackage,
                            appLabel,
                            lastSuggestedAction,
                            "ACCEPTED",
                            dwellMs
                        );
                        lastSuggestedAction = null;
                        lastSuggestionShownAt = 0;
                        synchronized (lastSuggestedEntityValues) {
                            lastSuggestedEntityValues.clear();
                        }
                    }
                }
            }
            // Return immediately for clicks to prevent walking entire node hierarchy on every touch
            return;
        }

        AccessibilityNodeInfo rootNode = event.getSource();
        List<String> extractedTexts = new ArrayList<>();
        try {
            extractText(rootNode, extractedTexts, 0, new int[]{0}, new boolean[]{false});
        } finally {
            rootNode.recycle();
        }

        if (extractedTexts.isEmpty()) return;

        lastCapturedPackage = packageName;
        lastCapturedText = extractedTexts;

        if (isPassiveModeEnabled()) {
            scheduleDebouncedPush(packageName, String.join("\n", extractedTexts));
        }
    }

    private void scheduleDebouncedPush(String packageName, String text) {
        if (pendingPush != null) debounceHandler.removeCallbacks(pendingPush);
        pendingPush = () -> {
            // Dedupe against a normalized hash rather than the raw string, and
            // against a small recent-history window rather than only the last
            // push — scrolling shifts whitespace/ordering without changing
            // content, and flicker between two states defeats a single-value
            // comparison.
            String hash = normalizedHash(packageName, text);
            if (recentPushHashes.contains(hash)) return;
            recentPushHashes.addLast(hash);
            while (recentPushHashes.size() > DEDUPE_HISTORY_SIZE) recentPushHashes.removeFirst();

            String appLabel = labelCache.get(packageName);
            if (appLabel == null) appLabel = packageName;

            // Prior suggestion expired or replaced without acceptance
            if (lastSuggestionShownAt > 0 && lastSuggestedAction != null) {
                long dwellMs = SystemClock.elapsedRealtime() - lastSuggestionShownAt;
                if (dwellMs >= 3000 && dwellMs < 300_000) {
                    NativeTelemetrySync.queueSuggestionDecision(
                        PiecesAccessibilityService.this,
                        lastSuggestionPackage != null ? lastSuggestionPackage : packageName,
                        appLabel,
                        lastSuggestedAction,
                        "IGNORED",
                        dwellMs
                    );
                }
                lastSuggestedAction = null;
                lastSuggestionShownAt = 0;
                synchronized (lastSuggestedEntityValues) {
                    lastSuggestedEntityValues.clear();
                }
            }

            // Extract on-device entities & system suggestions via TextClassifier
            ClassifierResult result = extractEntitiesAndSuggestions(text);
            JSONArray extractedEntities = result != null ? result.entities : null;
            JSONArray contextualSuggestions = result != null ? result.suggestions : null;

            if (contextualSuggestions != null && contextualSuggestions.length() > 0) {
                lastSuggestionShownAt = SystemClock.elapsedRealtime();
                lastSuggestedAction = contextualSuggestions.optString(0);
                lastSuggestionPackage = packageName;
                synchronized (lastSuggestedEntityValues) {
                    lastSuggestedEntityValues.clear();
                    if (result.rawEntityValues != null) {
                        lastSuggestedEntityValues.addAll(result.rawEntityValues);
                    }
                }
            }

            // Native durable outbox + background HTTP sync (runs independently of whether UI app is open)
            NativeTelemetrySync.queueScreenCapture(
                PiecesAccessibilityService.this,
                packageName,
                appLabel,
                text,
                extractedEntities,
                contextualSuggestions
            );

            PassiveCaptureListener listener = passiveListener;
            if (listener != null) listener.onCapture(packageName, text);
        };
        debounceHandler.postDelayed(pendingPush, DEBOUNCE_MS);
    }

    private static class ClassifierResult {
        final JSONArray entities;
        final JSONArray suggestions;
        final Set<String> rawEntityValues;

        ClassifierResult(JSONArray entities, JSONArray suggestions, Set<String> rawEntityValues) {
            this.entities = entities;
            this.suggestions = suggestions;
            this.rawEntityValues = rawEntityValues;
        }
    }

    private static final int MAX_ENTITIES = 16;
    private static final int MAX_ENTITY_VALUE_LENGTH = 128;

    private ClassifierResult extractEntitiesAndSuggestions(String text) {
        if (text == null || text.trim().isEmpty() || Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            return null;
        }
        try {
            TextClassificationManager tcm = (TextClassificationManager) getSystemService(Context.TEXT_CLASSIFICATION_SERVICE);
            if (tcm == null) return null;
            TextClassifier classifier = tcm.getTextClassifier();
            if (classifier == null) return null;

            String sample = text.length() > 1500 ? text.substring(0, 1500) : text;
            TextLinks.Request request = new TextLinks.Request.Builder(sample).build();
            TextLinks links = classifier.generateLinks(request);
            if (links == null || links.getLinks().isEmpty()) return null;

            JSONArray entitiesJson = new JSONArray();
            JSONArray suggestionsJson = new JSONArray();
            Set<String> suggestionSet = new HashSet<>();
            Set<String> rawValues = new HashSet<>();
            int count = 0;

            for (TextLinks.TextLink link : links.getLinks()) {
                if (count >= MAX_ENTITIES) break;
                int start = link.getStart();
                int end = link.getEnd();
                if (start < 0 || end > sample.length() || start >= end) continue;
                String value = sample.substring(start, end).trim();
                if (value.isEmpty() || value.length() > MAX_ENTITY_VALUE_LENGTH) continue;

                for (int i = 0; i < link.getEntityCount(); i++) {
                    if (count >= MAX_ENTITIES) break;
                    String entityType = link.getEntity(i);
                    float confidence = link.getConfidenceScore(entityType);
                    if (confidence < 0.6f) continue;

                    rawValues.add(value);

                    JSONObject entObj = new JSONObject();
                    entObj.put("type", entityType);
                    // PII Protection: hash sensitive values before appending to immutable outbox/event log
                    if (TextClassifier.TYPE_PHONE.equals(entityType)
                            || TextClassifier.TYPE_EMAIL.equals(entityType)
                            || TextClassifier.TYPE_ADDRESS.equals(entityType)) {
                        entObj.put("value", hashPii(value));
                        entObj.put("is_redacted", true);
                    } else {
                        entObj.put("value", value);
                    }
                    entObj.put("confidence", (double) confidence);
                    entitiesJson.put(entObj);
                    count++;

                    // Map entity directly to canonical action recommendation
                    String action = mapEntityToAction(entityType);
                    if (action != null && !suggestionSet.contains(action)) {
                        suggestionSet.add(action);
                        suggestionsJson.put(action);
                    }
                }
            }

            if (entitiesJson.length() == 0 && suggestionsJson.length() == 0) return null;
            return new ClassifierResult(
                entitiesJson.length() > 0 ? entitiesJson : null,
                suggestionsJson.length() > 0 ? suggestionsJson : null,
                rawValues
            );
        } catch (Throwable t) {
            return null;
        }
    }

    private static String mapEntityToAction(String entityType) {
        if (TextClassifier.TYPE_URL.equals(entityType)) return "open_url";
        if (TextClassifier.TYPE_PHONE.equals(entityType)) return "call_phone";
        if (TextClassifier.TYPE_ADDRESS.equals(entityType)) return "view_map";
        if (TextClassifier.TYPE_FLIGHT_NUMBER.equals(entityType)) return "track_flight";
        if (TextClassifier.TYPE_DATE.equals(entityType) || TextClassifier.TYPE_DATE_TIME.equals(entityType)) return "view_calendar";
        return null;
    }

    private static String hashPii(String raw) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hashBytes = digest.digest(raw.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder("sha256:");
            for (int i = 0; i < Math.min(hashBytes.length, 8); i++) {
                sb.append(String.format("%02x", hashBytes[i]));
            }
            return sb.toString();
        } catch (Exception e) {
            return "[REDACTED]";
        }
    }

    // Collapses whitespace and sorts text nodes so that content re-ordering
    // (e.g. list items shifting position during scroll) doesn't produce a
    // different hash for what is semantically the same screen content.
    private static String normalizedHash(String packageName, String text) {
        String[] lines = text.split("\n");
        for (int i = 0; i < lines.length; i++) {
            lines[i] = lines[i].trim().replaceAll("\\s+", " ");
        }
        Arrays.sort(lines);
        String normalized = packageName + "|" + String.join("\n", lines);

        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hashBytes = digest.digest(normalized.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : hashBytes) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            // SHA-256 is guaranteed available on Android; this is unreachable
            // in practice. Fall back to the normalized string itself so
            // dedup still functions rather than throwing.
            return normalized;
        }
    }

    private boolean isLocked() {
        KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
        return km == null || km.isKeyguardLocked();
    }

    private boolean isScreenContextEnabled() {
        SharedPreferences prefs = getSharedPreferences(AccessibilityPlugin.PREFS_NAME, MODE_PRIVATE);
        return prefs.getBoolean(AccessibilityPlugin.SCREEN_CONTEXT_ENABLED_KEY, false);
    }

    private boolean isPassiveModeEnabled() {
        SharedPreferences prefs = getSharedPreferences(AccessibilityPlugin.PREFS_NAME, MODE_PRIVATE);
        return prefs.getBoolean(AccessibilityPlugin.PASSIVE_MODE_KEY, false);
    }

    // Small cache so the label-based exclusion check (see isExcluded's comment
    // on why label matters, not just package id) doesn't do a fresh
    // PackageManager lookup on every single accessibility event — app
    // identity/label doesn't change at runtime, so caching by package name is
    // safe. Unbounded growth isn't a real concern: bounded by how many
    // distinct packages actually fire accessibility events on the device.
    private final java.util.Map<String, String> labelCache = new java.util.HashMap<>();

    // Only capture from packages the user explicitly selected via the app picker
    // (AccessibilityPlugin.setAllowlist) — this service is system-wide by platform
    // design (any app can fire a window event), so this check is the only thing
    // standing between "capture text from whatever's on screen" and "capture text
    // from apps the user actually opted into."
    private boolean isAllowed(String packageName) {
        if (packageName.isEmpty()) return false;
        // Hard denylist enforced independently of the user's saved allowlist —
        // see AccessibilityPlugin.isExcluded's comment for why this can't just
        // rely on the picker/setAllowlist having filtered these out already.
        // Label included here (not just package id) so this stays the actual
        // last line of defense rather than repeating the same prefix-only gap
        // that let com.wf.wellsfargomobile through at save time.
        String label = labelCache.get(packageName);
        if (label == null && !labelCache.containsKey(packageName)) {
            try {
                android.content.pm.PackageManager pm = getPackageManager();
                label = pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString();
            } catch (android.content.pm.PackageManager.NameNotFoundException ignored) {}
            labelCache.put(packageName, label);
        }
        if (AccessibilityPlugin.isExcluded(packageName, label)) return false;
        SharedPreferences prefs = getSharedPreferences(AccessibilityPlugin.PREFS_NAME, MODE_PRIVATE);
        Set<String> allowlist = prefs.getStringSet(AccessibilityPlugin.ALLOWLIST_KEY, new HashSet<>());
        return allowlist.contains(packageName);
    }

    // depth and charBudget[0] bound worst-case cost against deeply nested or
    // huge trees (e.g. a long webview) — without this, extractText has no
    // limit on recursion depth or total captured text size.
    //
    // Each captured string is tagged with a coarse role so the server side
    // (summarizeTelemetry) can build a structured block instead of a flat
    // dump. Role is inferred from what AccessibilityNodeInfo actually
    // exposes — there's no true "screen title" API, so the heuristic is:
    // the first non-clickable text encountered (shallow, tree-walk order)
    // is the title; anything clickable is a button; everything else is
    // plain text. Format: "role|text", one per line — '|' is not filtered
    // out of user text, so downstream parsing only trusts the first '|'.
    private void extractText(AccessibilityNodeInfo node, List<String> texts, int depth, int[] charBudget, boolean[] titleFound) {
        if (node == null || depth > MAX_NODE_DEPTH || charBudget[0] >= MAX_TEXT_CHARS) return;

        // Security / PII Defense: Never extract from password fields or password variations
        if (node.isPassword()) return;
        int it = node.getInputType();
        int cls = it & android.text.InputType.TYPE_MASK_CLASS;
        int var = it & android.text.InputType.TYPE_MASK_VARIATION;
        boolean pw =
            (cls == android.text.InputType.TYPE_CLASS_TEXT && (
                var == android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD ||
                var == android.text.InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD ||
                var == android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD))
            || (cls == android.text.InputType.TYPE_CLASS_NUMBER &&
                var == android.text.InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        if (pw) return;

        boolean clickable = node.isClickable();

        if (node.getText() != null && node.getText().length() > 0) {
            String value = node.getText().toString();
            String role = clickable ? "button" : (!titleFound[0] ? "title" : "text");
            if (role.equals("title")) titleFound[0] = true;
            texts.add(role + "|" + value);
            charBudget[0] += value.length();
        }
        if (node.getContentDescription() != null && node.getContentDescription().length() > 0) {
            String value = node.getContentDescription().toString();
            String role = clickable ? "button" : "text";
            texts.add(role + "|" + value);
            charBudget[0] += value.length();
        }

        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            extractText(child, texts, depth + 1, charBudget, titleFound);
            if (child != null) child.recycle();
        }
    }

    @Override
    public void onInterrupt() {
        // Required method, ignored for now
    }

    private static final long PERIODIC_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    private final Handler syncHandler = new Handler(Looper.getMainLooper());
    private final Runnable periodicSyncRunnable = new Runnable() {
        @Override
        public void run() {
            NativeTelemetrySync.flushAsync(PiecesAccessibilityService.this);
            syncHandler.postDelayed(this, PERIODIC_SYNC_INTERVAL_MS);
        }
    };

    private void initClipboardListener() {
        try {
            clipboardManager = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (clipboardManager != null) {
                clipListener = this::handlePrimaryClipChanged;
                clipboardManager.addPrimaryClipChangedListener(clipListener);
            }
        } catch (Throwable t) {
            // Clipboard service might be unavailable in restricted environments
        }
    }

    private void cleanupClipboardListener() {
        try {
            if (clipboardManager != null && clipListener != null) {
                clipboardManager.removePrimaryClipChangedListener(clipListener);
                clipListener = null;
            }
        } catch (Throwable t) {
            // Ignore cleanup failures
        }
    }

    private static boolean isCredentialOrSecret(String text) {
        if (text == null) return false;
        String trimmed = text.trim();
        // Common token / key prefixes
        if (trimmed.startsWith("ghp_") || trimmed.startsWith("gho_") || trimmed.startsWith("ghu_")
                || trimmed.startsWith("github_pat_") || trimmed.startsWith("sk-") || trimmed.startsWith("xoxb-")
                || trimmed.startsWith("Bearer ") || trimmed.contains("BEGIN PRIVATE KEY")
                || trimmed.contains("BEGIN RSA PRIVATE KEY") || trimmed.startsWith("eyJh")) {
            return true;
        }
        // High-entropy token or password pattern (e.g. 18+ alphanumeric characters with symbols and no spaces)
        if (trimmed.length() >= 18 && !trimmed.contains(" ") && !trimmed.contains("\n")
                && trimmed.matches("^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[^a-zA-Z0-9]).+$")) {
            return true;
        }
        return false;
    }

    private void handlePrimaryClipChanged() {
        if (!isScreenContextEnabled() || isLocked()) return;
        if (clipboardManager == null) return;
        try {
            if (!clipboardManager.hasPrimaryClip()) return;

            ClipDescription desc = clipboardManager.getPrimaryClipDescription();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && desc != null) {
                if (desc.getExtras() != null && desc.getExtras().getBoolean(ClipDescription.EXTRA_IS_SENSITIVE, false)) {
                    return; // Dropped: sensitive content from password manager or secure field
                }
            }

            ClipData clip = clipboardManager.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) return;

            CharSequence cs = clip.getItemAt(0).getText();
            if (cs == null) {
                cs = clip.getItemAt(0).coerceToText(this);
            }
            if (cs == null) return;
            String text = cs.toString().trim();
            if (text.isEmpty() || text.length() > 5000) return;

            // Reject credentials / secrets first
            if (isCredentialOrSecret(text)) return;

            // Deduplicate repeat triggers
            String textHash = hashPii(text);
            if (textHash.equals(lastClipContentHash)) return;
            lastClipContentHash = textHash;

            // Check deterministic patterns
            Matcher ups = UPS_TRACKING_PATTERN.matcher(text);
            if (ups.find()) {
                String tracking = ups.group(1);
                NativeTelemetrySync.queueClipboardIntent(this, "tracking_number", tracking, "UPS " + tracking, "track_package");
                return;
            }

            Matcher usps = USPS_TRACKING_PATTERN.matcher(text);
            if (usps.find()) {
                String tracking = usps.group(1);
                NativeTelemetrySync.queueClipboardIntent(this, "tracking_number", tracking, "USPS " + tracking, "track_package");
                return;
            }

            Matcher fedex = FEDEX_TRACKING_PATTERN.matcher(text);
            if (fedex.find() && (text.length() == 12 || text.length() == 15 || text.length() == 20 || text.length() == 22)) {
                String tracking = fedex.group(1);
                NativeTelemetrySync.queueClipboardIntent(this, "tracking_number", tracking, "FedEx " + tracking, "track_package");
                return;
            }

            Matcher url = URL_PATTERN.matcher(text);
            if (url.matches()) {
                String snippet = text.length() > 48 ? text.substring(0, 48) + "..." : text;
                NativeTelemetrySync.queueClipboardIntent(this, "url", text, snippet, "open_link");
                return;
            }

            Matcher email = EMAIL_PATTERN.matcher(text);
            if (email.matches()) {
                NativeTelemetrySync.queueClipboardIntent(this, "email", hashPii(text), "[REDACTED_EMAIL]", "compose_email");
                return;
            }

            Matcher phone = PHONE_PATTERN.matcher(text);
            if (phone.matches()) {
                NativeTelemetrySync.queueClipboardIntent(this, "phone", hashPii(text), "[REDACTED_PHONE]", "dial_number");
                return;
            }

            // Fallback to on-device TextClassifier entity & suggestion extraction
            ClassifierResult result = extractEntitiesAndSuggestions(text);
            if (result != null && result.entities != null && result.entities.length() > 0) {
                JSONObject ent = result.entities.getJSONObject(0);
                String entityType = ent.optString("type", "text");
                String value = ent.optString("value", "");
                String action = mapEntityToAction(entityType);
                if (action == null) action = "view_details";
                String snippet = value.length() > 48 ? value.substring(0, 48) + "..." : value;
                NativeTelemetrySync.queueClipboardIntent(this, entityType, value, snippet, action);
            }
        } catch (Throwable t) {
            // Log or ignore non-fatal clipboard extraction issues
        }
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        isRunning = true;
        initClipboardListener();
        NativeHardwareTelemetry.initSensors(this);
        NativeTelemetrySync.warmUpDatabaseAsync(this);
        NativeTelemetrySync.flushAsync(this);
        syncHandler.postDelayed(periodicSyncRunnable, PERIODIC_SYNC_INTERVAL_MS);
    }

    @Override
    public boolean onUnbind(android.content.Intent intent) {
        isRunning = false;
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        isRunning = false;
        cleanupClipboardListener();
        NativeHardwareTelemetry.stopSensors();
        syncHandler.removeCallbacks(periodicSyncRunnable);
        super.onDestroy();
    }
}

