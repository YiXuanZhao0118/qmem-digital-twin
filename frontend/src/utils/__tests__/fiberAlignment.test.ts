/**
 * Pinning tests for the fiber-end alignment math. Established 2026-05-12
 * after fixing a bug where `alignFiberEndToBeam` was projecting the
 * spline NODE onto the beam instead of the optical PORT (= ferrule tip
 * 36.28 mm out from the node). The fix moves the projection target to
 * the port and back-derives the node 36.28 mm behind it. These tests
 * guard the two invariants future refactors must keep:
 *
 *   I1. After align, the optical port (= node + outward · TIP) lands ON
 *       the projected beam point.
 *   I2. After align, the spline node sits exactly TIP mm "behind" the
 *       port along the new outward direction (outward = −beam_tangent for
 *       End A entry, +beam_tangent for End B exit), so the connector
 *       face is anti-parallel / parallel to the beam respectively.
 *
 * Coverage:
 *   - End A entry: handle present, handle missing (fallback to segment),
 *     pose rotation applied, out-of-tolerance returns null.
 *   - End B exit: symmetric — outward = +beam_tangent.
 *   - Constant TIP_MM matches the canonical FIBER_FERRULE_TIP_MM export.
 */

import { describe, expect, it } from "vitest";

import { FIBER_FERRULE_TIP_MM } from "../fiberAnchorResolver";
import {
  computeFiberEndAlignment,
  endpointOutwardBody,
  type BeamSegmentLab,
  type FiberAlignPose,
  type FiberNodePersist,
} from "../fiberAlignment";

// =============================================================================
// Test helpers
// =============================================================================

const IDENTITY_POSE: FiberAlignPose = {
  xMm: 0,
  yMm: 0,
  zMm: 0,
  rxDeg: 0,
  ryDeg: 0,
  rzDeg: 0,
};

/** A 1000-mm beam along +x at (0, *, 500). Chosen so a fiber whose
 *  default node sits at (0, 0, 50) body + pose hits it with room to
 *  spare. */
const beamAlongX = (yLab: number, zLab: number): BeamSegmentLab => ({
  beamId: "test-beam-x",
  aMm: [-500, yLab, zLab],
  bMm: [500, yLab, zLab],
});

function expectVec3Close(
  got: [number, number, number],
  want: [number, number, number],
  tolMm = 1e-6,
) {
  expect(got[0]).toBeCloseTo(want[0], 5);
  expect(got[1]).toBeCloseTo(want[1], 5);
  expect(got[2]).toBeCloseTo(want[2], 5);
  // Belt-and-suspenders: the per-axis check uses .toBeCloseTo's default
  // base-10 precision, but the documented contract is a flat mm
  // tolerance — assert that here too.
  expect(Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2])).toBeLessThan(tolMm);
}

// =============================================================================
// Constants
// =============================================================================

describe("FIBER_FERRULE_TIP_MM", () => {
  it("matches the cached FC housing length (30126A9 STL) of 36.28 mm", () => {
    expect(FIBER_FERRULE_TIP_MM).toBe(36.28);
  });
});

// =============================================================================
// endpointOutwardBody helper
// =============================================================================

describe("endpointOutwardBody", () => {
  it("End A: outward = −handleOut / |handleOut|", () => {
    const nodes: FiberNodePersist[] = [
      { posMm: [0, 0, 0], handleOutMm: [100, 0, 0] },
      { posMm: [200, 0, 0] },
    ];
    expectVec3Close(endpointOutwardBody(nodes, "A"), [-1, 0, 0]);
  });

  it("End B: outward = −handleIn / |handleIn|", () => {
    const nodes: FiberNodePersist[] = [
      { posMm: [0, 0, 0] },
      { posMm: [200, 0, 0], handleInMm: [-100, 0, 0] },
    ];
    expectVec3Close(endpointOutwardBody(nodes, "B"), [1, 0, 0]);
  });

  it("falls back to segment direction toward neighbour when handle missing", () => {
    const nodes: FiberNodePersist[] = [
      { posMm: [10, 0, 0] }, // no handleOut
      { posMm: [30, 0, 0] }, // neighbour is to +x
    ];
    // outward at A = direction from neighbour TO node = -x
    expectVec3Close(endpointOutwardBody(nodes, "A"), [-1, 0, 0]);
  });

  it("falls back to segment direction at End B too", () => {
    const nodes: FiberNodePersist[] = [
      { posMm: [10, 0, 0] }, // neighbour
      { posMm: [30, 0, 0] }, // End B, no handleIn
    ];
    // outward at B = direction from neighbour TO node = +x
    expectVec3Close(endpointOutwardBody(nodes, "B"), [1, 0, 0]);
  });
});

// =============================================================================
// End A entry — projection + back-derivation
// =============================================================================

describe("computeFiberEndAlignment — End A (beam entry)", () => {
  it("places port on the beam and node TIP_MM behind it along −beam_tangent", () => {
    // Fiber whose End A is currently 10 mm above the +x beam. Port at
    // node + outward·TIP = (0, 10, 50) + (-1,0,0)·36.28 = (-36.28, 10, 50).
    const nodes: FiberNodePersist[] = [
      { posMm: [0, 10, 50], handleOutMm: [100, 0, 0] },
      { posMm: [300, 10, 50], handleInMm: [-100, 0, 0] },
    ];
    const result = computeFiberEndAlignment({
      end: "A",
      nodes,
      pose: IDENTITY_POSE,
      beamSegmentsLab: [beamAlongX(0, 50)],
      toleranceMm: 25,
    });
    expect(result).not.toBeNull();
    if (!result) return; // type guard

    // The reported distance is the port-to-beam distance pre-align,
    // which is 10 mm (the y offset).
    expect(result.distMm).toBeCloseTo(10, 5);

    // I1: port lab now lands ON the beam (= projection point).
    //     Projected port lab = (-36.28, 0, 50).
    expectVec3Close(result.projectedPortLab, [-36.28, 0, 50]);

    // I2: node sits TIP_MM behind the port along −beam_tangent.
    //     outward_new = -(+x) = (-1,0,0)
    //     node_new = port - outward_new·TIP = (-36.28, 0, 50) + (36.28,0,0) = (0, 0, 50)
    expectVec3Close(result.newPosMmBody, [0, 0, 50]);
    expectVec3Close(result.newOutwardBody, [-1, 0, 0]);

    // Recompute the port from the new node + new outward and check it
    // matches the projected point (closes the round-trip).
    const portFromNewNode: [number, number, number] = [
      result.newPosMmBody[0] + result.newOutwardBody[0] * FIBER_FERRULE_TIP_MM,
      result.newPosMmBody[1] + result.newOutwardBody[1] * FIBER_FERRULE_TIP_MM,
      result.newPosMmBody[2] + result.newOutwardBody[2] * FIBER_FERRULE_TIP_MM,
    ];
    expectVec3Close(portFromNewNode, result.projectedPortLab);

    // Handle direction: handleOut_A = +beam_tangent, magnitude = max(20, segLen·0.33)
    // segLen = 300 mm → handleLen = 99 mm.
    expectVec3Close(result.newHandleMmBody, [99, 0, 0]);
  });

  it("works when handleOut is missing — falls back to neighbour segment direction", () => {
    // No handleOut → outward derives from neighbour direction. Place the
    // node such that neighbour-to-node direction is +x, so outward = −x
    // initially, port = (0, 5, 50) + (−1,0,0)·36.28 = (−36.28, 5, 50).
    const nodes: FiberNodePersist[] = [
      { posMm: [-50, 5, 50] /* no handleOut */ },
      { posMm: [100, 5, 50] /* neighbour */ },
    ];
    // outward_A = (node - neighbour) / |.| = (-150, 0, 0)/150 = (-1, 0, 0)
    // port_lab = (-50 + (-1)·36.28, 5, 50) = (-86.28, 5, 50)
    const result = computeFiberEndAlignment({
      end: "A",
      nodes,
      pose: IDENTITY_POSE,
      beamSegmentsLab: [beamAlongX(0, 50)],
      toleranceMm: 25,
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.distMm).toBeCloseTo(5, 5);
    expectVec3Close(result.projectedPortLab, [-86.28, 0, 50]);
    expectVec3Close(result.newOutwardBody, [-1, 0, 0]);
    // node_new = port_projected - outward·TIP = (-86.28 + 36.28, 0, 50) = (-50, 0, 50)
    expectVec3Close(result.newPosMmBody, [-50, 0, 50]);
  });

  it("returns null when port-to-beam distance exceeds tolerance", () => {
    // Port at (-36.28, 100, 50) — 100 mm off the (y=0) beam.
    const nodes: FiberNodePersist[] = [
      { posMm: [0, 100, 50], handleOutMm: [100, 0, 0] },
      { posMm: [200, 100, 50], handleInMm: [-100, 0, 0] },
    ];
    const result = computeFiberEndAlignment({
      end: "A",
      nodes,
      pose: IDENTITY_POSE,
      beamSegmentsLab: [beamAlongX(0, 50)],
      toleranceMm: 25,
    });
    expect(result).toBeNull();
  });

  it("returns null when there are no beam segments at all", () => {
    const nodes: FiberNodePersist[] = [
      { posMm: [0, 0, 0], handleOutMm: [100, 0, 0] },
      { posMm: [200, 0, 0], handleInMm: [-100, 0, 0] },
    ];
    expect(
      computeFiberEndAlignment({
        end: "A",
        nodes,
        pose: IDENTITY_POSE,
        beamSegmentsLab: [],
        toleranceMm: 25,
      }),
    ).toBeNull();
  });
});

// =============================================================================
// End B exit — symmetric case
// =============================================================================

describe("computeFiberEndAlignment — End B (beam exit)", () => {
  it("places port on beam and node TIP_MM behind it along +beam_tangent", () => {
    // Fiber whose End B is currently 8 mm below the +x beam. Port at
    // node + outward·TIP where outward = -handleIn/|.| = -(−1,0,0) = (+1,0,0).
    // port_lab = (200, -8, 50) + (1,0,0)·36.28 = (236.28, -8, 50).
    const nodes: FiberNodePersist[] = [
      { posMm: [0, -8, 50], handleOutMm: [100, 0, 0] },
      { posMm: [200, -8, 50], handleInMm: [-100, 0, 0] },
    ];
    const result = computeFiberEndAlignment({
      end: "B",
      nodes,
      pose: IDENTITY_POSE,
      beamSegmentsLab: [beamAlongX(0, 50)],
      toleranceMm: 25,
    });
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.distMm).toBeCloseTo(8, 5);

    // I1: port lab on beam — projected = (236.28, 0, 50).
    expectVec3Close(result.projectedPortLab, [236.28, 0, 50]);

    // I2: at End B, outward = +beam_tangent (face goes WITH beam),
    //     node = port - outward·TIP = (236.28, 0, 50) - (36.28, 0, 0) = (200, 0, 50).
    expectVec3Close(result.newOutwardBody, [1, 0, 0]);
    expectVec3Close(result.newPosMmBody, [200, 0, 50]);

    // Handle: outward_B = -handleIn → handleIn_B = -beam_tangent.
    // segLen = 200 mm → handleLen = max(20, 200·0.33) = 66.
    expectVec3Close(result.newHandleMmBody, [-66, 0, 0]);

    // Round-trip: port_from_new_node should equal projected.
    const portFromNewNode: [number, number, number] = [
      result.newPosMmBody[0] + result.newOutwardBody[0] * FIBER_FERRULE_TIP_MM,
      result.newPosMmBody[1] + result.newOutwardBody[1] * FIBER_FERRULE_TIP_MM,
      result.newPosMmBody[2] + result.newOutwardBody[2] * FIBER_FERRULE_TIP_MM,
    ];
    expectVec3Close(portFromNewNode, result.projectedPortLab);
  });

  it("works at End B when handleIn is missing — neighbour fallback", () => {
    // No handleIn at B. neighbour at (100, 5, 50), B at (250, 5, 50).
    // outward_B = (250-100, 0, 0)/150 = (+1, 0, 0).
    // port_lab = (250 + 36.28, 5, 50) = (286.28, 5, 50).
    const nodes: FiberNodePersist[] = [
      { posMm: [100, 5, 50] /* neighbour */ },
      { posMm: [250, 5, 50] /* no handleIn */ },
    ];
    const result = computeFiberEndAlignment({
      end: "B",
      nodes,
      pose: IDENTITY_POSE,
      beamSegmentsLab: [beamAlongX(0, 50)],
      toleranceMm: 25,
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.distMm).toBeCloseTo(5, 5);
    expectVec3Close(result.projectedPortLab, [286.28, 0, 50]);
    expectVec3Close(result.newOutwardBody, [1, 0, 0]);
    expectVec3Close(result.newPosMmBody, [250, 0, 50]);
  });
});

// =============================================================================
// Pose rotation
// =============================================================================

describe("computeFiberEndAlignment — with pose rotation", () => {
  it("respects SceneObject pose translation", () => {
    // Same fiber as the first End A test, but the SceneObject is at
    // (500, 0, 0) with no rotation. The fiber body coords are unchanged
    // but the lab port shifts by +500 in x; aim a beam at the new port y.
    const nodes: FiberNodePersist[] = [
      { posMm: [0, 10, 50], handleOutMm: [100, 0, 0] },
      { posMm: [300, 10, 50], handleInMm: [-100, 0, 0] },
    ];
    const pose: FiberAlignPose = { ...IDENTITY_POSE, xMm: 500 };
    // Lab beam y=10 to match the fiber's y exactly (so port is 0 off
    // the beam). The beam runs at lab y=10, z=50.
    const result = computeFiberEndAlignment({
      end: "A",
      nodes,
      pose,
      beamSegmentsLab: [
        { beamId: "shifted", aMm: [0, 10, 50], bMm: [1000, 10, 50] },
      ],
      toleranceMm: 25,
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.distMm).toBeLessThan(1e-6);
    // Projected port lab = current port lab = (500 + 0 + (-1)·36.28, 10, 50)
    //                                       = (463.72, 10, 50)
    expectVec3Close(result.projectedPortLab, [463.72, 10, 50]);
    // In body frame the node sits where it always was (0, 10, 50) since
    // the beam is exactly through the existing port.
    expectVec3Close(result.newPosMmBody, [0, 10, 50]);
  });

  it("rotation: 90° about Z swaps x/y, beam along lab +y aligns body+x port", () => {
    // Fiber with the same initial body coords (handleOut along body +x).
    // SceneObject rotated +90° about Z (lab Z is also body Z), so body
    // +x maps to lab +y. Aim a beam along lab +y at lab x=0, z=50.
    // Expectation: port lands on the beam (which is along lab +y at
    // x=0, z=50), node sits 36.28 mm "behind" along lab -y (= body -x).
    const nodes: FiberNodePersist[] = [
      { posMm: [0, 0, 50], handleOutMm: [100, 0, 0] },
      { posMm: [300, 0, 50], handleInMm: [-100, 0, 0] },
    ];
    const pose: FiberAlignPose = { ...IDENTITY_POSE, rzDeg: 90 };
    const result = computeFiberEndAlignment({
      end: "A",
      nodes,
      pose,
      beamSegmentsLab: [
        { beamId: "labY", aMm: [0, -500, 50], bMm: [0, 500, 50] },
      ],
      toleranceMm: 25,
    });
    expect(result).not.toBeNull();
    if (!result) return;
    // Port should now be ON the beam (lab x ≈ 0, z = 50).
    expect(Math.abs(result.projectedPortLab[0])).toBeLessThan(1e-6);
    expect(result.projectedPortLab[2]).toBeCloseTo(50, 5);
    // In body frame, outward at End A entry must be anti-parallel to
    // the beam in lab. Beam lab = (0,1,0). Rotated to body: rz=+90°
    // inverse → (0,1,0) lab is body (1,0,0). So outward_body = (-1,0,0).
    expectVec3Close(result.newOutwardBody, [-1, 0, 0]);
  });
});
