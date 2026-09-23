/**
 * The PHY Editor's Save must not rewrite an anchor nobody touched.
 *
 * `Asset3DV3Update.anchors` has no partial form — Save sends the WHOLE list —
 * so every untouched row rides along on any edit, and any lossy step in
 * `stored → draft → stored` silently rewrites rows the user never opened.
 *
 * The fixtures below are verbatim rows from `GET /api/v3/assets3d`
 * (2026-09-23) — not hand-rounded, because the whole point is the last bits:
 * re-normalising an already-unit axisX and re-Gram-Schmidt'ing an
 * already-orthogonal axisY is not idempotent in float64, and a
 * device-authored anchor that drifts by 1e-16 re-grades itself "overridden"
 * in the editor (`gradeAnchor`). Of the live catalog's 76 anchors the old
 * derive-on-every-save path rewrote 8 on a no-edit save: 3 axis drifts
 * (`30126a9_step:fiber_out`, `intercept_face` on `pbs055` / `pbs122_step`)
 * and 5 that gained `apertureMm: 0` + `apertureShape: "circle"` out of thin
 * air, because `Number("")` is 0 rather than NaN. `pbs252_step` is included
 * as the near miss: the same 45° frame, which happens to survive the
 * derivation — the drift depends on the last bit, so "it looked fine on my
 * asset" was never evidence.
 */
import { describe, expect, it } from "vitest";

import {
  anchorPayloadFromDraft,
  draftAnchorFromStored,
} from "../anchorDraft";

/** Anchors carrying a full tri-axis frame. The first three are the live
 *  axis drifts (max |Δ| ≈ 1e-16); `pbs252_step` is the near miss. */
const FRAMED = {
  "30126a9_step:fiber_out": {
    id: "fiber_out",
    apertureMm: 1.0,
    apertureShape: "circle",
    connectorType: "fc_apc_male",
    axisXBodyLocal: { x: 2.686006310088765e-7, y: -0.1391728997450958, z: 0.9902680970204327 },
    axisYBodyLocal: { x: 3.7749301227963455e-8, y: 0.9902680970204691, z: 0.13917289974509064 },
    axisZBodyLocal: { x: -0.999999999999963, y: 0.0, z: 2.712403154429041e-7 },
    positionMmBodyLocal: { x: 0.0, y: -0.0398994676147898, z: 11.210308583577474 },
  },
  "pbs055:intercept_face": {
    id: "intercept_face",
    apertureMm: 1,
    apertureShape: "rectangle",
    axisXBodyLocal: { x: -0.7071067811865476, y: 0.7071067811865476, z: 0.0 },
    axisYBodyLocal: { x: 0.7071067811865476, y: 0.7071067811865476, z: 0.0 },
    axisZBodyLocal: { x: 0.0, y: 0.0, z: -1.0 },
    apertureWidthMm: 7.0710678118654755,
    apertureHeightMm: 5,
    positionMmBodyLocal: { x: 0.0, y: 0.0, z: 0.0 },
  },
  "pbs122_step:intercept_face": {
    id: "intercept_face",
    apertureMm: 1.0,
    apertureShape: "rectangle",
    axisXBodyLocal: { x: 0.7071067811865475, y: 0.7071067811865475, z: 0.0 },
    axisYBodyLocal: { x: -0.7071067811865475, y: 0.7071067811865476, z: 0.0 },
    axisZBodyLocal: { x: 0.0, y: 0.0, z: 0.9999999999999999 },
    apertureWidthMm: 18.0,
    apertureHeightMm: 12.7,
    positionMmBodyLocal: { x: 0.0, y: 0.0, z: 0.0 },
  },
  "pbs252_step:intercept_face": {
    id: "intercept_face",
    apertureMm: 1.0,
    apertureShape: "rectangle",
    axisXBodyLocal: { x: -0.7071067811865475, y: 0.7071067811865475, z: 0.0 },
    axisYBodyLocal: { x: 0.7071067811865475, y: 0.7071067811865475, z: 0.0 },
    axisZBodyLocal: { x: 0.0, y: 0.0, z: -0.9999999999999998 },
    apertureWidthMm: 35.92,
    apertureHeightMm: 25.4,
    positionMmBodyLocal: { x: 0.0, y: 0.0, z: 0.0 },
  },
} as const satisfies Record<string, Record<string, unknown>>;

/** Anchors with NO aperture at all — the old path wrote `apertureMm: 0`
 *  AND `apertureShape: "circle"` onto them. */
const NO_APERTURE = {
  "bnc_female:connect_in": {
    id: "connect_in",
    axisXBodyLocal: { x: 1.0, y: 0.0, z: 0.0 },
    axisYBodyLocal: { x: 0.0, y: 1.0, z: 0.0 },
    axisZBodyLocal: { x: 0.0, y: 0.0, z: 1.0 },
    positionMmBodyLocal: { x: 27.0, y: 0.0, z: 0.0 },
  },
  "aa_mt80_a1_5_ir:acoustic_axis": {
    id: "acoustic_axis",
    axisXBodyLocal: { x: -1.0, y: 0.0, z: 0.0 },
    axisYBodyLocal: { x: 0.0, y: -1.0, z: 0.0 },
    axisZBodyLocal: { x: 0.0, y: 0.0, z: 1.0 },
    positionMmBodyLocal: { x: 0.0, y: 0.0, z: 0.0 },
  },
} as const satisfies Record<string, Record<string, unknown>>;

const ALL = { ...FRAMED, ...NO_APERTURE };

/** What a Save with no edits does to one anchor. */
function saveUntouched(stored: Record<string, unknown>): Record<string, unknown> {
  return anchorPayloadFromDraft(draftAnchorFromStored(stored), 0);
}

describe("an untouched anchor goes back exactly as read", () => {
  for (const [label, stored] of Object.entries(ALL)) {
    it(`${label} survives a no-edit save unchanged`, () => {
      const out = saveUntouched(stored);
      // Deep equality catches a changed value (vitest compares numbers with
      // ===, so 0.9999999999999999 vs 1 is a failure, not a rounding win);
      // the key-set assertion catches an ADDED or DROPPED key — the old path
      // conjured `apertureMm: 0` AND `apertureShape: "circle"`. Key ORDER is
      // deliberately not asserted: JSONB normalises it, so it is not part of
      // "unchanged".
      expect(out).toEqual(stored);
      expect(new Set(Object.keys(out))).toEqual(new Set(Object.keys(stored)));
    });
  }

  it("keeps every axis component bit-identical, not merely close", () => {
    // The old path's error was ~1e-16 — inside any toBeCloseTo. Object.is
    // is the only assertion that would have failed.
    for (const stored of Object.values(FRAMED)) {
      const out = saveUntouched(stored) as typeof stored;
      for (const axis of ["axisXBodyLocal", "axisYBodyLocal", "axisZBodyLocal"] as const) {
        for (const c of ["x", "y", "z"] as const) {
          expect(Object.is(out[axis][c], stored[axis][c])).toBe(true);
        }
      }
    }
  });

  it("does not invent an apertureMm on an anchor that has none", () => {
    for (const stored of Object.values(NO_APERTURE)) {
      expect(saveUntouched(stored)).not.toHaveProperty("apertureMm");
    }
  });
});

describe("an edited anchor is still re-derived", () => {
  const stored = FRAMED["pbs055:intercept_face"];

  it("re-orthonormalises the frame once a field changes", () => {
    const draft = draftAnchorFromStored(stored);
    const moved = anchorPayloadFromDraft({ ...draft, px: "1.5" }, 0) as Record<
      string,
      { x: number; y: number; z: number } & number
    >;
    expect(moved.positionMmBodyLocal).toEqual({ x: 1.5, y: 0, z: 0 });
    // axisZ = axisX × axisY, recomputed — the stored exact -1 is precisely
    // what the derivation does NOT reproduce (it lands on
    // -0.9999999999999998), which is the whole reason untouched rows are
    // passed through instead.
    expect(moved.axisZBodyLocal.z).toBeCloseTo(-1, 12);
    expect(Object.is(moved.axisZBodyLocal.z, stored.axisZBodyLocal.z)).toBe(false);
  });

  it("returns to pristine when the edit is typed back", () => {
    const draft = draftAnchorFromStored(stored);
    const there = { ...draft, px: "1.5" };
    const back = { ...there, px: draft.px };
    expect(anchorPayloadFromDraft(back, 0)).toEqual(stored);
  });

  it("omits apertureMm when the field is cleared rather than writing 0", () => {
    const draft = draftAnchorFromStored(stored);
    const cleared = anchorPayloadFromDraft({ ...draft, apertureMm: "" }, 0);
    expect(cleared).not.toHaveProperty("apertureMm");
  });
});

describe("a row the editor invented is never pristine", () => {
  it("serialises a seeded row through the derivation", () => {
    const seeded = {
      id: "intercept_out",
      px: "0", py: "0", pz: "0",
      nx: "0", ny: "0", nz: "1",
      yx: "0", yy: "1", yz: "0",
      apertureMm: "1",
      apertureShape: "circle" as const,
      apertureWidthMm: "",
      apertureHeightMm: "",
      connectorType: "",
      name: "",
      pristine: null,
    };
    const out = anchorPayloadFromDraft(seeded, 0);
    expect(out).toMatchObject({
      id: "intercept_out",
      apertureMm: 1,
      axisXBodyLocal: { x: 0, y: 0, z: 1 },
    });
  });
});
