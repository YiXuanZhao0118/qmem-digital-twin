import * as THREE from "three";

import type { Asset3D, ComponentItem } from "../../../types/digitalTwin";

// Render the AD9959/PCBZ evaluation board STL with a two-zone material split.
// The single STEP→STL export merges the entire board (PCB substrate + chips +
// regulators + SMA jacks + headers) into one triangle soup, so a single
// `materialFor()` call paints everything in the component-type colour
// (#0f3f2a PCB green) — including the SMA flanges, which looks wrong.
//
// We split by triangle-centroid Z (body-local Z-up frame, PCB substrate sits
// at Z ∈ [-1.4, +0.6] mm — verified empirically: 92% of total surface area
// lives in that band). Triangles below the threshold get the PCB green
// material that matches the procedural primitive; everything above gets a
// dark-matte "components-on-board" material so the SMAs / chips / headers no
// longer read as green.
export function isAd9959PcbAsset(asset: Asset3D): boolean {
  return asset.name === "primitive_dds_ad9959_pcb"
    || /ad9959_pcbz\.stl$/i.test(asset.filePath);
}

// PCB substrate top sits near z = 0 in the imported STL frame (gmsh kept
// the corner-anchored Z and we recentred only X/Y in `_finalize_ad9959_stl.py`).
// 0.6 mm clears the silkscreen + solder mask thickness without bleeding into
// surface-mount component bodies whose lowest faces start around z = 1 mm.
const AD9959_PCB_TOP_Z_MM = 0.6;

// SMA gold-zone classifier. The AD9959/PCBZ uses right-angle edge-launch
// SMAs at the ±X edges (CH0–CH3 on +X, REF_CLK on −X). The connector body
// sits within ~8 mm of the board edge and rises 1–12 mm above the PCB
// substrate (hex flange ~9 mm AF, barrel ø ~6 mm, total height ≲ 11 mm).
// Empirical probe of the mesh (`above PCB tris near +X edge: 199 tris in
// Y ∈ [-49, 53]`) confirms the classifier captures the connector bodies
// without bleeding into the centre of the board.
const AD9959_SMA_X_EDGE_BAND_MM = 8.0;
const AD9959_SMA_Z_MIN_MM = 1.0;
const AD9959_SMA_Z_MAX_MM = 12.0;

export function buildAd9959PcbObject(
  geometry: THREE.BufferGeometry,
  component: ComponentItem,
): THREE.Object3D {
  const positionAttr = geometry.attributes.position as THREE.BufferAttribute;
  const oldPositions = positionAttr.array as Float32Array;

  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox!;
  // The mesh is symmetric in X around 0 (re-centred by `_finalize_ad9959_stl.py`);
  // pick the larger absolute edge as the half-width so the classifier is robust
  // even if a future export shifts the centroid by a fraction of a mm.
  const halfX = Math.max(Math.abs(bbox.min.x), Math.abs(bbox.max.x));

  const triangleCount = Math.floor(positionAttr.count / 3);
  const pcbTris: number[] = [];
  const smaTris: number[] = [];
  const componentTris: number[] = [];
  for (let t = 0; t < triangleCount; t += 1) {
    const o = t * 9;
    // Buffer layout per triangle is [x1,y1,z1, x2,y2,z2, x3,y3,z3]. STLLoader
    // loads file coordinates verbatim (mm, body-local frame) — `applyAssetScale`
    // only scales uniformly downstream and doesn't permute axes, so the file's
    // X / Z are still at offsets {0,3,6} and {2,5,8} respectively here.
    const centroidX = (oldPositions[o + 0] + oldPositions[o + 3] + oldPositions[o + 6]) / 3;
    const centroidZ = (oldPositions[o + 2] + oldPositions[o + 5] + oldPositions[o + 8]) / 3;
    if (centroidZ <= AD9959_PCB_TOP_Z_MM) {
      pcbTris.push(t);
    } else if (
      Math.abs(centroidX) > halfX - AD9959_SMA_X_EDGE_BAND_MM
      && centroidZ >= AD9959_SMA_Z_MIN_MM
      && centroidZ <= AD9959_SMA_Z_MAX_MM
    ) {
      smaTris.push(t);
    } else {
      componentTris.push(t);
    }
  }

  const buildSubGeometry = (triangleIndices: number[]): THREE.BufferGeometry => {
    const sub = new THREE.BufferGeometry();
    const buf = new Float32Array(triangleIndices.length * 9);
    for (let i = 0; i < triangleIndices.length; i += 1) {
      const srcOff = triangleIndices[i] * 9;
      const dstOff = i * 9;
      for (let k = 0; k < 9; k += 1) buf[dstOff + k] = oldPositions[srcOff + k];
    }
    sub.setAttribute("position", new THREE.BufferAttribute(buf, 3));
    sub.computeVertexNormals();
    return sub;
  };

  const pcbMat = new THREE.MeshStandardMaterial({
    color: "#0f3f2a",   // matches `ddsPcbGreenMat` used by the procedural fallback
    metalness: 0.05,
    roughness: 0.62,
  });
  const componentMat = new THREE.MeshStandardMaterial({
    color: "#1f2733",   // dark matte for ICs / regulators / headers
    metalness: 0.18,
    roughness: 0.45,
  });
  // Gold-plated SMA hex flange + barrel. Reference: a representative SMA
  // model on 3DContentCentral (catalogid=171 → connectors) shipped from a
  // supplier rendered with a brighter, more saturated gold than the muted
  // brass tone (#b7791f) used for procedural placeholder pins inside the
  // PCB. We bump toward true gold (#d4a017) and crank metalness so the
  // SMA bodies read as a polished plated metal instead of a dull alloy.
  const smaMat = new THREE.MeshStandardMaterial({
    color: "#d4a017",
    metalness: 0.85,
    roughness: 0.22,
  });

  const group = new THREE.Group();
  group.name = component.name;

  if (pcbTris.length > 0) {
    group.add(new THREE.Mesh(buildSubGeometry(pcbTris), pcbMat));
  }
  if (componentTris.length > 0) {
    group.add(new THREE.Mesh(buildSubGeometry(componentTris), componentMat));
  }
  if (smaTris.length > 0) {
    group.add(new THREE.Mesh(buildSubGeometry(smaTris), smaMat));
  }

  geometry.dispose();
  return group;
}
