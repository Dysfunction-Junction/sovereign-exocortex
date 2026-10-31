package com.pieces.android.companion;

import static org.junit.Assert.*;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;

public class SummaryStoreTest {

    private KeyPair rsaKeyPair;
    private byte[] kek;

    @Before
    public void setUp() throws Exception {
        KeyPairGenerator kpg = KeyPairGenerator.getInstance("RSA");
        kpg.initialize(2048);
        rsaKeyPair = kpg.generateKeyPair();

        kek = new byte[32];
        for (int i = 0; i < 32; i++) {
            kek[i] = (byte) (i + 1);
        }
    }

    @Test
    public void rsaOaepKeyWrapAndUnwrapRoundTrip() throws Exception {
        Cipher encryptCipher = SummaryStore.getRsaOaepCipher();
        encryptCipher.init(Cipher.ENCRYPT_MODE, rsaKeyPair.getPublic(), SummaryStore.getOaepParameterSpec());
        byte[] wrappedKek = encryptCipher.doFinal(kek);

        Cipher decryptCipher = SummaryStore.getRsaOaepCipher();
        decryptCipher.init(Cipher.DECRYPT_MODE, rsaKeyPair.getPrivate(), SummaryStore.getOaepParameterSpec());
        byte[] unwrappedKek = decryptCipher.doFinal(wrappedKek);

        assertArrayEquals(kek, unwrappedKek);
    }

    @Test
    public void aesGcmEncryptedNoteDecryptsCorrectly() throws Exception {
        String id = "note-uuid-123";
        long createdAt = 1700000000000L;
        long expiresAt = createdAt + SummaryStore.RETENTION_MS;
        byte[] iv = new byte[12];
        Arrays.fill(iv, (byte) 7);

        String secretSummaryText = "SecretSeededWord123 should never appear in ciphertext";
        SummaryGuard.Summary summary = new SummaryGuard.Summary(
            "plan",
            Arrays.asList("coding"),
            Arrays.asList("product"),
            secretSummaryText,
            null
        );

        byte[] plaintext = summary.toJson().toString().getBytes(StandardCharsets.UTF_8);

        // Encrypt with AES-256-GCM under KEK and AAD = id + createdAt
        byte[] aad = (id + createdAt).getBytes(StandardCharsets.UTF_8);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(kek, "AES"), new GCMParameterSpec(128, iv));
        cipher.updateAAD(aad);
        byte[] ct = cipher.doFinal(plaintext);

        // Plaintext must NOT appear in ciphertext
        String ctString = new String(ct, StandardCharsets.ISO_8859_1);
        assertFalse(ctString.contains("SecretSeededWord123"));

        SummaryStore.NoteRecord record = new SummaryStore.NoteRecord(
            id, 1, createdAt, expiresAt, "notes", "typed", iv, ct
        );

        // Decrypt
        JSONObject decrypted = SummaryStore.decryptNote(record, kek);
        assertNotNull(decrypted);
        assertEquals("plan", decrypted.getString("intent"));
        assertEquals(secretSummaryText, decrypted.getString("summary"));
    }

    @Test
    public void tamperedCiphertextFailsGcmAuthentication() throws Exception {
        String id = "note-uuid-tamper";
        long createdAt = 1700000000000L;
        byte[] iv = new byte[12];
        Arrays.fill(iv, (byte) 3);

        byte[] aad = (id + createdAt).getBytes(StandardCharsets.UTF_8);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(kek, "AES"), new GCMParameterSpec(128, iv));
        cipher.updateAAD(aad);
        byte[] ct = cipher.doFinal("{\"summary\":\"valid\"}".getBytes(StandardCharsets.UTF_8));

        // Flip one bit in ciphertext
        ct[0] ^= 0x01;

        SummaryStore.NoteRecord record = new SummaryStore.NoteRecord(
            id, 1, createdAt, createdAt + 1000, "notes", "typed", iv, ct
        );

        JSONObject decrypted = SummaryStore.decryptNote(record, kek);
        assertNull("Tampered ciphertext must fail GCM authentication and return null", decrypted);
    }

    @Test
    public void tamperedAadFailsGcmAuthentication() throws Exception {
        String id = "note-uuid-aad";
        long createdAt = 1700000000000L;
        byte[] iv = new byte[12];

        byte[] aad = (id + createdAt).getBytes(StandardCharsets.UTF_8);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(kek, "AES"), new GCMParameterSpec(128, iv));
        cipher.updateAAD(aad);
        byte[] ct = cipher.doFinal("{\"summary\":\"valid\"}".getBytes(StandardCharsets.UTF_8));

        // Tamper with record ID (which is part of AAD)
        SummaryStore.NoteRecord record = new SummaryStore.NoteRecord(
            "tampered-id", 1, createdAt, createdAt + 1000, "notes", "typed", iv, ct
        );

        JSONObject decrypted = SummaryStore.decryptNote(record, kek);
        assertNull("Mismatched AAD ID must fail GCM authentication and return null", decrypted);
    }
}
