// Pins what the WEB still decides about fibre receptacles after the align
// maths moved behind `POST /api/v3/fibers/*` (2026-09-23): which anchors are
// sockets, and which connector anchor is the mating face vs the cable root.
//
// The mating geometry itself — End B facing ALONG the port's axisX, End A
// against it, and the optical face landing one `FIBER_MATING_GAP_MM` SHORT of
// the port plane so `anchor_tracer.nearest_anchor_hit` does not drop the hit
// at t < 1e-9 — is now pinned on the Python side only
// (`backend/tests/optical/test_fiber_endpoints.py`, plus the golden fixtures
// in `backend/tests/fixtures/fibers/`).
import { describe, expect, it } from "vitest";

import {
  isFiberPortConnectorType,
  isFiberReceptacleAnchor,
  OPTICAL_PORT_ANCHOR_IDS,
} from "../fiberAnchorResolver";
import { findCableRootAnchor, findMatingFaceAnchor } from "../connectorAnchors";

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
