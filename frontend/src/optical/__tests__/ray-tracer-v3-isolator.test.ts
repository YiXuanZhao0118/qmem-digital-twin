/**
 * Phase 4 Bonus — IO-3 isolator end-to-end through the v3 scene tracer.
 *
 * Exercises 4a (free-space q), 4b (Faraday op), 4c (Jones lab↔body
 * binding rotation) together in the canonical isolator scenario:
 *   - input polarizer (transmission axis at 0° in body, 0° in lab)
 *   - Faraday rotator (+45° in lab around body +z = B-field axis)
 *   - output polarizer (transmission axis at 0° in body, +45° in lab
 *     via binding ryDeg=-45 which is Z(+45) in this project's Euler)
 *
 * Expected:
 *   - Forward beam (lab +x polarized, going +z): passes at full power
 *   - Reverse beam (same polarization, going -z): blocked (power ≈ 0)
 *
 * This is the milestone proving the v3 model + tracer + 3 kinds
 * compose into emergent isolator behaviour with no isolator-specific code.
 */

import { describe, it, expect } from "vitest";

import "../kinds/polarizer/physics";
import "../kinds/faraday-rotator/physics";

import { makeBeamRay } from "../beam-ray";
import {
  type V3AssetSnapshot,
  type V3ComponentSnapshot,
  type V3Scene,
  traceRayScene,
} from "../ray-tracer-v3";

const noRot = { rxDeg: 0, ryDeg: 0, rzDeg: 0 };

const polarizerAsset: V3AssetSnapshot = {
  catalogId: "iso_polarizer",
  kind: "polarizer",
  faces: [
    { id: "A1", positionMmBodyLocal: { x: 0, y: 0, z: -1 },
      normalBodyLocal: { x: 0, y: 0, z: -1 },
      apertureMm: 6, apertureShape: "rectangle" },
    { id: "B1", positionMmBodyLocal: { x: 0, y: 0, z: 1 },
      normalBodyLocal: { x: 0, y: 0, z: 1 },
      apertureMm: 6, apertureShape: "rectangle" },
    { id: "A2", positionMmBodyLocal: { x: 0, y: 0, z: 1 },
      normalBodyLocal: { x: 0, y: 0, z: 1 },
      apertureMm: 6, apertureShape: "rectangle" },
    { id: "B2", positionMmBodyLocal: { x: 0, y: 0, z: -1 },
      normalBodyLocal: { x: 0, y: 0, z: -1 },
      apertureMm: 6, apertureShape: "rectangle" },
  ],
  transitions: [
    { in: "A1", out: "B1", op: "jones_polarizer" },
    { in: "A2", out: "B2", op: "jones_polarizer" },
  ],
  defaultParams: { transmissionAxisDegBeamLocal: 0 },
};

const faradayAsset: V3AssetSnapshot = {
  catalogId: "iso_faraday",
  kind: "faraday_rotator",
  faces: [
    { id: "A1", positionMmBodyLocal: { x: 0, y: 0, z: -1 },
      normalBodyLocal: { x: 0, y: 0, z: -1 },
      apertureMm: 4, apertureShape: "circle" },
    { id: "B1", positionMmBodyLocal: { x: 0, y: 0, z: 1 },
      normalBodyLocal: { x: 0, y: 0, z: 1 },
      apertureMm: 4, apertureShape: "circle" },
    { id: "A2", positionMmBodyLocal: { x: 0, y: 0, z: 1 },
      normalBodyLocal: { x: 0, y: 0, z: 1 },
      apertureMm: 4, apertureShape: "circle" },
    { id: "B2", positionMmBodyLocal: { x: 0, y: 0, z: -1 },
      normalBodyLocal: { x: 0, y: 0, z: -1 },
      apertureMm: 4, apertureShape: "circle" },
  ],
  transitions: [
    { in: "A1", out: "B1", op: "faraday_rotate" },
    { in: "A2", out: "B2", op: "faraday_rotate" },
  ],
  defaultParams: { rotationDeg: 45, lengthMm: 2, refractiveIndex: 1.95 },
};

const isolatorComponent: V3ComponentSnapshot = {
  catalogId: "iso_3_stage",
  bindings: [
    // input polarizer: transmission axis along body +x = lab +x
    { bindingId: "input_pol", asset: polarizerAsset,
      localPose: { xMm: 0, yMm: 0, zMm: -5, ...noRot } },
    // Faraday: rotates +45° around lab Z
    { bindingId: "faraday", asset: faradayAsset,
      localPose: { xMm: 0, yMm: 0, zMm: 0, ...noRot } },
    // output polarizer: ryDeg=-45 → Three Z(+45) → Rz(+45) in lab.
    // Body +x (transmission axis) maps to lab (cos45, sin45, 0) = +45° in lab.
    { bindingId: "output_pol", asset: polarizerAsset,
      localPose: { xMm: 0, yMm: 0, zMm: 5,
                   rxDeg: 0, ryDeg: -45, rzDeg: 0 } },
  ],
};

describe("IO-3 isolator scenario / forward beam", () => {
  it("lab +x polarized ray going +z passes at near-full power", () => {
    const scene: V3Scene = {
      objects: [{
        id: "iso1", component: isolatorComponent,
        pose: { xMm: 0, yMm: 0, zMm: 0, ...noRot },
      }],
    };
    const ray = {
      ...makeBeamRay({
        origin: { x: 0, y: 0, z: -20 },
        direction: { x: 0, y: 0, z: 1 },
        wavelengthNm: 850, powerMw: 1.0,
      }),
      jones: [{ re: 1, im: 0 }, { re: 0, im: 0 }] as [
        { re: number; im: number }, { re: number; im: number }
      ],
    };
    const result = traceRayScene(ray, scene, { maxSteps: 20 });
    // Three optical steps: input_pol, faraday, output_pol
    expect(result.steps.length).toBeGreaterThanOrEqual(3);
    const finalPower = result.finalRays[0]!.powerMw;
    expect(finalPower).toBeCloseTo(1.0, 6);
  });
});

describe("IO-3 isolator scenario / reverse beam", () => {
  it("lab +x polarized ray going -z is BLOCKED (power → 0)", () => {
    const scene: V3Scene = {
      objects: [{
        id: "iso1", component: isolatorComponent,
        pose: { xMm: 0, yMm: 0, zMm: 0, ...noRot },
      }],
    };
    const ray = {
      ...makeBeamRay({
        origin: { x: 0, y: 0, z: 20 },
        direction: { x: 0, y: 0, z: -1 },
        wavelengthNm: 850, powerMw: 1.0,
      }),
      jones: [{ re: 1, im: 0 }, { re: 0, im: 0 }] as [
        { re: number; im: number }, { re: number; im: number }
      ],
    };
    const result = traceRayScene(ray, scene, { maxSteps: 20 });
    // After output_pol attenuates by 0.5 (axis at +45°, polarization at 0°),
    // Faraday rotates polarization in lab to align with lab +y,
    // then input_pol (axis at 0° in lab) blocks the +y polarization.
    const finalPower = result.finalRays[0]!.powerMw;
    expect(finalPower).toBeCloseTo(0, 6);
  });
});

describe("IO-3 isolator scenario / forward+reverse asymmetry (isolation)", () => {
  it("forward power >> reverse power → isolation > 40 dB", () => {
    const scene: V3Scene = {
      objects: [{
        id: "iso1", component: isolatorComponent,
        pose: { xMm: 0, yMm: 0, zMm: 0, ...noRot },
      }],
    };
    const fwdRay = {
      ...makeBeamRay({
        origin: { x: 0, y: 0, z: -20 }, direction: { x: 0, y: 0, z: 1 },
        wavelengthNm: 850, powerMw: 1.0,
      }),
      jones: [{ re: 1, im: 0 }, { re: 0, im: 0 }] as [
        { re: number; im: number }, { re: number; im: number }
      ],
    };
    const revRay = {
      ...makeBeamRay({
        origin: { x: 0, y: 0, z: 20 }, direction: { x: 0, y: 0, z: -1 },
        wavelengthNm: 850, powerMw: 1.0,
      }),
      jones: [{ re: 1, im: 0 }, { re: 0, im: 0 }] as [
        { re: number; im: number }, { re: number; im: number }
      ],
    };
    const fwdResult = traceRayScene(fwdRay, scene, { maxSteps: 20 });
    const revResult = traceRayScene(revRay, scene, { maxSteps: 20 });
    const fwdPower = fwdResult.finalRays[0]!.powerMw;
    const revPower = revResult.finalRays[0]!.powerMw;
    // Ideal isolator: fwd ≈ 1, rev ≈ 0. Ratio infinite. Use threshold to
    // allow for floating-point noise.
    expect(fwdPower).toBeGreaterThan(0.99);
    expect(revPower).toBeLessThan(1e-6);
  });
});
