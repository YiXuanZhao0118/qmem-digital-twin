/** Which SceneObjects belong to the OPTICAL domain.
 *
 *  Domain is asset-kind authoritative (see docs/introduce/kinds.md): the
 *  element kind on the object's PhysicsElement decides first, the component's
 *  kindId is the fallback for objects with no physics row, and a composite
 *  optic (kindId "none", no PhysicsElement — e.g. the IO-3-850-HP isolator)
 *  is resolved from the kinds of the assets its ComponentBindings bind.
 *
 *  Shared by the optical-link viewer chrome (which lists every optic in its
 *  inspector) and the main viewer (which keeps optics at full strength and
 *  ghosts everything else in `optical-link` display mode) so the two can never
 *  disagree about what counts as an optic.
 */
import type {
  Asset3D,
  ComponentBinding,
  ComponentItem,
  PhysicsElement,
  SceneObject,
} from "../types/digitalTwin";
import { domainForElementKind, kindIdToElementKind } from "./elementDefaults";

export function opticalObjectIdSet(scene: {
  objects: readonly SceneObject[];
  components: readonly ComponentItem[];
  physicsElements: readonly PhysicsElement[];
  componentBindings?: readonly ComponentBinding[] | null;
  assets: readonly Asset3D[];
}): Set<string> {
  const compById = new Map(scene.components.map((c) => [c.id, c]));
  const ekByObjectId = new Map(scene.physicsElements.map((e) => [e.objectId, e.elementKind]));
  const assetById = new Map(scene.assets.map((a) => [a.id, a]));
  const bindings = scene.componentBindings ?? [];
  const out = new Set<string>();
  for (const o of scene.objects) {
    // Element kind is authoritative on the PhysicsElement; fall back to the
    // component's kindId only for objects with no physics row. Keying off the
    // component alone dropped LASER_SOURCE0 — its component is typed `none`,
    // so its real `laser_source` kind lives only on the PE.
    const ek = ekByObjectId.get(o.id) || kindIdToElementKind(compById.get(o.componentId)?.kindId);
    if (ek) {
      if (domainForElementKind(ek) === "optical") out.add(o.id);
      continue;
    }
    const opticalByBinding = bindings.some((b) => {
      if (b.componentId !== o.componentId || b.targetKind !== "asset" || !b.asset3dId) return false;
      const aek = assetById.get(b.asset3dId)?.kindId
        ? kindIdToElementKind(assetById.get(b.asset3dId)!.kindId)
        : null;
      return aek != null && domainForElementKind(aek) === "optical";
    });
    if (opticalByBinding) out.add(o.id);
  }
  return out;
}
