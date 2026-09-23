/**
 * "Seed from kind template" for the PHY Editor's ASSET3D form.
 *
 * A kind declares which anchor ids an asset of that kind should carry
 * (`kinds.anchor_template` = `{required, optional}`). Seeding fills in a blank
 * row for every declared id the asset is missing, plus the kind's
 * `defaultParams` / tunable set / λ range while those are still empty.
 *
 * **This is a deliberate user action, not something opening an asset does**
 * (2026-09-23). It used to run from a `useEffect` keyed on the whole draft, so
 * merely OPENING an asset appended rows: on the live catalog that put a blank
 * `intercept_out` at the body origin onto 8 lens assets and blank rows onto 12
 * more (`out` / `seed` / `fiber_in` / `intercept_in`), 20 of 64 assets in all.
 * The row is not inert — `intercept_out` is in `PRIMARY_ANCHOR_IDS`, so it is
 * hit-tested: saving a lens after opening it dropped a 1 mm face at the lens's
 * own origin, facing +Z, into the beam path. And because it landed in the
 * draft, ANY save carried it, including a save the user made for an unrelated
 * field. The Blender add-on's asset editor seeds on an explicit click for the
 * same reason.
 *
 * Additive only: never drops or reorders an anchor the asset already has.
 * Synthesised ids outside the template (`interaction_center` for aom,
 * `optical_center` for faraday / slab) must survive.
 */
import type { DraftAnchor } from "./anchorDraft";
import { n } from "./anchorDraft";

/** The slice of the editor's `AssetDraft` this function reads and writes. */
export type KindSeedDraft = {
  anchors: DraftAnchor[];
  /** The defaultParams JSON textarea. Seeded only while blank / `{}`. */
  defaultParamsText: string;
  tunableParams: string[];
  wavelengthMinNm: string;
  wavelengthMaxNm: string;
};

export type KindSeedSource = {
  /** `anchorTemplate.required` ++ `anchorTemplate.optional`, in order. */
  templateAnchorIds: readonly string[];
  /** The kind row's `defaultParams`. */
  kindDefaultParams: Record<string, unknown>;
  /** The kind plugin's `physics.stateParamKeys` — the per-instance knobs. */
  stateParamKeys: readonly string[];
};

/** Anchor ids the kind declares that this draft does not have yet. */
export function missingTemplateAnchorIds(
  draft: Pick<KindSeedDraft, "anchors">,
  templateAnchorIds: readonly string[],
): string[] {
  const present = new Set(draft.anchors.map((a) => a.id));
  return templateAnchorIds.filter((id) => !present.has(id));
}

/** A blank anchor row, as the seed writes it: at the body origin, facing +Z,
 *  1 mm circular. `pristine: null` because the editor invented it — it is not
 *  something read off the asset, so it must serialise through the derivation
 *  (see `anchorDraft.ts`). */
function blankAnchor(id: string): DraftAnchor {
  return {
    id,
    px: "0", py: "0", pz: "0",
    nx: "0", ny: "0", nz: "1",
    yx: "0", yy: "1", yz: "0",
    apertureMm: "1",
    apertureShape: "circle",
    apertureWidthMm: "",
    apertureHeightMm: "",
    connectorType: "",
    name: "",
    pristine: null,
  };
}

/** The draft patch "Seed from kind" applies, or `null` when the asset already
 *  carries every id the kind declares (the button is disabled in that case).
 *
 *  `wavelengthRangeNm` is special: on an asset it lives ONLY in the
 *  `wavelength_range_nm` column, edited through the λ min/max fields, and Save
 *  treats that column as authoritative. So it is stripped out of the JSON seed
 *  and routed to those fields instead; left in defaultParams it would be a
 *  duplicate the fields never reflect and the save silently drops
 *  ([asset.md](../../../docs/introduce/asset.md)). */
export function kindTemplateSeedPatch(
  draft: KindSeedDraft,
  source: KindSeedSource,
): Partial<KindSeedDraft> | null {
  const missing = missingTemplateAnchorIds(draft, source.templateAnchorIds);
  if (missing.length === 0) return null;

  const { wavelengthRangeNm: seedWavelength, ...kindParams } = source.kindDefaultParams;
  const seedParams =
    (draft.defaultParamsText.trim() === "" || draft.defaultParamsText.trim() === "{}")
    && Object.keys(kindParams).length > 0;
  const seedWavelengthFields =
    Array.isArray(seedWavelength)
    && draft.wavelengthMinNm.trim() === ""
    && draft.wavelengthMaxNm.trim() === "";
  // Seed the tunable set from the kind's declared state params (∩ the params
  // actually seeded), so a new laser / RF asset is born with sensible
  // per-instance knobs. Only when nothing is tunable yet.
  const seedTunable =
    seedParams
    && draft.tunableParams.length === 0
    && source.stateParamKeys.some((k) => k in kindParams);

  return {
    anchors: [...draft.anchors, ...missing.map(blankAnchor)],
    ...(seedParams ? { defaultParamsText: JSON.stringify(kindParams, null, 2) } : {}),
    ...(seedTunable
      ? { tunableParams: source.stateParamKeys.filter((k) => k in kindParams) }
      : {}),
    ...(seedWavelengthFields
      ? {
          wavelengthMinNm: n((seedWavelength as unknown[])[0] as number),
          wavelengthMaxNm: n((seedWavelength as unknown[])[1] as number),
        }
      : {}),
  };
}
