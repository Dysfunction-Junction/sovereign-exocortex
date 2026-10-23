package com.pieces.android.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

import org.junit.Before;
import org.junit.Test;

/** Envelope format tests against a software AES key; the Keystore key itself needs a device. */
public class SecureCredentialStoreTest {

    private SecretKey key;

    @Before
    public void setUp() throws Exception {
        KeyGenerator kg = KeyGenerator.getInstance("AES");
        kg.init(256);
        key = kg.generateKey();
    }

    @Test
    public void roundTripsAValue() throws Exception {
        String envelope = SecureCredentialStore.seal(key, "pieces-android:proxyToken", "s3cret-token");
        assertEquals("s3cret-token", SecureCredentialStore.open(key, "pieces-android:proxyToken", envelope));
    }

    @Test
    public void envelopeIsVersionedAndDoesNotContainThePlaintext() throws Exception {
        String envelope = SecureCredentialStore.seal(key, "n", "plain-value-123");
        byte[] raw = Base64.getDecoder().decode(envelope);
        assertEquals(1, raw[0]);
        assertTrue(!new String(raw, StandardCharsets.ISO_8859_1).contains("plain-value-123"));
        // version(1) + iv(12) + ciphertext + tag(16)
        assertEquals(1 + 12 + "plain-value-123".length() + 16, raw.length);
    }

    @Test
    public void everyEncryptionUsesAFreshIv() throws Exception {
        String a = SecureCredentialStore.seal(key, "n", "same");
        String b = SecureCredentialStore.seal(key, "n", "same");
        assertNotEquals(a, b);
    }

    @Test
    public void aValueCannotBeReplayedUnderAnotherCredentialName() throws Exception {
        String envelope = SecureCredentialStore.seal(key, "pieces-android:proxyToken", "tok");
        assertNull(SecureCredentialStore.open(key, "pieces-android:remoteGatewayToken", envelope));
    }

    @Test
    public void tamperingFailsClosed() throws Exception {
        String envelope = SecureCredentialStore.seal(key, "n", "tok");
        byte[] raw = Base64.getDecoder().decode(envelope);
        raw[raw.length - 1] ^= 1;
        assertNull(SecureCredentialStore.open(key, "n", Base64.getEncoder().encodeToString(raw)));
    }

    @Test
    public void malformedEnvelopesReturnNull() throws Exception {
        assertNull(SecureCredentialStore.open(key, "n", ""));
        assertNull(SecureCredentialStore.open(key, "n", "not base64 !!"));
        assertNull(SecureCredentialStore.open(key, "n", Base64.getEncoder().encodeToString(new byte[5])));
        byte[] wrongVersion = Base64.getDecoder().decode(SecureCredentialStore.seal(key, "n", "tok"));
        wrongVersion[0] = 9;
        assertNull(SecureCredentialStore.open(key, "n", Base64.getEncoder().encodeToString(wrongVersion)));
    }

    @Test
    public void aDifferentKeyCannotOpenIt() throws Exception {
        KeyGenerator kg = KeyGenerator.getInstance("AES");
        kg.init(256);
        String envelope = SecureCredentialStore.seal(key, "n", "tok");
        assertNull(SecureCredentialStore.open(kg.generateKey(), "n", envelope));
    }
}
