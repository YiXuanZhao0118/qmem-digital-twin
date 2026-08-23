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
import * as THREE from "three";

import type {
  Asset3D,
  ComponentBinding,
  ComponentItem,
  SceneData,
  SceneObject,
} from "../types/digitalTwin";
import {
  deriveCablePropsFromConnectorBindings,
  resolveBindingTree,
} from "../utils/componentBindings";
import { ANNOTATION_KIND_IDS, effectiveInstanceParams } from "../utils/instanceParams";
import { loadAssetObject } from "./loadAsset";
import { buildBindingTreeObject } from "./bindingTreeObject";
import type { FiberNode } from "./loadAsset/fiber/types";
import {
  resolveFiberEndKindParams,
  syncFiberNodesFromKindParams,
} from "../utils/fiberAnchorResolver";
import { GLAN_POLARIZER_PRISM_FILEPATH } from "./loadAsset/procedural/glan_polarizer_prism";


/** Unified render path (2026-06-10): EVERY Component now renders via the
 *  ComponentBinding tree (``buildSceneObjectFromBindings``). The legacy
 *  single-asset ``loadAssetObject`` dispatch is retired, so this gate is a
 *  constant ``true`` — kept (rather than deleted) so the call sites compile
 *  unchanged while the legacy branch is removed in a follow-up.
 *
 *  Deferred: per-instance fiber / rf_cable / isolator state
 *  (fiberNodes / rfCableNodes / radiusMm / ferrule poses / translucentHousing)
 *  is NOT yet forwarded through the binding-tree walk, so those kinds may
 *  render with catalog-default spline/pose until that forwarding lands.
 */
export function shouldRenderViaBindings(
  _componentType: string,
  _componentId: string,
  _scene: Pick<SceneData, "componentBindings">,
): boolean {
  return true;
}


/** Build the renderable Object3D for a SceneObject by walking its
 *  Component's ComponentBinding tree. Replacement for the legacy
 *  ``loadAssetObject(component, asset, ...)`` single-asset call when
 *  the componentType is allowlisted.
 *
 *  Loader semantics inside the walk:
 *    * ``target.kind === "asset"``        → delegate to ``loadAssetObject``
 *      with the resolved asset. The walker stacks the binding's local
 *      transform on top of whatever wrapper the per-kind loader returns.
 *    * ``target.kind === "subcomponent"`` → emit an empty Group at the
 *      binding's local transform. The walker recurses into the
 *      splice'd sub-Component bindings as children of that empty
 *      Group — no geometry of its own, just a transform parent.
 *    * ``target.kind === "missing"``      → skip the subtree (the data
 *      layer chose to surface this as a soft-fail).
 *
 *  Returns a Group regardless of tree shape so the caller's
 *  ``wrapper.add(...)`` + ``applyObjectGeometryOffset(wrapper, placement)``
 *  pattern stays uniform with the legacy path.
 */
export async function buildSceneObjectFromBindings(
  component: ComponentItem,
  sceneObject: SceneObject | null,
  scene: Pick<SceneData, "componentBindings" | "objectBindings" | "assets" | "components">
    & { physicsElements?: SceneData["physicsElements"] },
  /** Opt in to distance-switched LOD (objectives.md §R-5). Only the live
   *  scene renderer should — see the ``enableLod`` note on ``loadAssetObject``
   *  for why this is opt-in rather than opt-out. */
  options?: { enableLod?: boolean },
): Promise<THREE.Object3D> {
  // Cables (fiber / rf_cable) render procedurally via their kindId spline
  // branch in loadAssetObject — NOT by walking binding nodes, which would
  // re-render the whole spline once per connector-asset node. Derive the two
  // end connectors from the connector-asset bindings, inject them into the
  // spline's properties, and render the spline ONCE. Per-instance spline
  // state (fiberNodes / rfCableNodes / radiusMm) forwards from the
  // SceneObject here too.
  if (component.kindId === "fiber" || component.kindId === "rf_cable") {
    const derived = deriveCablePropsFromConnectorBindings(component, scene);
    const loaderComponent = derived
      ? { ...component, properties: { ...(component.properties ?? {}), ...derived } }
      : component;
    let objectProps = sceneObject?.properties as unknown as Parameters<
      typeof loadAssetObject
    >[3];

    // A fibre whose spline was never cached must still be drawn where its
    // ENDPOINTS are (2026-08-21).
    //
    // `createFiberSplineObject` reads only `SceneObject.properties.fiberNodes`
    // then `Component.properties.fiberNodes`; with neither it falls back to a
    // hard-coded 0→300 mm straight run. But a freshly instantiated fibre has
    // its endpoints ONLY in the fibre PhysicsElement's `kindParams.endA/endB`
    // (what Align End A/B writes, and what the backend's `_synth_fiber_slot`
    // traces) — nothing writes `properties.fiberNodes` until someone edits a
    // node. So the cable rendered a metre away from where it actually was,
    // while the COMPONENT preview looked right because it deliberately draws
    // the catalog shape. Rebuild from the PE, mirroring the precedence in
    // `sceneStore.resolveEffectiveFiberNodes` (which every fibre-endpoint
    // EDITOR already goes through — this is the render path catching up).
    // Called through `utils/fiberAnchorResolver` rather than the store to
    // keep `three/` from importing `store/`, which would close a cycle
    // (`sceneStore` → `three/photoRoom`).
    if (component.kindId === "fiber" && sceneObject) {
      const cached = (objectProps as { fiberNodes?: unknown } | undefined)?.fiberNodes;
      const catalogCached = (component.properties as { fiberNodes?: unknown } | undefined)
        ?.fiberNodes;
      const usable = (v: unknown) => Array.isArray(v) && v.length >= 2;
      if (!usable(cached) && !usable(catalogCached)) {
        const pe = (scene.physicsElements ?? []).find(
          (e) => e.objectId === sceneObject.id && e.elementKind === "fiber",
        );
        const { endA, endB } = resolveFiberEndKindParams(pe);
        if (endA || endB) {
          const nodes = syncFiberNodesFromKindParams(endA, endB, undefined);
          if (usable(nodes)) {
            objectProps = {
              ...((objectProps ?? {}) as Record<string, unknown>),
              fiberNodes: nodes,
            } as typeof objectProps;
          }
        }
      }
    }

    const content = await loadAssetObject(
      loaderComponent,
      undefined,
      undefined,
      objectProps,
      null,
      null,
    );
    const group = new THREE.Group();
    group.add(content);
    group.name = component.name;
    return group;
  }

  const tree = resolveBindingTree(component, sceneObject, scene);
  // Per-instance binding-override deltas are applied INSIDE
  // resolveBindingTree (via _effectiveTransform), which reads them off
  // ``scene.objectBindings`` filtered by ``sceneObject.id``. Callers
  // MUST pass objectBindings to get per-instance pose adjustments
  // (e.g. the isolator's front/back glan-laser rotation slider) —
  // omitting it freezes the asset at its catalog default pose.
  //
  // Per-instance rendering hints (e.g. ``translucentHousing``) live on
  // the SceneObject's properties and forward through every asset load
  // in this tree so body + piece sub-meshes flip together. Generic
  // channel — add a new key to the type when a new hint shows up.
  const renderHints = sceneObject
    ? {
        translucentHousing: (sceneObject.properties as { translucentHousing?: unknown } | undefined)?.translucentHousing === true,
      }
    : null;
  // Per-instance pigtail shapes (see bindingTreeObject.buildBindingPigtail).
  // The binding row is the catalog baseline; how THIS instance's fibre is
  // dressed lives on the SceneObject, keyed by binding id.
  const instancePigtails = (sceneObject?.properties as {
    bindingFiberNodes?: Record<string, unknown>;
  } | undefined)?.bindingFiberNodes;
  const pigtailNodesFor = (bindingId: string) => {
    const v = instancePigtails?.[bindingId];
    return Array.isArray(v) && v.length >= 2 ? (v as FiberNode[]) : undefined;
  };

  const content = await buildBindingTreeObject(tree, async (node) => {
    if (node.target.kind === "missing") return null;
    if (node.target.kind === "subcomponent" || node.target.kind === "empty") {
      // subcomponent: logical container that recurses into the
      // sub-Component's own root bindings (resolveBindingTree splices
      // them in as children).
      // empty: explicit transform-only node — the user's "PBS Mount"
      // case in the 5-part isolator decomposition. Carries
      // localTransform + tunable_axes, no geometry of its own.
      // Both render as an empty Group that the walker hangs children
      // under, so the parent transform propagates through.
      return new THREE.Group();
    }
    // Asset node — load via the existing per-kind / per-asset loader.
    // ``component`` (the parent Component being rendered) is passed for
    // material + anchor-resolution context; this matches how the
    // legacy single-asset path called loadAssetObject before binding
    // trees existed. Per-instance fiber / rf_cable spline + ferrule
    // state is intentionally NOT forwarded — those are only meaningful
    // for the legacy single-asset path and a composite Component
    // (isolator, mirror_mount, …) never has fiber-style per-instance
    // state on its root.
    // Annotations (rect_annotation / text_annotation) are pure params: the
    // Component is ONE shared catalog row, so everything that makes THIS label
    // look the way it does lives in asset.defaultParams merged with the
    // object's dynamicSources (alembic 0125). Hand the renderer that merge
    // through the same synthetic-component channel the glan prism uses below —
    // plugin renderers only ever see a ComponentItem.
    if (ANNOTATION_KIND_IDS.has(component.kindId ?? "")) {
      const annotated: ComponentItem = {
        ...component,
        properties: effectiveInstanceParams(node.target.asset, sceneObject),
      };
      return loadAssetObject(annotated, node.target.asset, undefined, null, null, {
        skipAutoCenter: true,
        enableLod: options?.enableLod === true,
      });
    }
    const loaderComponent = node.target.asset.filePath === GLAN_POLARIZER_PRISM_FILEPATH
      ? ({
          id: `binding-${node.target.asset.id}`,
          name: node.target.asset.name ?? "glan",
          kindId: node.target.asset.kindId ?? "glan_polarizer",
          properties: {
            ...(node.target.asset.defaultParams ?? {}),
            ...(node.target.asset.properties ?? {}),
          },
          physicsCapabilities: ["optical"],
        } as ComponentItem)
      : component;
    return loadAssetObject(loaderComponent, node.target.asset, undefined, null, null, {
      translucentHousing: renderHints?.translucentHousing,
      skipAutoCenter: true,
      enableLod: options?.enableLod === true,
    });
  }, pigtailNodesFor);
  // CAD→three basis swap for the whole assembled tree.
  //
  // bindingTreeObject assembles in the component's CAD frame (Z-up, raw
  // mm/100 — see its "Frame contract"). Legacy single-asset meshes have
  // the Blender→glTF Z-up→Y-up swap baked into their vertices, and the
  // backend beam is converted with labMmToThree (which swaps); the
  // binding tree's STEP→STL sub-assets carry no such bake. Without a
  // swap here the assembly sits 90° (Z↔Y) off from its own beam and
  // from every legacy asset — the IO-3-850-HP bore rendered
  // perpendicular to its beam. Apply the swap (Rx(-90°), the rotational
  // half of labMmToThree) ONCE to the rigid assembly — NEVER per-binding,
  // which scatters the pieces (see bindingTreeObject.ts ⚠). It composes
  // exactly with the wrapper's sceneObjectToQuaternion (= S·R_obj·S⁻¹):
  // quat·S = S·R_obj, so a body-local point lands where the backend beam
  // (labMmToThree) puts it, for any object pose. The caller still applies
  // applyObjectGeometryOffset (origin nudge, three frame) to this Group.
  const group = new THREE.Group();
  group.add(content);
  group.name = component.name;
  return group;
}


// Re-export ComponentBinding-related helpers so callers only need one
// import to opt in. Wildcards intentionally avoided to keep the
// public surface explicit.
export type {
  Asset3D,
  ComponentBinding,
  SceneObject,
};
