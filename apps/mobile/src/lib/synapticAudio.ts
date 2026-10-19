import { Preferences } from "@capacitor/preferences";

const AUDIO_ENABLED_KEY = "pieces-android:synapticAudioEnabled";

let audioCtx: AudioContext | null = null;
let cachedAudioEnabled: boolean | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === "suspended") {
    void audioCtx.resume();
  }
  return audioCtx;
}

export async function isSynapticAudioEnabled(): Promise<boolean> {
  if (cachedAudioEnabled !== null) return cachedAudioEnabled;
  try {
    const { value } = await Preferences.get({ key: AUDIO_ENABLED_KEY });
    cachedAudioEnabled = value !== "false"; // Default true
    return cachedAudioEnabled;
  } catch {
    return true;
  }
}

export async function setSynapticAudioEnabled(enabled: boolean): Promise<void> {
  cachedAudioEnabled = enabled;
  try {
    await Preferences.set({ key: AUDIO_ENABLED_KEY, value: String(enabled) });
  } catch {
    // Non-fatal if storage fails
  }
}

/**
 * Procedural Action Potential Spark:
 * Initiator neuron firing. Generates an electrical impulse transient
 * followed by a resonant harmonic pitch discharge.
 */
export async function playActionPotential(frequencyMultiplier = 1): Promise<void> {
  if (!(await isSynapticAudioEnabled())) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;

  // 1. Electrical spark transient (Bandpassed noise burst)
  try {
    const bufferSize = Math.floor(ctx.sampleRate * 0.035); // 35ms burst
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }

    const whiteNoise = ctx.createBufferSource();
    whiteNoise.buffer = noiseBuffer;

    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.setValueAtTime(2600 * frequencyMultiplier, now);
    noiseFilter.Q.setValueAtTime(6.0, now);

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.08, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.035);

    whiteNoise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(ctx.destination);

    whiteNoise.start(now);
    whiteNoise.stop(now + 0.035);
  } catch {
    // Audio node failure fail-soft
  }

  // 2. Tonal harmonic discharge (Sine wave with rapid exponential pitch decay)
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    const startFreq = 340 * frequencyMultiplier;
    const endFreq = 180 * frequencyMultiplier;

    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(endFreq, now + 0.18);

    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.24);
  } catch {
    // Audio node failure fail-soft
  }
}

/**
 * Procedural Synaptic Cascade Wave:
 * Fired as the action potential reaches downstream synapses.
 * Hop 1: Bright harmonic chime (C5/E5).
 * Hop 2: Ethereal overtone ripple (+110ms delay, G5).
 */
export async function playSynapticCascade(hop: 1 | 2): Promise<void> {
  if (!(await isSynapticAudioEnabled())) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  const delay = hop === 1 ? 0.03 : 0.14;
  const startTime = now + delay;

  try {
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    if (hop === 1) {
      osc1.frequency.setValueAtTime(523.25, startTime); // C5
      osc2.frequency.setValueAtTime(659.25, startTime); // E5
      gain.gain.setValueAtTime(0.09, startTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.32);
    } else {
      osc1.frequency.setValueAtTime(783.99, startTime); // G5
      osc2.frequency.setValueAtTime(1046.50, startTime); // C6
      gain.gain.setValueAtTime(0.05, startTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.28);
    }

    osc1.type = "sine";
    osc2.type = "triangle";

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(startTime);
    osc2.start(startTime);
    osc1.stop(startTime + 0.35);
    osc2.stop(startTime + 0.35);
  } catch {
    // Fail-soft
  }
}

/**
 * Procedural Lateral Inhibition Relaxation:
 * Fired when focus is released or empty space is clicked.
 * Smooth sub-bass harmonic sweep settling the circuit back to equilibrium.
 */
export async function playLateralInhibitionRelax(): Promise<void> {
  if (!(await isSynapticAudioEnabled())) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;

  try {
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(160, now);
    osc.frequency.exponentialRampToValueAtTime(65, now + 0.35);

    filter.type = "lowpass";
    filter.frequency.setValueAtTime(300, now);
    filter.frequency.exponentialRampToValueAtTime(80, now + 0.35);

    gain.gain.setValueAtTime(0.14, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.4);
  } catch {
    // Fail-soft
  }
}
