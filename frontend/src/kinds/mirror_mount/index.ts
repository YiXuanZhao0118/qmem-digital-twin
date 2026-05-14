/**
 * Mirror Mount — kinematic mount for a mirror disc.
 *
 * Passive component: no physics contract, no ElementKind. Appears in
 * the Components catalog under Mechanical, renders via STL (Thorlabs
 * KS1 / KS1T / Polaris series) if asset_3d_id is linked.
 *
 * Today's `link_components_to_stl.py` matches Component.name against
 * Asset3D.name=`<name>_stl`; the `assetNamePattern` field below
 * declares that convention so M5's API-layer auto-linker can take over
 * (no more one-shot scripts).
 */
import { definePassivePlugin } from "../_plugin";

export const mirrorMountPlugin = definePassivePlugin({
  id: "mirror_mount",
  displayName: "Mirror Mount",
  componentTypes: ["mirror_mount"],
  assetCategory: "mechanical",
  assetNamePattern: "{name}_stl",
});
