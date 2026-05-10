/**
 * Arc-length and curvature integration for parametric curves
 * (the editable fiber Bezier path). Uses 64-point Gauss-Legendre
 * quadrature on the parametric interval [0, 1] which is exact for
 * polynomial integrands up to degree 127 — far more than enough for
 * cubic Bezier velocity (degree 4 under sqrt).
 */

/** 64-point Gauss-Legendre nodes (x_i) and weights (w_i) on [-1, 1].
 *  Pre-tabulated to numerical precision; sufficient for our 0.1%
 *  arc-length accuracy target on cubic Beziers. */
const GL_NODES_64 = [
  -0.9993050417357721, -0.9963401167719553, -0.9910133714767443,
  -0.9833362538846260, -0.9733268277899110, -0.9610087996520538,
  -0.9464113748584028, -0.9295691721319396, -0.9105221370785028,
  -0.8893154459951141, -0.8659993981540928, -0.8406292962525803,
  -0.8132653151227975, -0.7839723589433414, -0.7528199072605319,
  -0.7198818501716109, -0.6852363130542333, -0.6489654712546573,
  -0.6111553551723933, -0.5718956462026340, -0.5312794640198946,
  -0.4894031457070530, -0.4463660172534641, -0.4022701579639916,
  -0.3572201583376681, -0.3113228719902110, -0.2646871622087674,
  -0.2174236437400071, -0.1696444204239928, -0.1214628192961206,
  -0.0729931217877990, -0.0243502926634244, 0.0243502926634244,
  0.0729931217877990, 0.1214628192961206, 0.1696444204239928,
  0.2174236437400071, 0.2646871622087674, 0.3113228719902110,
  0.3572201583376681, 0.4022701579639916, 0.4463660172534641,
  0.4894031457070530, 0.5312794640198946, 0.5718956462026340,
  0.6111553551723933, 0.6489654712546573, 0.6852363130542333,
  0.7198818501716109, 0.7528199072605319, 0.7839723589433414,
  0.8132653151227975, 0.8406292962525803, 0.8659993981540928,
  0.8893154459951141, 0.9105221370785028, 0.9295691721319396,
  0.9464113748584028, 0.9610087996520538, 0.9733268277899110,
  0.9833362538846260, 0.9910133714767443, 0.9963401167719553,
  0.9993050417357721,
];

const GL_WEIGHTS_64 = [
  0.0017832807216964, 0.0041470332605625, 0.0065044579689784,
  0.0088467598263639, 0.0111681394601311, 0.0134630478967186,
  0.0157260304760247, 0.0179517157756973, 0.0201348231535302,
  0.0222701738083833, 0.0243527025687109, 0.0263774697150547,
  0.0283396726142595, 0.0302346570724025, 0.0320579283548516,
  0.0338051618371416, 0.0354722132568824, 0.0370551285402400,
  0.0385501531786156, 0.0399537411327203, 0.0412625632426235,
  0.0424735151236536, 0.0435837245293235, 0.0445905581637566,
  0.0454916279274181, 0.0462847965813144, 0.0469681828162100,
  0.0475401657148303, 0.0479993885964583, 0.0483447622348030,
  0.0485754674415034, 0.0486909570091397, 0.0486909570091397,
  0.0485754674415034, 0.0483447622348030, 0.0479993885964583,
  0.0475401657148303, 0.0469681828162100, 0.0462847965813144,
  0.0454916279274181, 0.0445905581637566, 0.0435837245293235,
  0.0424735151236536, 0.0412625632426235, 0.0399537411327203,
  0.0385501531786156, 0.0370551285402400, 0.0354722132568824,
  0.0338051618371416, 0.0320579283548516, 0.0302346570724025,
  0.0283396726142595, 0.0263774697150547, 0.0243527025687109,
  0.0222701738083833, 0.0201348231535302, 0.0179517157756973,
  0.0157260304760247, 0.0134630478967186, 0.0111681394601311,
  0.0088467598263639, 0.0065044579689784, 0.0041470332605625,
  0.0017832807216964,
];

/** Integrate `f(t)` over t ∈ [a, b] via 64-point Gauss-Legendre. */
export function gaussLegendre64(
  f: (t: number) => number,
  a: number,
  b: number,
): number {
  const half = 0.5 * (b - a);
  const mid = 0.5 * (a + b);
  let sum = 0;
  for (let i = 0; i < 64; i += 1) {
    sum += GL_WEIGHTS_64[i] * f(mid + half * GL_NODES_64[i]);
  }
  return sum * half;
}

/**
 * Arc length of a parametric 3D curve r(t) on t ∈ [0, 1] given a
 * function speed(t) = |r'(t)|. Returns arc length in the same
 * physical units used by `speed`.
 */
export function arcLengthOfCurve(
  speed: (t: number) => number,
): number {
  return gaussLegendre64(speed, 0, 1);
}

/**
 * Compute curvature radius R(t) = |r'(t)|³ / |r'(t) × r''(t)| at a
 * single t. Returns +∞ for a straight segment.
 */
export function curvatureRadiusAt(
  rPrime: [number, number, number],
  rDoublePrime: [number, number, number],
): number {
  const speed = Math.hypot(rPrime[0], rPrime[1], rPrime[2]);
  const cx = rPrime[1] * rDoublePrime[2] - rPrime[2] * rDoublePrime[1];
  const cy = rPrime[2] * rDoublePrime[0] - rPrime[0] * rDoublePrime[2];
  const cz = rPrime[0] * rDoublePrime[1] - rPrime[1] * rDoublePrime[0];
  const crossMag = Math.hypot(cx, cy, cz);
  if (crossMag < 1e-15) return Number.POSITIVE_INFINITY;
  return Math.pow(speed, 3) / crossMag;
}

/** Cubic Bezier first derivative at t: 3·[(1-t)²·(P1-P0) + 2(1-t)t·(P2-P1) + t²·(P3-P2)]. */
export function cubicBezierDerivative(
  t: number,
  p0: [number, number, number],
  p1: [number, number, number],
  p2: [number, number, number],
  p3: [number, number, number],
): [number, number, number] {
  const u = 1 - t;
  const c0 = 3 * u * u;
  const c1 = 6 * u * t;
  const c2 = 3 * t * t;
  return [
    c0 * (p1[0] - p0[0]) + c1 * (p2[0] - p1[0]) + c2 * (p3[0] - p2[0]),
    c0 * (p1[1] - p0[1]) + c1 * (p2[1] - p1[1]) + c2 * (p3[1] - p2[1]),
    c0 * (p1[2] - p0[2]) + c1 * (p2[2] - p1[2]) + c2 * (p3[2] - p2[2]),
  ];
}

/** Cubic Bezier second derivative at t: 6·[(1-t)·(P2-2P1+P0) + t·(P3-2P2+P1)]. */
export function cubicBezierSecondDerivative(
  t: number,
  p0: [number, number, number],
  p1: [number, number, number],
  p2: [number, number, number],
  p3: [number, number, number],
): [number, number, number] {
  const u = 1 - t;
  return [
    6 * u * (p2[0] - 2 * p1[0] + p0[0]) + 6 * t * (p3[0] - 2 * p2[0] + p1[0]),
    6 * u * (p2[1] - 2 * p1[1] + p0[1]) + 6 * t * (p3[1] - 2 * p2[1] + p1[1]),
    6 * u * (p2[2] - 2 * p1[2] + p0[2]) + 6 * t * (p3[2] - 2 * p2[2] + p1[2]),
  ];
}
