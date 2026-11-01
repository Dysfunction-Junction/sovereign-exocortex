package com.pieces.android.companion;

import static org.junit.Assert.*;

import org.junit.Test;

public class TypedTextPolicyTest {

    @Test
    public void explicitlyAllowedAppsAreNotExcluded() {
        assertFalse(TypedTextPolicy.excluded("com.google.android.gm", "Gmail"));
        assertFalse(TypedTextPolicy.excluded("com.google.android.apps.messaging", "Messages"));
        assertFalse(TypedTextPolicy.excluded("com.microsoft.office.outlook", "Outlook"));
        assertFalse(TypedTextPolicy.excluded("com.android.chrome", "Chrome"));
        assertFalse(TypedTextPolicy.excluded("com.google.android.apps.docs.editors.docs", "Google Docs"));
        assertFalse(TypedTextPolicy.excluded("com.samsung.android.app.notes", "Samsung Notes"));
        assertFalse(TypedTextPolicy.excluded("md.obsidian", "Obsidian"));
    }

    @Test
    public void messagingAndSocialAndDialerExcluded() {
        assertTrue(TypedTextPolicy.excluded("com.whatsapp", "WhatsApp"));
        assertTrue(TypedTextPolicy.excluded("org.telegram.messenger", "Telegram"));
        assertTrue(TypedTextPolicy.excluded("org.thoughtcrime.securesms", "Signal"));
        assertTrue(TypedTextPolicy.excluded("com.facebook.orca", "Messenger"));
        assertTrue(TypedTextPolicy.excluded("com.discord", "Discord"));
        assertTrue(TypedTextPolicy.excluded("com.facebook.katana", "Facebook"));
        assertTrue(TypedTextPolicy.excluded("com.instagram.android", "Instagram"));
        assertTrue(TypedTextPolicy.excluded("com.instagram.barcelona", "Threads"));
        assertTrue(TypedTextPolicy.excluded("com.snapchat.android", "Snapchat"));
        assertTrue(TypedTextPolicy.excluded("com.reddit.frontpage", "Reddit"));
        assertTrue(TypedTextPolicy.excluded("com.twitter.android", "X"));
        assertTrue(TypedTextPolicy.excluded("com.zhiliaoapp.musically", "TikTok"));
        assertTrue(TypedTextPolicy.excluded("com.samsung.android.dialer", "Phone"));
        assertTrue(TypedTextPolicy.excluded("com.google.android.dialer", "Phone"));
        assertTrue(TypedTextPolicy.excluded("com.android.dialer", "Phone"));
    }

    @Test
    public void financeAndSecretsAndHealthAndDatingExcluded() {
        // Finance
        assertTrue(TypedTextPolicy.excluded("com.chase.sig.android", "Chase Bank"));
        assertTrue(TypedTextPolicy.excluded("com.venmo", "Venmo"));
        assertTrue(TypedTextPolicy.excluded("com.coinbase.android", "Coinbase"));
        assertTrue(TypedTextPolicy.excluded("com.random.app", "My Crypto Wallet"));

        // Secrets
        assertTrue(TypedTextPolicy.excluded("com.bitwarden", "Bitwarden"));
        assertTrue(TypedTextPolicy.excluded("com.agilebits.onepassword", "1Password"));
        assertTrue(TypedTextPolicy.excluded("com.google.android.apps.authenticator2", "Authenticator"));
        assertTrue(TypedTextPolicy.excluded("com.random.vault", "Secure Vault"));

        // Health
        assertTrue(TypedTextPolicy.excluded("com.sec.android.app.shealth", "Samsung Health"));
        assertTrue(TypedTextPolicy.excluded("com.google.android.apps.fitness", "Google Fit"));
        assertTrue(TypedTextPolicy.excluded("com.mychart", "MyChart Clinic"));

        // Dating / Adult
        assertTrue(TypedTextPolicy.excluded("com.tinder", "Tinder"));
        assertTrue(TypedTextPolicy.excluded("com.bumble.app", "Bumble Dating"));
    }

    @Test
    public void imeAndSelfExcluded() {
        assertTrue(TypedTextPolicy.excluded("com.google.android.inputmethod.latin", "Gboard"));
        assertTrue(TypedTextPolicy.excluded("com.touchtype.swiftkey", "SwiftKey"));
        assertTrue(TypedTextPolicy.excluded("com.pieces.android.companion", "Companion"));
        assertTrue(TypedTextPolicy.excluded("com.hermesandroid.bridge", "Hermes Bridge"));
    }

    @Test
    public void missingOrEmptyPackageIsExcluded() {
        assertTrue(TypedTextPolicy.excluded(null, "Some Label"));
        assertTrue(TypedTextPolicy.excluded("", "Some Label"));
        assertTrue(TypedTextPolicy.excluded("   ", "Some Label"));
    }

    @Test
    public void fieldSkippedWorksAcrossAllTypesAndHints() {
        // Password
        assertTrue(TypedTextPolicy.fieldSkipped(new TypedTextPolicy.FieldInfo("android.widget.EditText", 1, true, "")));

        // Number, Phone, DateTime
        assertTrue(TypedTextPolicy.fieldSkipped(new TypedTextPolicy.FieldInfo("android.widget.EditText", 2, false, "")));
        assertTrue(TypedTextPolicy.fieldSkipped(new TypedTextPolicy.FieldInfo("android.widget.EditText", 3, false, "")));
        assertTrue(TypedTextPolicy.fieldSkipped(new TypedTextPolicy.FieldInfo("android.widget.EditText", 4, false, "")));

        // Variations: Email (0x21), URI (0x11), PersonName (0x61), PostalAddress (0x71), Password (0x81)
        assertTrue(TypedTextPolicy.fieldSkipped(new TypedTextPolicy.FieldInfo("android.widget.EditText", 0x21, false, "")));
        assertTrue(TypedTextPolicy.fieldSkipped(new TypedTextPolicy.FieldInfo("android.widget.EditText", 0x11, false, "")));
        assertTrue(TypedTextPolicy.fieldSkipped(new TypedTextPolicy.FieldInfo("android.widget.EditText", 0x61, false, "")));
        assertTrue(TypedTextPolicy.fieldSkipped(new TypedTextPolicy.FieldInfo("android.widget.EditText", 0x71, false, "")));
        assertTrue(TypedTextPolicy.fieldSkipped(new TypedTextPolicy.FieldInfo("android.widget.EditText", 0x81, false, "")));

        // Sensitive hints
        assertTrue(TypedTextPolicy.fieldSkipped(new TypedTextPolicy.FieldInfo("android.widget.EditText", 1, false, "Enter security code")));
        assertTrue(TypedTextPolicy.fieldSkipped(new TypedTextPolicy.FieldInfo("android.widget.EditText", 1, false, "SMS OTP")));
        assertTrue(TypedTextPolicy.fieldSkipped(new TypedTextPolicy.FieldInfo("android.widget.EditText", 1, false, "Credit card CVV")));
        assertTrue(TypedTextPolicy.fieldSkipped(new TypedTextPolicy.FieldInfo("android.widget.EditText", 1, false, "Account PIN")));

        // Normal text field passes
        assertFalse(TypedTextPolicy.fieldSkipped(new TypedTextPolicy.FieldInfo("android.widget.EditText", 1, false, "What's on your mind?")));
        assertFalse(TypedTextPolicy.fieldSkipped(new TypedTextPolicy.FieldInfo("android.widget.EditText", 0x20001, false, "Search notes")));
    }

    @Test
    public void categoryMappingWorks() {
        assertEquals("email", TypedTextPolicy.category("com.google.android.gm"));
        assertEquals("email", TypedTextPolicy.category("com.microsoft.office.outlook"));
        assertEquals("messaging", TypedTextPolicy.category("com.google.android.apps.messaging"));
        assertEquals("notes", TypedTextPolicy.category("md.obsidian"));
        assertEquals("notes", TypedTextPolicy.category("com.samsung.android.app.notes"));
        assertEquals("browser", TypedTextPolicy.category("com.android.chrome"));
        assertEquals("docs", TypedTextPolicy.category("com.google.android.apps.docs.editors.docs"));
        assertEquals("other", TypedTextPolicy.category("com.example.unknownapp"));
    }
}
