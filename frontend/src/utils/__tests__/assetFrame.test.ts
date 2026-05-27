import { describe, expect, it } from "vitest";

import { bodyFrameDirectionToObjectLocal, bodyFrameMeshShiftMm, bodyFramePointToObjectLocalMm } from "../assetFrame";

const z90 = {
  x: 0,
  y: 0,
  z: Math.sin(Math.PI / 4),
  w: Math.cos(Math.PI / 4),
};

describe("asset frame composition", () => {
  it("places anchors under Lab Sense + body frame origin", () => {
    const asset = {
      bodyFrameRotation: z90,
      properties: { bodyFramePositionMm: { x: 10, y: 20, z: 30 } },
    };

    const p = bodyFramePointToObjectLocalMm({ x: 5, y: 0, z: 2 }, asset);
    expect(p.x).toBeCloseTo(10, 6);
    expect(p.y).toBeCloseTo(25, 6);
    expect(p.z).toBeCloseTo(32, 6);
  });

  it("rotates directions without translating them", () => {
    const d = bodyFrameDirectionToObjectLocal(
      { x: 1, y: 0, z: 0 },
      { bodyFrameRotation: z90, properties: { bodyFramePositionMm: { x: 10, y: 0, z: 0 } } },
    );
    expect(d.x).toBeCloseTo(0, 6);
    expect(d.y).toBeCloseTo(1, 6);
    expect(d.z).toBeCloseTo(0, 6);
  });

  it("returns the inverse-rotated mesh shift for body-origin preview", () => {
    const shift = bodyFrameMeshShiftMm({
      bodyFrameRotation: z90,
      properties: { bodyFramePositionMm: { x: 0, y: 10, z: 0 } },
    });
    expect(shift.x).toBeCloseTo(10, 6);
    expect(shift.y).toBeCloseTo(0, 6);
    expect(shift.z).toBeCloseTo(0, 6);
  });
});
