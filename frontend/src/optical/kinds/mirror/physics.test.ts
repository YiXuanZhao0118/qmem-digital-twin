/**
 * Vitest for mirror PhysicsOp.
 */

import { describe, it, expect } from "vitest";
import "./physics";

import { type BeamRay, makeBeamRay } from "../../beam-ray";
import { type Face, getOp } from "../../registry";
import { reflectDirection } from "./physics";

function faceWithNormal(n: { x: number; y: number; z: number }): Face {
  return {
    id: "A",
    positionMmBodyLocal: { x: 0, y: 0, z: 0 },
    normalBodyLocal: n,
    apertureMm: 12.7,
    apertureShape: "circle",
  };
}

function makeIncomingRay(direction: { x: number; y: number; z: number }): BeamRay {
  return makeBeamRay({
    origin: { x: 0, y: 0, z: 0 },
    direction,
    wavelengthNm: 780,
  });
}

describe("mirror / reflect_specular", () => {
  it("registers under kind=mirror, op=reflect_specular", () => {
    const op = getOp("mirror", "reflect_specular");
    expect(typeof op).toBe("function");
  });

  it("throws when face lacks normal", () => {
    const op = getOp("mirror", "reflect_specular");
    const ray = makeIncomingRay({ x: 0, y: 0, z: -1 });
    expect(() =>
      op(ray, {
        faceIn: {
          id: "A",
          positionMmBodyLocal: { x: 0, y: 0, z: 0 },
          apertureMm: 12.7,
          apertureShape: "circle",
        },
        faceOut: {
          id: "A",
          positionMmBodyLocal: { x: 0, y: 0, z: 0 },
          apertureMm: 12.7,
          apertureShape: "circle",
        },
        params: {},
      }),
    ).toThrowError(/normalBodyLocal/);
  });

  it("normal incidence: +z mirror reflects -z ray back along +z", () => {
    const op = getOp("mirror", "reflect_specular");
    const face = faceWithNormal({ x: 0, y: 0, z: 1 });
    const ray = makeIncomingRay({ x: 0, y: 0, z: -1 });
    const [out] = op(ray, { faceIn: face, faceOut: face, params: {} });
    expect(out.direction.x).toBeCloseTo(0, 12);
    expect(out.direction.y).toBeCloseTo(0, 12);
    expect(out.direction.z).toBeCloseTo(1, 12);
  });

  it("45° incidence: reflects symmetric across normal", () => {
    const op = getOp("mirror", "reflect_specular");
    const face = faceWithNormal({ x: 0, y: 0, z: 1 });
    // Incoming at 45° in xz plane: d = (sin45, 0, -cos45)
    const a = Math.SQRT1_2;
    const ray = makeIncomingRay({ x: a, y: 0, z: -a });
    const [out] = op(ray, { faceIn: face, faceOut: face, params: {} });
    expect(out.direction.x).toBeCloseTo(a, 12);   // x preserved
    expect(out.direction.y).toBeCloseTo(0, 12);
    expect(out.direction.z).toBeCloseTo(a, 12);   // z flips sign
  });

  it("applies reflectivity to power", () => {
    const op = getOp("mirror", "reflect_specular");
    const face = faceWithNormal({ x: 0, y: 0, z: 1 });
    const ray = makeIncomingRay({ x: 0, y: 0, z: -1 });
    const [out] = op(ray, {
      faceIn: face, faceOut: face,
      params: { reflectivity: 0.97 },
    });
    expect(out.powerMw).toBeCloseTo(ray.powerMw * 0.97, 12);
  });

  it("preserves origin, wavelength, qx, qy", () => {
    const op = getOp("mirror", "reflect_specular");
    const face = faceWithNormal({ x: 0, y: 0, z: 1 });
    const ray = makeIncomingRay({ x: 0, y: 0, z: -1 });
    const [out] = op(ray, { faceIn: face, faceOut: face, params: {} });
    expect(out.origin).toEqual(ray.origin);
    expect(out.wavelengthNm).toBe(ray.wavelengthNm);
    expect(out.qx).toEqual(ray.qx);
    expect(out.qy).toEqual(ray.qy);
  });

  it("returns single ray (no branching)", () => {
    const op = getOp("mirror", "reflect_specular");
    const face = faceWithNormal({ x: 0, y: 0, z: 1 });
    const ray = makeIncomingRay({ x: 0, y: 0, z: -1 });
    const outs = op(ray, { faceIn: face, faceOut: face, params: {} });
    expect(outs).toHaveLength(1);
  });

  it("reflectDirection helper: d - 2(d·n)n identity", () => {
    const d = { x: 1, y: 2, z: 3 };
    const n = { x: 0, y: 0, z: 1 };
    const dPrime = reflectDirection(d, n);
    expect(dPrime.x).toBeCloseTo(1, 12);
    expect(dPrime.y).toBeCloseTo(2, 12);
    expect(dPrime.z).toBeCloseTo(-3, 12);  // z flipped
  });
});
