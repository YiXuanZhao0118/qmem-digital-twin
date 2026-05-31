import { describe, expect, it } from "vitest";

import { dirBodyToLab, poseToTransform, dirBodyToLabT } from "./pose";

describe("V3Pose body-local Z-up rotation", () => {
  it("ry=90 rotates body +Z to lab -X", () => {
    const out = dirBodyToLab(
      { x: 0, y: 0, z: 1 },
      { xMm: 0, yMm: 0, zMm: 0, rxDeg: 0, ryDeg: 90, rzDeg: 0 },
    );

    expect(out.x).toBeCloseTo(-1, 9);
    expect(out.y).toBeCloseTo(0, 9);
    expect(out.z).toBeCloseTo(0, 9);
  });

  it("poseToTransform uses the same rotation", () => {
    const transform = poseToTransform({
      xMm: 0,
      yMm: 0,
      zMm: 0,
      rxDeg: 0,
      ryDeg: 90,
      rzDeg: 0,
    });
    const out = dirBodyToLabT({ x: 0, y: 0, z: 1 }, transform);

    expect(out.x).toBeCloseTo(-1, 9);
    expect(out.y).toBeCloseTo(0, 9);
    expect(out.z).toBeCloseTo(0, 9);
  });
});
