import { defineDevice } from "./_device";

/**
 * Thorlabs BB1-E03 — Ø1" broadband dielectric mirror (750–1100 nm, E03).
 *
 * First OPTICAL device example (plan §6 Phase 3). Unlike the RF placeholders,
 * the anchor frame here is real and matters: the tracer hit-tests
 * `intercept_face` and reflects about its `axisX`. Coordinates lifted from the
 * live (locked) `bb1_e03_step` asset's confirmed anchor: face at the body
 * origin, optical axis +Z, clear aperture Ø12.7 mm.
 *
 * LIMITATION (mirror/lens-safe only): a device anchor carries position +
 * direction (→ axisX); `materialize_device_anchors` recomputes axisY/axisZ.
 * For a mirror that's fine (reflection is axisY-independent). Polarisation-
 * sensitive optics (waveplate / PBS / Glan) would need an explicit
 * body-local axisY on the device template — a schema extension deferred until
 * such a device is authored.
 *
 * Forward-looking: every real optical asset today is `locked` (complete), so
 * this template seeds NEW/unlocked mirror imports, not the existing frozen row.
 */
export const bb1_e03 = defineDevice({
  id: "bb1_e03",
  displayName: "Thorlabs BB1-E03 mirror (Ø1\", E03)",
  behavioralKind: "mirror",
  componentType: "mirror",
  mesh: "bb1_e03_step.glb",
  anchors: [
    {
      role: "intercept_face",
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      directionBodyLocal: { x: 0, y: 0, z: 1 },
      apertureMm: 12.7,
    },
  ],
  defaultParams: {
    reflectivity: 0.99,
  },
});
