/**
 * AOM physics — single source of truth for Bragg-geometry and Raman-Nath
 * sideband formulas. Used by:
 *   - AomAdjustControls (panel readouts: θ_B, η preview, sideband table)
 *   - rayTrace.ts (frontend ray tracer's AOM branch propagation)
 *   - alignToLaser (1-D scan target: dir·acoustic = orderSign·sin(θ_B))
 *
 * Established as Phase 7 of the codebase normalisation effort
 * (see vibe coding.md). Before this module, the same formulas existed
 * verbatim in OpticalElementPanel.tsx and rayTrace.ts; any change had to
 * be applied to both files in lockstep or the panel readouts and the
 * scene rays would silently disagree.
 *
 * All public functions are pure (no React, no THREE, no DOM) and operate
 * on plain number inputs in SI / convenient lab units. Unit suffixes on
 * the inputs match the kindParams keys directly.
 */

/** Subset of `AOMParams` (frontend type) needed for the physics formulas.
 *  Defined locally so this module can stand alone (no `digitalTwin.ts`
 *  import → easier to mirror to backend later). The Phase 5 frame-suffix
 *  fields drop-in here; legacy fields are handled at the caller. */
export type AomPhysicsParams = {
  centerFreqMhz?: number;            // RF carrier
  acousticVelocityMPerS?: number;    // 4200 default (TeO2 [110])
  refractiveIndex?: number;          // 2.26 default (TeO2)
  baseEfficiency?: number;           // fallback when M2/L/W/Pd not all set
  figureOfMeritM2?: number;          // m^2/W (closed-form sin² model)
  crystalLengthMm?: number;          // L
  acousticBeamWidthMm?: number;      // W
  rfDrivePowerW?: number;            // P_d
};

const DEFAULT_CENTER_FREQ_MHZ = 80;
const DEFAULT_ACOUSTIC_VELOCITY_M_PER_S = 4200;
const DEFAULT_REFRACTIVE_INDEX = 2.26;
const DEFAULT_BASE_EFFICIENCY = 0.85;
/** Suppression floor for the "wrong-sign" ±1 order when the user has
 *  selected the opposite ±1. Models the residual diffraction from
 *  imperfect Bragg matching. Used by panel display (rayTrace folds the
 *  full braggAngularFactor in instead). */
export const SUPPRESSED_FIRST_ORDER_FLOOR = 0.001;

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** Bessel function of the first kind, integer order, via the standard
 *  ascending series. Used for Raman-Nath multi-order sidebands (|n| ≥ 2)
 *  whose intensity is approximated by `J_n²(v)` where `v` is the
 *  phase-modulation depth — see `phaseModulationDepth`.
 *
 *  Truncates at the first term below 1e-16 or after 100 iterations. */
export function besselJ(n: number, x: number): number {
  if (n < 0) return ((-n) % 2 === 0 ? 1 : -1) * besselJ(-n, x);
  if (Math.abs(x) < 1e-12) return n === 0 ? 1 : 0;
  let nFact = 1;
  for (let i = 2; i <= n; i++) nFact *= i;
  const half = x / 2;
  let term = Math.pow(half, n) / nFact;
  let sum = term;
  for (let k = 1; k < 100; k++) {
    term *= -(half * half) / (k * (n + k));
    sum += term;
    if (Math.abs(term) < 1e-16) break;
  }
  return sum;
}

/** Bragg angle θ_B for the given operating wavelength.
 *
 *  θ_B (EXTERNAL, lab-frame Bragg half-angle) = arcsin( λ · f / (2 · v) )
 *
 *  Convention (clarified 2026-05-11 against AA Opto MT80 datasheet):
 *  This returns the **external** Bragg half-angle (in air, lab frame),
 *  NOT the internal-crystal angle. The datasheet's `Δθ = λ·f / v` is the
 *  full external 0→±1 separation angle, equal to 2·θ_B_external. So:
 *
 *       sin(θ_B_external) = λ·f / (2·v)         ← here
 *       sin(θ_B_internal) = λ·f / (2·n·v)       ← what's inside the crystal
 *
 *  These are related by Snell's law at the crystal entry face: n·sin(θ_in)
 *  = sin(θ_ext). Using the external angle keeps everything (alignment,
 *  ray-trace, Bragg residual) in lab frame consistently. The refractive
 *  index `n` is no longer in the geometric Bragg path; it only enters the
 *  closed-form efficiency formula via cosθ_B (small-angle limit, ≈ 1).
 *
 *  Pre-fix this function used `arcsin(λ·f / (2·n·v))` (internal angle),
 *  which made the trace's separation angle ≈ 2·θ_B_internal = 2·θ_B_ext/n,
 *  i.e. 7.18 mrad instead of the datasheet's 16.2 mrad at 850 nm/80 MHz.
 *
 *  Domain-clamps the asin argument so an over-driven RF doesn't NaN —
 *  caller can then notice the result is at the ±π/2 limit. */
export function braggAngleRad(
  params: AomPhysicsParams,
  wavelengthNm: number,
): number {
  const fHz = (params.centerFreqMhz ?? DEFAULT_CENTER_FREQ_MHZ) * 1e6;
  const v = params.acousticVelocityMPerS ?? DEFAULT_ACOUSTIC_VELOCITY_M_PER_S;
  const lambdaM = wavelengthNm * 1e-9;
  const sinThetaB = (lambdaM * fHz) / (2 * v);
  return Math.asin(Math.max(-1, Math.min(1, sinThetaB)));
}

/** First-order diffraction efficiency η.
 *
 *  Resolution order:
 *    1. If `params.baseEfficiency` is explicitly set, return it (clamped
 *       to [0, 1]). This is the user-facing override — useful when the
 *       closed-form constants don't match the datasheet (e.g., the
 *       AA Optoelectronic MT80 datasheet quotes η > 85% at P_max but
 *       our seeded M₂/L/W combo gives ~9% via the closed-form). Setting
 *       baseEfficiency = 0.85 directly delivers what the datasheet
 *       advertises.
 *    2. Otherwise, if all four closed-form inputs (M₂, P_d, L, W) are
 *       present, compute
 *          η = sin²( (π · L / (2 · λ · cosθ_B)) · √(2 · M₂ · P_d / W) ).
 *    3. Otherwise, fall back to DEFAULT_BASE_EFFICIENCY.
 *
 *  Output is clamped to [0, 1]. */
export function diffractionEfficiency(
  params: AomPhysicsParams,
  wavelengthNm: number,
  thetaBRad: number,
): number {
  if (typeof params.baseEfficiency === "number") {
    return clamp01(params.baseEfficiency);
  }
  const allClosedFormInputs =
    typeof params.figureOfMeritM2 === "number" &&
    typeof params.rfDrivePowerW === "number" &&
    typeof params.crystalLengthMm === "number" &&
    typeof params.acousticBeamWidthMm === "number";
  if (!allClosedFormInputs) {
    return clamp01(DEFAULT_BASE_EFFICIENCY);
  }
  const lambdaM = wavelengthNm * 1e-9;
  const L = (params.crystalLengthMm as number) * 1e-3;
  const W = (params.acousticBeamWidthMm as number) * 1e-3;
  const Pd = params.rfDrivePowerW as number;
  const M2 = params.figureOfMeritM2 as number;
  const inner = Math.sqrt((2 * M2 * Pd) / W);
  const arg = ((Math.PI * L) / (2 * lambdaM * Math.cos(thetaBRad))) * inner;
  return clamp01(Math.sin(arg) ** 2);
}

/** Phase-modulation depth `v` used by the Raman-Nath multi-order
 *  approximation. When all four closed-form inputs are present, computes
 *
 *      v = (π · L / (2 · λ · cosθ_B)) · √(2 · M₂ · P_d / W)
 *
 *  (= the same `arg` as in `diffractionEfficiency`). Otherwise falls back
 *  to `2 · √η`, which gives v ≈ π/2·√η — a useful proxy for cells where
 *  M₂/L/W aren't all set. */
export function phaseModulationDepth(
  params: AomPhysicsParams,
  wavelengthNm: number,
  thetaBRad: number,
  fallbackEfficiency: number,
): number {
  const allClosedFormInputs =
    typeof params.figureOfMeritM2 === "number" &&
    typeof params.rfDrivePowerW === "number" &&
    typeof params.crystalLengthMm === "number" &&
    typeof params.acousticBeamWidthMm === "number";
  if (!allClosedFormInputs) {
    return 2 * Math.sqrt(clamp01(fallbackEfficiency));
  }
  const lambdaM = wavelengthNm * 1e-9;
  const L = (params.crystalLengthMm as number) * 1e-3;
  const W = (params.acousticBeamWidthMm as number) * 1e-3;
  const Pd = params.rfDrivePowerW as number;
  const M2 = params.figureOfMeritM2 as number;
  const inner = Math.sqrt((2 * M2 * Pd) / W);
  return ((Math.PI * L) / (2 * lambdaM * Math.cos(thetaBRad))) * inner;
}

export type DiffractionOrder = -1 | 0 | 1;
export type AomTraversalSign = -1 | 1;

/** Convert the AOM entry face into the sign of the optical traversal
 *  relative to the canonical body axis b = intercept_out - intercept_in.
 *
 *  +1 means the beam enters intercept_in and exits intercept_out.
 *  -1 means the same crystal is used backwards: intercept_out -> intercept_in.
 *  In the backwards use the drawing's +order/-order labels swap for the same
 *  mechanical Bragg tilt, which is exactly the user's MT80 bidirectional rule. */
export function aomTraversalSignFromEntryPort(
  entryPortId: "intercept_in" | "intercept_out" | string | null | undefined,
): AomTraversalSign {
  return entryPortId === "intercept_out" ? -1 : 1;
}

export function effectiveAomOrderForTraversal(
  selectedOrder: DiffractionOrder,
  traversalSign: AomTraversalSign,
): DiffractionOrder {
  if (selectedOrder === 0) return 0;
  return (selectedOrder * traversalSign) as DiffractionOrder;
}

/** Per-order intensity fractions for the on-Bragg case (no off-axis
 *  detuning). Matches the panel's sideband-table calculation exactly:
 *
 *    - currentOrder = 0:  100 % in 0th, all others 0
 *    - selected ±1:        η in selected sign, suppression floor in the
 *                          opposite ±1, |n|≥2 use J_n²(v), 0th absorbs
 *                          whatever's left after normalisation
 *    - sums normalised so the total ≤ 1
 *
 *  Caller passes the already-derived `efficiency` and `phaseModDepth`
 *  so this stays a pure mapping. Returns a Map<order, fraction>. */
export function sidebandIntensitiesOnBragg(
  currentOrder: DiffractionOrder,
  efficiency: number,
  phaseModDepth: number,
  maxOrder: number,
): Map<number, number> {
  const orders: number[] = [];
  for (let n = -maxOrder; n <= maxOrder; n++) orders.push(n);

  const selectedFirstOrderIntensity = currentOrder === 0 ? 0 : efficiency;

  const fractionForOrder = (order: number): number => {
    if (currentOrder === 0) return order === 0 ? 1 : 0;
    if (order === currentOrder) return selectedFirstOrderIntensity;
    if (Math.abs(order) === 1) return SUPPRESSED_FIRST_ORDER_FLOOR;
    if (order === 0) return Number.NaN; // filled in below
    return besselJ(order, phaseModDepth) ** 2;
  };

  let nonZeroSum = 0;
  const intensityByOrder = new Map<number, number>();
  for (const o of orders) {
    if (o === 0) continue;
    const f = fractionForOrder(o);
    intensityByOrder.set(o, f);
    nonZeroSum += f;
  }
  // Normalise if the non-zero sum exceeds 1 so the panel table never
  // shows >100 % of input power. The ray-tracer applies the same
  // normalisation downstream of its own braggAngularFactor scaling.
  if (nonZeroSum > 1) {
    const scale = 1 / nonZeroSum;
    for (const [k, v] of intensityByOrder) intensityByOrder.set(k, v * scale);
    nonZeroSum = 1;
  }
  intensityByOrder.set(0, Math.max(0, 1 - nonZeroSum));
  return intensityByOrder;
}

/** Compute the Bragg tilt axis (body-local Z-up unit vector) given the
 *  body axis b̂ (port-to-port direction) and a user-chosen angle α (deg)
 *  **in the body-local plane perpendicular to b̂**.
 *
 *  Parameterisation (â-INDEPENDENT, Phase 7.3 — vibe-coding-log
 *  2026-05-08 follow-up):
 *
 *    ê₀ = body+X projected onto ⊥-b̂, normalised
 *         (falls back to body+Z, then body+Y when b̂ is parallel to
 *         body+X, body+X-or-Z, etc.)
 *    ê₁ = ê₀ × b̂           (the second basis vector in the ⊥-b̂ plane;
 *                            forms a right-handed frame {ê₀, ê₁, b̂})
 *    τ̂(α) = cos(α)·ê₀ + sin(α)·ê₁
 *
 *  For the canonical AOM with b̂ = body+Y this gives:
 *    α = 0°   → τ̂ = body+X
 *    α = 90°  → τ̂ = body+Z
 *    α = 180° → τ̂ = −body+X
 *    α = 270° → τ̂ = −body+Z
 *
 *  τ̂ ⊥ b̂ is structurally guaranteed.
 *
 *  Decoupling τ̂ from â (the previous parameterisation used b̂×â as
 *  ê₀) was a deliberate fix: with the old form, changing the asset's
 *  acousticAxisBodyLocal silently rotated the user's α reference,
 *  which caused the user to set "α=270° expecting body+Z" but get
 *  τ̂ along â (degenerate: rotation around τ̂ leaves â·d̂ constant).
 *  The new form always maps α=0° to body+X (or fallback) regardless
 *  of â, so PHY Editor presets behave predictably.
 *
 *  Returns null only for truly degenerate b̂ inputs (zero vector). For
 *  any unit-length b̂ at least one of body+X / body+Z / body+Y has a
 *  substantial perpendicular component. */
export function computeBraggTiltAxisBodyLocal(
  bUnit: { x: number; y: number; z: number },
  alphaDeg: number,
): { x: number; y: number; z: number } | null {
  const bMag = Math.hypot(bUnit.x, bUnit.y, bUnit.z);
  if (bMag < 1e-9) return null;
  const tryRef = (axis: { x: number; y: number; z: number }) => {
    const dot = bUnit.x * axis.x + bUnit.y * axis.y + bUnit.z * axis.z;
    const proj = {
      x: axis.x - dot * bUnit.x,
      y: axis.y - dot * bUnit.y,
      z: axis.z - dot * bUnit.z,
    };
    const m = Math.hypot(proj.x, proj.y, proj.z);
    return m > 0.5 ? { x: proj.x / m, y: proj.y / m, z: proj.z / m } : null;
  };
  const e0 =
    tryRef({ x: 1, y: 0, z: 0 }) ??
    tryRef({ x: 0, y: 0, z: 1 }) ??
    tryRef({ x: 0, y: 1, z: 0 });
  if (!e0) return null;
  // ê₁ = ê₀ × b̂. With ê₀=body+X, b̂=body+Y this yields body+Z.
  const e1 = {
    x: e0.y * bUnit.z - e0.z * bUnit.y,
    y: e0.z * bUnit.x - e0.x * bUnit.z,
    z: e0.x * bUnit.y - e0.y * bUnit.x,
  };
  const a = (alphaDeg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return {
    x: c * e0.x + s * e1.x,
    y: c * e0.y + s * e1.y,
    z: c * e0.z + s * e1.z,
  };
}

/** Closed-form inverse of the sin² efficiency model: pick the RF drive
 *  power that places the closed-form `arg` at π/2 (peak transmission to
 *  the chosen ±1 order).
 *
 *      arg = (π·L / (2·λ·cosθ_B)) · √(2·M₂·P_d / W) = π/2
 *  ⇒   P_d = W · cos²θ_B · λ² / (2 · M₂ · L²)
 *
 *  Returns `null` when M₂/L/W aren't all set (caller should fall back
 *  to the non-closed-form path, e.g. peg `baseEfficiency` to 0.99). */
/** Compute the real Bragg rocking axis from the RF/acoustic propagation
 *  direction. PHY Editor now exposes the intuitive RF direction
 *  (default body -X) and derives the tilt axis from that vector:
 *
 *      tau_body = rf_direction_body x optical_axis_body
 *
 *  For the MT80 frame b=body+Y and RF=body-X, tau=body-Z. */
export function computeBraggTiltAxisFromRfDirectionBodyLocal(
  bUnit: { x: number; y: number; z: number },
  rfUnit: { x: number; y: number; z: number },
): { x: number; y: number; z: number } | null {
  const bMag = Math.hypot(bUnit.x, bUnit.y, bUnit.z);
  const rMag = Math.hypot(rfUnit.x, rfUnit.y, rfUnit.z);
  if (bMag < 1e-9 || rMag < 1e-9) return null;
  const bx = bUnit.x / bMag, by = bUnit.y / bMag, bz = bUnit.z / bMag;
  const rx = rfUnit.x / rMag, ry = rfUnit.y / rMag, rz = rfUnit.z / rMag;
  const tau = {
    x: ry * bz - rz * by,
    y: rz * bx - rx * bz,
    z: rx * by - ry * bx,
  };
  const tMag = Math.hypot(tau.x, tau.y, tau.z);
  if (tMag < 1e-9) return null;
  return { x: tau.x / tMag, y: tau.y / tMag, z: tau.z / tMag };
}

export function rfPowerForPeakEfficiencyW(
  params: AomPhysicsParams,
  wavelengthNm: number,
  thetaBRad: number,
): number | null {
  if (
    typeof params.figureOfMeritM2 !== "number" ||
    typeof params.crystalLengthMm !== "number" ||
    typeof params.acousticBeamWidthMm !== "number"
  ) {
    return null;
  }
  const lambdaM = wavelengthNm * 1e-9;
  const L = params.crystalLengthMm * 1e-3;
  const W = params.acousticBeamWidthMm * 1e-3;
  const M2 = params.figureOfMeritM2;
  const cos2 = Math.cos(thetaBRad) ** 2;
  return (W * cos2 * lambdaM * lambdaM) / (2 * M2 * L * L);
}

// =============================================================================
// Phase 7.4 — D1/D2/D3 Bragg geometry: single source of truth shared by
// alignToLaser (in OpticalElementPanel.tsx) and the rayTrace.ts AOM branch.
// =============================================================================
//
// Body-frame naming convention (matches the user's MT80-A1.5-IR spec):
//
//   D1 = optical axis            =  intercept_out − intercept_in
//        (canonical body +Y for the MT80 GLB; assets that drill the hole
//        elsewhere can override via the anchor positions, but the relation
//        D1 = unit(out − in) holds regardless.)
//
//   D2 = acoustic / RF axis      =  rfPropagationDirectionBodyLocal
//        (canonical body −X for the MT80; transducer −> absorber.)
//
//   D3 = D1 × D2                 =  Bragg rotation axis
//        (canonical body +Z for the MT80; perpendicular to both D1 and D2.)
//
// The Bragg condition only constrains the D2 component of the beam:
//
//      beam · D2 = sin(θ_B)        (one equation — leaves 2 rotational DoF)
//
// All AOM diffraction physics in this codebase derives from `expectedInputDotD2`
// and `diffractedDirection` below, so align and rayTrace cannot silently
// disagree on a sign convention again (the cause of the pre-Phase-7.4 bug
// where user-selected ±1 always landed at the off-Bragg position +3θ_B).
// =============================================================================

export type Vec3Like = { x: number; y: number; z: number };

/** Bragg condition target: the value the beam direction's D2 component
 *  must satisfy in body frame for the user-selected order m to land on
 *  the Bragg-mirror direction after the rayTrace deflection.
 *
 *      beam · D2 = −m · traversalSign · sin(θ_B)
 *
 *  Convention (clarified 2026-05-11):
 *    - θ_B = arcsin(λ·f / (2·n·v))  is the conventional Bragg grazing
 *      half-angle (denominator has 2). Computed in `braggAngleRad()`.
 *    - The crystal must be tilted so the input beam makes angle ±θ_B
 *      with D1 (the body's optical axis). m=+1 needs input at −θ_B,
 *      m=−1 needs input at +θ_B. Switching between m=±1 rotates the
 *      crystal by 2·θ_B in total.
 *    - The diffraction deflection between order 0 and order m on the
 *      output side is m·2·θ_B (the wider "spot separation" angle,
 *      ≈ m·λ·f/v in the small-angle limit). That factor of 2 lives in
 *      `diffractedDirection`, not here.
 *
 *  Side ledger:
 *    state A, m=+1:   input·D2 = −sin(θ_B)   →  output·D2 = +sin(θ_B)
 *    state A, m=−1:   input·D2 = +sin(θ_B)   →  output·D2 = −sin(θ_B)
 *    state A, m=0 :   input·D2 = 0           →  output·D2 = 0  (pass-through)
 *
 *  `traversalSign` flips the sign for state-B usage (beam enters at
 *  intercept_out instead of intercept_in) so the user's m label maps to
 *  the correct physical lab side regardless of how they oriented the
 *  body. */
export function expectedInputDotD2(
  selectedOrder: DiffractionOrder,
  traversalSign: AomTraversalSign,
  thetaBRad: number,
): number {
  return -selectedOrder * traversalSign * Math.sin(thetaBRad);
}

/** Diffracted output direction for order m: rotate the input direction
 *  by `+m·2·θ_B` about the D3 axis (right-hand rule). Pure Rodrigues
 *  rotation; no THREE.js dependency so this can mirror to backend later.
 *
 *  Convention (clarified 2026-05-11):
 *    - θ_B = arcsin(λ·f / (2·n·v))  is the conventional Bragg grazing
 *      half-angle. The angle between two adjacent diffraction orders
 *      (e.g. between 0 and +1 spots on a screen) is 2·θ_B, not θ_B.
 *      In the small-angle limit this matches the standard textbook
 *      result `θ_d ≈ m·λ·f / v` (no factor of 2 in the denominator).
 *
 *  Conservation properties — verified by the round-trip tests:
 *    - `output · D3` is preserved for every m (including 0).
 *    - For Bragg-aligned input (input·D2 = expectedInputDotD2(m, ...)),
 *      `output·D2` lands on the Bragg-mirror value `+m·traversalSign·sin(θ_B)`.
 *
 *  Caller passes UNIT vectors; the result is unit length up to the
 *  numerical precision of the trig functions (no explicit re-normalise
 *  to keep this allocation-free in hot loops). */
export function diffractedDirection(
  inputUnit: Vec3Like,
  D3Unit: Vec3Like,
  m: number,
  thetaBRad: number,
): Vec3Like {
  if (m === 0) return { x: inputUnit.x, y: inputUnit.y, z: inputUnit.z };
  const angle = m * 2 * thetaBRad;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = D3Unit;
  const v = inputUnit;
  // k · v
  const kdotv = k.x * v.x + k.y * v.y + k.z * v.z;
  // k × v
  const kx = k.y * v.z - k.z * v.y;
  const ky = k.z * v.x - k.x * v.z;
  const kz = k.x * v.y - k.y * v.x;
  return {
    x: v.x * c + kx * s + k.x * kdotv * (1 - c),
    y: v.y * c + ky * s + k.y * kdotv * (1 - c),
    z: v.z * c + kz * s + k.z * kdotv * (1 - c),
  };
}

/** Convenience: compute the body-local D1/D2/D3 unit vectors from raw
 *  asset / kindParams data. D1 is derived from the in/out anchor offsets
 *  (so any orientation of the optical axis on the asset works), D2 is
 *  the user-supplied RF propagation direction, D3 = D1 × D2 normalised.
 *
 *  Returns `null` when D1 or D2 is degenerate (zero-length or parallel),
 *  signalling that the caller cannot proceed with Bragg geometry until
 *  the asset metadata is fixed. */
export function aomBodyFrameBodyLocal(
  interceptInBodyLocal: Vec3Like,
  interceptOutBodyLocal: Vec3Like,
  rfPropagationDirectionBodyLocal: Vec3Like,
): { D1: Vec3Like; D2: Vec3Like; D3: Vec3Like } | null {
  const d1Raw = {
    x: interceptOutBodyLocal.x - interceptInBodyLocal.x,
    y: interceptOutBodyLocal.y - interceptInBodyLocal.y,
    z: interceptOutBodyLocal.z - interceptInBodyLocal.z,
  };
  const d1Mag = Math.hypot(d1Raw.x, d1Raw.y, d1Raw.z);
  if (d1Mag < 1e-9) return null;
  const D1 = { x: d1Raw.x / d1Mag, y: d1Raw.y / d1Mag, z: d1Raw.z / d1Mag };

  const d2Mag = Math.hypot(
    rfPropagationDirectionBodyLocal.x,
    rfPropagationDirectionBodyLocal.y,
    rfPropagationDirectionBodyLocal.z,
  );
  if (d2Mag < 1e-9) return null;
  const D2 = {
    x: rfPropagationDirectionBodyLocal.x / d2Mag,
    y: rfPropagationDirectionBodyLocal.y / d2Mag,
    z: rfPropagationDirectionBodyLocal.z / d2Mag,
  };

  const d3 = {
    x: D1.y * D2.z - D1.z * D2.y,
    y: D1.z * D2.x - D1.x * D2.z,
    z: D1.x * D2.y - D1.y * D2.x,
  };
  const d3Mag = Math.hypot(d3.x, d3.y, d3.z);
  if (d3Mag < 1e-9) return null;  // D1 ‖ D2 — geometry undefined
  const D3 = { x: d3.x / d3Mag, y: d3.y / d3Mag, z: d3.z / d3Mag };
  return { D1, D2, D3 };
}

/** Stage 1 rotation choice for `alignToLaser`. After Stage 1, body D1
 *  is parallel (state A) or anti-parallel (state B) to the beam. The
 *  rotation about beam direction is a free DoF; this enum pins it:
 *
 *    "min-rot"  — minimum-angle rotation from current pose (least
 *                 disturbance, but D3 in lab depends on initial pose)
 *    "upright"  — D3 in lab is forced as close to lab+Z as possible
 *                 (AOM stays "upright" on the optical table)
 *    "keep-d2"  — D2 in lab stays as close to its current direction as
 *                 possible (RFin port direction is preserved)
 *
 *  Default for new AOM placements is "upright" since most lab tables are
 *  horizontal and users expect the AOM body not to roll. */
export type Stage1RotationMode = "min-rot" | "upright" | "keep-d2";

export const DEFAULT_STAGE1_MODE: Stage1RotationMode = "upright";

/** Stage 2 sign convention — see `expectedInputDotD2` for the math.
 *
 *    "physical-traversal" — `traversalSign` flips the user's m label
 *                           when the beam enters the body backwards.
 *                           Matches how a real AOM behaves when used
 *                           in reverse, and matches the existing
 *                           rayTrace.ts emission logic.
 *    "lab-fixed"          — user's m=+1 always emerges on the same lab
 *                           side regardless of state. Internal logic
 *                           pins traversalSign to +1 always.
 *
 *  Default "physical-traversal" matches the prior code's behaviour. */
export type Stage2SignConvention = "physical-traversal" | "lab-fixed";

export const DEFAULT_STAGE2_SIGN: Stage2SignConvention = "physical-traversal";

/** Resolve `traversalSign` accounting for the chosen Stage 2 convention.
 *  Centralised so callers (align, rayTrace, panel) all see the same
 *  effective sign. */
export function resolveTraversalSign(
  rawTraversalSign: AomTraversalSign,
  signConvention: Stage2SignConvention,
): AomTraversalSign {
  return signConvention === "lab-fixed" ? 1 : rawTraversalSign;
}
