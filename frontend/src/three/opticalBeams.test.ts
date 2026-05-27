import { describe, expect, it } from "vitest";

import { emissionFromObject } from "./opticalBeams";
import type { Asset3D, SceneObject } from "../types/digitalTwin";

describe("emissionFromObject", () => {
  it("uses ObjectPanel Lab Sense pose plus body frame origin plus anchor frame", () => {
    const placement = {
      xMm: 100,
      yMm: 200,
      zMm: 300,
      rxDeg: 0,
      ryDeg: 0,
      rzDeg: 0,
    } as SceneObject;
    const asset = {
      anchors: [{
        id: "intercept_out",
        positionMmBodyLocal: { x: 1, y: 2, z: 3 },
        axisXBodyLocal: { x: 1, y: 0, z: 0 },
      }],
      properties: {
        bodyFramePositionMm: { x: 10, y: 20, z: 30 },
      },
    } as unknown as Asset3D;

    const result = emissionFromObject(placement, asset);

    expect(result.origin.x).toBeCloseTo(111, 6);
    expect(result.origin.y).toBeCloseTo(222, 6);
    expect(result.origin.z).toBeCloseTo(333, 6);
    expect(result.direction.x).toBeCloseTo(1, 6);
    expect(result.direction.y).toBeCloseTo(0, 6);
    expect(result.direction.z).toBeCloseTo(0, 6);
  });
});
