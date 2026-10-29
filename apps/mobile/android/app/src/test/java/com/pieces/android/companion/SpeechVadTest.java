package com.pieces.android.companion;

import static org.junit.Assert.*;

import java.util.Random;
import org.junit.Test;

public class SpeechVadTest {
    private static final int SR = 16_000;
    private static final int N = SR * 5;
    private final SpeechVad vad = new SpeechVad();

    private static short clip(double v) {
        return (short) Math.max(-32768, Math.min(32767, Math.round(v * 32767.0)));
    }

    @Test
    public void silenceIsNotSpeech() {
        assertFalse(vad.isSpeech(new short[N], N, SR));
    }

    @Test
    public void whiteNoiseIsNotSpeech() {
        Random r = new Random(1);
        short[] pcm = new short[N];
        for (int i = 0; i < N; i++) pcm[i] = clip((r.nextDouble() * 2 - 1) * 0.3);
        assertFalse(vad.isSpeech(pcm, N, SR));
    }

    @Test
    public void steadySineIsNotSpeech() {
        short[] pcm = new short[N];
        for (int i = 0; i < N; i++) pcm[i] = clip(0.4 * Math.sin(2 * Math.PI * 1000.0 * i / SR));
        assertFalse(vad.isSpeech(pcm, N, SR));
    }

    /** Harmonics of f0 shaped like a vowel (strongest near 700 Hz), amplitude-modulated at 4 Hz like syllables. */
    private static short[] syllabic(double f0, double modHz, double noise) {
        Random r = new Random(7);
        short[] pcm = new short[N];
        for (int i = 0; i < N; i++) {
            double t = i / (double) SR;
            double s = 0;
            for (int k = 1; k * f0 < 3000; k++) {
                double f = k * f0;
                double w = Math.exp(-Math.pow((f - 700.0) / 500.0, 2));
                s += w * Math.sin(2 * Math.PI * f * t);
            }
            double env = 0.5 + 0.5 * Math.sin(2 * Math.PI * modHz * t);
            pcm[i] = clip(0.08 * s * env + noise * (r.nextDouble() * 2 - 1));
        }
        return pcm;
    }

    @Test
    public void modulatedHarmonicVoiceIsSpeech() {
        assertTrue(vad.isSpeech(syllabic(150, 4, 0.0005), N, SR));
    }

    @Test
    public void tooShortInputIsNotSpeech() {
        short[] pcm = syllabic(150, 4, 0.0005);
        assertFalse(vad.isSpeech(pcm, 100, SR));
    }

    @Test
    public void versionIsStamped() {
        assertEquals("ezc-1", vad.version());
    }
}
