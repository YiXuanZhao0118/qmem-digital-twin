import { describe, expect, it } from "vitest";

import { emissionFromObject } from "../opticalBeams";
import type { Asset3D, SceneObject } from "../../types/digitalTwin";
import { anchorObjectLocalPos } from "../../utils/anchorAccess";

function buildAsset(anchorPos: { x: number; y: number; z: number }): Asset3D {
  return {
    anchors: [
      {
        id: "intercept_out",
        positionMmBodyLocal: anchorPos,
        axisXBodyLocal: { x: 0, y: 0, z: 1 },
      },
    ],
  } as unknown as Asset3D;
}

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

function expectVecsClose(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
) {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
  expect(a.z).toBeCloseTo(b.z, 6);
}

describe("beam-mesh alignment invariant", () => {
  it("beam origin equals SceneObject pose composed with Asset/CAD-local anchor", () => {
    const placement = {
      xMm: -50,
      yMm: 75,
      zMm: 425,
      rxDeg: 15,
      ryDeg: -30,
      rzDeg: 60,
    } as SceneObject;
    const asset = buildAsset({ x: 2, y: 5, z: 1 });

    const emission = emissionFromObject(placement, asset);
    const local = anchorObjectLocalPos(asset.anchors[0], asset);
    const expected = expectedLabFromObjectLocal(placement, local);

    expectVecsClose({ x: emission.origin.x, y: emission.origin.y, z: emission.origin.z }, expected);
  });
});
