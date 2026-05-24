/**
 * Vitest for waveplate op. Verifies:
 *   - HWP θ=0°: +s unchanged, +p phase-flipped
 *   - HWP θ=45°: +s → +p (90° polarization rotation)
 *   - QWP θ=45° on +s: → circular polarization (equal mag, 90° phase diff)
 *   - Power conservation
 *   - q-parameter slab propagation
 */

import { describe, it, expect } from "vitest";
import "./physics";

import { type BeamRay, makeBeamRay } from "../../beam-ray";
import { type Complex } from "../../fiber/gaussian";
import { type Face, type PhysicsOpContext, getOp } from "../../registry";
import { applyWaveplate } from "./physics";

const FACE_A: Face = {
  id: "A",
  positionMmBodyLocal: { x: 0, y: 0, z: -0.5 },
  normalBodyLocal: { x: 0, y: 0, z: -1 },
  apertureMm: 12.5, apertureShape: "rectangle",
};
const FACE_B: Face = {
  id: "B",
  positionMmBodyLocal: { x: 0, y: 0, z: 0.5 },
  normalBodyLocal: { x: 0, y: 0, z: 1 },
  apertureMm: 12.5, apertureShape: "rectangle",
};

function rayWithJones(jones: [Complex, Complex]): BeamRay {
  return {
    ...makeBeamRay({
      origin: { x: 0, y: 0, z: -0.5 },
      direction: { x: 0, y: 0, z: 1 },
      wavelengthNm: 780, powerMw: 1.0,
    }),
    jones,
  };
}

const ctx = (retDeg: number, fastDeg: number): PhysicsOpContext => ({
  faceIn: FACE_A, faceOut: FACE_B,
  params: {
    retardanceDeg: retDeg,
    fastAxisDegBeamLocal: fastDeg,
    lengthMm: 1, refractiveIndex: 1.5,
  },
});

describe("waveplate / jones_waveplate", () => {
  it("registers", () => {
    const op = getOp("waveplate", "jones_waveplate");
    expect(typeof op).toBe("function");
  });

  it("HWP θ=0°: +s preserved (E_s along fast axis)", () => {
    const op = getOp("waveplate", "jones_waveplate");
    const ray = rayWithJones([{ re: 1, im: 0 }, { re: 0, im: 0 }]);
    const [out] = op(ray, ctx(180, 0));
    expect(out.jones[0].re).toBeCloseTo(1, 12);
    expect(out.jones[1].re).toBeCloseTo(0, 12);
    expect(out.powerMw).toBeCloseTo(1, 12);
  });

  it("HWP θ=0°: +p phase-flipped (E_p along slow axis)", () => {
    const op = getOp("waveplate", "jones_waveplate");
    const ray = rayWithJones([{ re: 0, im: 0 }, { re: 1, im: 0 }]);
    const [out] = op(ray, ctx(180, 0));
    // E_p picks up π phase = sign flip
    expect(out.jones[1].re).toBeCloseTo(-1, 12);
    expect(out.jones[1].im).toBeCloseTo(0, 12);
  });

  it("HWP θ=45°: +s → +p (90° polarization rotation)", () => {
    const op = getOp("waveplate", "jones_waveplate");
    const ray = rayWithJones([{ re: 1, im: 0 }, { re: 0, im: 0 }]);
    const [out] = op(ray, ctx(180, 45));
    expect(out.jones[0].re).toBeCloseTo(0, 9);
    expect(out.jones[1].re).toBeCloseTo(1, 9);
  });

  it("HWP θ=22.5°: +s → 45° linear", () => {
    const op = getOp("waveplate", "jones_waveplate");
    const ray = rayWithJones([{ re: 1, im: 0 }, { re: 0, im: 0 }]);
    const [out] = op(ray, ctx(180, 22.5));
    const a = Math.SQRT1_2;
    expect(out.jones[0].re).toBeCloseTo(a, 9);
    expect(out.jones[1].re).toBeCloseTo(a, 9);
  });

  it("QWP θ=45° on +s: equal magnitude, 90° phase difference (circular)", () => {
    const op = getOp("waveplate", "jones_waveplate");
    const ray = rayWithJones([{ re: 1, im: 0 }, { re: 0, im: 0 }]);
    const [out] = op(ray, ctx(90, 45));
    const magS = out.jones[0].re ** 2 + out.jones[0].im ** 2;
    const magP = out.jones[1].re ** 2 + out.jones[1].im ** 2;
    expect(magS).toBeCloseTo(0.5, 9);
    expect(magP).toBeCloseTo(0.5, 9);
    // Phase difference = 90° (one is +i, other is -i relative)
    const phaseS = Math.atan2(out.jones[0].im, out.jones[0].re);
    const phaseP = Math.atan2(out.jones[1].im, out.jones[1].re);
    const diff = phaseS - phaseP;
    // Normalize to [-π, π]
    const normalized = ((diff + Math.PI) % (2 * Math.PI)) - Math.PI;
    expect(Math.abs(Math.abs(normalized) - Math.PI / 2)).toBeLessThan(1e-9);
  });

  it("power preserved (unitary)", () => {
    const op = getOp("waveplate", "jones_waveplate");
    const ray = rayWithJones([{ re: 0.6, im: 0 }, { re: 0.8, im: 0 }]);
    const [out] = op(ray, ctx(90, 30));
    const magOut = out.jones[0].re ** 2 + out.jones[0].im ** 2
                 + out.jones[1].re ** 2 + out.jones[1].im ** 2;
    expect(magOut).toBeCloseTo(1, 12);
    expect(out.powerMw).toBeCloseTo(1, 12);
  });

  it("q-parameter slab propagation (B = L/n)", () => {
    const op = getOp("waveplate", "jones_waveplate");
    const ray = rayWithJones([{ re: 1, im: 0 }, { re: 0, im: 0 }]);
    const B_expected = 1 / 1.5;  // L=1, n=1.5
    const qxIn = ray.qx;
    const [out] = op(ray, ctx(180, 0));
    expect(out.qx.re).toBeCloseTo(qxIn.re + B_expected, 9);
  });

  it("q-parameter accepts legacy thicknessMm alias", () => {
    const op = getOp("waveplate", "jones_waveplate");
    const ray = rayWithJones([{ re: 1, im: 0 }, { re: 0, im: 0 }]);
    const [out] = op(ray, {
      faceIn: FACE_A,
      faceOut: FACE_B,
      params: {
        retardanceDeg: 180,
        fastAxisDegBeamLocal: 0,
        thicknessMm: 2,
        refractiveIndex: 1.5,
      },
    });
    expect(out.qx.re).toBeCloseTo(ray.qx.re + 2 / 1.5, 9);
  });

  it("chief ray propagates face_in → face_out", () => {
    const op = getOp("waveplate", "jones_waveplate");
    const ray = rayWithJones([{ re: 1, im: 0 }, { re: 0, im: 0 }]);
    const [out] = op(ray, ctx(180, 0));
    expect(out.origin.z).toBeCloseTo(0.5, 12);
    expect(out.pathLengthMm).toBeCloseTo(1, 12);
  });

  it("applyWaveplate helper: HWP θ=45° matrix identity", () => {
    const out = applyWaveplate(
      [{ re: 1, im: 0 }, { re: 0, im: 0 }],
      Math.PI, Math.PI / 4,
    );
    expect(out[0].re).toBeCloseTo(0, 9);
    expect(out[1].re).toBeCloseTo(1, 9);
  });
});
