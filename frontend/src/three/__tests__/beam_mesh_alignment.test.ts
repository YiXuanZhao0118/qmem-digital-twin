// Integration test: beam start lab position derived from the full
// `emissionFromObject` pipeline MUST equal the position derived from
// `anchorObjectLocalPos` + SceneObject pose composition.
//
// This is the test gap that let the 2026-05-27 bug land. The unit
// tests in `assetFrame.test.ts` and `opticalBeams.test.ts` each verify
// their own piece, but nothing cross-checked that the beam pipeline
// and the canonical anchor helper agree on where the anchor sits in
// lab coords. The bug came from `emissionFromObject` rolling its own
// body-frame logic that subtly diverged from the helper.
//
// To prevent recurrence, this file asserts the invariant:
//
//   emissionFromObject(placement, asset).origin
//       == placement.xyz + lab_rotation(anchorObjectLocalPos(anchor, asset))
//
// across four body-frame regimes:
//   1. identity (no body frame, no rotation)         — legacy assets
//   2. body offset only (bfp != 0, R_body = I)       — pre-Phase-9.11 lasers
//   3. body rotation only (bfp = 0, R_body != I)     — CAD axis swap
//   4. both (bfp != 0, R_body != I)                  — real DBR-852 laser
//
// If anyone changes either side's frame handling without updating the
// other, this test fails. See docs/frame-anchor-architecture.md §15.3.

import { describe, expect, it } from "vitest";

import { emissionFromObject } from "../opticalBeams";
import type { Asset3D, SceneObject } from "../../types/digitalTwin";
import { anchorObjectLocalPos } from "../../utils/anchorAccess";

function buildAsset(opts: {
  bfp?: { x: number; y: number; z: number };
  bfr?: { x: number; y: number; z: number; w: number };
  anchorId: string;
  anchorPosBody: { x: number; y: number; z: number };
}): Asset3D {
  return {
    bodyFrameRotation: opts.bfr ?? null,
    properties: opts.bfp ? { bodyFramePositionMm: opts.bfp } : {},
    anchors: [
      {
        id: opts.anchorId,
        positionMmBodyLocal: opts.anchorPosBody,
        axisXBodyLocal: { x: 0, y: 0, z: 1 },
      },
    ],
  } as unknown as Asset3D;
}

// Match `rotateVecLab` inside opticalBeams.ts — Rz · Rx · Ry intrinsic.
function expectedLabFromObjectLocal(
  placement: SceneObject,
  localMm: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const rx = (placement.rxDeg * Math.PI) / 180;
  const ry = (placement.ryDeg * Math.PI) / 180;
  const rz = (placement.rzDeg * Math.PI) / 180;
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const x1 = localMm.x * cy + localMm.z * sy;
  const y1 = localMm.y;
  const z1 = -localMm.x * sy + localMm.z * cy;
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const x2 = x1;
  const y2 = y1 * cx - z1 * sx;
  const z2 = y1 * sx + z1 * cx;
  const cz = Math.cos(rz), sz = Math.sin(rz);
  return {
    x: placement.xMm + (x2 * cz - y2 * sz),
    y: placement.yMm + (x2 * sz + y2 * cz),
    z: placement.zMm + z2,
  };
}

const placement = {
  xMm: 100,
  yMm: 200,
  zMm: 300,
  rxDeg: 0,
  ryDeg: 0,
  rzDeg: 0,
} as SceneObject;

const placementRotated = {
  xMm: -50,
  yMm: 75,
  zMm: 425,
  rxDeg: 15,
  ryDeg: -30,
  rzDeg: 60,
} as SceneObject;

const y90 = {
  x: 0,
  y: Math.sin(Math.PI / 4),
  z: 0,
  w: Math.cos(Math.PI / 4),
};

const z45 = {
  x: 0,
  y: 0,
  z: Math.sin(Math.PI / 8),
  w: Math.cos(Math.PI / 8),
};

function expectVecsClose(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  tol = 1e-6,
) {
  expect(a.x).toBeCloseTo(b.x, Math.log10(1 / tol));
  expect(a.y).toBeCloseTo(b.y, Math.log10(1 / tol));
  expect(a.z).toBeCloseTo(b.z, Math.log10(1 / tol));
}

describe("beam-mesh alignment invariant", () => {
  it("regime 1: identity body frame, identity pose", () => {
    const asset = buildAsset({
      anchorId: "intercept_out",
      anchorPosBody: { x: 0, y: 0, z: 0 },
    });
    const emission = emissionFromObject(placement, asset);
    const local = anchorObjectLocalPos(asset.anchors[0], asset);
    const expected = expectedLabFromObjectLocal(placement, local);
    expectVecsClose({ x: emission.origin.x, y: emission.origin.y, z: emission.origin.z }, expected);
  });

  it("regime 2: body offset only (DBR-852 case sans rotation)", () => {
    const asset = buildAsset({
      bfp: { x: 0, y: 0, z: 6.875 },
      anchorId: "intercept_out",
      anchorPosBody: { x: 0, y: 0, z: 0 },
    });
    const emission = emissionFromObject(placement, asset);
    const local = anchorObjectLocalPos(asset.anchors[0], asset);
    const expected = expectedLabFromObjectLocal(placement, local);
    expectVecsClose({ x: emission.origin.x, y: emission.origin.y, z: emission.origin.z }, expected);
    // Sanity: with identity R_body, local should equal bfp (since anchor pos = 0).
    expect(local.x).toBeCloseTo(0, 6);
    expect(local.y).toBeCloseTo(0, 6);
    expect(local.z).toBeCloseTo(6.875, 6);
  });

  it("regime 3: body rotation only (CAD axis swap)", () => {
    const asset = buildAsset({
      bfr: y90,
      anchorId: "intercept_out",
      anchorPosBody: { x: 0, y: 0, z: 5 },
    });
    const emission = emissionFromObject(placement, asset);
    const local = anchorObjectLocalPos(asset.anchors[0], asset);
    const expected = expectedLabFromObjectLocal(placement, local);
    expectVecsClose({ x: emission.origin.x, y: emission.origin.y, z: emission.origin.z }, expected);
    // Sanity: y90 maps body +z → CAD +x, so (0,0,5) in body → (5,0,0) in CAD.
    expect(local.x).toBeCloseTo(5, 6);
    expect(local.y).toBeCloseTo(0, 6);
    expect(local.z).toBeCloseTo(0, 6);
  });

  it("regime 4: both bfp and R_body (real DBR-852 laser config)", () => {
    const asset = buildAsset({
      bfp: { x: 0, y: 0, z: 6.875 },
      bfr: y90,
      anchorId: "intercept_out",
      anchorPosBody: { x: 0, y: 0, z: 0 },
    });
    const emission = emissionFromObject(placement, asset);
    const local = anchorObjectLocalPos(asset.anchors[0], asset);
    const expected = expectedLabFromObjectLocal(placement, local);
    expectVecsClose({ x: emission.origin.x, y: emission.origin.y, z: emission.origin.z }, expected);
    // Concrete check: identity rotation + this asset → lab (100, 200, 306.875)
    expect(emission.origin.x).toBeCloseTo(100, 6);
    expect(emission.origin.y).toBeCloseTo(200, 6);
    expect(emission.origin.z).toBeCloseTo(306.875, 6);
  });

  it("regime 4 + non-identity SceneObject pose", () => {
    const asset = buildAsset({
      bfp: { x: 0, y: 0, z: 6.875 },
      bfr: y90,
      anchorId: "intercept_out",
      anchorPosBody: { x: 0, y: 0, z: 0 },
    });
    const emission = emissionFromObject(placementRotated, asset);
    const local = anchorObjectLocalPos(asset.anchors[0], asset);
    const expected = expectedLabFromObjectLocal(placementRotated, local);
    expectVecsClose({ x: emission.origin.x, y: emission.origin.y, z: emission.origin.z }, expected);
  });

  it("non-zero anchor body position + R_body + bfp + scene rot", () => {
    const asset = buildAsset({
      bfp: { x: 10, y: -3, z: 8 },
      bfr: z45,
      anchorId: "intercept_out",
      anchorPosBody: { x: 2, y: 5, z: 1 },
    });
    const emission = emissionFromObject(placementRotated, asset);
    const local = anchorObjectLocalPos(asset.anchors[0], asset);
    const expected = expectedLabFromObjectLocal(placementRotated, local);
    expectVecsClose({ x: emission.origin.x, y: emission.origin.y, z: emission.origin.z }, expected);
  });
});
