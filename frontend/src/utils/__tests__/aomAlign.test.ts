/**
 * AOM Bragg align geometry. The invariant every test here defends: after the
 * align, the beam arrives at the incidence the SOLVER calls matched for the
 * selected order (`k̂·D̂2 = −m·sin θ_B`, backend `aom_physics`), with the
 * interaction centre still on the beam.
 */
import { describe, expect, it } from "vitest";

import type { Asset3D, SceneObject } from "../../types/digitalTwin";
import { braggAngleRad } from "../../optical/kinds/aom/physics";
import {
  aomBraggReadout,
  braggTiltRad,
  computeAomBraggAlignPose,
  computeAomTiltNudgePose,
  resolveAomBraggFrame,
} from "../aomAlign";
import { cadToLab } from "../isolatorAlign";

const THETA_B = braggAngleRad({ centerFreqMhz: 80, acousticVelocityMps: 4200 }, 780);

/** MT80-like asset: optical axis body +Y (in at −11.2, out at +11.2),
 *  acoustic −X (the live aa_mt80_a1_5_ir row). */
function mt80Asset(overrides: Partial<Asset3D> = {}): Asset3D {
  return {
    id: "asset-aom",
    name: "aa_mt80_a1_5_ir",
    kindId: "aom",
    filePath: "aa_mt80_a1_5_ir.glb",
    anchors: [
      {
        id: "intercept_in",
        positionMmBodyLocal: { x: 0, y: -11.2, z: 0 },
        axisXBodyLocal: { x: 0, y: -1, z: 0 },
      },
      {
        id: "intercept_out",
        positionMmBodyLocal: { x: 0, y: 11.2, z: 0 },
        axisXBodyLocal: { x: 0, y: 1, z: 0 },
      },
    ],
    defaultParams: { rfPropagationDirectionBodyLocal: [-1, 0, 0] },
    ...overrides,
  } as unknown as Asset3D;
}

function sceneObject(pose: Partial<SceneObject> = {}): SceneObject {
  return {
    id: "obj-aom",
    componentId: "comp-aom",
    xMm: 0, yMm: 0, zMm: 0,
    rxDeg: 0, ryDeg: 0, rzDeg: 0,
    ...pose,
  } as unknown as SceneObject;
}

const norm = (v: { x: number; y: number; z: number }) => {
  const m = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / m, y: v.y / m, z: v.z / m };
};

/** Re-read the frame in lab coords under a pose and measure the incidence
 *  the solver would see. */
function measure(
  asset: Asset3D, obj: SceneObject, beamDir: { x: number; y: number; z: number },
) {
  const frame = resolveAomBraggFrame(asset)!;
  return aomBraggReadout({
    frame, sceneObject: obj, beamDir, thetaBRad: THETA_B,
    wavelengthNm: 780, freqMhz: 80, acousticVelocityMps: 4200,
    refractiveIndex: 2.26, crystalLengthMm: 1.6,
  })!;
}

describe("resolveAomBraggFrame", () => {
  it("builds a right-handed triad from the intercept pair + acoustic param", () => {
    const f = resolveAomBraggFrame(mt80Asset())!;
    expect(f.D1).toEqual({ x: 0, y: 1, z: 0 });          // in → out
    expect(f.D2.x).toBeCloseTo(-1, 12);                   // acoustic −X
    expect(f.D2.y).toBeCloseTo(0, 12);
    // D3 = D1 × D2 = ŷ × (−x̂) = +ẑ
    expect(f.D3.z).toBeCloseTo(1, 12);
    expect(f.centreMm).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("prefers the acoustic_axis anchor over the legacy param", () => {
    const asset = mt80Asset();
    asset.anchors!.push({
      id: "acoustic_axis",
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      axisXBodyLocal: { x: 0, y: 0, z: 1 },
    } as never);
    expect(resolveAomBraggFrame(asset)!.D2.z).toBeCloseTo(1, 12);
  });

  it("orthogonalises an acoustic axis that isn't quite perpendicular", () => {
    const asset = mt80Asset({
      defaultParams: { rfPropagationDirectionBodyLocal: [-1, 0.2, 0] },
    } as Partial<Asset3D>);
    const f = resolveAomBraggFrame(asset)!;
    expect(f.D2.y).toBeCloseTo(0, 12);                    // D1 component removed
    expect(f.D1.x * f.D2.x + f.D1.y * f.D2.y + f.D1.z * f.D2.z).toBeCloseTo(0, 12);
  });

  it("returns null without an intercept pair or an acoustic direction", () => {
    expect(resolveAomBraggFrame(mt80Asset({ anchors: [] } as Partial<Asset3D>))).toBeNull();
    expect(resolveAomBraggFrame(mt80Asset({ defaultParams: {} } as Partial<Asset3D>))).toBeNull();
  });
});

describe("computeAomBraggAlignPose", () => {
  const asset = mt80Asset();
  const beamDir = { x: 1, y: 0, z: 0 };
  const beamRef = { x: 0, y: 0, z: 50 };

  const alignedFor = (order: number, extra: { reverse?: boolean; fineRad?: number } = {}) => {
    const frame = resolveAomBraggFrame(asset)!;
    const start = sceneObject({ xMm: 13, yMm: 7, zMm: 62, ryDeg: 20 });
    const pose = computeAomBraggAlignPose({
      frame,
      sceneObject: start,
      beamDir,
      beamRef,
      reverse: extra.reverse,
      tiltRad: braggTiltRad(order, THETA_B) + (extra.fineRad ?? 0),
    })!;
    return sceneObject(pose);
  };

  it("puts the beam at the matched incidence for the selected order", () => {
    for (const order of [1, -1]) {
      const r = measure(asset, alignedFor(order), beamDir);
      // Matched incidence is −m·θ_B (backend bragg_matched_incidence_rad).
      expect(r.thetaInRad).toBeCloseTo(-order * THETA_B, 9);
      expect(r.matchedOrder).toBe(order);
      const sel = r.orders.find((o) => o.order === order)!;
      expect(sel.mismatchRad).toBeCloseTo(0, 9);
      expect(sel.phaseMatch).toBeCloseTo(1, 9);
      // The other first order is 2·θ_B off and weaker.
      const other = r.orders.find((o) => o.order === -order)!;
      expect(Math.abs(other.mismatchRad)).toBeCloseTo(2 * THETA_B, 9);
      expect(other.phaseMatch).toBeLessThan(sel.phaseMatch);
    }
  });

  it("leaves the interaction centre on the beam line", () => {
    const obj = alignedFor(1);
    const frame = resolveAomBraggFrame(asset)!;
    const centre = cadToLab(frame.centreMm, obj);
    const b = norm(beamDir);
    const t = (centre.x - beamRef.x) * b.x + (centre.y - beamRef.y) * b.y
      + (centre.z - beamRef.z) * b.z;
    const miss = Math.hypot(
      centre.x - (beamRef.x + b.x * t),
      centre.y - (beamRef.y + b.y * t),
      centre.z - (beamRef.z + b.z * t),
    );
    expect(miss).toBeCloseTo(0, 9);
  });

  it("is idempotent (re-aligning an aligned AOM does not move it)", () => {
    const frame = resolveAomBraggFrame(asset)!;
    const once = alignedFor(1);
    const twice = computeAomBraggAlignPose({
      frame, sceneObject: once, beamDir, beamRef, tiltRad: braggTiltRad(1, THETA_B),
    })!;
    for (const k of ["xMm", "yMm", "zMm", "rxDeg", "ryDeg", "rzDeg"] as const) {
      expect(twice[k]).toBeCloseTo(once[k] as number, 6);
    }
  });

  it("keeps the tilt lab-fixed under reverse traversal (CONV-2), which matches −m", () => {
    // Same +θ_B tilt about D3; the beam now runs backwards through the cell,
    // so the matched order flips sign — the readout has to say so.
    const r = measure(asset, alignedFor(1, { reverse: true }), beamDir);
    expect(r.thetaInRad).toBeCloseTo(THETA_B, 9);
    expect(r.matchedOrder).toBe(-1);
    expect(r.orders.find((o) => o.order === -1)!.phaseMatch).toBeCloseTo(1, 9);
  });

  it("carries a fine-tune offset straight into the incidence", () => {
    const fineRad = 2e-3;
    const r = measure(asset, alignedFor(1, { fineRad }), beamDir);
    expect(r.thetaInRad).toBeCloseTo(-THETA_B - fineRad, 9);
    expect(r.orders.find((o) => o.order === 1)!.phaseMatch).toBeLessThan(1);
  });
});

describe("computeAomTiltNudgePose", () => {
  const asset = mt80Asset();
  const beamDir = { x: 1, y: 0, z: 0 };
  const beamRef = { x: 0, y: 0, z: 0 };

  it("changes the incidence by exactly the nudge and keeps the pivot fixed", () => {
    const frame = resolveAomBraggFrame(asset)!;
    const aligned = sceneObject(computeAomBraggAlignPose({
      frame, sceneObject: sceneObject({ yMm: 4 }), beamDir, beamRef,
      tiltRad: braggTiltRad(1, THETA_B),
    })!);
    const before = measure(asset, aligned, beamDir);
    const pivotBefore = cadToLab(frame.centreMm, aligned);

    const delta = 1.5e-3;
    const nudged = sceneObject(
      computeAomTiltNudgePose({ frame, sceneObject: aligned, deltaRad: delta }),
    );
    const after = measure(asset, nudged, beamDir);
    const pivotAfter = cadToLab(frame.centreMm, nudged);

    expect(after.thetaInRad).toBeCloseTo(before.thetaInRad - delta, 9);
    expect(pivotAfter.x).toBeCloseTo(pivotBefore.x, 9);
    expect(pivotAfter.y).toBeCloseTo(pivotBefore.y, 9);
    expect(pivotAfter.z).toBeCloseTo(pivotBefore.z, 9);
  });
});
