package com.pieces.android.companion;

import java.util.Arrays;

/**
 * Pure-Java speech-present detector, version "ezc-1" (ANDROID_SENSITIVE_CAPTURE_DESIGN section 2).
 *
 * One boolean per sample, from energy, zero-crossing rate and the 300-3400 Hz band share. No native code, no model,
 * no network, no buffer retained: it reads the samples it is given and returns. Weakness: TV and music with vocals
 * count as speech. Swap behind {@link Vad} and bump {@link #VERSION} if that matters.
 */
final class SpeechVad implements MicWindowSampler.Vad {
    static final String VERSION = "ezc-1";

    static final int FRAME_MS = 30;
    /** A frame must be this far above the sample's 10th-percentile frame energy. */
    static final double ABOVE_FLOOR_DB = 9.0;
    static final double ZCR_MIN = 0.02;
    static final double ZCR_MAX = 0.25;
    static final double BAND_SHARE_MIN = 0.55;
    /** At least this share of frames must be speech-like. */
    static final double FRAME_SHARE_MIN = 0.20;
    /** At least this many runs of {@link #RUN_FRAMES} consecutive speech-like frames (syllabic modulation, 90 ms). */
    static final int RUNS_MIN = 3;
    static final int RUN_FRAMES = 3;

    private static final double DB_FLOOR = -120.0;

    @Override
    public String version() {
        return VERSION;
    }

    @Override
    public boolean isSpeech(short[] pcm, int len, int sampleRate) {
        int frame = sampleRate * FRAME_MS / 1000;
        if (frame < 8 || len < frame * 6) return false;
        int frames = len / frame;

        double[] db = new double[frames];
        for (int f = 0; f < frames; f++) db[f] = energyDb(pcm, f * frame, frame);
        double[] sorted = db.clone();
        Arrays.sort(sorted);
        double floor = sorted[Math.min(frames - 1, (int) Math.floor(frames * 0.10))];

        boolean[] speechLike = new boolean[frames];
        int speechFrames = 0;
        for (int f = 0; f < frames; f++) {
            if (db[f] < floor + ABOVE_FLOOR_DB) continue;
            double zcr = zeroCrossingRate(pcm, f * frame, frame);
            if (zcr < ZCR_MIN || zcr > ZCR_MAX) continue;
            if (bandShare(pcm, f * frame, frame, sampleRate) < BAND_SHARE_MIN) continue;
            speechLike[f] = true;
            speechFrames++;
        }
        if (speechFrames < frames * FRAME_SHARE_MIN) return false;

        int runs = 0;
        int run = 0;
        for (int f = 0; f < frames; f++) {
            if (speechLike[f]) {
                run++;
                if (run == RUN_FRAMES) runs++; // count each run once, when it reaches the minimum length
            } else {
                run = 0;
            }
        }
        return runs >= RUNS_MIN;
    }

    static double energyDb(short[] pcm, int off, int n) {
        double sum = 0;
        for (int i = off; i < off + n; i++) {
            double s = pcm[i] / 32768.0;
            sum += s * s;
        }
        double ms = sum / n;
        return ms <= 1e-12 ? DB_FLOOR : 10.0 * Math.log10(ms);
    }

    static double zeroCrossingRate(short[] pcm, int off, int n) {
        int crossings = 0;
        for (int i = off + 1; i < off + n; i++) {
            if ((pcm[i - 1] >= 0) != (pcm[i] >= 0)) crossings++;
        }
        return crossings / (double) (n - 1);
    }

    /** Share of the (Hann-windowed) frame energy between 300 and 3400 Hz, from Goertzel bins every 100 Hz. */
    static double bandShare(short[] pcm, int off, int n, int sampleRate) {
        double[] x = new double[n];
        for (int i = 0; i < n; i++) {
            double w = 0.5 - 0.5 * Math.cos(2.0 * Math.PI * i / (n - 1));
            x[i] = pcm[off + i] / 32768.0 * w;
        }
        double inBand = 0;
        double total = 0;
        int nyquist = sampleRate / 2;
        for (int hz = 100; hz < nyquist; hz += 100) {
            double p = goertzelPower(x, hz, sampleRate);
            total += p;
            if (hz >= 300 && hz <= 3400) inBand += p;
        }
        return total <= 1e-18 ? 0.0 : inBand / total;
    }

    static double goertzelPower(double[] x, double freqHz, int sampleRate) {
        double w = 2.0 * Math.PI * freqHz / sampleRate;
        double coeff = 2.0 * Math.cos(w);
        double s1 = 0;
        double s2 = 0;
        for (double v : x) {
            double s = v + coeff * s1 - s2;
            s2 = s1;
            s1 = s;
        }
        return s1 * s1 + s2 * s2 - coeff * s1 * s2;
    }
}
