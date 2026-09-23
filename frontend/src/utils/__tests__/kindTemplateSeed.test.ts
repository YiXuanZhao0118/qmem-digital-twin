/**
 * "Seed from kind template" — what the click actually writes.
 *
 * The seed is additive and blank: a row at the body origin facing +Z with a
 * 1 mm circular aperture. That is fine as an explicit action and was NOT fine
 * as something opening an asset did, because `intercept_out` is hit-tested
 * (`PRIMARY_ANCHOR_IDS`) — see `utils/kindTemplateSeed.ts` and the guard in
 * `components/__tests__/kindAnchorSeeding.guard.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { draftAnchorFromStored } from "../anchorDraft";
import {
  kindTemplateSeedPatch,
  missingTemplateAnchorIds,
  type KindSeedDraft,
} from "../kindTemplateSeed";

/** A lens asset as the live catalog stores it: `intercept_in` only. Every one
 *  of the 8 lens assets is in exactly this state, and `lens_plano_convex`
 *  declares `intercept_out` as well. */
function lensDraft(): KindSeedDraft {
  return {
    anchors: [
      draftAnchorFromStored({
        id: "intercept_in",
        apertureMm: 12.7,
        apertureShape: "circle",
        axisXBodyLocal: { x: 1, y: 0, z: 0 },
        axisYBodyLocal: { x: 0, y: 1, z: 0 },
        axisZBodyLocal: { x: 0, y: 0, z: 1 },
        positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      }),
    ],
    defaultParamsText: '{\n  "focalLengthMm": 100\n}',
    tunableParams: [],
    wavelengthMinNm: "350",
    wavelengthMaxNm: "1100",
  };
}

const LENS_TEMPLATE = ["intercept_in", "intercept_out"] as const;

const LENS_SOURCE = {
  templateAnchorIds: LENS_TEMPLATE,
  kindDefaultParams: { focalLengthMm: 100, transmittance: 0.99 },
  stateParamKeys: [] as const,
};

describe("missingTemplateAnchorIds", () => {
  it("names the template ids the asset does not carry", () => {
    expect(missingTemplateAnchorIds(lensDraft(), LENS_TEMPLATE)).toEqual(["intercept_out"]);
  });

  it("is empty once every declared id is present", () => {
    const draft = lensDraft();
    draft.anchors.push(draftAnchorFromStored({ id: "intercept_out" }));
    expect(missingTemplateAnchorIds(draft, LENS_TEMPLATE)).toEqual([]);
  });
});

describe("kindTemplateSeedPatch", () => {
  it("appends a blank row for each missing id, at the origin facing +Z", () => {
    const patch = kindTemplateSeedPatch(lensDraft(), LENS_SOURCE);
    expect(patch).not.toBeNull();
    expect(patch!.anchors).toHaveLength(2);
    expect(patch!.anchors![1]).toMatchObject({
      id: "intercept_out",
      px: "0", py: "0", pz: "0",
      nx: "0", ny: "0", nz: "1",
      apertureMm: "1",
      apertureShape: "circle",
      // Invented by the editor, so Save derives it rather than passing it
      // through (utils/anchorDraft.ts).
      pristine: null,
    });
  });

  it("never touches an anchor the asset already has", () => {
    const before = lensDraft();
    const patch = kindTemplateSeedPatch(before, LENS_SOURCE)!;
    expect(patch.anchors![0]).toEqual(before.anchors[0]);
  });

  it("returns null when the asset already carries every declared id", () => {
    const draft = lensDraft();
    draft.anchors.push(draftAnchorFromStored({ id: "intercept_out" }));
    expect(kindTemplateSeedPatch(draft, LENS_SOURCE)).toBeNull();
  });

  it("leaves non-empty defaultParams / λ fields alone", () => {
    const patch = kindTemplateSeedPatch(lensDraft(), LENS_SOURCE)!;
    expect(patch).not.toHaveProperty("defaultParamsText");
    expect(patch).not.toHaveProperty("wavelengthMinNm");
  });

  it("seeds params, tunables and λ onto a freshly imported (empty) asset", () => {
    const fresh: KindSeedDraft = {
      anchors: [],
      defaultParamsText: "",
      tunableParams: [],
      wavelengthMinNm: "",
      wavelengthMaxNm: "",
    };
    const patch = kindTemplateSeedPatch(fresh, {
      templateAnchorIds: ["intercept_out"],
      // wavelengthRangeNm must NOT land in the JSON — on an asset it lives
      // only in the column, edited through the λ fields.
      kindDefaultParams: {
        nominalPowerMw: 50,
        centerWavelengthNm: 780.241,
        wavelengthRangeNm: [760, 800],
      },
      stateParamKeys: ["nominalPowerMw", "centerWavelengthNm"],
    })!;
    expect(patch.anchors).toHaveLength(1);
    expect(JSON.parse(patch.defaultParamsText!)).toEqual({
      nominalPowerMw: 50,
      centerWavelengthNm: 780.241,
    });
    expect(patch.tunableParams).toEqual(["nominalPowerMw", "centerWavelengthNm"]);
    expect(patch.wavelengthMinNm).toBe("760");
    expect(patch.wavelengthMaxNm).toBe("800");
  });
});
