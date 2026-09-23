/**
 * A per-instance asset swap must be DRAWN, not only traced.
 *
 * `ObjectBinding.asset3dIdOverride` replaces one ComponentBinding's target
 * asset for one placed object. The tracer's loader resolves it
 * (`effectiveBindingAssetId`), and so do the anchor-pose walk
 * (`anchorPose.resolveAnchorPosesLab`) and every align path — but
 * `bindingRendererGate` called `resolveBindingTree` without
 * `honourAssetOverride`, so the renderer kept drawing the catalog part. A
 * swapped instance looked unswapped while it traced, aligned and posed as the
 * swapped one: the mesh and the beam describe different hardware, which is the
 * one thing a digital twin must not do.
 *
 * No live object carries an override today, which is exactly why this needs a
 * built case rather than a bench check. The STL loader is mocked and records
 * every URL it is asked for, so the assertion is on WHICH asset's mesh was
 * fetched — the only thing that distinguishes the two outcomes.
 */

import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

// `vi.hoisted` because `vi.mock`'s factory is hoisted above the module body:
// a plain `const` here is still in its temporal dead zone when an unrelated
// module (the fibre FC housing) loads an STL at import time.
const loaded = vi.hoisted(() => ({ urls: [] as string[] }));

vi.mock("three/examples/jsm/loaders/STLLoader.js", () => {
  return {
    STLLoader: class {
      async loadAsync(url: string): Promise<THREE.BufferGeometry> {
        loaded.urls.push(url);
        const three = await import("three");
        return new three.BoxGeometry(1, 1, 1);
      }
    },
  };
});

import { buildSceneObjectFromBindings } from "../bindingRendererGate";
import type {
  Asset3D,
  ComponentBinding,
  ComponentItem,
  ObjectBinding,
  SceneData,
  SceneObject,
} from "../../types/digitalTwin";

const CATALOG_ASSET = {
  id: "asset_catalog",
  name: "catalog mirror",
  filePath: "files/stl/catalog_mirror.stl",
  unit: "mm",
  scaleFactor: 1,
  properties: {},
} as unknown as Asset3D;

/** What this ONE instance is actually wearing. */
const SWAPPED_ASSET = {
  id: "asset_swapped",
  name: "swapped mirror",
  filePath: "files/stl/swapped_mirror.stl",
  unit: "mm",
  scaleFactor: 1,
  properties: {},
} as unknown as Asset3D;

const COMPONENT = {
  id: "comp1",
  name: "comp1",
  kindId: "none",
  properties: {},
} as unknown as ComponentItem;

const ROOT_BINDING = {
  id: "b1",
  componentId: "comp1",
  parentBindingId: null,
  targetKind: "asset",
  asset3dId: "asset_catalog",
  subComponentId: null,
  localXMm: 0,
  localYMm: 0,
  localZMm: 0,
  localRxDeg: 0,
  localRyDeg: 0,
  localRzDeg: 0,
  tunableAxes: {},
  properties: {},
} as unknown as ComponentBinding;

const OBJECT = { id: "obj1", componentId: "comp1", properties: {} } as unknown as SceneObject;

/** The swap itself. Deltas are all zero: this changes WHICH asset, not where. */
const OVERRIDE = {
  id: "ob1",
  objectId: "obj1",
  componentBindingId: "b1",
  asset3dIdOverride: "asset_swapped",
  localXMmDelta: 0,
  localYMmDelta: 0,
  localZMmDelta: 0,
  localRxDegDelta: 0,
  localRyDegDelta: 0,
  localRzDegDelta: 0,
} as unknown as ObjectBinding;

function scene(objectBindings: ObjectBinding[]): Pick<
  SceneData,
  "componentBindings" | "objectBindings" | "assets" | "components"
> {
  return {
    componentBindings: [ROOT_BINDING],
    objectBindings,
    assets: [CATALOG_ASSET, SWAPPED_ASSET],
    components: [COMPONENT],
  } as unknown as Pick<
    SceneData,
    "componentBindings" | "objectBindings" | "assets" | "components"
  >;
}

/** The asset file paths the renderer actually asked the loader for. */
async function render(
  sceneObject: SceneObject | null,
  objectBindings: ObjectBinding[],
): Promise<string[]> {
  loaded.urls.length = 0;
  await buildSceneObjectFromBindings(COMPONENT, sceneObject, scene(objectBindings));
  return loaded.urls.map((u) => u.split("?")[0]);
}

describe("buildSceneObjectFromBindings honours asset3dIdOverride", () => {
  it("draws the overridden asset for the instance that carries the swap", async () => {
    const drawn = await render(OBJECT, [OVERRIDE]);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]).toContain(SWAPPED_ASSET.filePath);
    expect(drawn[0]).not.toContain(CATALOG_ASSET.filePath);
  });

  it("draws the catalog asset when the instance has no override", async () => {
    const drawn = await render(OBJECT, []);
    expect(drawn[0]).toContain(CATALOG_ASSET.filePath);
  });

  it("draws the catalog asset for an override belonging to another object", async () => {
    // Overrides are filtered by sceneObject.id inside resolveBindingTree;
    // honouring them must not start leaking one instance's swap into another.
    const other = { ...OVERRIDE, id: "ob2", objectId: "obj2" } as unknown as ObjectBinding;
    const drawn = await render(OBJECT, [other]);
    expect(drawn[0]).toContain(CATALOG_ASSET.filePath);
  });

  it("draws the catalog asset for a catalog-time preview (no instance)", async () => {
    // sceneObject = null is the PHY Editor's COMPONENT preview: there is no
    // instance, so there is nothing to swap.
    const drawn = await render(null, [OVERRIDE]);
    expect(drawn[0]).toContain(CATALOG_ASSET.filePath);
  });
});
