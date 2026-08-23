/**
 * Walk a ResolvedBindingNode tree and build a composite THREE.Object3D.
 *
 * Stage A''' helper — sits between the data-only ``resolveBindingTree``
 * (utils/componentBindings.ts) and the renderer's per-asset loader.
 * The renderer passes a ``BindingLoader`` callback that knows how to
 * load a single asset / sub-component into an Object3D (typically
 * wrapping the existing ``loadAssetObject``); the walker handles the
 * tree traversal + local-transform composition + parent-child wiring.
 *
 * For the 518 components backfilled by alembic 0062 (single root,
 * target_kind="asset", identity transform), this produces a Group with
 * one child at the origin — visually identical to the legacy
 * ``loadAssetObject(component, asset, ...)`` path. Composite bindings
 * (isolator, mirror_mount, …) fan out with each child positioned by
 * its declared local transform.
 *
 * Frame contract
 * --------------
 * Binding's local transform positions a child asset within the PARENT's
 * CAD frame — the SAME frame the loaded meshes live in (loadAssetObject
 * scales STL/procedural geometry to mm/100 but does NOT swap axes). So
 * the binding pose is applied RAW: per-axis /100 scale, no lab→three
 * y↔z swap, XYZ Euler. The SceneObject's pose (applyObjectTransform via
 * sceneObjectToQuaternion) then converts the whole assembled tree from
 * CAD frame to lab/three in one step.
 *
 * ⚠️ Earlier this used ``labMmToThree`` (which y↔z-swaps) + a YXZ Euler
 * "to match sceneObjectToQuaternion". That put binding POSITIONS in
 * three's Y-up frame while the meshes they position stayed in CAD frame
 * → composite pieces scattered onto the wrong axis (IO-3-850-HP glans
 * flew off perpendicular to the housing). Raw composition matches
 * ComponentsEditor's ``poseFromBinding`` (the editor the user tunes
 * against) AND the backend solver's raw binding composition.
 */
import * as THREE from "three";

import { mmToThree } from "../optical/frames";
import type { ResolvedBindingNode } from "../utils/componentBindings";
import { buildFiberCurvePath } from "./loadAsset/fiber/curve";
import type { FiberNode } from "./loadAsset/fiber/types";


/** Jacket colour by fibre type — same table `loadAsset/fiber/spline.ts`
 *  dyes a patch cable with, so a pigtail and the cable it mates to read
 *  as the same material. */
/** Jacket colour by the CONNECTOR's `fiberType` — the same table a patch
 *  cable uses. Exported so the COMPONENT editor's per-port jacket controls
 *  can show the true default behind a `fiberJacketColor` override instead of
 *  keeping a fourth copy of this mapping. */
export const PIGTAIL_JACKET_COLOR: Record<string, string> = {
  single_mode: "#facc15",
  polarization_maintaining: "#1d4ed8",
  multi_mode: "#fb923c",
};
export const PIGTAIL_DEFAULT_RADIUS_MM = 0.9;


/** The PIGTAIL of a fibre-coupled instrument.
 *
 *  A binding may carry its own spline in `binding.properties.fiberNodes`:
 *  the run of fibre from the device body out to the connector that this
 *  binding places. That is what lets ONE Component hold several fibre
 *  runs — a `fiber` patch cable stores a single spline on the Component /
 *  SceneObject, so a two-pigtail part (the EOSpace EOM) has nowhere to
 *  put the second one. Per-binding splines have no such limit.
 *
 *  **Frame**: the nodes are in the frame the binding's local transform is
 *  expressed in — the PARENT's CAD frame — NOT the binding's own local
 *  frame. So the tube is added to the parent group, beside the pivot, and
 *  a node coordinate means the same thing as the binding's `localXMm`.
 *  Node 0 is normally the device's fibre exit and the last node the
 *  connector's `connect_out` (its wire junction).
 *
 *  Optional siblings: `fiberRadiusMm` (jacket radius) and
 *  `fiberJacketColor` (overrides the fibre-type colour).
 *
 *  **The binding's array is the CATALOG baseline.** How a pigtail is
 *  actually dressed on a table is per-instance, so a scene object may
 *  override it (`SceneObject.properties.bindingFiberNodes[bindingId]`,
 *  supplied here by `overrideNodes`) — same layer split, and for the same
 *  reason, as `SceneObject.properties.fiberNodes` overriding
 *  `Component.properties.fiberNodes` for a patch cable. Writing a drag
 *  back to the binding would restyle every instance of the part.
 *
 *  Purely visual — the pigtail is NOT traced. A pigtailed device's
 *  optical port is the connector's `connect_in` at the far end
 *  (`db_scene_loader._port_connector_anchors`), and its datasheet
 *  insertion loss is quoted fibre-to-fibre, i.e. it already contains
 *  both pigtails. Tracing them would double-count.
 */
function buildBindingPigtail(
  node: ResolvedBindingNode,
  overrideNodes?: FiberNode[],
): THREE.Object3D | null {
  const props = (node.binding.properties ?? {}) as {
    fiberNodes?: FiberNode[];
    fiberRadiusMm?: number;
    fiberJacketColor?: string;
  };
  const nodes =
    overrideNodes && overrideNodes.length >= 2 ? overrideNodes : props.fiberNodes;
  if (!Array.isArray(nodes) || nodes.length < 2) return null;

  const radiusMm =
    typeof props.fiberRadiusMm === "number" && props.fiberRadiusMm > 0
      ? props.fiberRadiusMm
      : PIGTAIL_DEFAULT_RADIUS_MM;
  const fiberType =
    node.target.kind === "asset"
      ? String(
          (node.target.asset.defaultParams as { fiberType?: unknown } | undefined)
            ?.fiberType ?? "",
        )
      : "";
  const color =
    props.fiberJacketColor ??
    PIGTAIL_JACKET_COLOR[fiberType] ??
    PIGTAIL_JACKET_COLOR.polarization_maintaining;

  const geometry = new THREE.TubeGeometry(
    buildFiberCurvePath(nodes),
    Math.max(64, (nodes.length - 1) * 32),
    radiusMm / 100,
    12,
    false,
  );
  const tube = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color, metalness: 0.05, roughness: 0.55 }),
  );
  tube.castShadow = true;
  tube.receiveShadow = true;
  tube.name = `${node.binding.id}__pigtail`;
  tube.userData.fiberRole = "pigtail";
  tube.userData.__bindingId = node.binding.id;
  // The node-edit gizmo reads these to build its handles and to know what
  // to commit without re-deriving the resolution above.
  tube.userData.pigtailNodes = nodes;
  tube.userData.pigtailRadiusMm = radiusMm;
  return tube;
}


/** Async callback the renderer supplies to convert one binding node
 *  into a renderable Object3D. Should ignore ``children`` — the walker
 *  handles recursion on its own and wires the result as a child group.
 *  Returning ``null`` skips this node + its subtree (the caller chose
 *  not to render it; missing-target nodes typically fall here). */
export type BindingLoader = (
  node: ResolvedBindingNode,
) => Promise<THREE.Object3D | null>;


/** Build the THREE.Group representing this tree. Returns a Group even
 *  when there are no nodes — keeps the caller's add-to-scene path
 *  uniform. */
export async function buildBindingTreeObject(
  nodes: readonly ResolvedBindingNode[],
  loader: BindingLoader,
  /** Per-instance pigtail overrides, by binding id — see
   *  ``buildBindingPigtail``. Omitted for catalog previews, which should
   *  show the baseline shape. */
  pigtailNodesFor?: (bindingId: string) => FiberNode[] | undefined,
): Promise<THREE.Group> {
  const parent = new THREE.Group();
  for (const node of nodes) {
    const content = await loader(node);
    if (content === null) continue;

    // The binding's own fibre run, if it has one. Added to the PARENT
    // (its nodes are in the parent's frame), not to the pivot.
    const pigtail = buildBindingPigtail(node, pigtailNodesFor?.(node.binding.id));
    if (pigtail !== null) parent.add(pigtail);

    const pivot = new THREE.Group();
    pivot.name = content.name || node.binding.id;
    applyBindingLocalTransform(pivot, node);
    pivot.add(content);

    // Recurse into children — each becomes a sub-group attached to
    // the binding pivot so asset-root corrections do not affect them.
    if (node.children.length > 0) {
      const childGroup = await buildBindingTreeObject(
        node.children, loader, pigtailNodesFor,
      );
      childGroup.userData.__bindingChildrenOf = node.binding.id;
      pivot.add(childGroup);
    }

    pivot.userData.__bindingId = node.binding.id;
    content.userData.__bindingId = node.binding.id;
    parent.add(pivot);
  }
  return parent;
}


/** Apply a binding's effective local transform (post-override) to a
 *  THREE.Object3D, in the parent's CAD frame (no lab→three swap). Per-
 *  axis /100 scale matches the meshes (loadAssetObject's mm/100); the
 *  RAW XYZ Euler matches ComponentsEditor's poseFromBinding so the
 *  Component editor preview and the lab viewer compose pieces
 *  identically. The SceneObject pose converts the assembled tree to
 *  lab/three afterwards. */
export function applyBindingLocalTransform(
  obj: THREE.Object3D,
  node: ResolvedBindingNode,
): void {
  const t = node.localTransform;
  obj.position.set(mmToThree(t.xMm), mmToThree(t.yMm), mmToThree(t.zMm));
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(t.rxDeg),
    THREE.MathUtils.degToRad(t.ryDeg),
    THREE.MathUtils.degToRad(t.rzDeg),
    "XYZ",
  );
  obj.quaternion.setFromEuler(euler);
}
