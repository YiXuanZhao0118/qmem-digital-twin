import { describe, expect, it } from "vitest";

import {
  eigSym2,
  principalAzimuthRad,
  qWidthTensor,
  realWidthTensor,
  rotateCSym2,
  rotateSym2,
  type CSym2,
  type Sym2,
} from "./beamTensor";

const WL = 852.347;
const ISO: Sym2 = { xx: 1, yy: 1, xy: 0 };
const deg = (d: number) => (d * Math.PI) / 180;

/** A collimated-ish astigmatic Q, diagonal in its own principal frame. */
const Q_DIAG: CSym2 = {
  xx: { re: -188.8, im: 1792.6 },
  yy: { re: -626.0, im: 1232.6 },
  xy: { re: 0, im: 0 },
};

/** The same beam seen from a frame the principal axes sit `theta` away from. */
function rolledBy(theta: number): CSym2 {
  return rotateCSym2(Q_DIAG, -theta);
}

describe("rotateSym2", () => {
  it("is exempt for a zero angle and for an isotropic tensor", () => {
    const t: Sym2 = { xx: 4, yy: 1, xy: 0.3 };
    expect(rotateSym2(t, 0)).toBe(t);
    const iso: Sym2 = { xx: 2, yy: 2, xy: 0 };
    expect(rotateSym2(iso, deg(37))).toBe(iso);
  });

  it("swaps the diagonal on a quarter turn", () => {
    const out = rotateSym2({ xx: 4, yy: 1, xy: 0 }, Math.PI / 2);
    expect(out.xx).toBeCloseTo(1, 12);
    expect(out.yy).toBeCloseTo(4, 12);
    expect(out.xy).toBeCloseTo(0, 12);
  });

  it("round-trips and preserves the eigenvalues", () => {
    const t: Sym2 = { xx: 9, yy: 1, xy: 0 };
    const r = rotateSym2(t, deg(41));
    expect(eigSym2(r).major).toBeCloseTo(9, 10);
    expect(eigSym2(r).minor).toBeCloseTo(1, 10);
    const back = rotateSym2(r, deg(-41));
    expect(back.xx).toBeCloseTo(9, 10);
    expect(back.yy).toBeCloseTo(1, 10);
    expect(back.xy).toBeCloseTo(0, 10);
  });
});

describe("eigSym2", () => {
  it("recovers a known decomposition", () => {
    const t = rotateSym2({ xx: 9, yy: 1, xy: 0 }, deg(-30));
    const e = eigSym2(t);
    expect(e.major).toBeCloseTo(9, 10);
    expect(e.minor).toBeCloseTo(1, 10);
    expect(e.azimuthRad).toBeCloseTo(deg(30), 10);
  });
});

describe("realWidthTensor", () => {
  it("reduces to the per-axis width x multiplier when both are diagonal", () => {
    const w: Sym2 = { xx: 4, yy: 9, xy: 0 };          // widths SQUARED
    const s: Sym2 = { xx: 2, yy: 3, xy: 0 };
    const r = realWidthTensor(w, s);
    expect(Math.sqrt(r.xx)).toBeCloseTo(2 * 2, 12);   // mult * sqrt(w)
    expect(Math.sqrt(r.yy)).toBeCloseTo(3 * 3, 12);
    expect(r.xy).toBeCloseTo(0, 12);
  });
});

describe("qWidthTensor", () => {
  it("is diagonal for a diagonal Q, with the wider axis where qy is", () => {
    const w = qWidthTensor(Q_DIAG, WL);
    expect(w.xy).toBeCloseTo(0, 12);
    // both entries are real widths squared, so positive
    expect(w.xx).toBeGreaterThan(0);
    expect(w.yy).toBeGreaterThan(0);
  });

  it("turns with the beam", () => {
    const w = qWidthTensor(rolledBy(deg(25)), WL);
    expect(eigSym2(w).azimuthRad).toBeCloseTo(deg(25), 8);
  });
});

describe("principalAzimuthRad", () => {
  it("is EXACTLY zero for an unrolled beam, so old payloads are untouched", () => {
    expect(principalAzimuthRad(Q_DIAG, ISO, WL)).toBe(0);
  });

  it("is exactly zero for a circular beam with no cross term", () => {
    const round: CSym2 = {
      xx: { re: 0, im: 900 }, yy: { re: 0, im: 900 }, xy: { re: 0, im: 0 },
    };
    expect(principalAzimuthRad(round, ISO, WL)).toBe(0);
  });

  it.each([5, 25, 45, 70, -33])("recovers a %s deg roll", (d) => {
    const theta = deg(d);
    expect(principalAzimuthRad(rolledBy(theta), ISO, WL)).toBeCloseTo(theta, 8);
  });

  it("returns the angle that diagonalises Q", () => {
    const theta = deg(37);
    const q = rolledBy(theta);
    const azim = principalAzimuthRad(q, ISO, WL);
    const diag = rotateCSym2(q, azim);
    expect(diag.xy.re).toBeCloseTo(0, 8);
    expect(diag.xy.im).toBeCloseTo(0, 8);
    // and it restores the original principal q values
    expect(diag.xx.re).toBeCloseTo(Q_DIAG.xx.re, 6);
    expect(diag.yy.im).toBeCloseTo(Q_DIAG.yy.im, 6);
  });

  it("follows the multiplier when Q itself is round", () => {
    const round: CSym2 = {
      xx: { re: 0, im: 900 }, yy: { re: 0, im: 900 }, xy: { re: 0, im: 0 },
    };
    // an anisotropic multiplier rolled by 20 deg is the only asymmetry here
    const mult = rotateSym2({ xx: 3, yy: 1, xy: 0 }, deg(-20));
    expect(principalAzimuthRad(round, mult, WL)).toBeCloseTo(deg(20), 8);
  });
});
