/**
 * `cableSplineLengthMm` — the number the RF Link panel labels a cable with.
 * It must measure the SAME curve the tube is extruded along, in lab mm, or
 * the panel goes back to quoting the 152 mm catalog default for a cable the
 * user has routed across the table.
 */
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { buildFiberCurvePath, cableSplineLengthMm } from "../curve";
import { MM_PER_THREE_UNIT } from "../../../../optical/frames";
import type { FiberNode } from "../types";

describe("cableSplineLengthMm", () => {
  it("measures a straight 2-node spline in lab mm", () => {
    // Collinear handles keep the cubic a straight line, so the arc length is
    // exactly the node separation.
    const nodes: FiberNode[] = [
      { posMm: [0, 0, 0], handleOutMm: [100, 0, 0] },
      { posMm: [300, 0, 0], handleInMm: [-100, 0, 0] },
    ];
    expect(cableSplineLengthMm(nodes)).toBeCloseTo(300, 3);
  });

  it("uses the default 1/3 handles when none are authored", () => {
    const nodes: FiberNode[] = [{ posMm: [0, 0, 0] }, { posMm: [0, 0, 500] }];
    expect(cableSplineLengthMm(nodes)).toBeCloseTo(500, 3);
  });

  it("counts the curvature of a routed cable, not the end-to-end distance", () => {
    // RF_CABLE2's live shape: perpendicular handles bow the cable out.
    const nodes: FiberNode[] = [
      { posMm: [155.6, -9.6, 0], handleOutMm: [30, 0, 0] },
      { posMm: [-588.8, 197.3, 67.5], handleInMm: [-5.8, 29.4, 0] },
    ];
    const straight = Math.hypot(155.6 + 588.8, -9.6 - 197.3, -67.5);
    const arc = cableSplineLengthMm(nodes)!;
    expect(arc).toBeGreaterThan(straight);
    expect(arc).toBeGreaterThan(700);       // NOT the 152 mm nominal
  });

  it("sums every segment of a multi-node spline", () => {
    const nodes: FiberNode[] = [
      { posMm: [0, 0, 0], handleOutMm: [50, 0, 0] },
      { posMm: [150, 0, 0], handleInMm: [-50, 0, 0], handleOutMm: [50, 0, 0] },
      { posMm: [300, 0, 0], handleInMm: [-50, 0, 0] },
    ];
    expect(cableSplineLengthMm(nodes)).toBeCloseTo(300, 3);
  });

  it("agrees with the CurvePath the renderer extrudes", () => {
    const nodes: FiberNode[] = [
      { posMm: [0, 0, 0], handleOutMm: [80, 40, 0] },
      { posMm: [400, 120, -60], handleInMm: [-30, 90, 10] },
    ];
    expect(cableSplineLengthMm(nodes)).toBeCloseTo(
      buildFiberCurvePath(nodes).getLength() * MM_PER_THREE_UNIT, 6,
    );
  });

  it("returns null for a degenerate node list (caller falls back to nominal)", () => {
    expect(cableSplineLengthMm(undefined)).toBeNull();
    expect(cableSplineLengthMm([])).toBeNull();
    expect(cableSplineLengthMm([{ posMm: [0, 0, 0] }])).toBeNull();
  });
});
