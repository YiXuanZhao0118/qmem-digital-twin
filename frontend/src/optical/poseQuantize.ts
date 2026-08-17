/**
 * Pose quantization — snap float dust to the authored resolution.
 *
 * A rotation decomposed from a quaternion (`sceneObjectEulerFromQuaternion`,
 * the gizmo's `Euler.setFromQuaternion`) or a position carried through a
 * chain of transforms comes back carrying double-precision residue: an angle
 * that is *exactly* 0° reads as `-8.995967132789893e-15`, a 12 mm offset as
 * `12.000000000000002`. Nothing physical cares about a 1e-14° tilt, but it
 * leaks into the DB, into every UI number field and into every diff, and it
 * breaks "is this pose still identity?" comparisons.
 *
 * `docs/objectives.md` fixes the accuracy budget at **O-1 1 µm** and
 * **O-2 0.1 µrad**, so the grid here is deliberately far finer than either:
 *
 *  - `POSITION_DECIMALS_MM = 6` → 1 nm, 1000× below the 1 µm budget
 *  - `ANGLE_DECIMALS_DEG = 9`   → 1e-9° = 1.75e-11 rad, ~5700× below 0.1 µrad
 *
 * Invariants:
 *  - the grid is COARSER than double dust at these magnitudes (~1e-13 for
 *    |angle| ≤ 360, ~1e-12 for |position| ≤ 1e4 mm), so residue snaps to an
 *    exact `0`;
 *  - the grid is FINER than anything physically meaningful, so quantizing
 *    never consumes O-1 / O-2 budget;
 *  - `-0` is normalized to `0` — the sign of a zero is never data.
 *
 * Mirrors `backend/app/pose_quantize.py`; keep the two in step.
 */

export const POSITION_DECIMALS_MM = 6;
export const ANGLE_DECIMALS_DEG = 9;

function quantize(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  // Decimal rounding via toFixed (not `Math.round(v / q) * q`) — multiplying
  // back by a non-representable quantum would reintroduce the dust we just
  // removed. `+ 0` collapses a resulting `-0` to `0`.
  return Number(value.toFixed(decimals)) + 0;
}

/** Snap a millimetre length onto the 1 nm grid. */
export function quantizeMm(value: number): number {
  return quantize(value, POSITION_DECIMALS_MM);
}

/** Snap an angle in degrees onto the 1e-9° grid. */
export function quantizeDeg(value: number): number {
  return quantize(value, ANGLE_DECIMALS_DEG);
}

/** Quantize the pose keys of a patch in place-free fashion, leaving every
 *  other key untouched. Both the SceneObject spelling (`xMm` / `rxDeg`) and
 *  the ComponentBinding spelling (`localXMm` / `localRxDeg`) are handled, so
 *  one helper covers every pose write path in the app. */
const MM_KEYS = ["xMm", "yMm", "zMm", "localXMm", "localYMm", "localZMm"] as const;
const DEG_KEYS = [
  "rxDeg", "ryDeg", "rzDeg",
  "localRxDeg", "localRyDeg", "localRzDeg",
] as const;

export function quantizePosePatch<T extends Record<string, unknown>>(patch: T): T {
  let next: Record<string, unknown> | null = null;
  const apply = (key: string, fn: (v: number) => number) => {
    const raw = (patch as Record<string, unknown>)[key];
    if (typeof raw !== "number") return;
    const snapped = fn(raw);
    if (snapped === raw) return;
    if (!next) next = { ...patch };
    next[key] = snapped;
  };
  for (const key of MM_KEYS) apply(key, quantizeMm);
  for (const key of DEG_KEYS) apply(key, quantizeDeg);
  return (next ?? patch) as T;
}
