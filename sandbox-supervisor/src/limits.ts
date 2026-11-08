/**
 * Upper bound for any command timeout (30 min). The HTTP API clamps what clients ask for, and the code that
 * actually arms the timers clamps again with {@link clampTimeoutMs}: a setTimeout whose duration comes from a
 * caller is a resource-exhaustion lever (huge values pin the sandbox/terminal forever; Node coerces values above
 * 2^31-1 to 1 ms, so an oversized value would instead fire immediately), and the guarantee should not depend
 * on every caller remembering to validate.
 */
export const MAX_TIMEOUT_MS = 30 * 60_000;

/** Coerces a caller-provided duration into [1, MAX_TIMEOUT_MS]; NaN and non-numbers become the minimum. */
export function clampTimeoutMs(ms: number): number {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return 1;
  return Math.min(Math.max(Math.trunc(ms), 1), MAX_TIMEOUT_MS);
}
