/**
 * The LOD container's swap / cache / dispose contract.
 *
 * The two behaviours worth pinning are the ones that silently corrupt the
 * scene if they regress: a container must hold exactly ONE child (a second
 * attached tier would produce ghost raycast hits, which is the whole reason
 * this is not `THREE.LOD`), and every tier it ever built must be freed —
 * detached cache entries are unreachable by traversal, so a naive
 * `disposeObject` leaks them.
 */

import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

import type { AssetLod } from "../../../types/digitalTwin";
import { createLodNode, disposeLodNode, lodStateOf, setLodLevel } from "../lodNode";

function tier(level: number, errorMm: number): AssetLod {
  return { level, filePath: `x.lod${level}.glb`, triCount: 100, byteSize: 100, errorMm };
}

const TIERS = [tier(0, 0), tier(1, 0.4), tier(2, 1.8)];

/** A tier subtree with one disposable mesh, so disposal is observable. */
function fakeTier(level: number): THREE.Object3D {
  const group = new THREE.Group();
  group.name = `tier${level}`;
  group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
  return group;
}

describe("lod node", () => {
  it("attaches exactly one tier and swaps it in place", async () => {
    const node = createLodNode("asset-1", TIERS, async (l) => fakeTier(l));
    await setLodLevel(node, 2);
    expect(node.children).toHaveLength(1);
    expect(node.children[0].name).toBe("tier2");

    await setLodLevel(node, 0);
    expect(node.children).toHaveLength(1);
    expect(node.children[0].name).toBe("tier0");
    expect(lodStateOf(node)!.level).toBe(0);
  });

  it("builds each level once and reuses it on return", async () => {
    const build = vi.fn(async (l: number) => fakeTier(l));
    const node = createLodNode("asset-1", TIERS, build);

    await setLodLevel(node, 2);
    await setLodLevel(node, 0);
    await setLodLevel(node, 2); // back again — must come from the cache
    expect(build).toHaveBeenCalledTimes(2);
    expect(node.children[0].name).toBe("tier2");
  });

  it("is a no-op for the level already attached", async () => {
    const build = vi.fn(async (l: number) => fakeTier(l));
    const node = createLodNode("asset-1", TIERS, build);
    await setLodLevel(node, 1);
    await setLodLevel(node, 1);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("refreshes the cached bounds on every swap", async () => {
    const node = createLodNode("asset-1", TIERS, async (l) => {
      const g = new THREE.Group();
      // Level 2's mesh is deliberately larger, so a stale box is detectable.
      const size = l === 2 ? 10 : 1;
      g.add(new THREE.Mesh(new THREE.BoxGeometry(size, size, size)));
      return g;
    });
    await setLodLevel(node, 0);
    const small = lodStateOf(node)!.localBounds!.getSize(new THREE.Vector3()).x;
    await setLodLevel(node, 2);
    const large = lodStateOf(node)!.localBounds!.getSize(new THREE.Vector3()).x;
    expect(small).toBeCloseTo(1);
    expect(large).toBeCloseTo(10);
  });

  it("keeps the current tier when a build fails", async () => {
    const node = createLodNode("asset-1", TIERS, async (l) => {
      if (l === 1) throw new Error("404");
      return fakeTier(l);
    });
    await setLodLevel(node, 2);
    await setLodLevel(node, 1);
    expect(node.children).toHaveLength(1);
    expect(node.children[0].name).toBe("tier2");
    expect(lodStateOf(node)!.level).toBe(2);
  });

  it("discards a load that was superseded while in flight", async () => {
    // Level 1 resolves late; a level-0 request lands first and must win.
    let releaseSlow: (() => void) | null = null;
    const node = createLodNode("asset-1", TIERS, async (l) => {
      if (l === 1) {
        await new Promise<void>((resolve) => { releaseSlow = resolve; });
      }
      return fakeTier(l);
    });

    const slow = setLodLevel(node, 1);
    // Supersede: clearing `loading` is what marks the in-flight build stale.
    lodStateOf(node)!.loading = null;
    await setLodLevel(node, 0);
    releaseSlow!();
    await slow;

    expect(node.children).toHaveLength(1);
    expect(node.children[0].name).toBe("tier0");
  });

  it("frees detached cached tiers, which traversal cannot reach", async () => {
    const node = createLodNode("asset-1", TIERS, async (l) => fakeTier(l));
    await setLodLevel(node, 2);
    const cachedMesh = node.children[0].children[0] as THREE.Mesh;
    const disposeSpy = vi.spyOn(cachedMesh.geometry, "dispose");

    await setLodLevel(node, 0); // tier2 is now detached but still cached
    expect(node.children[0].name).toBe("tier0");
    expect(disposeSpy).not.toHaveBeenCalled();

    disposeLodNode(node);
    expect(disposeSpy).toHaveBeenCalled();
  });

  it("ignores requests once disposed", async () => {
    const build = vi.fn(async (l: number) => fakeTier(l));
    const node = createLodNode("asset-1", TIERS, build);
    await setLodLevel(node, 2);
    disposeLodNode(node);
    await setLodLevel(node, 0);
    expect(build).toHaveBeenCalledTimes(1);
  });
});
