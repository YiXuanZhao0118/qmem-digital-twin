import { defineDevice } from "./_device";

/**
 * PBS055 — Thorlabs 5 mm polarizing beamsplitter cube, 700–1300 nm.
 *
 * Same shape as `pbs252` (the 25.4 mm cube), rescaled to the 5 mm body: the
 * `intercept_face` sits at the cube centre with the coating normal at 45° in
 * the XY plane, and the rectangular hit aperture is the coating's own
 * footprint — 5 mm tall by 5·√2 = 7.071 mm along the diagonal.
 *
 * The 700–1300 nm coating range lives on the asset's `wavelengthRangeNm`
 * (a range has no place in the flat device `defaultParams`), as does the
 * `coatingNormalBodyLocal` array.
 *
 * `refractiveIndex_e` / `_o` (1.693, isotropic here — a PBS cube is not
 * birefringent, both branches just need the glass index) and the 30 dB
 * extinction ratios are **inherited from `pbs252`**, not read off a PBS055
 * spec sheet. Correct them if the datasheet disagrees.
 */
export const pbs055 = defineDevice({
  id: "pbs055",
  displayName: "PBS055",
  behavioralKind: "beam_splitter",
  componentType: "beam_splitter",
  mesh: "pbs055.glb",
  anchors: [
    {
      role: "intercept_face",
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      directionBodyLocal: { x: -0.7071067811865475, y: 0.7071067811865475, z: 0 },
      axisYBodyLocal: { x: 0.7071067811865475, y: 0.7071067811865475, z: 0 },
      apertureMm: 1,
      apertureShape: "rectangle",
      apertureWidthMm: 7.0710678118654755,
      apertureHeightMm: 5,
    },
  ],
  defaultParams: {
    lengthMm: 5,
    polarizing: true,
    refractiveIndex_e: 1.693,
    refractiveIndex_o: 1.693,
    extinctionRatioPpDb: 30,
    extinctionRatioSpDb: 30,
    transmissionAxisDegBeamLocal: 0,
  },
});
