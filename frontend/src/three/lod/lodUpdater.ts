/**
 * Per-frame LOD evaluation — walks the rendered scene, decides each LOD node's
 * tier by the screen-space-error rule, and requests the swap.
 *
 * Called from `DigitalTwinViewer`'s on-demand `animate()` loop *after*
 * `renderer.render`, so every `matrixWorld` is current (evaluating before the
 * render would use last frame's transforms, and would be plain wrong on the
 * first pass after a scene rebuild, when they are still identity).
 *
 * Two budgets keep this off the frame time: the whole pass runs at most every
 * `LOD_EVAL_INTERVAL_MS`, and at most `MAX_SWAPS_PER_PASS` tiers may start
 * loading in one pass. Neither caps correctness — an object that misses its
 * turn simply switches on a later pass.
 *
 * Rule and thresholds: `lodPolicy.ts` / docs/objectives.md §R-5.
 */

import * as THREE from "three";

import { lodStateOf, setLodLevel } from "./lodNode";
import { MM_PER_WORLD_UNIT, chooseLodLevel } from "./lodPolicy";

/** Minimum wall-clock gap between passes. Camera motion is continuous but
 *  tier changes are not; 10 Hz is far finer than the eye needs for a pop. */
export const LOD_EVAL_INTERVAL_MS = 100;

/** How many tier loads may be *started* in one pass. A scene-wide camera jump
 *  would otherwise kick off dozens of GLB parses in the same frame. */
export const MAX_SWAPS_PER_PASS = 2;

const _box = new THREE.Box3();
const _cameraPos = new THREE.Vector3();

export interface LodUpdateOptions {
  /** Object ids that must render at full detail regardless of distance —
   *  the current selection. Quadric error under-reports the loss of thin
   *  features, so whatever the user is actually looking at stays exact. */
  pinnedObjectIds?: ReadonlySet<string>;
  /** Called once a requested tier is actually attached. The viewer renders
   *  on demand, so without this the swapped geometry would not be painted
   *  until the next unrelated redraw. */
  onSwapApplied?: () => void;
  /** Test seam for the interval throttle. */
  nowMs?: number;
}

interface UpdaterState {
  lastPassMs: number;
}

export function createLodUpdaterState(): UpdaterState {
  return { lastPassMs: Number.NEGATIVE_INFINITY };
}

/**
 * Evaluate every LOD node under `root`. Returns the number of tier swaps
 * requested (0 when the pass was throttled out), which the caller can use to
 * schedule another render once the geometry actually lands.
 */
export function updateSceneLod(
  state: UpdaterState,
  root: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  viewportHeightPx: number,
  options: LodUpdateOptions = {},
): number {
  const now = options.nowMs ?? performance.now();
  if (now - state.lastPassMs < LOD_EVAL_INTERVAL_MS) return 0;
  state.lastPassMs = now;

  camera.getWorldPosition(_cameraPos);
  const fovRadY = (camera.fov * Math.PI) / 180;
  const pinned = options.pinnedObjectIds;

  let swaps = 0;
  root.traverse((child) => {
    if (swaps >= MAX_SWAPS_PER_PASS) return;
    const lod = lodStateOf(child);
    if (!lod || lod.disposed || !lod.localBounds) return;

    const objectId = child.userData.objectId as string | undefined;
    let target: number;
    if (objectId && pinned?.has(objectId)) {
      target = 0;
    } else {
      // Distance to the AABB *surface*, never the centre: for anything big
      // enough to contain the camera a centre distance collapses toward 0 and
      // would pin the asset at LOD0 forever. Box3.distanceToPoint returns 0
      // when the point is inside, which feeds an infinite pixel error into
      // chooseLodLevel and correctly forces LOD0.
      _box.copy(lod.localBounds).applyMatrix4(child.matrixWorld);
      const distanceMm = _box.distanceToPoint(_cameraPos) * MM_PER_WORLD_UNIT;
      target = chooseLodLevel({
        tiers: lod.tiers,
        distanceMm,
        viewportHeightPx,
        fovRadY,
        currentLevel: lod.level,
      });
    }

    if (target === lod.level || target === lod.loading) return;
    swaps += 1;
    // Fire and forget: the swap lands whenever the tier is ready. Errors are
    // handled inside setLodLevel, which keeps the current tier attached.
    void setLodLevel(child, target).then(() => options.onSwapApplied?.());
  });
  return swaps;
}
