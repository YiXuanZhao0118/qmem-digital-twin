import { defineDevice } from "./_device";

/**
 * Mini-Circuits ZYSWA-2-50DR — SP2T coaxial RF switch.
 *
 * Device example for the `rf_switch` behavioral kind. Four SMA-F jacks:
 * rf_in (RFIN common), two throws (RF1/RF2, both role `rf_out`,
 * disambiguated by name), and ttl_in (TTL control). The role `rf_out`'s
 * cardinality (max: null) is what makes the two-throw layout legal — no
 * `repeatable` flag. All four directions are outward face normals.
 *
 * Positions synced 2026-08-17 from the locked `minicircuits_zyswa_2_50dr`
 * Asset3D row and verified against the GLB it renders
 * (07fe77a6…_minicircuits_zyswa_2_50dr.glb): the housing face sits between
 * x = 9.5 and 10.0, and the connector barrels in |x| 14…20 have their
 * vertex mass centred on y = ±4.7. They previously carried nothing at all,
 * so the PHY Editor could not tell an authored anchor from a dragged one.
 */
export const zyswa_2_50dr = defineDevice({
  id: "zyswa_2_50dr",
  displayName: "Mini-Circuits ZYSWA-2-50DR (SP2T switch)",
  behavioralKind: "rf_switch",
  componentType: "rf_switch",
  mesh: "primitive://rf_switch",
  anchors: [
    {
      role: "rf_in",
      positionMmBodyLocal: { x: -9.525, y: 4.7, z: 0 },
      directionBodyLocal: { x: -1, y: 0, z: 0 },
      connectorType: "sma_female",
    },
    {
      role: "rf_out",
      name: "RF1",
      positionMmBodyLocal: { x: 9.525, y: 4.7, z: 0 },
      directionBodyLocal: { x: 1, y: 0, z: 0 },
      connectorType: "sma_female",
    },
    {
      role: "rf_out",
      name: "RF2",
      positionMmBodyLocal: { x: 9.525, y: -4.7, z: 0 },
      directionBodyLocal: { x: 1, y: 0, z: 0 },
      connectorType: "sma_female",
    },
    {
      role: "ttl_in",
      positionMmBodyLocal: { x: -9.525, y: -4.7, z: 0 },
      directionBodyLocal: { x: -1, y: 0, z: 0 },
      connectorType: "sma_female",
    },
  ],
});
