// Tiny expression evaluator for numeric inputs in the placement UI.
//
// Supported syntax (whitespace insensitive):
//   - "200"            absolute value
//   - "-50" / "+50"    absolute signed values (always absolute)
//   - "*2" / "/2"      multiply / divide ctx.current
//   - "@200"           absolute (alias for "200"; works with negatives)
//   - "mid(A, B)"      midpoint of two named SceneObjects' values along the
//                        same axis (ctx.midOnAxis returns it)
//
// Anything else returns null; the caller should display the failure indicator
// separately. Plain absolute parsing is tried FIRST so a leading sign with
// digits ("-2", "+30.5") is always treated as the absolute value, never
// accidentally interpreted as a relative operator.

export type ExprContext = {
  /** The field's current numeric value (used for *, /). */
  current: number;
  /** For "mid(A, B)", given two object names, return their median value
   * along the relevant axis. Returns null if either name is unresolved. */
  midOnAxis?: (nameA: string, nameB: string) => number | null;
};

const ABSOLUTE_NUMBER_RE = /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;

export function parseExpression(input: string, ctx: ExprContext): number | null {
  const text = input.trim();
  if (text.length === 0) return null;

  // Plain absolute number wins over every other rule. Defends against the
  // `-2` vs `-=2` confusion that previously let a typo turn -1 into -3.
  if (ABSOLUTE_NUMBER_RE.test(text)) {
    const v = Number(text);
    return Number.isFinite(v) ? v : null;
  }

  const midMatch = text.match(/^mid\s*\(\s*([^,)]+)\s*,\s*([^)]+)\s*\)$/i);
  if (midMatch && ctx.midOnAxis) {
    return ctx.midOnAxis(midMatch[1].trim(), midMatch[2].trim());
  }

  if (text.startsWith("@")) {
    const v = Number(text.slice(1));
    return Number.isFinite(v) ? v : null;
  }

  if (text.startsWith("*")) {
    const m = Number(text.slice(1));
    return Number.isFinite(m) ? ctx.current * m : null;
  }
  if (text.startsWith("/")) {
    const d = Number(text.slice(1));
    return Number.isFinite(d) && d !== 0 ? ctx.current / d : null;
  }

  const direct = Number(text);
  if (Number.isFinite(direct)) return direct;

  return null;
}
