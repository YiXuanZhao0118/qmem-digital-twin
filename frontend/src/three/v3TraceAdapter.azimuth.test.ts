import { describe, expect, it } from "vitest";

import { rotateCSym2, type CSym2 } from "../optical/beamTensor";
import { adaptV3LabSegmentsToTraceSegments } from "./v3TraceAdapter";

/**
 * End-to-end wiring check for the principal-axis azimuth: the backend may hand
 * over a Q whose astigmatism is rolled away from the beam-local (s, p) frame
 * (`qxyAtStart != 0`, produced by e.g. a cylindrical lens mounted at an
 * angle). The adapter must find that roll, express its per-axis beam model in
 * the frame where it is exact, and publish the leftover angle so the tube and
 * the scope profile can turn with it.
 */

const WL = 852.347;
const deg = (d: number) => (d * Math.PI) / 180;

/** Astigmatic, diagonal in its own principal frame. */
const Q_DIAG: CSym2 = {
  xx: { re: -188.8, im: 1792.6 },
  yy: { re: -626.0, im: 1232.6 },
  xy: { re: 0, im: 0 },
};

function segmentWithQ(q: CSym2) {
  return {
    start: { x: 0, y: 0, z: 0 },
    end: { x: 100, y: 0, z: 0 },
    wavelengthNm: WL,
    powerMw: 1,
    sceneObjectId: null,
    bindingId: null,
    assetCatalogId: null,
    faceInId: null,
    op: null,
    isTerminal: true,
    emitterSceneObjectId: "emitter",
    sourceSceneObjectId: "emitter",
    jones: [{ re: 1, im: 0 }, { re: 0, im: 0 }],
    qxAtStart: q.xx,
    qyAtStart: q.yy,
    qxyAtStart: q.xy,
    widthMultAtStart: { x: 1, y: 1, xy: 0 },
    m2AtStart: { x: 1, y: 1, xy: 0 },
    pathLengthMmAtStart: 0,
  };
}

function adaptOneQ(q: CSym2) {
  const result = { labSegments: [segmentWithQ(q)] } as never;
  const scene = {
    objects: [{ id: "emitter", componentId: "component" }],
  } as never;
  return adaptV3LabSegmentsToTraceSegments(result, scene)[0];
}

describe("v3 adapter — principal-axis azimuth", () => {
  it("publishes exactly zero for an unrolled beam", () => {
    expect(adaptOneQ(Q_DIAG).beamMode.azimuthRad).toBe(0);
  });

  it.each([15, 30, 45, -40])("recovers a %s deg roll from qxy", (d) => {
    const theta = deg(d);
    const seg = adaptOneQ(rotateCSym2(Q_DIAG, -theta));
    expect(seg.beamMode.azimuthRad).toBeCloseTo(theta, 8);
  });

  it("reports the SAME principal widths however the beam is rolled", () => {
    const flat = adaptOneQ(Q_DIAG);
    const rolled = adaptOneQ(rotateCSym2(Q_DIAG, -deg(33)));
    // the physical beam is identical; only the frame it was expressed in moved
    expect(rolled.waistAtStartUm).toBeCloseTo(flat.waistAtStartUm, 6);
    expect(rolled.waistAtStartUmY).toBeCloseTo(flat.waistAtStartUmY, 6);
    expect(rolled.waistAtEndUm).toBeCloseTo(flat.waistAtEndUm, 6);
    expect(rolled.waistAtEndUmY).toBeCloseTo(flat.waistAtEndUmY, 6);
  });

  it("would have reported the wrong widths without the rotation", () => {
    // Guard on the guard: reading the rolled Q's diagonal straight off — the
    // pre-azimuth behaviour — gives visibly different widths, so the test
    // above cannot pass vacuously.
    const rolled = rotateCSym2(Q_DIAG, -deg(45));
    const naive = adaptOneQ({ ...rolled, xy: { re: 0, im: 0 } });
    const correct = adaptOneQ(rolled);
    expect(Math.abs(naive.waistAtStartUm - correct.waistAtStartUm)).toBeGreaterThan(1);
  });
});
