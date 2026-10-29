package com.pieces.android.companion;

import org.junit.Test;
import static org.junit.Assert.*;

public class NativeHardwareTelemetryTest {

    @Test
    public void testPocketGate_nearAndDarkIsPocket() {
        assertEquals("pocket", NativeHardwareTelemetry.pocketGate(true, true, true));
    }

    @Test
    public void testPocketGate_otherwiseOk() {
        assertEquals("ok", NativeHardwareTelemetry.pocketGate(true, false, true));
        assertEquals("ok", NativeHardwareTelemetry.pocketGate(false, true, true));
        assertEquals("ok", NativeHardwareTelemetry.pocketGate(false, false, true));
    }

    @Test
    public void testPocketGate_missingReadingIsUnknownNeverOk() {
        assertEquals("unknown", NativeHardwareTelemetry.pocketGate(true, true, false));
        assertEquals("unknown", NativeHardwareTelemetry.pocketGate(false, false, false));
    }

    @Test
    public void testIsNearIsDark_matchClassifierThresholds() {
        assertTrue(NativeHardwareTelemetry.isNear(0.0f, 5.0f));    // binary sensor: below maxRange
        assertFalse(NativeHardwareTelemetry.isNear(5.0f, 5.0f));
        assertFalse(NativeHardwareTelemetry.isNear(-1f, 5.0f));    // no reading
        assertTrue(NativeHardwareTelemetry.isNear(0.5f, 20.0f));   // continuous sensor: below 1 cm
        assertFalse(NativeHardwareTelemetry.isNear(3.0f, 20.0f));
        assertTrue(NativeHardwareTelemetry.isDark(0.0f));
        assertFalse(NativeHardwareTelemetry.isDark(5.0f));
        assertFalse(NativeHardwareTelemetry.isDark(-1f));
    }

    @Test
    public void testClassifyState_inPocket() {
        // Non-interactive, proximity near (0cm), dark (0 lux), gravity down in pocket
        String state = NativeHardwareTelemetry.classifyState(
                0.0f,   // proxVal
                5.0f,   // maxRange (binary)
                0.0f,   // lux (dark)
                -1.0f,  // gravZ
                true,   // hasGrav
                false,  // inCall
                false   // isInteractive (screen off in pocket)
        );
        assertEquals("in_pocket", state);
    }

    @Test
    public void testClassifyState_screenInteractiveHandheld() {
        // User's palm or thumb covers top sensor while actively using phone
        String state = NativeHardwareTelemetry.classifyState(
                0.0f,   // proxVal
                5.0f,   // maxRange
                0.0f,   // lux
                -1.0f,  // gravZ
                true,   // hasGrav
                false,  // inCall
                true    // isInteractive (screen ON and active)
        );
        assertEquals("handheld", state);
    }

    @Test
    public void testClassifyState_atEarDuringCall() {
        // Phone held to ear during active call
        String state = NativeHardwareTelemetry.classifyState(
                0.0f,   // proxVal
                5.0f,   // maxRange
                0.0f,   // lux
                0.0f,   // gravZ
                true,   // hasGrav
                true,   // inCall
                false   // isInteractive
        );
        assertEquals("at_ear", state);
    }

    @Test
    public void testClassifyState_faceDown() {
        // Phone placed face down on table (Z-axis < -7)
        String state = NativeHardwareTelemetry.classifyState(
                0.0f,   // proxVal
                5.0f,   // maxRange
                0.0f,   // lux
                -9.8f,  // gravZ
                true,   // hasGrav
                false,  // inCall
                false   // isInteractive
        );
        assertEquals("face_down", state);
    }

    @Test
    public void testClassifyState_deskAmbient() {
        // Phone sitting flat on desk, display facing up (Z-axis > 7), not near
        String state = NativeHardwareTelemetry.classifyState(
                5.0f,   // proxVal (far)
                5.0f,   // maxRange
                120.0f, // lux (room light)
                9.8f,   // gravZ
                true,   // hasGrav
                false,  // inCall
                false   // isInteractive
        );
        assertEquals("desk_ambient", state);
    }

    @Test
    public void testClassifyState_continuousProximitySensor() {
        // Analog/continuous proximity sensor (maxRange = 100cm)
        // Values < 1.0f are treated as near
        String nearState = NativeHardwareTelemetry.classifyState(
                0.5f,   // proxVal < 1.0
                100.0f, // maxRange > 10.0f
                0.0f,   // lux (dark)
                0.0f,   // gravZ
                true,   // hasGrav
                false,  // inCall
                false   // isInteractive
        );
        assertEquals("in_pocket", nearState);

        // Values >= 1.0f are treated as far
        String farState = NativeHardwareTelemetry.classifyState(
                2.0f,   // proxVal >= 1.0
                100.0f, // maxRange > 10.0f
                150.0f, // lux
                9.8f,   // gravZ
                true,   // hasGrav
                false,  // inCall
                false   // isInteractive
        );
        assertEquals("desk_ambient", farState);
    }

    @Test
    public void testClassifyState_noEvidenceUnknown() {
        // Uninitialized sensors, no gravity, no proximity, screen off -> unknown (not handheld)
        String state = NativeHardwareTelemetry.classifyState(
                -1.0f,  // proxVal
                5.0f,   // maxRange
                -1.0f,  // lux
                0.0f,   // gravZ
                false,  // hasGrav
                false,  // inCall
                false   // isInteractive
        );
        assertEquals("unknown", state);
    }

    @Test
    public void testClassifyState_tiltedHandheld() {
        // Tilted phone held in hand (Z-axis between -7 and +7), screen off
        String state = NativeHardwareTelemetry.classifyState(
                5.0f,   // proxVal (far)
                5.0f,   // maxRange
                80.0f,  // lux
                3.5f,   // gravZ
                true,   // hasGrav
                false,  // inCall
                false   // isInteractive
        );
        assertEquals("handheld", state);
    }
}
