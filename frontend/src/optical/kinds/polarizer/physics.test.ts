/**
 * Vitest for polarizer PhysicsOp — verifies Malus's law and Jones projection.
 */

import { describe, it, expect } from "vitest";
import "./physics";

import { type BeamRay, makeBeamRay } from "../../beam-ray";
import { type Complex } from "../../fiber/gaussian";
import { type Face, type PhysicsOpContext, getOp } from "../../registry";
import { applyLinearPolarizer } from "./physics";

const FACE_IN: Face = {
  id: "A1", positionMmBodyLocal: { x: 0, y: 0, z: -3.75 },
  apertureMm: 6, apertureShape: "rectangle",
};
const FACE_OUT: Face = {
  id: "B1", positionMmBodyLocal: { x: 0, y: 0, z: +3.75 },
  apertureMm: 6, apertureShape: "rectangle",
};

function rayWithJones(jones: [Complex, Complex], powerMw = 1.0): BeamRay {
  return {
    ...makeBeamRay({
      origin: { x: 0, y: 0, z: -3.75 },
      direction: { x: 0, y: 0, z: 1 },
      wavelengthNm: 780,
      powerMw,
    }),
    jones,
  };
}

const ctxAt = (axisDeg: number): PhysicsOpContext => ({
  faceIn: FACE_IN, faceOut: FACE_OUT,
  params: { transmissionAxisDegBeamLocal: axisDeg },
});

describe("polarizer / jones_polarizer", () => {
  it("registers under kind=polarizer", () => {
    const op = getOp("polarizer", "jones_polarizer");
    expect(typeof op).toBe("function");
  });

  it("axis=0°, pure +s input: passes through unchanged power", () => {
    const op = getOp("polarizer", "jones_polarizer");
    const ray = rayWithJones([{ re: 1, im: 0 }, { re: 0, im: 0 }], 1.0);
    const [out] = op(ray, ctxAt(0));
    expect(out.powerMw).toBeCloseTo(1.0, 12);
    expect(out.jones[0].re).toBeCloseTo(1, 12);
    expect(out.jones[1].re).toBeCloseTo(0, 12);
  });

  it("axis=0°, pure +p input: blocked → power = 0", () => {
    const op = getOp("polarizer", "jones_polarizer");
    const ray = rayWithJones([{ re: 0, im: 0 }, { re: 1, im: 0 }], 1.0);
    const [out] = op(ray, ctxAt(0));
    expect(out.powerMw).toBeCloseTo(0, 12);
  });

  it("axis=0°, 45° linear input: Malus's law → power = 0.5", () => {
    const op = getOp("polarizer", "jones_polarizer");
    const a = Math.SQRT1_2;
    const ray = rayWithJones([{ re: a, im: 0 }, { re: a, im: 0 }], 1.0);
    const [out] = op(ray, ctxAt(0));
    expect(out.powerMw).toBeCloseTo(0.5, 12);
  });

  it("axis=90°, pure +s input: blocked", () => {
    const op = getOp("polarizer", "jones_polarizer");
    const ray = rayWithJones([{ re: 1, im: 0 }, { re: 0, im: 0 }], 1.0);
    const [out] = op(ray, ctxAt(90));
    expect(out.powerMw).toBeCloseTo(0, 12);
  });

  it("axis=30°, pure +s input: Malus → power = cos²(30°) = 0.75", () => {
    const op = getOp("polarizer", "jones_polarizer");
    const ray = rayWithJones([{ re: 1, im: 0 }, { re: 0, im: 0 }], 1.0);
    const [out] = op(ray, ctxAt(30));
    expect(out.powerMw).toBeCloseTo(0.75, 12);
  });

  it("chief ray propagates face_in → face_out", () => {
    const op = getOp("polarizer", "jones_polarizer");
    const ray = rayWithJones([{ re: 1, im: 0 }, { re: 0, im: 0 }]);
    const [out] = op(ray, ctxAt(0));
    expect(out.origin.z).toBeCloseTo(3.75, 12);
    expect(out.pathLengthMm).toBeCloseTo(7.5, 12);
  });

  it("preserves wavelength, qx, qy, direction", () => {
    const op = getOp("polarizer", "jones_polarizer");
    const ray = rayWithJones([{ re: 1, im: 0 }, { re: 0, im: 0 }]);
    const [out] = op(ray, ctxAt(0));
    expect(out.wavelengthNm).toBe(ray.wavelengthNm);
    expect(out.qx).toEqual(ray.qx);
    expect(out.qy).toEqual(ray.qy);
    expect(out.direction).toEqual(ray.direction);
  });

  it("renormalizes jones to unit magnitude after projection", () => {
    const op = getOp("polarizer", "jones_polarizer");
    const a = Math.SQRT1_2;
    const ray = rayWithJones([{ re: a, im: 0 }, { re: a, im: 0 }], 1.0);
    const [out] = op(ray, ctxAt(0));
    const mag = out.jones[0].re ** 2 + out.jones[0].im ** 2
              + out.jones[1].re ** 2 + out.jones[1].im ** 2;
    expect(mag).toBeCloseTo(1, 12);
  });

  it("applyLinearPolarizer helper: J(0) = diag(1,0)", () => {
    const out = applyLinearPolarizer(
      [{ re: 0.6, im: 0 }, { re: 0.8, im: 0 }],
      0,
    );
    expect(out[0].re).toBeCloseTo(0.6, 12);
    expect(out[1].re).toBeCloseTo(0, 12);
  });
});
