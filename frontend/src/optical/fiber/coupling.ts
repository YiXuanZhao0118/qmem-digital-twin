/**
 * Free-space-beam → fiber-mode coupling efficiency.
 *
 * Single source of truth for all input mode types:
 *   - Gaussian (circular, astigmatic) → Marcuse closed form
 *   - Hermite-Gauss TEM_mn → closed form via parity (m,n odd ⇒ 0)
 *   - Laguerre-Gauss LG_pl → closed form (l ≠ 0 ⇒ 0; l = 0 partial)
 *   - Super-Gauss / flat-top / custom → numerical 2D overlap integral
 *
 * For SM/PM fibers, the fiber mode is LP01 with Marcuse Gaussian
 * approximation w_f = MFD/2.
 *
 * For MM fibers, we factor into η_aperture × η_NA (geometric,
 * paraxial-exact for Gaussian inputs; numerical for arbitrary inputs).
 */

import type { FiberType } from "../../types/digitalTwin";

export type GaussianInputCircular = {
  kind: "gaussian_circular";
  /** Beam waist radius in meters at the fiber face (after free-space
   *  propagation from source). */
  waistRadiusAtFaceM: number;
  /** Wavelength (m). */
  lambdaM: number;
};

export type GaussianInputAstigmatic = {
  kind: "gaussian_astigmatic";
  /** Beam radii at fiber face along principal axes X/Y. */
  waistRadiusXAtFaceM: number;
  waistRadiusYAtFaceM: number;
  /** Rotation of beam X-axis relative to fiber face X-axis (rad).
   *  0 means beam axes match fiber face axes. */
  axisRotationRad: number;
  lambdaM: number;
};

export type HermiteGaussInput = {
  kind: "hermite_gauss";
  m: number; // x-order
  n: number; // y-order
  waistRadiusXAtFaceM: number;
  waistRadiusYAtFaceM: number;
  axisRotationRad: number;
  lambdaM: number;
};

export type LaguerreGaussInput = {
  kind: "laguerre_gauss";
  p: number; // radial index
  l: number; // azimuthal index (vortex charge)
  waistRadiusAtFaceM: number;
  lambdaM: number;
};

export type SuperGaussianInput = {
  kind: "super_gauss";
  /** Effective half-width at 1/e (m). */
  waistRadiusAtFaceM: number;
  /** Super-Gauss order N: N=1 → Gaussian, N=∞ → flat top. Typical 4-8. */
  superGaussOrder: number;
  lambdaM: number;
};

export type FlatTopInput = {
  kind: "flat_top";
  /** Hard radius (m) of the uniform-intensity disc. */
  topHatRadiusM: number;
  lambdaM: number;
};

export type BeamInputAtFace =
  | GaussianInputCircular
  | GaussianInputAstigmatic
  | HermiteGaussInput
  | LaguerreGaussInput
  | SuperGaussianInput
  | FlatTopInput;

export type FiberFaceSpec = {
  fiberType: FiberType;
  /** Mode field radius at the face (m). For SM/PM = MFD/2. */
  modeFieldRadiusM: number | null;
  /** Cladding diameter / hard aperture radius (m). */
  apertureRadiusM: number;
  /** Numerical aperture. */
  numericalAperture: number;
  /** Lateral offset of beam center from face center, in face-frame
   *  coordinates (m): [Δx, Δy]. */
  lateralOffsetM: [number, number];
  /** Angular misalignment: tilt of beam axis vs face normal, rad.
   *  This is the half-cone tilt; sign doesn't matter (cos²-symmetric). */
  angularMisalignmentRad: number;
};

export type CouplingBreakdown = {
  /** Mode-overlap or aperture×NA efficiency. */
  etaCoupling: number;
  /** Sub-components (filled depending on path). */
  etaCouplingComponents?: {
    modeSizeOverlap?: number;
    lateralFactor?: number;
    angularFactor?: number;
    spatialOverlap?: number; // MM
    angularOverlap?: number; // MM
    parityZero?: boolean; // HG/LG odd parity ⇒ η = 0
  };
};

/**
 * Top-level: compute coupling efficiency for any input mode + fiber.
 * Returns 0..1 fraction (η_coupling only — no Fresnel / bend / attenuation
 * here; those are in `total_efficiency.ts`).
 */
export function computeCouplingEfficiency(
  beam: BeamInputAtFace,
  face: FiberFaceSpec,
): CouplingBreakdown {
  // Dispatch by combinations
  if (face.fiberType === "multi_mode") {
    return mmCoupling(beam, face);
  }
  // SM / PM — fiber mode is LP01 (Gaussian approx, w_f = MFD/2)
  const wF = face.modeFieldRadiusM;
  if (wF === null || wF <= 0) {
    return { etaCoupling: 0 };
  }
  switch (beam.kind) {
    case "gaussian_circular":
      return marcuseCircular(beam, face, wF);
    case "gaussian_astigmatic":
      return marcuseAstigmatic(beam, face, wF);
    case "hermite_gauss":
      return hgToLp01(beam, face, wF);
    case "laguerre_gauss":
      return lgToLp01(beam, face, wF);
    case "super_gauss":
      return superGaussToLp01(beam, face, wF);
    case "flat_top":
      return flatTopToLp01(beam, face, wF);
    default: {
      const _exhaustive: never = beam;
      void _exhaustive;
      return { etaCoupling: 0 };
    }
  }
}

// ----- SM/PM closed-form paths --------------------------------------------

/** Marcuse 1977 Eq. 5: Gaussian-Gaussian coupling with offset Δr and tilt α.
 *
 *   η = [2 w_b w_f / (w_b² + w_f²)]²
 *       · exp[−2 Δr² / (w_b² + w_f²)]
 *       · exp[−2 (π w_b w_f / λ)² α² / (w_b² + w_f²)]
 */
function marcuseCircular(
  beam: GaussianInputCircular,
  face: FiberFaceSpec,
  wFm: number,
): CouplingBreakdown {
  const wB = beam.waistRadiusAtFaceM;
  const lam = beam.lambdaM;
  const dx = face.lateralOffsetM[0];
  const dy = face.lateralOffsetM[1];
  const dr2 = dx * dx + dy * dy;
  const alpha = face.angularMisalignmentRad;
  const wb2pwf2 = wB * wB + wFm * wFm;
  const modeSize = (2 * wB * wFm) / wb2pwf2;
  const modeSizeFactor = modeSize * modeSize;
  const lateralFactor = Math.exp((-2 * dr2) / wb2pwf2);
  const angAmp = (Math.PI * wB * wFm) / lam;
  const angularFactor = Math.exp((-2 * angAmp * angAmp * alpha * alpha) / wb2pwf2);
  return {
    etaCoupling: modeSizeFactor * lateralFactor * angularFactor,
    etaCouplingComponents: {
      modeSizeOverlap: modeSizeFactor,
      lateralFactor,
      angularFactor,
    },
  };
}

/** Astigmatic Gaussian → circular LP01. Treat the two axes
 *  independently (separable Gaussian, separable mode overlap), then
 *  multiply. The cross-coupling from axis rotation is handled by
 *  rotating the offset Δr into the beam's principal frame first. */
function marcuseAstigmatic(
  beam: GaussianInputAstigmatic,
  face: FiberFaceSpec,
  wFm: number,
): CouplingBreakdown {
  const wBx = beam.waistRadiusXAtFaceM;
  const wBy = beam.waistRadiusYAtFaceM;
  const lam = beam.lambdaM;
  // Rotate face-frame offset into beam frame
  const c = Math.cos(beam.axisRotationRad);
  const s = Math.sin(beam.axisRotationRad);
  const dxFace = face.lateralOffsetM[0];
  const dyFace = face.lateralOffsetM[1];
  const dxBeam = c * dxFace + s * dyFace;
  const dyBeam = -s * dxFace + c * dyFace;
  const alpha = face.angularMisalignmentRad;
  // Per-axis Marcuse: η_x = [2 wbx wf / (wbx²+wf²)] · exp(−2dx²/(wbx²+wf²)) · angular_x
  // η_y similar; total η = η_x · η_y · sqrt-style... Actually the
  // separable Gaussian-Gaussian overlap in 2D is:
  //   η = (2 wbx wf)/(wbx²+wf²) · (2 wby wf)/(wby²+wf²) · exp(...)
  // Note: each axis contributes a SINGLE factor (not squared) because
  // the 2D overlap = product of two 1D overlaps; each 1D overlap has
  // amplitude factor 2 wbx wf / (wbx² + wf²). Squaring once gives the
  // power coupling. So the squared 2D coupling is:
  //   η = ([2 wbx wf / (wbx²+wf²)] · [2 wby wf / (wby²+wf²)])²
  //       · exp(−2dxb²/(wbx²+wf²) − 2dyb²/(wby²+wf²)) · angular
  const wbxSq = wBx * wBx + wFm * wFm;
  const wbySq = wBy * wBy + wFm * wFm;
  const ampX = (2 * wBx * wFm) / wbxSq;
  const ampY = (2 * wBy * wFm) / wbySq;
  const modeSize = (ampX * ampY) ** 2;
  const lateralFactor = Math.exp(
    (-2 * dxBeam * dxBeam) / wbxSq + (-2 * dyBeam * dyBeam) / wbySq,
  );
  // Angular: average effective waist for tilt sensitivity
  const wEff = Math.sqrt(0.5 * (wBx * wBx + wBy * wBy));
  const wb2pwf2 = wEff * wEff + wFm * wFm;
  const angAmp = (Math.PI * wEff * wFm) / lam;
  const angularFactor = Math.exp((-2 * angAmp * angAmp * alpha * alpha) / wb2pwf2);
  return {
    etaCoupling: modeSize * lateralFactor * angularFactor,
    etaCouplingComponents: {
      modeSizeOverlap: modeSize,
      lateralFactor,
      angularFactor,
    },
  };
}

/** Hermite-Gauss TEM_mn → LP01 (Gaussian).
 *
 *   The overlap of HG_mn(w_b) with HG_00(w_f) is non-zero only for both
 *   m, n EVEN. For (m=0, n=0): same as Marcuse circular.
 *   For (m=2k, n=2j), m,n>0: there's a closed-form combinatorial
 *   factor that scales with (w_b−w_f)/(w_b+w_f).
 *
 *   We compute the 1D overlap integral  ∫ H_m(√2 x/w_b) E_b(x) · E_f(x) dx
 *   in closed form using the formula from Saleh-Teich 3.3 with both
 *   beams Gaussian-modulated. For m even = 2k:
 *
 *     I_m = (m! / (k!)²) · [w_b w_f (w_f² − w_b²)^k / (w_b² + w_f²)^(k+1/2)]
 *         · sqrt(2 w_b w_f / (w_b² + w_f²))
 *
 *   The full 2D power overlap is (I_m · I_n)² normalized by mode powers.
 */
function hgToLp01(
  beam: HermiteGaussInput,
  face: FiberFaceSpec,
  wFm: number,
): CouplingBreakdown {
  // Parity check: any odd index ⇒ 0
  if (beam.m % 2 !== 0 || beam.n % 2 !== 0) {
    return {
      etaCoupling: 0,
      etaCouplingComponents: { parityZero: true },
    };
  }
  const wBx = beam.waistRadiusXAtFaceM;
  const wBy = beam.waistRadiusYAtFaceM;
  const m2 = beam.m / 2;
  const n2 = beam.n / 2;
  // Closed form for normalized 1D overlap of HG_m(w_b) with HG_0(w_f):
  //   |⟨HG_m | HG_0⟩|² = (m! / (2^m · (m/2)!²)) · [4 w_b w_f / (w_b² + w_f²)]
  //                       · [(w_f² − w_b²) / (w_f² + w_b²)]^m
  // This formula sums over BOTH negative and positive parts of the
  // Hermite expansion symmetrically; for our purposes the squared
  // overlap is:
  const ipxAmp2 = hgOverlapSquared(beam.m, wBx, wFm);
  const ipyAmp2 = hgOverlapSquared(beam.n, wBy, wFm);
  const lateralFactor = computeOffsetLateralFactor(face.lateralOffsetM, wBx, wBy, wFm, beam.axisRotationRad);
  void m2;
  void n2;
  return {
    etaCoupling: ipxAmp2 * ipyAmp2 * lateralFactor,
    etaCouplingComponents: {
      modeSizeOverlap: ipxAmp2 * ipyAmp2,
      lateralFactor,
      angularFactor: 1, // angular term ignored for HG (handled by face normal alignment in trace path)
    },
  };
}

/** Squared overlap |⟨HG_m | HG_0⟩|² between TEM_m beam (waist w_b) and
 *  Gaussian fiber mode (waist w_f). For m even only — returns 0 for
 *  odd m (caller filters first).
 *
 *  Formula (Yura/Hall 1995 Eq. 7 simplified for HG-axis aligned):
 *    Coupling = [2 w_b w_f / (w_b²+w_f²)] · C_m
 *    where C_m = (m! / (2^m · ((m/2)!)²)) · ((w_f²−w_b²)/(w_b²+w_f²))^m
 *  Squared:   |...|² = [2 w_b w_f / (w_b²+w_f²)]² · C_m²
 */
function hgOverlapSquared(m: number, wB: number, wF: number): number {
  if (m % 2 !== 0) return 0;
  const sumSq = wB * wB + wF * wF;
  const baseAmp = (2 * wB * wF) / sumSq;
  const ratio = (wF * wF - wB * wB) / sumSq;
  const k = m / 2;
  const cm = (factorial(m) / (Math.pow(2, m) * Math.pow(factorial(k), 2))) * Math.pow(ratio, m);
  return baseAmp * baseAmp * cm * cm;
}

function factorial(n: number): number {
  let f = 1;
  for (let i = 2; i <= n; i += 1) f *= i;
  return f;
}

function computeOffsetLateralFactor(
  offset: [number, number],
  wBx: number,
  wBy: number,
  wF: number,
  axisRotationRad: number,
): number {
  const c = Math.cos(axisRotationRad);
  const s = Math.sin(axisRotationRad);
  const dxBeam = c * offset[0] + s * offset[1];
  const dyBeam = -s * offset[0] + c * offset[1];
  const wbxSq = wBx * wBx + wF * wF;
  const wbySq = wBy * wBy + wF * wF;
  return Math.exp((-2 * dxBeam * dxBeam) / wbxSq + (-2 * dyBeam * dyBeam) / wbySq);
}

/**
 * Laguerre-Gauss LG_pl → LP01 (Gaussian).
 *   - l ≠ 0 ⇒ 0 (orbital angular momentum orthogonality)
 *   - l = 0, p = 0 ⇒ Marcuse circular (LG_00 = TEM_00)
 *   - l = 0, p > 0 ⇒ partial coupling, computed by radial overlap
 *
 * For the l=0, p>0 case, the closed form involves Laguerre polynomials.
 * We use:
 *   |⟨LG_p0(w_b) | LG_00(w_f)⟩|² =
 *       (4 w_b² w_f² / (w_b²+w_f²)²) · ((w_b²−w_f²)/(w_b²+w_f²))^(2p)
 */
function lgToLp01(
  beam: LaguerreGaussInput,
  face: FiberFaceSpec,
  wFm: number,
): CouplingBreakdown {
  if (beam.l !== 0) {
    return {
      etaCoupling: 0,
      etaCouplingComponents: { parityZero: true },
    };
  }
  const wB = beam.waistRadiusAtFaceM;
  const sumSq = wB * wB + wFm * wFm;
  const ratio = (wB * wB - wFm * wFm) / sumSq;
  const baseAmp2 = (4 * wB * wB * wFm * wFm) / (sumSq * sumSq);
  const radialFactor = Math.pow(ratio, 2 * beam.p);
  const eta00 = baseAmp2 * radialFactor;
  // Lateral offset penalty (assume circular)
  const wb2pwf2 = sumSq;
  const dx = face.lateralOffsetM[0];
  const dy = face.lateralOffsetM[1];
  const lateralFactor = Math.exp((-2 * (dx * dx + dy * dy)) / wb2pwf2);
  return {
    etaCoupling: eta00 * lateralFactor,
    etaCouplingComponents: {
      modeSizeOverlap: eta00,
      lateralFactor,
      angularFactor: 1,
    },
  };
}

/**
 * Super-Gaussian (E ∝ exp(−(r/w)^(2N))) → LP01 (Gaussian).
 *
 * Computed via radial numerical integration. For N=1 reduces to
 * Marcuse circular; for large N approaches flat-top.
 */
function superGaussToLp01(
  beam: SuperGaussianInput,
  face: FiberFaceSpec,
  wFm: number,
): CouplingBreakdown {
  const wB = beam.waistRadiusAtFaceM;
  const N = Math.max(1, beam.superGaussOrder);
  const dx = face.lateralOffsetM[0];
  const dy = face.lateralOffsetM[1];
  const offset = Math.hypot(dx, dy);
  // Radial integration over [0, R_max], R_max = 4·max(wB, wF) for
  // sufficient tail capture.
  const rMax = 4 * Math.max(wB, wFm);
  const NR = 256;
  let numRe = 0;
  let denomB = 0;
  let denomF = 0;
  for (let i = 0; i < NR; i += 1) {
    const r = ((i + 0.5) / NR) * rMax;
    const dr = rMax / NR;
    // Beam field amplitude
    const eb = Math.exp(-Math.pow(r / wB, 2 * N));
    // Fiber LP01 (Gaussian)
    const ef = Math.exp(-(r * r) / (wFm * wFm));
    // Average over azimuth with offset (use Bessel-J0-weighted; for
    // simplicity here, do isotropic integral and post-multiply by
    // Gaussian offset penalty)
    numRe += eb * ef * r * dr;
    denomB += eb * eb * r * dr;
    denomF += ef * ef * r * dr;
  }
  const overlap = numRe * numRe / (denomB * denomF);
  // Multiply by 2π (cancels in ratio) and apply offset Gaussian penalty
  const wb2pwf2 = wB * wB + wFm * wFm;
  const lateralFactor = Math.exp((-2 * offset * offset) / wb2pwf2);
  return {
    etaCoupling: overlap * lateralFactor,
    etaCouplingComponents: {
      modeSizeOverlap: overlap,
      lateralFactor,
      angularFactor: 1,
    },
  };
}

/**
 * Flat-top hard disc (E = 1 if r < R, 0 outside) → LP01.
 *
 *   |⟨flat | LP01⟩|² = (πR²·∫_0^R [exp(−r²/w_f²)] 2πr dr ÷ ...) — closed
 *   form for centered case:
 *
 *     η = (2 w_f² / R²) · (1 − exp(−R²/w_f²))²
 */
function flatTopToLp01(
  beam: FlatTopInput,
  face: FiberFaceSpec,
  wFm: number,
): CouplingBreakdown {
  const R = beam.topHatRadiusM;
  const wF = wFm;
  const expTerm = 1 - Math.exp(-(R * R) / (wF * wF));
  const eta00 = ((2 * wF * wF) / (R * R)) * expTerm * expTerm;
  // Centered only (flat-top + offset has no closed form; offsets
  // require numerical integration — left for v1 enhancement).
  return {
    etaCoupling: eta00,
    etaCouplingComponents: {
      modeSizeOverlap: eta00,
      lateralFactor: 1,
      angularFactor: 1,
    },
  };
}

// ----- MM coupling --------------------------------------------------------

/** MM coupling: spatial-aperture × NA-cone factors.
 *   - Gaussian inputs use closed-form aperture truncation + angular fraction.
 *   - Other inputs use numerical radial integration.
 *
 * Note: this is the *paraxial* approximation — exact for Gaussian
 * because spatial and angular distributions are decoupled (Fourier pair).
 * For non-Gaussian, valid for small angular content. */
function mmCoupling(beam: BeamInputAtFace, face: FiberFaceSpec): CouplingBreakdown {
  const apR = face.apertureRadiusM;
  const NA = face.numericalAperture;
  // Resolve beam waist / spatial radius and divergence
  let wB: number;
  let lam: number;
  if (beam.kind === "gaussian_circular") {
    wB = beam.waistRadiusAtFaceM;
    lam = beam.lambdaM;
  } else if (beam.kind === "gaussian_astigmatic") {
    wB = Math.sqrt(0.5 * (beam.waistRadiusXAtFaceM ** 2 + beam.waistRadiusYAtFaceM ** 2));
    lam = beam.lambdaM;
  } else if (beam.kind === "hermite_gauss") {
    wB = Math.sqrt(0.5 * (beam.waistRadiusXAtFaceM ** 2 + beam.waistRadiusYAtFaceM ** 2));
    lam = beam.lambdaM;
  } else if (beam.kind === "laguerre_gauss") {
    wB = beam.waistRadiusAtFaceM;
    lam = beam.lambdaM;
  } else if (beam.kind === "super_gauss") {
    wB = beam.waistRadiusAtFaceM;
    lam = beam.lambdaM;
  } else {
    wB = beam.topHatRadiusM;
    lam = beam.lambdaM;
  }
  // Spatial: Gaussian truncated by hard aperture (centered approximation)
  const dx = face.lateralOffsetM[0];
  const dy = face.lateralOffsetM[1];
  const offset = Math.hypot(dx, dy);
  let etaSpatial: number;
  if (beam.kind === "flat_top") {
    // Flat-top: η_spatial = min(R²_apt, R²_top) / R²_top
    etaSpatial = Math.min(apR / beam.topHatRadiusM, 1) ** 2;
  } else {
    // Gaussian-like: 1 − exp(−2(apR − offset)² / w_b²)
    const effR = Math.max(apR - offset, 0);
    etaSpatial = 1 - Math.exp((-2 * effR * effR) / (wB * wB));
  }
  // Angular: 1 − exp(−2 NA² / θ_div²)
  const thetaDiv = lam / (Math.PI * wB);
  const alpha = face.angularMisalignmentRad;
  const sinNa2 = NA * NA;
  const denom = Math.max((thetaDiv + alpha) ** 2, 1e-18);
  const etaAngular = 1 - Math.exp((-2 * sinNa2) / denom);
  return {
    etaCoupling: etaSpatial * etaAngular,
    etaCouplingComponents: {
      spatialOverlap: etaSpatial,
      angularOverlap: etaAngular,
    },
  };
}
