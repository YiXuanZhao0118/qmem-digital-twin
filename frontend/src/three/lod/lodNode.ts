/**
 * The LOD container node — a Group holding exactly ONE tier subtree at a time.
 *
 * Why not `THREE.LOD`: its `raycast()` correctly tests only the active level,
 * but picking in DigitalTwinViewer goes through
 * `raycaster.intersectObjects(componentGroup.children, true)`, and that
 * recursion descends into `LOD.children` — every level — because `Raycaster`
 * does not test `visible`. Selection, hover and snap would all pick up ghost
 * hits from tiers that are not on screen. Attaching one child sidesteps the
 * whole class of problem, and additionally lets a future LOD2 be a
 * material-merged subtree rather than a per-mesh geometry swap.
 *
 * Tier subtrees this node has already built are kept, detached, in
 * `userData.lodCache` so orbiting back and forth does not re-parse a 20 MB GLB
 * on the main thread (that would be a guaranteed frame spike, R-1/R-3).
 * Nothing is shared across instances: each container owns its geometry, so
 * `disposeObject` stays correct — it only has to be taught to also free the
 * detached cache, which it is (`loadAsset/index.ts`).
 *
 * Selection rule and the switching metric live in `lodPolicy.ts`; see
 * docs/introduce/rendering.md §LOD.
 */

import * as THREE from "three";

import type { AssetLod } from "../../types/digitalTwin";

export interface LodNodeState {
  assetId: string;
  /** Manifest as delivered by the API, ordered by level. */
  tiers: AssetLod[];
  /** Builds a tier's subtree. Carried on the node so the per-frame evaluator
   *  can request a level without knowing anything about file resolution or
   *  material treatment — that stays the loader's business. */
  build: TierBuilder;
  /** The level currently attached. */
  level: number;
  /** Local-space bounds of the attached tier, for the distance test. Cached
   *  because `Box3.setFromObject` walks all geometry, which is far too
   *  expensive to repeat per evaluation; refreshed on every swap. */
  localBounds: THREE.Box3 | null;
  /** Level being fetched right now, if any — prevents duplicate requests and
   *  lets a late arrival notice it has been superseded. */
  loading: number | null;
  /** Detached, already-built tiers, keyed by level. */
  cache: Map<number, THREE.Object3D>;
  /** Set when the node is disposed so an in-flight load discards its result
   *  instead of attaching to a detached container. */
  disposed: boolean;
}

const LOD_STATE_KEY = "lod";

/** Build tier `level`'s subtree. Supplied by the loader, which owns file
 *  resolution and the per-tier post-processing (materials, shadow flags). */
export type TierBuilder = (level: number) => Promise<THREE.Object3D>;

export function createLodNode(
  assetId: string,
  tiers: AssetLod[],
  build: TierBuilder,
): THREE.Group {
  const group = new THREE.Group();
  group.name = "lod";
  const state: LodNodeState = {
    assetId,
    tiers: [...tiers].sort((a, b) => a.level - b.level),
    build,
    level: -1,
    localBounds: null,
    loading: null,
    cache: new Map(),
    disposed: false,
  };
  group.userData[LOD_STATE_KEY] = state;
  return group;
}

export function lodStateOf(object: THREE.Object3D): LodNodeState | null {
  const state = object.userData?.[LOD_STATE_KEY];
  return state && typeof state === "object" ? (state as LodNodeState) : null;
}

/** Every level the asset actually has a tier for, coarsest last. */
export function availableLevels(state: LodNodeState): number[] {
  return state.tiers.map((t) => t.level).sort((a, b) => a - b);
}

/**
 * Attach tier `level`, building it if this node has not seen it before.
 *
 * Resolves once the level is attached, or immediately when it already is /
 * is already being fetched. Safe to call every frame — the guards make a
 * repeat call for the current or in-flight level free.
 *
 * The previous tier is detached but NOT disposed: it goes back into the cache
 * so returning to it is instant. Everything is freed together by
 * `disposeLodNode`.
 */
export async function setLodLevel(node: THREE.Object3D, level: number): Promise<void> {
  const state = lodStateOf(node);
  if (!state || state.disposed) return;
  if (state.level === level || state.loading === level) return;

  const cached = state.cache.get(level);
  if (cached) {
    swapChild(node, state, level, cached);
    return;
  }

  state.loading = level;
  let built: THREE.Object3D;
  try {
    built = await state.build(level);
  } catch (err) {
    // A missing or corrupt tier file must not blank the object — keep
    // whatever is attached and let the next evaluation try another level.
    console.error(`[lod] tier ${level} failed for asset ${state.assetId}`, err);
    if (state.loading === level) state.loading = null;
    return;
  }
  if (state.loading !== level || state.disposed) {
    // Superseded while loading (or the node went away): drop the result
    // rather than attach geometry nobody asked for any more.
    disposeSubtree(built);
    return;
  }
  state.loading = null;
  state.cache.set(level, built);
  swapChild(node, state, level, built);
}

function swapChild(
  node: THREE.Object3D,
  state: LodNodeState,
  level: number,
  child: THREE.Object3D,
): void {
  for (const existing of [...node.children]) node.remove(existing);
  node.add(child);
  state.level = level;
  // Tiers are decimations of one mesh, so their bounds agree to within
  // `errorMm` — but recompute anyway rather than assume, since it only
  // happens on a swap.
  state.localBounds = new THREE.Box3().setFromObject(child);
}

/** Free every tier this node ever built, attached or cached. Called by
 *  `disposeObject`, which cannot reach the detached ones by traversal. */
export function disposeLodNode(node: THREE.Object3D): void {
  const state = lodStateOf(node);
  if (!state) return;
  state.disposed = true;
  for (const [, subtree] of state.cache) disposeSubtree(subtree);
  state.cache.clear();
}

function disposeSubtree(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else if (material) material.dispose();
  });
}
