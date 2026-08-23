/**
 * Cross-language invariants for the beam-chain decorations.
 *
 * `PRIMARY_OPTICAL_ANCHOR_IDS` is a hand-kept duplicate of the backend's
 * `anchor_tracer.PRIMARY_ANCHOR_IDS`, and duplicates drift. See
 * docs/introduce/rendering.md for what an optic-surface marker claims.
 */

import { describe, expect, it } from "vitest";

import { PRIMARY_OPTICAL_ANCHOR_IDS } from "../beamChain";


describe("PRIMARY_OPTICAL_ANCHOR_IDS mirrors the backend", () => {
  it("matches anchor_tracer.PRIMARY_ANCHOR_IDS plus the legacy alias", () => {
    // Hand-kept duplicate of `backend/app/optical/anchor_tracer.py`'s
    // PRIMARY_ANCHOR_IDS — the two live in different languages, so nothing but
    // this test notices when one side gains an anchor and the other does not.
    // That already happened once: `fiber_in` landed backend-side in alembic
    // 0133 and the RXM15EF quietly stopped getting an optic-surface marker.
    //
    // If this fails, do NOT just update the literal — decide first whether the
    // new anchor is a surface the beam is really acted on. A marker claims
    // exactly that, which is why connector and RF anchors stay out.
    const BACKEND_PRIMARY = [
      "intercept_in", "intercept_out", "intercept_face",
      "interaction_center", "optical_center", "fiber_in",
    ];
    const LEGACY_ALIAS = ["optical_anchor"];
    expect([...PRIMARY_OPTICAL_ANCHOR_IDS].sort()).toEqual(
      [...BACKEND_PRIMARY, ...LEGACY_ALIAS].sort(),
    );
  });
});
