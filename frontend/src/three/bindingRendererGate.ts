/**
 * Per-componentType allowlist for the ComponentBinding-tree renderer.
 *
 * The legacy renderer path in DigitalTwinViewer
 * (``loadAssetObject(component, asset, deviceState, props, fiberEnds)``)
 * has deep ties to per-componentType state — fiber's per-instance
 * spline, rf_cable's anchor-linked endpoints, isolator's bespoke
 * pbsOverlay STL-triangle partition. The binding-tree renderer
 * (``buildBindingTreeObject`` over ``resolveBindingTree``) is the
 * long-term replacement but only makes sense for componentTypes whose
 * catalog has actually been migrated to a binding tree (i.e. has
 * ``ComponentBinding`` rows describing the assembly structure).
 *
 * This allowlist is the migration gate. A componentType added here
 * tells DigitalTwinViewer's per-object render block to walk the
 * binding tree instead of calling the legacy single-asset loader.
 * Components NOT in the set keep their existing render path — zero
 * regression for the 280+ catalog rows we haven't touched.
 *
 * Order of migration (each entry = one PR):
 *   - "isolator"      — Stage A'', replaces pbsOverlay.ts
 *   - "mirror_mount"  — Stage D, collapses mirror_mount + mirror
 *   - …
 *
 * Once every componentType uses the binding path, the gate goes away
 * (along with ``Component.asset_3d_id`` — Stage G).
 */


// Empty by default — every componentType currently goes through the
// legacy ``loadAssetObject`` path. Adding "isolator" here is the
// switch-flip for Stage A''; the visual diff between the bespoke
// pbsOverlay path and the binding-tree path is the test that the
// migration succeeded.
export const RENDER_VIA_BINDINGS: ReadonlySet<string> = new Set<string>([
  // "isolator",
  // "mirror_mount",
]);


/** Returns true when ``componentType``'s render path should walk the
 *  ComponentBinding tree (via ``buildBindingTreeObject``) instead of
 *  the legacy ``loadAssetObject`` single-asset path. */
export function shouldRenderViaBindings(componentType: string): boolean {
  return RENDER_VIA_BINDINGS.has(componentType);
}
