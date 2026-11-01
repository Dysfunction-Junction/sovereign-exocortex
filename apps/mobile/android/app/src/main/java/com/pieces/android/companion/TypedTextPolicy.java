package com.pieces.android.companion;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Pure policy rules for typed text capture (A5-1).
 * JVM-tested; zero Android framework dependencies so tests run fast.
 */
final class TypedTextPolicy {
    private TypedTextPolicy() {}

    static final class FieldInfo {
        final String className;
        final int inputType;
        final boolean isPassword;
        final String hintText;

        FieldInfo(String className, int inputType, boolean isPassword, String hintText) {
            this.className = className != null ? className : "";
            this.inputType = inputType;
            this.isPassword = isPassword;
            this.hintText = hintText != null ? hintText : "";
        }
    }

    // InputType constants replicated to avoid android.text.InputType in JVM tests
    private static final int TYPE_MASK_CLASS = 0x0000000f;
    private static final int TYPE_CLASS_DATETIME = 0x00000004;
    private static final int TYPE_CLASS_NUMBER = 0x00000002;
    private static final int TYPE_CLASS_PHONE = 0x00000003;
    private static final int TYPE_CLASS_TEXT = 0x00000001;

    private static final int TYPE_MASK_VARIATION = 0x00000ff0;
    private static final int TYPE_TEXT_VARIATION_EMAIL_ADDRESS = 0x00000020;
    private static final int TYPE_TEXT_VARIATION_URI = 0x00000010;
    private static final int TYPE_TEXT_VARIATION_PERSON_NAME = 0x00000060;
    private static final int TYPE_TEXT_VARIATION_POSTAL_ADDRESS = 0x00000070;
    private static final int TYPE_TEXT_VARIATION_PASSWORD = 0x00000080;
    private static final int TYPE_TEXT_VARIATION_VISIBLE_PASSWORD = 0x00000090;
    private static final int TYPE_TEXT_VARIATION_WEB_PASSWORD = 0x000000e0;
    private static final int TYPE_NUMBER_VARIATION_PASSWORD = 0x00000010;

    private static final Pattern SENSITIVE_HINT_PATTERN =
        Pattern.compile("(?i)\\b(code|otp|pin|card|cvv|ssn|account|passcode|routing|iban)\\b");

    private static final Set<String> EXPLICITLY_ALLOWED_PACKAGES = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "com.google.android.gm",
        "com.google.android.apps.messaging",
        "com.microsoft.office.outlook",
        "com.android.chrome",
        "com.google.android.apps.docs.editors.docs",
        "com.samsung.android.app.notes",
        "md.obsidian"
    )));

    private static final Set<String> EXACT_EXCLUDED_PACKAGES = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        // Messaging & Calling
        "com.whatsapp",
        "org.telegram.messenger",
        "org.thoughtcrime.securesms",
        "com.facebook.orca",
        "com.discord",
        // Social apps
        "com.facebook.katana",
        "com.instagram.android",
        "com.instagram.barcelona",
        "com.snapchat.android",
        "com.reddit.frontpage",
        "com.twitter.android",
        "com.zhiliaoapp.musically",
        // Dialers
        "com.samsung.android.dialer",
        "com.google.android.dialer",
        "com.android.dialer",
        // Health
        "com.sec.android.app.shealth",
        "com.google.android.apps.fitness",
        // Self
        "com.pieces.android.companion",
        "com.hermesandroid.bridge"
    )));

    private static final String[] FINANCE_KEYWORDS = {
        "bank", "wallet", "pay", "venmo", "cashapp", "paypal", "crypto",
        "coinbase", "invest", "credit", "transunion", "creditkarma"
    };

    private static final String[] SECRET_KEYWORDS = {
        "password", "authenticator", "2fa", "otp", "keepass", "bitwarden",
        "1password", "lastpass", "vault"
    };

    private static final String[] HEALTH_KEYWORDS = {
        "health", "pharmacy", "therapy", "clinic", "mychart", "medic"
    };

    private static final String[] DATING_ADULT_KEYWORDS = {
        "dating", "tinder", "bumble", "hinge", "grindr", "adult", "lovense"
    };

    private static final String[] IME_PREFIXES = {
        "com.google.android.inputmethod",
        "com.touchtype.swiftkey",
        "com.samsung.android.honeyboard",
        "com.google.android.googlequicksearchbox"
    };

    /**
     * Returns true if the package or label should be excluded from typed text capture.
     */
    static boolean excluded(String pkg, String label) {
        if (pkg == null) return true;
        String p = pkg.toLowerCase(Locale.ROOT).trim();
        if (p.isEmpty()) return true;
        String l = label != null ? label.toLowerCase(Locale.ROOT).trim() : "";

        // Explicit allowlist bypasses keyword false positives (e.g. Gmail, Docs, Notes, Obsidian)
        if (EXPLICITLY_ALLOWED_PACKAGES.contains(p)) {
            return false;
        }

        // Exact package matches
        if (EXACT_EXCLUDED_PACKAGES.contains(p)) {
            return true;
        }

        // IME / System noise prefixes or tokens
        for (String prefix : IME_PREFIXES) {
            if (p.startsWith(prefix)) return true;
        }
        if (p.contains("inputmethod") || p.endsWith(".ime") || p.contains(".ime.")) {
            return true;
        }

        // Finance
        for (String kw : FINANCE_KEYWORDS) {
            if (p.contains(kw) || (!l.isEmpty() && l.contains(kw))) return true;
        }

        // Secrets
        for (String kw : SECRET_KEYWORDS) {
            if (p.contains(kw) || (!l.isEmpty() && l.contains(kw))) return true;
        }

        // Health
        for (String kw : HEALTH_KEYWORDS) {
            if (p.contains(kw) || (!l.isEmpty() && l.contains(kw))) return true;
        }

        // Dating / Adult
        for (String kw : DATING_ADULT_KEYWORDS) {
            if (p.contains(kw) || (!l.isEmpty() && l.contains(kw))) return true;
        }

        return false;
    }

    /**
     * Returns true if a specific input field must be skipped.
     */
    static boolean fieldSkipped(FieldInfo f) {
        if (f == null) return true;
        if (f.isPassword) return true;

        int classType = f.inputType & TYPE_MASK_CLASS;
        if (classType == TYPE_CLASS_NUMBER || classType == TYPE_CLASS_PHONE || classType == TYPE_CLASS_DATETIME) {
            return true;
        }

        int variation = f.inputType & TYPE_MASK_VARIATION;
        if (classType == TYPE_CLASS_TEXT) {
            if (variation == TYPE_TEXT_VARIATION_EMAIL_ADDRESS ||
                variation == TYPE_TEXT_VARIATION_URI ||
                variation == TYPE_TEXT_VARIATION_PERSON_NAME ||
                variation == TYPE_TEXT_VARIATION_POSTAL_ADDRESS ||
                variation == TYPE_TEXT_VARIATION_PASSWORD ||
                variation == TYPE_TEXT_VARIATION_VISIBLE_PASSWORD ||
                variation == TYPE_TEXT_VARIATION_WEB_PASSWORD) {
                return true;
            }
        } else if (classType == TYPE_CLASS_NUMBER) {
            if (variation == TYPE_NUMBER_VARIATION_PASSWORD) {
                return true;
            }
        }

        if (!f.hintText.isEmpty() && SENSITIVE_HINT_PATTERN.matcher(f.hintText).find()) {
            return true;
        }

        return false;
    }

    /**
     * Map package to coarse category: email, messaging, notes, browser, docs, other.
     * Never leaks the package name.
     */
    static String category(String pkg) {
        if (pkg == null) return "other";
        String p = pkg.toLowerCase(Locale.ROOT);
        if (p.equals("com.google.android.gm") || p.equals("com.microsoft.office.outlook") || p.contains("mail")) {
            return "email";
        }
        if (p.equals("com.google.android.apps.messaging") || p.contains("message") || p.contains(".sms")) {
            return "messaging";
        }
        if (p.equals("md.obsidian") || p.equals("com.samsung.android.app.notes") || p.contains("note") || p.contains("keep")) {
            return "notes";
        }
        if (p.equals("com.android.chrome") || p.contains("browser") || p.contains("chrome") || p.contains("firefox")) {
            return "browser";
        }
        if (p.equals("com.google.android.apps.docs.editors.docs") || p.contains("docs") || p.contains("office") || p.contains("word")) {
            return "docs";
        }
        return "other";
    }
}
