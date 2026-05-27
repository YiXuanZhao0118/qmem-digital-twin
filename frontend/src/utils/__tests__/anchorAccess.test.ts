import { describe, expect, it } from "vitest";

import type { Anchor, Asset3D } from "../../types/digitalTwin";
import {
  anchorObjectLocalAxisX,
  anchorObjectLocalAxisY,
  anchorObjectLocalAxisZ,
  anchorObjectLocalLegacyDir,
  anchorObjectLocalPos,
  anchorObjectLocalPrimaryDir,
  resolveAnchor,
} from "../anchorAccess";

const z90 = {
  x: 0,
  y: 0,
  z: Math.sin(Math.PI / 4),
  w: Math.cos(Math.PI / 4),
};

const assetWithBody = {
  bodyFrameRotation: z90,
  properties: { bodyFramePositionMm: { x: 10, y: 20, z: 30 } },
} as unknown as Asset3D;

const assetWithoutBody = {
  bodyFrameRotation: null,
  properties: {},
} as unknown as Asset3D;

const anchorFull: Anchor = {
  id: "intercept_in",
  positionMmBodyLocal: { x: 5, y: 0, z: 2 },
  axisXBodyLocal: { x: 1, y: 0, z: 0 },
  axisYBodyLocal: { x: 0, y: 1, z: 0 },
  axisZBodyLocal: { x: 0, y: 0, z: 1 },
  apertureMm: 12.5,
};

describe("anchorAccess", () => {
  it("position: applies R_body × p + bfp", () => {
    const p = anchorObjectLocalPos(anchorFull, assetWithBody);
    // z90 rotates body +x → +y, so (5,0,2) → (0,5,2)
    // + bfp (10, 20, 30) = (10, 25, 32)
    expect(p.x).toBeCloseTo(10, 6);
    expect(p.y).toBeCloseTo(25, 6);
    expect(p.z).toBeCloseTo(32, 6);
  });

  it("position: identity body frame leaves the value unchanged", () => {
    const p = anchorObjectLocalPos(anchorFull, assetWithoutBody);
    expect(p.x).toBeCloseTo(5, 6);
    expect(p.y).toBeCloseTo(0, 6);
    expect(p.z).toBeCloseTo(2, 6);
  });

  it("axisX: rotation only, no translation", () => {
    const d = anchorObjectLocalAxisX(anchorFull, assetWithBody);
    expect(d).not.toBeNull();
    // z90 rotates +x → +y
    expect(d!.x).toBeCloseTo(0, 6);
    expect(d!.y).toBeCloseTo(1, 6);
    expect(d!.z).toBeCloseTo(0, 6);
  });

  it("axisY: rotation only", () => {
    const d = anchorObjectLocalAxisY(anchorFull, assetWithBody);
    expect(d).not.toBeNull();
    // z90 rotates +y → -x
    expect(d!.x).toBeCloseTo(-1, 6);
    expect(d!.y).toBeCloseTo(0, 6);
    expect(d!.z).toBeCloseTo(0, 6);
  });

  it("axisZ: rotation only, +z unchanged under z-rotation", () => {
    const d = anchorObjectLocalAxisZ(anchorFull, assetWithBody);
    expect(d).not.toBeNull();
    expect(d!.x).toBeCloseTo(0, 6);
    expect(d!.y).toBeCloseTo(0, 6);
    expect(d!.z).toBeCloseTo(1, 6);
  });

  it("axisX returns null when anchor lacks tri-axis data", () => {
    const legacyAnchor: Anchor = {
      id: "out",
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      directionBodyLocal: { x: 1, y: 0, z: 0 },
    };
    expect(anchorObjectLocalAxisX(legacyAnchor, assetWithBody)).toBeNull();
  });

  it("legacyDir reads directionBodyLocal and applies R_body", () => {
    const legacyAnchor: Anchor = {
      id: "out",
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      directionBodyLocal: { x: 1, y: 0, z: 0 },
    };
    const d = anchorObjectLocalLegacyDir(legacyAnchor, assetWithBody);
    expect(d).not.toBeNull();
    expect(d!.x).toBeCloseTo(0, 6);
    expect(d!.y).toBeCloseTo(1, 6);
    expect(d!.z).toBeCloseTo(0, 6);
  });

  it("legacyDir returns null when anchor lacks directionBodyLocal", () => {
    expect(anchorObjectLocalLegacyDir(anchorFull, assetWithBody)).toBeNull();
  });

  it("primaryDir prefers axisX over legacy directionBodyLocal", () => {
    const both: Anchor = {
      id: "intercept_in",
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      axisXBodyLocal: { x: 1, y: 0, z: 0 },
      // Different from axisX so we can detect which one is read.
      directionBodyLocal: { x: 0, y: 0, z: 1 },
    };
    const d = anchorObjectLocalPrimaryDir(both, assetWithoutBody);
    expect(d!.x).toBeCloseTo(1, 6);
    expect(d!.y).toBeCloseTo(0, 6);
    expect(d!.z).toBeCloseTo(0, 6);
  });

  it("primaryDir falls back to legacy when axisX missing", () => {
    const legacy: Anchor = {
      id: "out",
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      directionBodyLocal: { x: 0, y: 0, z: 1 },
    };
    const d = anchorObjectLocalPrimaryDir(legacy, assetWithoutBody);
    expect(d!.x).toBeCloseTo(0, 6);
    expect(d!.y).toBeCloseTo(0, 6);
    expect(d!.z).toBeCloseTo(1, 6);
  });

  it("primaryDir returns null when neither axisX nor legacy is set", () => {
    const bare: Anchor = {
      id: "mount_a",
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
    };
    expect(anchorObjectLocalPrimaryDir(bare, assetWithoutBody)).toBeNull();
  });

  it("null asset is tolerated (identity body frame)", () => {
    const p = anchorObjectLocalPos(anchorFull, null);
    expect(p.x).toBeCloseTo(5, 6);
    expect(p.y).toBeCloseTo(0, 6);
    expect(p.z).toBeCloseTo(2, 6);
    const d = anchorObjectLocalAxisX(anchorFull, undefined);
    expect(d).not.toBeNull();
    expect(d!.x).toBeCloseTo(1, 6);
    expect(d!.y).toBeCloseTo(0, 6);
    expect(d!.z).toBeCloseTo(0, 6);
  });

  const expectVec = (v: { x: number; y: number; z: number } | null, e: [number, number, number]) => {
    expect(v).not.toBeNull();
    expect(v!.x).toBeCloseTo(e[0], 6);
    expect(v!.y).toBeCloseTo(e[1], 6);
    expect(v!.z).toBeCloseTo(e[2], 6);
  };

  it("resolveAnchor packages every transformed field at once", () => {
    const r = resolveAnchor(anchorFull, assetWithBody);
    expect(r.id).toBe("intercept_in");
    expectVec(r.positionLocal, [10, 25, 32]);
    expectVec(r.axisXLocal, [0, 1, 0]);
    expectVec(r.axisYLocal, [-1, 0, 0]);
    expectVec(r.axisZLocal, [0, 0, 1]);
    expect(r.legacyDirLocal).toBeNull();
    expectVec(r.primaryDirLocal, [0, 1, 0]);
    expect(r.apertureMm).toBe(12.5);
  });

  it("resolveAnchor copies pass-through fields verbatim", () => {
    const decorated: Anchor = {
      id: "rf_in",
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      axisXBodyLocal: { x: 1, y: 0, z: 0 },
      apertureMm: 3,
      apertureWidthMm: 6,
      apertureHeightMm: 4,
      apertureShape: "rectangle",
      connectorType: "sma_female",
      fastAxisDegBodyLocal: 45,
      derivedFromRfCableEndpoint: "A",
    };
    const r = resolveAnchor(decorated, assetWithoutBody);
    expect(r.apertureMm).toBe(3);
    expect(r.apertureWidthMm).toBe(6);
    expect(r.apertureHeightMm).toBe(4);
    expect(r.apertureShape).toBe("rectangle");
    expect(r.connectorType).toBe("sma_female");
    expect(r.fastAxisDegBodyLocal).toBe(45);
    expect(r.derivedFromRfCableEndpoint).toBe("A");
  });
});
