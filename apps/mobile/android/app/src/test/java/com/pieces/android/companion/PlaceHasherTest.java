package com.pieces.android.companion;

import static org.junit.Assert.*;

import java.nio.charset.StandardCharsets;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.Test;

public class PlaceHasherTest {
    static PlaceHasher.MacFn keyed(String key) {
        return message -> {
            try {
                Mac mac = Mac.getInstance("HmacSHA256");
                mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
                return mac.doFinal(message);
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        };
    }

    @Test
    public void placeholderAndLocallyAdministeredBssidsAreUnusable() {
        assertFalse(PlaceHasher.usableBssid(null));
        assertFalse(PlaceHasher.usableBssid(""));
        assertFalse(PlaceHasher.usableBssid("02:00:00:00:00:00")); // what Android returns without location access
        assertFalse(PlaceHasher.usableBssid("00:00:00:00:00:00"));
        assertFalse(PlaceHasher.usableBssid("fa:12:34:56:78:9a")); // locally administered (0x02 bit): hotspot or randomized
        assertFalse(PlaceHasher.usableBssid("<unknown ssid>"));
        assertFalse(PlaceHasher.usableBssid("aa:bb:cc"));
        assertTrue(PlaceHasher.usableBssid("a0:b1:c2:d3:e4:f5"));
        assertTrue(PlaceHasher.usableBssid("A0:B1:C2:D3:E4:F5"));
    }

    @Test
    public void hashIsDeterministicForAKeyAndDiffersAcrossKeys() {
        String a = PlaceHasher.hash(keyed("k1"), "a0:b1:c2:d3:e4:f5");
        assertEquals(a, PlaceHasher.hash(keyed("k1"), "a0:b1:c2:d3:e4:f5"));
        assertEquals(a, PlaceHasher.hash(keyed("k1"), "A0:B1:C2:D3:E4:F5")); // case-insensitive
        assertNotEquals(a, PlaceHasher.hash(keyed("k2"), "a0:b1:c2:d3:e4:f5"));
        assertNotEquals(a, PlaceHasher.hash(keyed("k1"), "a0:b1:c2:d3:e4:f6"));
        assertEquals(PlaceHasher.ID_CHARS, a.length());
        assertTrue(a.matches("[a-z2-7]+"));
    }

    @Test
    public void unusableBssidNeverHashes() {
        assertNull(PlaceHasher.hash(keyed("k1"), "02:00:00:00:00:00"));
        assertNull(PlaceHasher.hash(keyed("k1"), null));
    }

    @Test
    public void base32MatchesKnownVector() {
        // RFC 4648 "foobar" -> MZXW6YTBOI (lower-case, no padding)
        assertEquals("mzxw6ytboi", PlaceHasher.base32("foobar".getBytes(StandardCharsets.UTF_8)));
    }
}
