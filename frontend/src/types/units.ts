/**
 * Compile-time brand types for units and frames. Zero runtime cost — these
 * are erased after type-checking. Used to make frame/unit mismatches a
 * compile error instead of a silent geometric bug.
 *
 * Convention (set during the Q1-Q5 unification):
 *   - Length:    millimetres (Mm)
 *   - Angle:     degrees (Deg) at the user/DB layer; radians (Rad) for
 *                internal trig; milliradians (Mrad) for tolerances
 *   - Frame:     "Lab"        = scene world frame (Z-up, mm)
 *                "BodyLocal"  = SceneObject's local frame (Z-up, mm) —
 *                               body-local convention is Z-up to match Lab
 *                "BeamLocal"  = beam propagation frame (+z along propagation)
 *                "Three"      = three.js render frame (Y-up, three units =
 *                               mm / MM_PER_THREE_UNIT). Should only appear
 *                               inside frames.ts and three/* renderers.
 */

declare const __unitBrand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__unitBrand]: B };

// === Scalar units ===
export type Mm = Brand<number, "Mm">;
export type Deg = Brand<number, "Deg">;
export type Rad = Brand<number, "Rad">;
export type Mrad = Brand<number, "Mrad">;
export type Hz = Brand<number, "Hz">;
export type MHz = Brand<number, "MHz">;
export type W = Brand<number, "W">;
export type MW = Brand<number, "MW">;
export type Nm = Brand<number, "Nm">;
export type Um = Brand<number, "Um">;
export type Ns = Brand<number, "Ns">;

// === Frame markers (compile-time only) ===
export type Frame = "Lab" | "BodyLocal" | "BeamLocal" | "Three";

// === Framed vector types ===

/** A position vector in the given frame, in millimetres. */
export type PositionMm<F extends Frame> = {
  readonly __frame: F;
  xMm: Mm;
  yMm: Mm;
  zMm: Mm;
};

/** A direction vector in the given frame. May or may not be unit-length;
 *  callers should document expectations. For unit-length, use DirectionUnit. */
export type Direction<F extends Frame> = {
  readonly __frame: F;
  x: number;
  y: number;
  z: number;
};

/** A unit-length direction vector in the given frame. The constructor
 *  helpers (in frames.ts) normalise on creation; consumers can rely on
 *  |v| ≈ 1 without re-normalising. */
export type DirectionUnit<F extends Frame> = Direction<F> & {
  readonly __unit: true;
};

// === Cheap escape hatches ===
// Only use when crossing a boundary you control — e.g. raw user input,
// JSON deserialisation, or interop with three.js APIs that don't know
// about brands. Inside frames.ts these are unavoidable; everywhere else
// prefer the typed helpers.

export const asMm = (v: number): Mm => v as Mm;
export const asDeg = (v: number): Deg => v as Deg;
export const asRad = (v: number): Rad => v as Rad;
export const asMrad = (v: number): Mrad => v as Mrad;
export const asMHz = (v: number): MHz => v as MHz;
export const asW = (v: number): W => v as W;
export const asMW = (v: number): MW => v as MW;
export const asNm = (v: number): Nm => v as Nm;
export const asUm = (v: number): Um => v as Um;
export const asNs = (v: number): Ns => v as Ns;

// === Numeric extraction (when you need the raw number for math) ===
export const mm = (v: Mm): number => v as number;
export const deg = (v: Deg): number => v as number;
export const rad = (v: Rad): number => v as number;
