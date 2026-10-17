import { describe, it, expect, beforeEach } from 'vitest';
import { AppTransitionMarkov } from './app-transitions.js';

describe('AppTransitionMarkov', () => {
  let markov: AppTransitionMarkov;

  beforeEach(() => {
    markov = new AppTransitionMarkov({
      quickBounceThresholdMs: 5000,
      laplaceAlpha: 1.0,
      maxDwellSamples: 50,
    });
  });

  it('records valid transitions and computes transition counts', () => {
    markov.recordTransition({
      from: 'com.slack',
      to: 'com.google.android.gm',
      dwell_ms: 12000,
    });
    markov.recordTransition({
      from: 'com.slack',
      to: 'com.google.android.gm',
      dwell_ms: 18000,
    });
    markov.recordTransition({
      from: 'com.slack',
      to: 'com.github.android',
      dwell_ms: 30000,
    });

    expect(markov.getTransitionCount('com.slack', 'com.google.android.gm')).toBe(2);
    expect(markov.getTransitionCount('com.slack', 'com.github.android')).toBe(1);
    expect(markov.getTransitionCount('com.slack', 'com.unseen.app')).toBe(0);
    expect(markov.getTotalTransitionsFrom('com.slack')).toBe(3);
  });

  it('ignores self transitions and invalid packages', () => {
    markov.recordTransition({ from: 'com.slack', to: 'com.slack', dwell_ms: 5000 });
    markov.recordTransition({ from: '', to: 'com.slack', dwell_ms: 5000 });
    markov.recordTransition({ from: 'com.slack', to: '   ', dwell_ms: 5000 });

    expect(markov.getTotalTransitionsFrom('com.slack')).toBe(0);
    expect(markov.getVocabulary()).toHaveLength(0);
  });

  it('detects quick bounces and calculates bounce rates', () => {
    markov.recordTransition({ from: 'com.twitter', to: 'com.instagram', dwell_ms: 2000 }); // bounce
    markov.recordTransition({ from: 'com.twitter', to: 'com.reddit', dwell_ms: 3000 }); // bounce
    markov.recordTransition({ from: 'com.twitter', to: 'com.browser', dwell_ms: 25000 }); // settled
    markov.recordTransition({ from: 'com.twitter', to: 'com.slack', dwell_ms: 15000 }); // settled

    expect(markov.isQuickBounce({ from: 'a', to: 'b', dwell_ms: 1500 })).toBe(true);
    expect(markov.isQuickBounce({ from: 'a', to: 'b', dwell_ms: 9000 })).toBe(false);

    // 2 bounces out of 4 dwell-observed transitions = 0.5
    expect(markov.getQuickBounceRate('com.twitter')).toBe(0.5);

    // Dwell-less transitions should not dilute the bounce rate
    markov.recordTransition({ from: 'com.twitter', to: 'com.music' });
    expect(markov.getQuickBounceRate('com.twitter')).toBe(0.5);
  });

  it('computes average dwell times correctly', () => {
    markov.recordTransition({ from: 'app.a', to: 'app.b', dwell_ms: 10000 });
    markov.recordTransition({ from: 'app.a', to: 'app.b', dwell_ms: 20000 });

    expect(markov.getAverageDwellMs('app.a', 'app.b')).toBe(15000);
  });

  it('calculates Laplace-smoothed probabilities and predicts next apps in descending order', () => {
    markov.recordBatch([
      { from: 'com.ide', to: 'com.terminal', dwell_ms: 40000 },
      { from: 'com.ide', to: 'com.terminal', dwell_ms: 35000 },
      { from: 'com.ide', to: 'com.terminal', dwell_ms: 45000 },
      { from: 'com.ide', to: 'com.browser', dwell_ms: 60000 },
    ]);

    const preds = markov.predictNextApp('com.ide', 2);
    expect(preds).toHaveLength(2);
    expect(preds[0].to).toBe('com.terminal');
    expect(preds[0].probability).toBe(0.75);
    expect(preds[0].mleProbability).toBe(0.75);
    expect(preds[0].smoothedProbability).toBeGreaterThan(0);
    expect(preds[1].to).toBe('com.browser');
    expect(preds[1].probability).toBe(0.25);

    // Laplace probability should be non-zero for unseen app in vocabulary
    const pTerminal = markov.getTransitionProbability('com.ide', 'com.terminal');
    const pUnseen = markov.getTransitionProbability('com.ide', 'com.unknown');
    expect(pTerminal).toBeGreaterThan(pUnseen);
    expect(pUnseen).toBeGreaterThan(0);
  });

  it('exports and imports transition matrices accurately', () => {
    markov.recordBatch([
      { from: 'app1', to: 'app2' },
      { from: 'app1', to: 'app2' },
      { from: 'app1', to: 'app3' },
    ]);

    const exported = markov.exportMatrix();
    expect(exported).toEqual({
      app1: {
        app2: 2,
        app3: 1,
      },
    });

    const newMarkov = new AppTransitionMarkov();
    newMarkov.importMatrix(exported);

    expect(newMarkov.getTransitionCount('app1', 'app2')).toBe(2);
    expect(newMarkov.getTransitionCount('app1', 'app3')).toBe(1);
    expect(newMarkov.getTotalTransitionsFrom('app1')).toBe(3);
  });

  it('clears all internal statistics', () => {
    markov.recordTransition({ from: 'app1', to: 'app2', dwell_ms: 1000 });
    expect(markov.getVocabulary()).toHaveLength(2);

    markov.clear();
    expect(markov.getVocabulary()).toHaveLength(0);
    expect(markov.getTotalTransitionsFrom('app1')).toBe(0);
    expect(markov.getQuickBounceRate('app1')).toBe(0);
  });
});
