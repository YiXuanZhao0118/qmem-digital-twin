import { describe, expect, it } from "vitest";

import type { SceneObject } from "../types/digitalTwin";
import { lensOpticalGeometry } from "./lensOpticalGeometry";
import { labDirToThree, labMmToThree } from "../optical/frames";

function makeObj(over: Partial<SceneObject>): SceneObject {
  return {
    id: "test",
    name: "test",
    componentId: "c",
    xMm: 0, yMm: 0, zMm: 0,
    rxDeg: 0, ryDeg: 0, rzDeg: 0,
    visible: true,
    locked: false,
    properties: {},
    ...over,
  };
}

describe("lensOpticalGeometry", () => {
  it("aligned lens at lab origin: centre = origin, axis = lab+X", () => {
    const g = lensOpticalGeometry(makeObj({ xMm: 0, yMm: 0, zMm: 0 }));
    const expectedAxis = labDirToThree({ x: 1, y: 0, z: 0 });
    expect(g.centerWorldThree.x).toBeCloseTo(0);
    expect(g.centerWorldThree.y).toBeCloseTo(0);
    expect(g.centerWorldThree.z).toBeCloseTo(0);
    expect(g.opticalAxisWorldThree.x).toBeCloseTo(expectedAxis.x);
    expect(g.opticalAxisWorldThree.y).toBeCloseTo(expectedAxis.y);
    expect(g.opticalAxisWorldThree.z).toBeCloseTo(expectedAxis.z);
  });

  it("lens placed at lab (100, 50, 25): centre tracks lab position", () => {
    const g = lensOpticalGeometry(makeObj({ xMm: 100, yMm: 50, zMm: 25 }));
    const expected = labMmToThree({ xMm: 100, yMm: 50, zMm: 25 });
    expect(g.centerWorldThree.x).toBeCloseTo(expected.x);
    expect(g.centerWorldThree.y).toBeCloseTo(expected.y);
    expect(g.centerWorldThree.z).toBeCloseTo(expected.z);
  });

  it("lens rotated 180° about lab-Y: axis flips to -lab+X", () => {
    const g = lensOpticalGeometry(makeObj({ ryDeg: 180 }));
    const expected = labDirToThree({ x: -1, y: 0, z: 0 });
    expect(g.opticalAxisWorldThree.x).toBeCloseTo(expected.x, 5);
    expect(g.opticalAxisWorldThree.y).toBeCloseTo(expected.y, 5);
    expect(g.opticalAxisWorldThree.z).toBeCloseTo(expected.z, 5);
  });

  it("optical axis is unit length", () => {
    const g = lensOpticalGeometry(makeObj({ rxDeg: 17, ryDeg: 23, rzDeg: 41 }));
    expect(g.opticalAxisWorldThree.length()).toBeCloseTo(1);
  });
});
