package com.pieces.android.companion;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Locale;
import javax.crypto.KeyGenerator;
import javax.crypto.Mac;
import javax.crypto.SecretKey;

/**
 * Turns a Wi-Fi BSSID into an opaque id that is stable on this install only (ANDROID_SENSITIVE_CAPTURE_DESIGN
 * section 3). id = base32(HMAC-SHA256(K, "bssid:" + bssid))[0:16].
 *
 * K is a non-exportable Android Keystore HMAC key created at first use. It is never in prefs or a backup, so the ids
 * cannot be reversed from a public BSSID database, differ on any other device or after a reinstall, and "Forget
 * places" deletes K (crypto-shred). Hashed fingerprints never leave the phone.
 */
final class PlaceHasher {
    static final String KEY_ALIAS = "places_hmac_v1";
    static final int ID_CHARS = 16;

    /** The keyed hash seam: a fixed-key fake in tests, the Keystore key on the phone. */
    interface MacFn {
        byte[] mac(byte[] message);
    }

    private PlaceHasher() {}

    /**
     * False for a missing, malformed or placeholder BSSID. Android returns 02:00:00:00:00:00 when location access is
     * missing, and hotspots and randomized addresses are "locally administered" (bit 0x02 of the first octet).
     * Hashing any of those would merge unrelated places into one, so they count as absent.
     */
    static boolean usableBssid(String bssid) {
        if (bssid == null) return false;
        String b = bssid.trim().toLowerCase(Locale.ROOT);
        if (!b.matches("[0-9a-f]{2}(:[0-9a-f]{2}){5}")) return false;
        if (b.equals("02:00:00:00:00:00") || b.equals("00:00:00:00:00:00") || b.equals("ff:ff:ff:ff:ff:ff")) return false;
        int first = Integer.parseInt(b.substring(0, 2), 16);
        return (first & 0x02) == 0;
    }

    /** Null when the BSSID is unusable. */
    static String hash(MacFn mac, String bssid) {
        if (!usableBssid(bssid)) return null;
        byte[] out = mac.mac(("bssid:" + bssid.trim().toLowerCase(Locale.ROOT)).getBytes(StandardCharsets.UTF_8));
        return base32(out).substring(0, ID_CHARS);
    }

    private static final char[] B32 = "abcdefghijklmnopqrstuvwxyz234567".toCharArray();

    static String base32(byte[] data) {
        StringBuilder sb = new StringBuilder();
        int buffer = 0;
        int bits = 0;
        for (byte b : data) {
            buffer = (buffer << 8) | (b & 0xff);
            bits += 8;
            while (bits >= 5) {
                sb.append(B32[(buffer >> (bits - 5)) & 31]);
                bits -= 5;
            }
            buffer &= (1 << bits) - 1;
        }
        if (bits > 0) sb.append(B32[(buffer << (5 - bits)) & 31]);
        return sb.toString();
    }

    /** The Keystore-backed function, created on first use. */
    static MacFn keystore() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (!ks.containsAlias(KEY_ALIAS)) {
            KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, "AndroidKeyStore");
            kg.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN).build());
            kg.generateKey();
        }
        final SecretKey key = (SecretKey) ks.getKey(KEY_ALIAS, null);
        return message -> {
            try {
                Mac mac = Mac.getInstance("HmacSHA256");
                mac.init(key);
                return mac.doFinal(message);
            } catch (Exception e) {
                throw new IllegalStateException(e.getClass().getSimpleName());
            }
        };
    }

    /** Crypto-shred: after this every stored hash is meaningless and new ones differ. */
    static void deleteKey() {
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            if (ks.containsAlias(KEY_ALIAS)) ks.deleteEntry(KEY_ALIAS);
        } catch (Exception ignored) {
            // nothing to shred
        }
    }
}
