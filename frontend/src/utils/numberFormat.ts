/** Display helpers that strip floating-point dust from computed values.
 *
 * Solver/geometry math leaves residue like `x = 4e-13` where the true value is
 * 0, plus long tails like `0.10000000002`. These helpers are for DISPLAY only
 * — they never mutate stored data — so a field reads "0" instead of "4e-13".
 */

/** Snap near-zero dust (|v| < 1e-9) to exactly 0 and trim long floating-point
 *  tails by rounding to `decimals` places. Returns a number, so it's safe to
 *  feed straight into a controlled `<input type="number">`. The default keeps
 *  9 decimals — enough to preserve any value a user would deliberately type
 *  while erasing the sub-nanometre solver dust. */
export function cleanNumber(value: number, decimals = 9): number {
  if (!Number.isFinite(value)) return value;
  if (Math.abs(value) < 1e-9) return 0;
  return Number(value.toFixed(decimals));
}

/** Format a number as a fixed-precision string with at least `decimals` places
 *  (dust snapped to 0 first), e.g. `cleanFixed(4e-13) → "0.00"`. Use for text
 *  readouts where a consistent column of decimals is wanted. */
export function cleanFixed(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return String(value);
  const v = Math.abs(value) < 1e-9 ? 0 : value;
  return v.toFixed(decimals);
}
