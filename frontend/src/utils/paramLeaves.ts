/**
 * Pure helpers for flattening a (possibly nested) param bag into editable
 * scalar leaves and reading/writing values at a dotted path.
 *
 * Lifted out of the former ObjectCoefficientOverrides.tsx so both the Asset
 * editor (tunable-flag picker) and the per-instance dynamic-sources editor
 * share one definition of "what counts as an editable leaf".
 */

export type EditableValue = number | boolean | string | number[];

/** One editable leaf of the (possibly nested) param bag: the dotted path from
 *  the top-level key down to a scalar leaf (`["spatialModeX","waistUm"]`,
 *  `["spectrum","components","0","fwhmMhz"]`) plus the baseline value there. */
export type Leaf = { path: string[]; base: EditableValue };

/** A scalar leaf a single input renders for: a number / boolean / string, or a
 *  short numeric tuple (e.g. wavelengthRangeNm, coatingNormalBodyLocal) kept
 *  whole. Objects and longer arrays are NOT leaves — they're recursed into by
 *  {@link flattenLeaves}. */
export function isEditableValue(v: unknown): v is EditableValue {
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return true;
  if (Array.isArray(v) && v.length > 0 && v.length <= 3 && v.every((x) => typeof x === "number")) {
    return true;
  }
  return false;
}

/** Recursively walk a param value, emitting one Leaf per scalar/tuple leaf.
 *  Nested objects and arrays-of-objects are descended (the path records the
 *  route); a short numeric tuple is treated as a single leaf, not recursed. */
export function flattenLeaves(value: unknown, path: string[], out: Leaf[]): void {
  if (isEditableValue(value)) {
    out.push({ path, base: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => flattenLeaves(v, [...path, String(i)], out));
    return;
  }
  if (value && typeof value === "object") {
    for (const k of Object.keys(value as Record<string, unknown>)) {
      flattenLeaves((value as Record<string, unknown>)[k], [...path, k], out);
    }
  }
}

export function getAtPath(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const k of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** Deep-set `value` at `path` inside a fresh deep clone of `root`, returning
 *  the clone. Used to rebuild the COMPLETE top-level object before writing it
 *  to a per-instance override bag — the backend merges per-instance values
 *  shallowly, so a nested leaf edit must carry the whole top-level object or
 *  its siblings would be dropped. */
export function setAtPath(root: unknown, path: string[], value: EditableValue): unknown {
  const clone = root == null ? {} : (JSON.parse(JSON.stringify(root)) as Record<string, unknown>);
  let cur = clone as Record<string, unknown>;
  for (let i = 0; i < path.length - 1; i++) {
    cur = cur[path[i]] as Record<string, unknown>;
  }
  cur[path[path.length - 1]] = value;
  return clone;
}
