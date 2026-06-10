/**
 * Bake a procedural / primitive asset (no mesh file on disk) into editable
 * sub-meshes for the Geometry Builder. Kept separate from `loadAssetGeometry`
 * (the pure file loader) because this path imports `loadAssetObject` — and
 * therefore the whole loadAsset/ render tree — which the file loader must stay
 * free of so it can be reused inside that tree (e.g. rf_cable connector models)
 * without an import cycle.
 */

import { loadAssetObject } from "./loadAsset";
import { collectSubMeshes, type LoadedSubMesh } from "./loadAssetGeometry";
import { MM_PER_THREE_UNIT } from "../optical/frames";
import type { Asset3D, ComponentItem } from "../types/digitalTwin";

/** Bake a procedural / primitive asset (e.g. the ZYSWA RF switch at
 *  `primitive://…`, or `procedural://isolator_body`) into editable sub-meshes.
 *  The procedural builders emit geometry in three-units (1 unit =
 *  MM_PER_THREE_UNIT mm); the builder works in mm, so the Object3D is scaled up
 *  before its meshes are flattened. Saving the result overwrites the asset's
 *  file_path with the baked GLB — the asset stops being procedural (its
 *  defaultParams no longer drive geometry). */
export async function loadProceduralAssetGeometry(asset: Asset3D): Promise<LoadedSubMesh[]> {
  const component: ComponentItem = {
    id: asset.catalogId ?? asset.id,
    name: asset.name || asset.catalogId || asset.id,
    kindId: asset.kindId ?? null,
    properties: { ...(asset.defaultParams ?? {}) },
    physicsCapabilities: [],
  };
  const object = await loadAssetObject(component, asset, undefined);
  object.scale.multiplyScalar(MM_PER_THREE_UNIT); // three-units → mm (builder works in mm)
  const subs = collectSubMeshes(object);
  if (subs.length === 0) throw new Error("Procedural asset produced no renderable meshes.");
  return subs;
}
