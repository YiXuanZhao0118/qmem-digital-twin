import { defineDevice } from "./_device";

/**
 * TORNOS-isolator-Faraday-Rod — the rotator stage of the EOT/Coherent
 * "TORNOS Medium Power Optical Isolators — 500 nm to 1030 nm" isolator.
 * The isolator is imported as three assets: front polarizer piece →
 * THIS Faraday rod → back polarizer piece (the two housing pieces are
 * `isolator`-kind assets, so isolation / transmission numbers live there,
 * not here).
 *
 * From the datasheet:
 *   • "rotate the plane of polarized light 45° in the forward direction and
 *     an additional 45° of non-reciprocal rotation in the reverse
 *     direction" → `rotationDeg: 45`, `reciprocal: false`. A round trip
 *     therefore accumulates 90°, which the crossed output polarizer turns
 *     into isolation.
 *   • "Wavelength tunability", 500–1030 nm → the asset's
 *     `wavelengthRangeNm` (a range is not representable in the flat device
 *     `defaultParams`).
 *   • "Attain 60 dB using two isolators in series" ⇒ ~30 dB per isolator —
 *     again a polarizer-pair number, carried by the front/back pieces.
 *
 * NOT on the datasheet, so taken from the `faraday_rotator` kind defaults
 * (identical to the sibling `io5_850_faraday`): `lengthMm` 18 and
 * `refractiveIndex` 1.95 (TGG). Replace both if the rod spec turns up —
 * without them the tracer falls back to a 1 mm / n = 1.5 slab.
 *
 * Frame: the imported CAD (`tornos_isolator_850nm_4mm`) puts the beam along
 * body +X, with the middle piece spanning x ∈ [−14, +14] mm, so the rod's
 * `optical_center` sits at the body origin — which is exactly where the
 * live asset's confirmed anchor already is. Aperture 4.0 mm is the model's
 * clear aperture (TORNOS-850-4, cf. `backend/scripts/seed.py`).
 */
export const tornos_faraday = defineDevice({
  id: "tornos_faraday",
  displayName: "TORNOS-isolator-Faraday-Rod",
  behavioralKind: "faraday_rotator",
  componentType: "faraday_rotator",
  mesh: "tornos_isolator_middle_piece.glb",
  anchors: [
    {
      role: "optical_center",
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      directionBodyLocal: { x: 1, y: 0, z: 0 },
      axisYBodyLocal: { x: 0, y: 1, z: 0 },
      apertureMm: 4,
      apertureShape: "circle",
    },
  ],
  defaultParams: {
    rotationDeg: 45,
    reciprocal: false,
    lengthMm: 18,
    refractiveIndex: 1.95,
  },
});
