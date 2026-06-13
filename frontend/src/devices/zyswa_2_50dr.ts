import { defineDevice } from "./_device";

/**
 * Mini-Circuits ZYSWA-2-50DR — SP2T coaxial RF switch.
 *
 * Device example for the `rf_switch` behavioral kind. Four SMA-F jacks:
 * rf_in (RFIN common), two throws (RF1/RF2, both role `rf_out`,
 * disambiguated by name), and ttl_in (TTL control). The role `rf_out`'s
 * cardinality (max: null) is what makes the two-throw layout legal — no
 * `repeatable` flag. Anchors seed at origin and are dragged onto the case;
 * all four are outward face normals.
 */
export const zyswa_2_50dr = defineDevice({
  id: "zyswa_2_50dr",
  displayName: "Mini-Circuits ZYSWA-2-50DR (SP2T switch)",
  behavioralKind: "rf_switch",
  componentType: "rf_switch",
  mesh: "primitive://rf_switch",
  anchors: [
    { role: "rf_in", connectorType: "sma_female" },
    { role: "rf_out", name: "RF1", connectorType: "sma_female" },
    { role: "rf_out", name: "RF2", connectorType: "sma_female" },
    { role: "ttl_in", connectorType: "sma_female" },
  ],
});
