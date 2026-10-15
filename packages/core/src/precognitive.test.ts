import { describe, it, expect, beforeEach } from 'vitest';
import {
  PreCognitiveEngine,
  computeWakeDeltaQuantile,
  extractWakeDeltasFromEvents,
  DEFAULT_WAKE_THRESHOLD_MS,
  MIN_WAKE_THRESHOLD_MS,
  MAX_WAKE_THRESHOLD_MS,
} from './precognitive.js';
import { DryRunCache } from './dry-run.js';

describe('PreCognitiveEngine (Frontier 1)', () => {
  let cache: DryRunCache;
  let engine: PreCognitiveEngine;

  beforeEach(() => {
    cache = new DryRunCache();
    engine = new PreCognitiveEngine(cache);
  });

  it('triggers pocket pre-staging on SCREEN_OFF', () => {
    const outcome = engine.handleScreenStateChange('SCREEN_OFF', 1000, () => ({
      candidateId: 'cand_next_task',
      payload: { action: 'open_file', file: 'server.ts' },
      summary: 'Open server.ts in editor',
    }));

    expect(outcome.isPreStaged).toBe(true);
    expect(outcome.preStagedProposalId).toBeDefined();

    const ready = engine.getReadyProposal();
    expect(ready).toBeDefined();
    expect(ready?.candidateId).toBe('cand_next_task');
  });

  it('classifies HIGH_URGENCY when wake occurs rapidly after vibration', () => {
    engine.recordVibration(1000);
    // User wakes screen 1.5 seconds later (1500ms < 4000ms)
    const state = engine.handleScreenStateChange('SCREEN_ON', 2500);

    expect(state.urgencyIntent).toBe('HIGH_URGENCY');
    expect(state.wakeupLatencyMs).toBe(1500);
  });

  it('classifies CASUAL when wake occurs long after vibration or screen off', () => {
    engine.recordVibration(1000);
    // User wakes screen 40 seconds later
    const state = engine.handleScreenStateChange('SCREEN_ON', 41000);

    expect(state.urgencyIntent).toBe('CASUAL');
    expect(state.wakeupLatencyMs).toBe(40000);
  });

  it('computes neuromuscular hesitation score based on dwell intervals', () => {
    // Fast tap (200ms)
    let score = engine.recordTouchInteraction(200);
    expect(score).toBeLessThan(0.1);

    // Freeze frame (>1800ms) indicating confusion or error pause
    score = engine.recordTouchInteraction(2400);
    expect(score).toBeGreaterThan(0.6);
  });

  describe('Dynamic Wake Delta Quantiles', () => {
    it('returns default fallback on empty or invalid inputs', () => {
      expect(computeWakeDeltaQuantile([])).toBe(DEFAULT_WAKE_THRESHOLD_MS);
      expect(computeWakeDeltaQuantile([-100, 0])).toBe(DEFAULT_WAKE_THRESHOLD_MS);
    });

    it('calculates p20 quantile correctly from sample deltas', () => {
      // 10 samples: 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000
      const deltas = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];
      const p20 = computeWakeDeltaQuantile(deltas, 0.20, DEFAULT_WAKE_THRESHOLD_MS, 5);
      expect(p20).toBe(2800);
    });

    it('clamps quantiles to min and max boundaries', () => {
      expect(computeWakeDeltaQuantile([10, 20, 50], 0.20, DEFAULT_WAKE_THRESHOLD_MS, 1)).toBe(MIN_WAKE_THRESHOLD_MS); // clamped to 500
      expect(computeWakeDeltaQuantile([20000, 30000, 40000], 0.50, DEFAULT_WAKE_THRESHOLD_MS, 1)).toBe(MAX_WAKE_THRESHOLD_MS); // clamped to 15000
    });

    it('pairs with latest vibration in a double-vibration burst', () => {
      const events = [
        { kind: 'telemetry', ts_device: 1000, payload: { event: 'VIBRATION' } },
        { kind: 'telemetry', ts_device: 1200, payload: { event: 'VIBRATION' } }, // latest vibration
        { kind: 'telemetry', ts_device: 2000, payload: { event: 'SCREEN_ON' } }, // delta = 800
      ];
      const deltas = extractWakeDeltasFromEvents(events);
      expect(deltas).toEqual([800]);
    });

    it('handles positional duck-typed cache in PreCognitiveEngine constructor', () => {
      const duckCache = {
        get: () => null,
        set: () => {},
        has: () => false,
      };
      const eng = new PreCognitiveEngine(duckCache as any);
      expect(eng.wakeThreshold).toBe(DEFAULT_WAKE_THRESHOLD_MS);
    });

    it('treats lastVibrationAt of 0 as a valid defined timestamp', () => {
      engine.recordVibration(0);
      const state = engine.handleScreenStateChange('SCREEN_ON', 1000);
      expect(state.urgencyIntent).toBe('HIGH_URGENCY');
    });

    it('extracts vibration to screen-on delta in VIBRATION -> SCREEN_ON -> TOUCH sequence', () => {
      const events = [
        { kind: 'telemetry', ts_device: 1000, payload: { event: 'VIBRATION' } },
        { kind: 'telemetry', ts_device: 1800, payload: { event: 'SCREEN_ON' } }, // delta = 800
        { kind: 'touch', ts_device: 2500 },
      ];
      const deltas = extractWakeDeltasFromEvents(events);
      expect(deltas).toEqual([800]);
    });

    it('returns fallback threshold when sample count is below minSamples', () => {
      const fewDeltas = [1000, 2000, 3000];
      expect(computeWakeDeltaQuantile(fewDeltas, 0.20, 4000, 20)).toBe(4000);
    });

    it('handles duck-typed cache or options object in PreCognitiveEngine constructor', () => {
      const duckCache = {
        get: () => null,
        set: () => {},
        has: () => false,
      };
      const eng = new PreCognitiveEngine({ cache: duckCache as any, wakeThresholdMs: 3000, moderateMultiplier: 2 });
      expect(eng.wakeThreshold).toBe(3000);
    });

    it('extracts wake-to-touch deltas from event stream', () => {
      const events = [
        { kind: 'wake', ts_device: 1000 },
        { kind: 'touch', ts_device: 2200 }, // delta = 1200
        { kind: 'other', ts_device: 2500 },
        { kind: 'telemetry', ts_device: 5000, payload: { event: 'VIBRATION' } },
        { kind: 'telemetry', ts_device: 7500, payload: { event: 'TAP' } }, // delta = 2500
        { kind: 'wake', ts_device: 10000 }, // unmatched wake beyond window
        { kind: 'touch', ts_device: 50000 },
      ];
      const deltas = extractWakeDeltasFromEvents(events);
      expect(deltas).toEqual([1200, 2500]);
    });

    it('adapts engine urgency classification when wakeThreshold is updated dynamically', () => {
      engine.recordVibration(1000);

      // Default threshold (4000ms): latency 2500ms is HIGH_URGENCY
      expect(engine.handleScreenStateChange('SCREEN_ON', 3500).urgencyIntent).toBe('HIGH_URGENCY');

      // Now set threshold to 2000ms: latency 2500ms should become MODERATE (since 2500 >= 2000 and < 6000)
      engine.setWakeThreshold(2000);
      expect(engine.wakeThreshold).toBe(2000);
      engine.recordVibration(1000);
      expect(engine.handleScreenStateChange('SCREEN_ON', 3500).urgencyIntent).toBe('MODERATE');

      // Now set threshold to 8000ms: latency 5500ms should become HIGH_URGENCY
      engine.setWakeThreshold(8000);
      expect(engine.wakeThreshold).toBe(8000);
      engine.recordVibration(1000);
      expect(engine.handleScreenStateChange('SCREEN_ON', 6500).urgencyIntent).toBe('HIGH_URGENCY');
    });
  });
});
