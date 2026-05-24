/**
 * Vitest for PBS ops. Verifies:
 *   - pbs_transmit_p: pure +s passes at full power, +p blocked
 *   - pbs_reflect_s: pure +p passes at full power, +s blocked,
 *                    direction reflects to face_out.normal
 *   - 45° linear → 0.5 transmit + 0.5 reflect (Malus)
 *   - q-parameter propagates through slab B = d/n
 */

import { describe, it, expect } from "vitest";
import "./physics";

import { type BeamRay, makeBeamRay } from "../../beam-ray";
import { type Complex } from "../../fiber/gaussian";
import { type Face, type PhysicsOpContext, getOp } from "../../registry";

const D = 10; // cube size
const SQRT_HALF = Math.SQRT1_2;

const FACE_BACK: Face = {
  id: "back",
  positionMmBodyLocal: { x: 0, y: 0, z: -D / 2 },
  normalBodyLocal: { x: 0, y: 0, z: -1 },
  apertureMm: D / 2, apertureShape: "rectangle",
};
const FACE_FRONT: Face = {
  id: "front",
  positionMmBodyLocal: { x: 0, y: 0, z: D / 2 },
  normalBodyLocal: { x: 0, y: 0, z: 1 },
  apertureMm: D / 2, apertureShape: "rectangle",
};
const FACE_RIGHT: Face = {
  id: "right",
  positionMmBodyLocal: { x: D / 2, y: 0, z: 0 },
  normalBodyLocal: { x: 1, y: 0, z: 0 },
  apertureMm: D / 2, apertureShape: "rectangle",
};
// Internal Brewster plate at 45°, normal toward back-up corner.
// Mirror-reflects back→right and front→left.
const FACE_B1: Face = {
  id: "B1",
  positionMmBodyLocal: { x: 0, y: 0, z: 0 },
  normalBodyLocal: { x: -SQRT_HALF, y: 0, z: SQRT_HALF },
  apertureMm: (D * Math.SQRT2) / 2,
  apertureShape: "rectangle",
};

function rayWithJones(jones: [Complex, Complex], powerMw = 1.0): BeamRay {
  return {
    ...makeBeamRay({
      origin: { x: 0, y: 0, z: -D / 2 },
      direction: { x: 0, y: 0, z: 1 },
      wavelengthNm: 780, powerMw,
    }),
    jones,
  };
}

const ctxTransmit = (overrides: Partial<PhysicsOpContext["params"]> = {}): PhysicsOpContext => ({
  faceIn: FACE_BACK, faceOut: FACE_FRONT,
  params: { cubeSizeMm: D, refractiveIndex: 1.5168, ...overrides },
  faceVia: [FACE_B1],
});

const ctxReflect = (overrides: Partial<PhysicsOpContext["params"]> = {}): PhysicsOpContext => ({
  faceIn: FACE_BACK, faceOut: FACE_RIGHT,
  params: { cubeSizeMm: D, refractiveIndex: 1.5168, ...overrides },
  faceVia: [FACE_B1],
});

describe("pbs / pbs_transmit_p", () => {
  it("registers under kind=pbs", () => {
    const op = getOp("pbs", "pbs_transmit_p");
    expect(typeof op).toBe("function");
  });

  it("pure +s input → full transmit power", () => {
    const op = getOp("pbs", "pbs_transmit_p");
    const ray = rayWithJones([{ re: 1, im: 0 }, { re: 0, im: 0 }]);
    const [out] = op(ray, ctxTransmit());
    expect(out.powerMw).toBeCloseTo(1.0, 12);
  });

  it("pure +p input → blocked (power 0)", () => {
    const op = getOp("pbs", "pbs_transmit_p");
    const ray = rayWithJones([{ re: 0, im: 0 }, { re: 1, im: 0 }]);
    const [out] = op(ray, ctxTransmit());
    expect(out.powerMw).toBeCloseTo(0, 12);
  });

  it("45° linear → 0.5 power (Malus)", () => {
    const op = getOp("pbs", "pbs_transmit_p");
    const a = Math.SQRT1_2;
    const ray = rayWithJones([{ re: a, im: 0 }, { re: a, im: 0 }]);
    const [out] = op(ray, ctxTransmit());
    expect(out.powerMw).toBeCloseTo(0.5, 12);
  });

  it("direction unchanged for transmit", () => {
    const op = getOp("pbs", "pbs_transmit_p");
    const ray = rayWithJones([{ re: 1, im: 0 }, { re: 0, im: 0 }]);
    const [out] = op(ray, ctxTransmit());
    expect(out.direction).toEqual(ray.direction);
  });

  it("exits at front face position", () => {
    const op = getOp("pbs", "pbs_transmit_p");
    const ray = rayWithJones([{ re: 1, im: 0 }, { re: 0, im: 0 }]);
    const [out] = op(ray, ctxTransmit());
    expect(out.origin.z).toBeCloseTo(D / 2, 12);
  });
});

describe("pbs / pbs_reflect_s", () => {
  it("registers under kind=pbs", () => {
    const op = getOp("pbs", "pbs_reflect_s");
    expect(typeof op).toBe("function");
  });

  it("pure +p input → full reflect power", () => {
    const op = getOp("pbs", "pbs_reflect_s");
    const ray = rayWithJones([{ re: 0, im: 0 }, { re: 1, im: 0 }]);
    const [out] = op(ray, ctxReflect());
    expect(out.powerMw).toBeCloseTo(1.0, 12);
  });

  it("pure +s input → blocked (power 0)", () => {
    const op = getOp("pbs", "pbs_reflect_s");
    const ray = rayWithJones([{ re: 1, im: 0 }, { re: 0, im: 0 }]);
    const [out] = op(ray, ctxReflect());
    expect(out.powerMw).toBeCloseTo(0, 12);
  });

  it("45° linear → 0.5 power (Malus)", () => {
    const op = getOp("pbs", "pbs_reflect_s");
    const a = Math.SQRT1_2;
    const ray = rayWithJones([{ re: a, im: 0 }, { re: a, im: 0 }]);
    const [out] = op(ray, ctxReflect());
    expect(out.powerMw).toBeCloseTo(0.5, 12);
  });

  it("direction from mirror formula at B1 (back → right)", () => {
    // k=+z reflected off plate n=(-0.7071,0,0.7071) gives k=+x (right).
    const op = getOp("pbs", "pbs_reflect_s");
    const ray = rayWithJones([{ re: 0, im: 0 }, { re: 1, im: 0 }]);
    const [out] = op(ray, ctxReflect());
    expect(out.direction.x).toBeCloseTo(1, 12);
    expect(out.direction.y).toBeCloseTo(0, 12);
    expect(out.direction.z).toBeCloseTo(0, 12);
  });

  it("exits at right face position", () => {
    const op = getOp("pbs", "pbs_reflect_s");
    const ray = rayWithJones([{ re: 0, im: 0 }, { re: 1, im: 0 }]);
    const [out] = op(ray, ctxReflect());
    expect(out.origin.x).toBeCloseTo(D / 2, 12);
    expect(out.origin.z).toBeCloseTo(0, 12);
  });

  it("throws if transition.via is missing the Brewster plate", () => {
    const op = getOp("pbs", "pbs_reflect_s");
    const ray = rayWithJones([{ re: 0, im: 0 }, { re: 1, im: 0 }]);
    const ctx: PhysicsOpContext = {
      faceIn: FACE_BACK,
      faceOut: FACE_RIGHT,
      params: { cubeSizeMm: D, refractiveIndex: 1.5168 },
      faceVia: [],
    };
    expect(() => op(ray, ctx)).toThrowError(/via/);
  });
});

describe("pbs / q-parameter slab propagation", () => {
  it("q propagates by B = d/n", () => {
    const op = getOp("pbs", "pbs_transmit_p");
    const ray = rayWithJones([{ re: 1, im: 0 }, { re: 0, im: 0 }]);
    const B_expected = D / 1.5168;
    const qx_in = ray.qx;
    const [out] = op(ray, ctxTransmit());
    expect(out.qx.re).toBeCloseTo(qx_in.re + B_expected, 9);
    expect(out.qx.im).toBeCloseTo(qx_in.im, 12);
  });
});
