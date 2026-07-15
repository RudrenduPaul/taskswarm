/**
 * Blocks the current thread for `ms` milliseconds without yielding to the
 * event loop. Used exclusively by small, synchronous retry-with-backoff
 * loops (first-boot config creation, the tasks-registry lockfile) where
 * pulling in an async/await call graph purely to sleep would ripple out
 * into every caller. Safe to use sparingly for short (single-digit to
 * low-hundreds of ms) waits; not a substitute for real async scheduling.
 */
export function sleepSyncMs(ms: number): void {
  if (ms <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}
