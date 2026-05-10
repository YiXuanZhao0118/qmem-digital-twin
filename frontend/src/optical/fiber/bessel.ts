/**
 * Bessel functions of the first and second kind, real arguments.
 * Lightweight implementations sufficient for fiber-mode work
 * (relative error < 1e-9 across the relevant ranges):
 *   - J_n(x)  — first-kind, integer order
 *   - K_n(x)  — modified second-kind (decays at infinity)
 * Plus root-finding for J_l(x) used in LP_lm cutoff calculations.
 */

/** Power-series for J_0 (good for |x| < 8); asymptotic for larger x. */
export function besselJ0(x: number): number {
  const ax = Math.abs(x);
  if (ax < 8.0) {
    const y = x * x;
    const num =
      57568490574.0 +
      y *
        (-13362590354.0 +
          y *
            (651619640.7 +
              y * (-11214424.18 + y * (77392.33017 + y * -184.9052456))));
    const den =
      57568490411.0 +
      y *
        (1029532985.0 +
          y * (9494680.718 + y * (59272.64853 + y * (267.8532712 + y))));
    return num / den;
  }
  const z = 8.0 / ax;
  const y = z * z;
  const p =
    1.0 +
    y *
      (-0.1098628627e-2 +
        y *
          (0.2734510407e-4 +
            y * (-0.2073370639e-5 + y * 0.2093887211e-6)));
  const q =
    -0.1562499995e-1 +
    y *
      (0.1430488765e-3 +
        y *
          (-0.6911147651e-5 +
            y * (0.7621095161e-6 + y * -0.934935152e-7)));
  return Math.sqrt(0.636619772 / ax) * (Math.cos(ax - 0.785398164) * p - z * Math.sin(ax - 0.785398164) * q);
}

/** Power-series for J_1 (good for |x| < 8); asymptotic for larger x. */
export function besselJ1(x: number): number {
  const ax = Math.abs(x);
  let result: number;
  if (ax < 8.0) {
    const y = x * x;
    const num =
      x *
      (72362614232.0 +
        y *
          (-7895059235.0 +
            y *
              (242396853.1 +
                y * (-2972611.439 + y * (15704.48260 + y * -30.16036606)))));
    const den =
      144725228442.0 +
      y *
        (2300535178.0 +
          y * (18583304.74 + y * (99447.43394 + y * (376.9991397 + y))));
    result = num / den;
  } else {
    const z = 8.0 / ax;
    const y = z * z;
    const p =
      1.0 +
      y *
        (0.183105e-2 +
          y *
            (-0.3516396496e-4 +
              y * (0.2457520174e-5 + y * -0.240337019e-6)));
    const q =
      0.04687499995 +
      y *
        (-0.2002690873e-3 +
          y *
            (0.8449199096e-5 +
              y * (-0.88228987e-6 + y * 0.105787412e-6)));
    result =
      Math.sqrt(0.636619772 / ax) *
      (Math.cos(ax - 2.356194491) * p - z * Math.sin(ax - 2.356194491) * q);
    if (x < 0) result = -result;
  }
  return result;
}

/** J_n for general integer n via stable downward recurrence. */
export function besselJ(n: number, x: number): number {
  if (n === 0) return besselJ0(x);
  if (n === 1) return besselJ1(x);
  if (n < 0) return (n & 1 ? -1 : 1) * besselJ(-n, x);
  if (x === 0) return 0;
  const ax = Math.abs(x);
  // For small n relative to x: forward recurrence
  if (ax > n) {
    const tox = 2.0 / ax;
    let bjm = besselJ0(ax);
    let bj = besselJ1(ax);
    for (let j = 1; j < n; j += 1) {
      const bjp = j * tox * bj - bjm;
      bjm = bj;
      bj = bjp;
    }
    return x < 0 && (n & 1) ? -bj : bj;
  }
  // Downward recurrence (Miller's algorithm) for stability when n > x
  const tox = 2.0 / ax;
  // Start from a high index well above n
  const ACC = 40.0;
  const BIGNO = 1.0e10;
  const BIGNI = 1.0e-10;
  const m = 2 * (Math.floor((n + Math.sqrt(ACC * n)) / 2) | 0);
  let jsum = false;
  let bjp = 0.0;
  let ans = 0.0;
  let bj = 1.0;
  let sum = 0.0;
  for (let j = m; j > 0; j -= 1) {
    const bjm = j * tox * bj - bjp;
    bjp = bj;
    bj = bjm;
    if (Math.abs(bj) > BIGNO) {
      bj *= BIGNI;
      bjp *= BIGNI;
      ans *= BIGNI;
      sum *= BIGNI;
    }
    if (jsum) sum += bj;
    jsum = !jsum;
    if (j === n) ans = bjp;
  }
  sum = 2.0 * sum - bj;
  ans /= sum;
  return x < 0 && (n & 1) ? -ans : ans;
}

/** Modified Bessel of the first kind I_0 (positive, monotonic).
 *  Series for |x|<3.75, asymptotic for larger. */
export function besselI0(x: number): number {
  const ax = Math.abs(x);
  if (ax < 3.75) {
    const y = (x / 3.75) ** 2;
    return (
      1.0 +
      y *
        (3.5156229 +
          y *
            (3.0899424 +
              y * (1.2067492 + y * (0.2659732 + y * (0.0360768 + y * 0.0045813)))))
    );
  }
  const y = 3.75 / ax;
  return (
    (Math.exp(ax) / Math.sqrt(ax)) *
    (0.39894228 +
      y *
        (0.01328592 +
          y *
            (0.00225319 +
              y *
                (-0.00157565 +
                  y *
                    (0.00916281 +
                      y *
                        (-0.02057706 +
                          y * (0.02635537 + y * (-0.01647633 + y * 0.00392377))))))))
  );
}

/** Modified Bessel of the first kind I_1. */
export function besselI1(x: number): number {
  const ax = Math.abs(x);
  let ans: number;
  if (ax < 3.75) {
    const y = (x / 3.75) ** 2;
    ans =
      ax *
      (0.5 +
        y *
          (0.87890594 +
            y *
              (0.51498869 +
                y *
                  (0.15084934 +
                    y * (0.02658733 + y * (0.00301532 + y * 0.00032411))))));
  } else {
    const y = 3.75 / ax;
    ans =
      0.39894228 +
      y *
        (-0.03988024 +
          y *
            (-0.00362018 +
              y *
                (0.00163801 +
                  y *
                    (-0.01031555 +
                      y *
                        (0.02282967 +
                          y * (-0.02895312 + y * (0.01787654 + y * -0.00420059)))))));
    ans *= Math.exp(ax) / Math.sqrt(ax);
  }
  return x < 0 ? -ans : ans;
}

/** Modified Bessel of the second kind K_0. */
export function besselK0(x: number): number {
  if (x <= 0) return Number.POSITIVE_INFINITY;
  if (x <= 2.0) {
    const y = (x * x) / 4.0;
    return (
      -Math.log(x / 2.0) * besselI0(x) +
      (-0.57721566 +
        y *
          (0.42278420 +
            y *
              (0.23069756 +
                y *
                  (0.03488590 +
                    y * (0.00262698 + y * (0.00010750 + y * 0.00000740))))))
    );
  }
  const y = 2.0 / x;
  return (
    (Math.exp(-x) / Math.sqrt(x)) *
    (1.25331414 +
      y *
        (-0.07832358 +
          y *
            (0.02189568 +
              y *
                (-0.01062446 +
                  y * (0.00587872 + y * (-0.00251540 + y * 0.00053208))))))
  );
}

/** Modified Bessel of the second kind K_1. */
export function besselK1(x: number): number {
  if (x <= 0) return Number.POSITIVE_INFINITY;
  if (x <= 2.0) {
    const y = (x * x) / 4.0;
    return (
      Math.log(x / 2.0) * besselI1(x) +
      (1.0 / x) *
        (1.0 +
          y *
            (0.15443144 +
              y *
                (-0.67278579 +
                  y *
                    (-0.18156897 +
                      y * (-0.01919402 + y * (-0.00110404 + y * -0.00004686))))))
    );
  }
  const y = 2.0 / x;
  return (
    (Math.exp(-x) / Math.sqrt(x)) *
    (1.25331414 +
      y *
        (0.23498619 +
          y *
            (-0.03655620 +
              y *
                (0.01504268 +
                  y * (-0.00780353 + y * (0.00325614 + y * -0.00068245))))))
  );
}

/** K_n via upward recurrence from K_0 and K_1. Stable for n ≥ 0. */
export function besselK(n: number, x: number): number {
  if (n === 0) return besselK0(x);
  if (n === 1) return besselK1(x);
  if (n < 0) return besselK(-n, x);
  if (x <= 0) return Number.POSITIVE_INFINITY;
  let bkm = besselK0(x);
  let bk = besselK1(x);
  const tox = 2.0 / x;
  for (let j = 1; j < n; j += 1) {
    const bkp = bkm + j * tox * bk;
    bkm = bk;
    bk = bkp;
  }
  return bk;
}

/** First N positive roots of J_0(x) via Newton's method.
 *  Initial guesses from McMahon's expansion: μ_n ≈ (n − 1/4)·π. */
export function besselJ0Roots(n: number): number[] {
  const roots: number[] = [];
  for (let k = 1; k <= n; k += 1) {
    let x = (k - 0.25) * Math.PI;
    for (let i = 0; i < 30; i += 1) {
      const f = besselJ0(x);
      const fp = -besselJ1(x);
      const dx = f / fp;
      x -= dx;
      if (Math.abs(dx) < 1e-12) break;
    }
    roots.push(x);
  }
  return roots;
}

/** First N positive roots of J_l(x) for given integer order l ≥ 0.
 *  Uses McMahon's asymptotic expansion as initial guess. */
export function besselJRoots(l: number, n: number): number[] {
  if (l === 0) return besselJ0Roots(n);
  const roots: number[] = [];
  for (let k = 1; k <= n; k += 1) {
    // Asymptotic: μ_lk ≈ (k + l/2 − 1/4)·π
    let x = (k + l / 2 - 0.25) * Math.PI;
    for (let i = 0; i < 40; i += 1) {
      const f = besselJ(l, x);
      // J_l'(x) = (J_{l-1}(x) − J_{l+1}(x)) / 2
      const fp = (besselJ(l - 1, x) - besselJ(l + 1, x)) / 2;
      if (Math.abs(fp) < 1e-15) break;
      const dx = f / fp;
      x -= dx;
      if (Math.abs(dx) < 1e-12) break;
    }
    roots.push(x);
  }
  return roots;
}
