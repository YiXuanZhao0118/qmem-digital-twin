import { describe, expect, it } from "vitest";

import type { Anchor, Asset3D } from "../../types/digitalTwin";
import {
  anchorObjectLocalAxisX,
  anchorObjectLocalLegacyDir,
  anchorObjectLocalPos,
  anchorObjectLocalPrimaryDir,
  resolveAnchor,
} from "../anchorAccess";

const asset = {} as Asset3D;

const anchorFull: Anchor = {
  id: "intercept_in",
  positionMmBodyLocal: { x: 5, y: 0, z: 2 },
  axisXBodyLocal: { x: 1, y: 0, z: 0 },
  axisYBodyLocal: { x: 0, y: 1, z: 0 },
  axisZBodyLocal: { x: 0, y: 0, z: 1 },
  apertureMm: 12.5,
};

describe("anchorAccess", () => {
  it("returns the stored Asset/CAD-local position directly", () => {
    expect(anchorObjectLocalPos(anchorFull, asset)).toEqual({ x: 5, y: 0, z: 2 });
  });

  it("returns stored axes without a runtime body-frame transform", () => {
    expect(anchorObjectLocalAxisX(anchorFull, asset)).toEqual({ x: 1, y: 0, z: 0 });
  });

  it("axisX returns null when anchor lacks tri-axis data", () => {
    const legacyAnchor: Anchor = {
      id: "out",
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      directionBodyLocal: { x: 1, y: 0, z: 0 },
    };
    expect(anchorObjectLocalAxisX(legacyAnchor, asset)).toBeNull();
  });

  it("legacyDir reads directionBodyLocal directly", () => {
    const legacyAnchor: Anchor = {
      id: "out",
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      directionBodyLocal: { x: 1, y: 0, z: 0 },
    };
    expect(anchorObjectLocalLegacyDir(legacyAnchor, asset)).toEqual({ x: 1, y: 0, z: 0 });
  });

  it("primaryDir prefers axisX over legacy directionBodyLocal", () => {
    const both: Anchor = {
      id: "intercept_in",
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      axisXBodyLocal: { x: 1, y: 0, z: 0 },
      directionBodyLocal: { x: 0, y: 0, z: 1 },
    };
    expect(anchorObjectLocalPrimaryDir(both, asset)).toEqual({ x: 1, y: 0, z: 0 });
  });

  it("primaryDir falls back to legacy when axisX is missing", () => {
    const legacy: Anchor = {
      id: "out",
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      directionBodyLocal: { x: 0, y: 0, z: 1 },
    };
    expect(anchorObjectLocalPrimaryDir(legacy, asset)).toEqual({ x: 0, y: 0, z: 1 });
  });

  it("resolveAnchor packages every direct field at once", () => {
    const r = resolveAnchor(anchorFull, asset);
    expect(r.id).toBe("intercept_in");
    expect(r.positionLocal).toEqual({ x: 5, y: 0, z: 2 });
    expect(r.axisXLocal).toEqual({ x: 1, y: 0, z: 0 });
    expect(r.axisYLocal).toEqual({ x: 0, y: 1, z: 0 });
    expect(r.axisZLocal).toEqual({ x: 0, y: 0, z: 1 });
    expect(r.legacyDirLocal).toBeNull();
    expect(r.primaryDirLocal).toEqual({ x: 1, y: 0, z: 0 });
    expect(r.apertureMm).toBe(12.5);
  });
});
