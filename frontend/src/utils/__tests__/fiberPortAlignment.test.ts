// Pins the fibre↔port mating math — the thing that makes a patch cable
// "pluggable" into an instrument (the optical twin of rf_cable's endpoint
// link). Two invariants matter and both have already been got wrong once:
//
//  1. ORIENTATION. An optical anchor's axisX is the PROPAGATION direction,
//     not a mechanical outward normal, so this is NOT the RF anti-parallel
//     rule. End B (an exit) must come out facing ALONG the port's axisX;
//     End A (an entry) facing against it.
//  2. THE GAP. The optical face must land slightly SHORT of the port plane,
//     because `anchor_tracer.nearest_anchor_hit` drops any hit with
//     t < 1e-9 — mate the faces exactly and a fibre-fed detector sees
//     nothing at all.
import { describe, expect, it } from "vitest";

import {
  findFiberPortAlignmentCandidates,
  isFiberPortConnectorType,
  isFiberReceptacleAnchor,
  OPTICAL_PORT_ANCHOR_IDS,
  type FiberPortLab,
} from "../fiberAlignment";
import {
  FIBER_MATING_GAP_MM,
  resolveLinkedFiberEndpoint,
} from "../fiberAnchorResolver";
import { findCableRootAnchor, findMatingFaceAnchor } from "../connectorAnchors";

const IDENTITY = { xMm: 0, yMm: 0, zMm: 0, rxDeg: 0, ryDeg: 0, rzDeg: 0 };
const TIP = 36.28;

/** A straight fibre along +X, both ends far from the port under test. */
const straightNodes = () => [
  { posMm: [0, 0, 0] as [number, number, number], handleOutMm: [30, 0, 0] as [number, number, number] },
  { posMm: [300, 0, 0] as [number, number, number], handleInMm: [-30, 0, 0] as [number, number, number] },
];

/** A detector-style input port at x=500 whose light travels −X. */
const inputPort = (): FiberPortLab => ({
  labPosMm: [500, 0, 0],
  labAxisX: [-1, 0, 0],
  targetName: "RXM15EF",
  targetObjectId: "det-1",
  targetAnchorId: "fiber_in",
  targetAnchorName: "OPTICAL IN (FC/PC)",
});

describe("isFiberPortConnectorType", () => {
  it("accepts fibre bulkheads and rejects coax + free-space faces", () => {
    expect(isFiberPortConnectorType("fc_pc_female")).toBe(true);
    expect(isFiberPortConnectorType("fc_apc_female")).toBe(true);
    // Prefix-based so a future sc_/lc_/st_ needs no change here.
    expect(isFiberPortConnectorType("lc_apc_female")).toBe(true);
    expect(isFiberPortConnectorType("sma_female")).toBe(false);
    expect(isFiberPortConnectorType(undefined)).toBe(false);
    expect(isFiberPortConnectorType(null)).toBe(false);
  });

  it("rejects a MALE ferrule — a cable end is a plug, not a socket", () => {
    // The reason the gender split exists at all: `collectFiberPortsLab`
    // filters on this predicate alone and never looks at the anchor id, so a
    // gender-blind test would advertise every patch-cable end as a
    // receptacle and let two cables be plugged into each other.
    expect(isFiberPortConnectorType("fc_pc_male")).toBe(false);
    expect(isFiberPortConnectorType("fc_apc_male")).toBe(false);
    // And the ungendered pre-0133 spellings are gone, not silently accepted.
    expect(isFiberPortConnectorType("fc_pc")).toBe(false);
    expect(isFiberPortConnectorType("fc_apc")).toBe(false);
  });
});

describe("findFiberPortAlignmentCandidates", () => {
  it("End B comes out facing ALONG the port axisX, not anti-parallel", () => {
    const [c] = findFiberPortAlignmentCandidates({
      end: "B",
      nodes: straightNodes(),
      pose: IDENTITY,
      ports: [inputPort()],
      toleranceMm: 250,
      tipMm: TIP,
    });
    expect(c).toBeDefined();
    // Light enters the detector travelling −X; the exit face must look the
    // same way. Anti-parallel (+X) would point the cable away from the part.
    expect(c.newOutwardBody[0]).toBeCloseTo(-1, 12);
    expect(c.newOutwardBody[1]).toBeCloseTo(0, 12);
    expect(c.newOutwardBody[2]).toBeCloseTo(0, 12);
  });

  it("End A faces back up the beam (opposite End B)", () => {
    const [c] = findFiberPortAlignmentCandidates({
      end: "A",
      nodes: straightNodes(),
      pose: IDENTITY,
      ports: [inputPort()],
      toleranceMm: 600,
      tipMm: TIP,
    });
    expect(c.newOutwardBody[0]).toBeCloseTo(1, 12);
  });

  it("puts the optical face one mating gap SHORT of the port plane", () => {
    const [c] = findFiberPortAlignmentCandidates({
      end: "B",
      nodes: straightNodes(),
      pose: IDENTITY,
      ports: [inputPort()],
      toleranceMm: 250,
      tipMm: TIP,
    });
    // face = node + outward·tip, and outward is −X here.
    const faceX = c.newPosMmBody[0] + c.newOutwardBody[0] * TIP;
    expect(faceX).toBeCloseTo(500 + FIBER_MATING_GAP_MM, 9);
    // The ray then travels +gap along −X to reach the plane at x=500, so
    // the tracer's t is positive rather than exactly zero.
    expect(faceX - 500).toBeGreaterThan(1e-6);
  });

  it("carries the link payload and rejects ports beyond tolerance", () => {
    const near = findFiberPortAlignmentCandidates({
      end: "B", nodes: straightNodes(), pose: IDENTITY,
      ports: [inputPort()], toleranceMm: 250, tipMm: TIP,
    });
    expect(near[0].port).toEqual({
      targetObjectId: "det-1",
      targetAnchorId: "fiber_in",
      targetAnchorName: "OPTICAL IN (FC/PC)",
    });
    const far = findFiberPortAlignmentCandidates({
      end: "B", nodes: straightNodes(), pose: IDENTITY,
      ports: [inputPort()], toleranceMm: 5, tipMm: TIP,
    });
    expect(far).toEqual([]);
  });
});

describe("resolveLinkedFiberEndpoint", () => {
  it("agrees with the align helper — same node for the same port", () => {
    const [c] = findFiberPortAlignmentCandidates({
      end: "B", nodes: straightNodes(), pose: IDENTITY,
      ports: [inputPort()], toleranceMm: 250, tipMm: TIP,
    });
    const r = resolveLinkedFiberEndpoint({
      endpoint: "B",
      fiberPose: IDENTITY,
      targetPose: IDENTITY,
      targetAnchorPosBodyMm: [500, 0, 0],
      targetAnchorDirBody: [-1, 0, 0],
      tipMm: TIP,
    });
    expect(r).not.toBeNull();
    // If these two ever diverge, a plugged cable jumps the moment the
    // instrument is nudged: align puts it in one place, re-snap another.
    expect(r!.posMmBody[0]).toBeCloseTo(c.newPosMmBody[0], 9);
    expect(r!.posMmBody[1]).toBeCloseTo(c.newPosMmBody[1], 9);
    expect(r!.posMmBody[2]).toBeCloseTo(c.newPosMmBody[2], 9);
  });

  it("follows the target through a rotation", () => {
    // Same port, but the instrument is yawed 90° about Y: its local −X
    // becomes lab −Z under lab = R_z·R_x·R_y·body.
    const r = resolveLinkedFiberEndpoint({
      endpoint: "B",
      fiberPose: IDENTITY,
      targetPose: { ...IDENTITY, ryDeg: 90 },
      targetAnchorPosBodyMm: [500, 0, 0],
      targetAnchorDirBody: [-1, 0, 0],
      tipMm: TIP,
    });
    expect(r).not.toBeNull();
    // Port lab position: R_y(90)·(500,0,0) = (0,0,-500).
    // Outward = that same rotated axisX = (0,0,500)/|..| = +Z.
    // node = port − outward·(tip+gap) → z = −500 − (tip+gap).
    expect(r!.posMmBody[0]).toBeCloseTo(0, 6);
    expect(r!.posMmBody[1]).toBeCloseTo(0, 6);
    expect(r!.posMmBody[2]).toBeCloseTo(-500 - (TIP + FIBER_MATING_GAP_MM), 6);
  });

  it("returns null on a degenerate port direction", () => {
    expect(
      resolveLinkedFiberEndpoint({
        endpoint: "B",
        fiberPose: IDENTITY,
        targetPose: IDENTITY,
        targetAnchorPosBodyMm: [500, 0, 0],
        targetAnchorDirBody: [0, 0, 0],
      }),
    ).toBeNull();
  });
});

describe("isFiberReceptacleAnchor", () => {
  it("counts a bulkhead by its anchor id, with no connectorType needed", () => {
    // The RXM15EF's whole shape. This is the case that regressed once: the
    // Object panel used to scan only for `intercept_*`, so a part built
    // entirely of sockets produced an EMPTY optical-anchor list, failed the
    // `length > 0` test, and got its meaningless "Align to beam" button back.
    expect(isFiberReceptacleAnchor({ id: "fiber_in" })).toBe(true);
    expect(
      isFiberReceptacleAnchor({ id: "fiber_in", connectorType: "fc_pc_female" }),
    ).toBe(true);
  });

  it("`fiber_in` is the ONLY socket id — fiber_out/fiber_root are the plug", () => {
    // The trap the 0135 rename sets for anyone who reads `fiber_*` as "a
    // fibre thing, therefore a port". `fiber_out` is a CONNECTOR's mating
    // face and `fiber_root` its cable junction: both live on the patch cable,
    // both are male, and nothing plugs into either. A prefix test here would
    // hand every cable end back as a socket — exactly the bug the gendered
    // connectorType was introduced to kill.
    expect(isFiberReceptacleAnchor({ id: "fiber_out" })).toBe(false);
    expect(
      isFiberReceptacleAnchor({ id: "fiber_out", connectorType: "fc_apc_male" }),
    ).toBe(false);
    expect(isFiberReceptacleAnchor({ id: "fiber_root" })).toBe(false);
  });

  it("counts a pre-0133 intercept that declares a female connector", () => {
    expect(
      isFiberReceptacleAnchor({ id: "intercept_in", connectorType: "fc_pc_female" }),
    ).toBe(true);
  });

  it("does NOT count a free-space face or a male ferrule", () => {
    // A bare optic keeps its Align button...
    expect(isFiberReceptacleAnchor({ id: "intercept_in" })).toBe(false);
    expect(isFiberReceptacleAnchor({ id: "intercept_out", connectorType: null })).toBe(false);
    // ...and a cable's own plug is not something to plug a cable into.
    expect(
      isFiberReceptacleAnchor({ id: "fiber_out", connectorType: "fc_apc_male" }),
    ).toBe(false);
  });

  it("OPTICAL_PORT_ANCHOR_IDS is the free-space faces plus the socket", () => {
    // Deliberately NOT every `fiber_*` id — see the test above.
    expect([...OPTICAL_PORT_ANCHOR_IDS].sort()).toEqual(
      ["fiber_in", "intercept_in", "intercept_out"],
    );
  });
});

describe("connector anchor lookup (fibre vs coax spellings)", () => {
  const face = { id: "fiber_out", connectorType: "fc_apc_male" };
  const root = { id: "fiber_root" };

  it("finds the fibre spelling written by alembic 0135", () => {
    expect(findMatingFaceAnchor([root, face])?.id).toBe("fiber_out");
    expect(findCableRootAnchor([root, face])?.id).toBe("fiber_root");
  });

  it("still finds the coax spelling, which was deliberately not renamed", () => {
    const rf = [{ id: "connect_out" }, { id: "connect_in" }];
    expect(findMatingFaceAnchor(rf)?.id).toBe("connect_in");
    expect(findCableRootAnchor(rf)?.id).toBe("connect_out");
  });

  it("prefers the fibre spelling by ID, not by array position", () => {
    // An asset caught mid-migration could carry both. Order the lookup by the
    // id we want, or a legacy anchor sitting earlier in the array wins.
    const both = [{ id: "connect_in" }, { id: "connect_out" }, face, root];
    expect(findMatingFaceAnchor(both)?.id).toBe("fiber_out");
    expect(findCableRootAnchor(both)?.id).toBe("fiber_root");
  });

  it("returns undefined rather than throwing on an anchorless asset", () => {
    expect(findMatingFaceAnchor([])).toBeUndefined();
    expect(findCableRootAnchor(null)).toBeUndefined();
    expect(findMatingFaceAnchor([{ id: "intercept_in" }])).toBeUndefined();
  });
});
