import { describe, it, expect, beforeEach } from 'vitest';
import { PreCognitiveEngine } from './precognitive.js';
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
});
