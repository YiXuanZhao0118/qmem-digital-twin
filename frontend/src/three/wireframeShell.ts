import * as THREE from "three";

/** Wireframe display mode hangs a child Mesh tagged `userData.isWireShell`
 *  off every body to draw its lines, and that shell SHARES the parent's
 *  geometry (see `DigitalTwinViewer.makeWireframeShell`).
 *
 *  So any code that REPLACES a mesh's geometry has to repoint the shell as
 *  well, or the shell keeps drawing — and holding — the geometry that was
 *  just disposed. The live case is the fiber / rf_cable tube: reshaping the
 *  spline rebuilds its `TubeGeometry` on every drag frame, which would
 *  otherwise freeze the cable's wireframe at the previous path. */
export function syncWireframeShellGeometry(mesh: THREE.Mesh): void {
  for (const child of mesh.children) {
    if (child.userData?.isWireShell) (child as THREE.Mesh).geometry = mesh.geometry;
  }
}
