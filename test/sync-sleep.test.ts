import { describe, it, expect } from 'vitest';
import { sleepSyncMs } from '../src/util/sync-sleep.js';

describe('sleepSyncMs', () => {
  it('blocks for approximately the requested duration', () => {
    const start = Date.now();
    sleepSyncMs(30);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(25);
  });

  it('returns immediately for a zero or negative duration', () => {
    const start = Date.now();
    sleepSyncMs(0);
    sleepSyncMs(-5);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(20);
  });
});
