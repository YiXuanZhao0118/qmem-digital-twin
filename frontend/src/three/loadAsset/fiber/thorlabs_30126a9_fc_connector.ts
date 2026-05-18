import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

import { resolveAssetUrl } from "../../../api/client";
import { FIBER_FERRULE_TIP_MM } from "../../../utils/fiberAnchorResolver";
import type { Polish } from "./types";

const stlLoader = new STLLoader();

interface FcConnectorOptions {
  polish: Polish;
  bootColor: string;
}

// 30126A9 reference geometry (Thorlabs FC/APC connector housing): high-fidelity
// mesh imported from the published STEP file via FreeCAD STEP→STL. Loaded once
// per session and shared across every fiber connector instance for memory
// efficiency. While the load is in flight, fiber connectors fall back to the
// procedural geometry below; once the cache fills they'll use the imported
// shape on the next fiber re-render.
//   - Original STEP frame: longitudinal axis +Z, cable-side end at z≈-25 mm,
//     ferrule tip at z≈+11.28 mm, Ø10 mm at the coupling nut.
//   - APC ferrule has the 8° polish baked into the geometry; the PC variant
//     is generated on demand by clamping the ferrule-tip vertices to a single
//     y so the slanted face becomes flat.
//   - All transforms are baked into the cached BufferGeometry: rotateX(-π/2)
//     swings +Z → +Y, translate(+25 mm in pre-scale frame) puts the cable end
//     at y=0, then scale 0.01 maps mm → scene units (1 unit = 100 mm).
const FC_HOUSING_ASSET_PATH = "uploads/thorlabs_fc_apc_30126a9.stl";
let fcHousingApcGeometryCache: THREE.BufferGeometry | null = null;
let fcHousingPcGeometryCache: THREE.BufferGeometry | null = null;
let fcHousingLoadPromise: Promise<void> | null = null;

function loadFcHousingGeometry(): Promise<void> {
  if (fcHousingApcGeometryCache && fcHousingPcGeometryCache) return Promise.resolve();
  if (!fcHousingLoadPromise) {
    fcHousingLoadPromise = stlLoader
      .loadAsync(resolveAssetUrl(FC_HOUSING_ASSET_PATH))
      .then((raw: THREE.BufferGeometry) => {
        // Bake the orientation/scale transforms once into the geometry so the
        // per-fiber Mesh just references it without further transforms. The
        // procedural boot was removed 2026-05-09 (it added an unwanted
        // Ø3→Ø6 taper at each cable end), so the housing's cable-side end
        // sits exactly at the fiber endpoint (y=0). The cable goes directly
        // into the rear plastic barrel of the imported model.
        raw.rotateX(-Math.PI / 2); // +Z → +Y in original STL frame
        raw.translate(0, 25, 0);   // cable end (was z=-25) → y=0 mm
        raw.scale(0.01, 0.01, 0.01); // mm → scene units (1 unit = 100 mm)
        raw.computeVertexNormals();

        // Split the housing into 3 visual zones along the longitudinal axis
        // by reordering triangles and emitting BufferGeometry groups. Per-
        // triangle Y boundaries chosen from inspecting the STL radial-vs-Z
        // distribution (scripts/_inspect_stl_zones.py): rear barrel narrows
        // and the wide hex coupling nut starts around STL z = -9 mm; the
        // ceramic ferrule (Ø2.5 mm) starts around z = +10 mm.
        //   group 0 → rear barrel (plastic, jacket-coloured by polish)
        //   group 1 → coupling nut + body sleeve + chrome ring (silver metal)
        //   group 2 → ceramic ferrule (white zirconia)
        const Y_REAR_TO_MID = 0.16; // 16 mm in scene units (= STL z -9 mm)
        const Y_MID_TO_TIP = 0.35;  // 35 mm in scene units (= STL z +10 mm)
        const pos = raw.attributes.position;
        const norm = raw.attributes.normal;
        const vertCount = pos.count;
        const triCount = vertCount / 3;
        const triZones: number[] = new Array(triCount);
        const counts = [0, 0, 0];
        for (let t = 0; t < triCount; t++) {
          const yc = (pos.getY(t * 3) + pos.getY(t * 3 + 1) + pos.getY(t * 3 + 2)) / 3;
          const z = yc < Y_REAR_TO_MID ? 0 : yc < Y_MID_TO_TIP ? 1 : 2;
          triZones[t] = z;
          counts[z]++;
        }
        // Stable reorder: triangles are written into the new buffer grouped
        // by zone, preserving original order within each zone.
        const newPos = new Float32Array(pos.array.length);
        const newNorm = new Float32Array(norm.array.length);
        const writeOffset = [0, counts[0], counts[0] + counts[1]]; // tri-index offsets per zone
        const writeCursor = [0, 0, 0];
        for (let t = 0; t < triCount; t++) {
          const z = triZones[t];
          const dstTri = writeOffset[z] + writeCursor[z]++;
          for (let v = 0; v < 3; v++) {
            const srcBase = (t * 3 + v) * 3;
            const dstBase = (dstTri * 3 + v) * 3;
            newPos[dstBase] = pos.array[srcBase];
            newPos[dstBase + 1] = pos.array[srcBase + 1];
            newPos[dstBase + 2] = pos.array[srcBase + 2];
            newNorm[dstBase] = norm.array[srcBase];
            newNorm[dstBase + 1] = norm.array[srcBase + 1];
            newNorm[dstBase + 2] = norm.array[srcBase + 2];
          }
        }
        (pos.array as Float32Array).set(newPos);
        (norm.array as Float32Array).set(newNorm);
        pos.needsUpdate = true;
        norm.needsUpdate = true;
        raw.clearGroups();
        let cursor = 0;
        for (let z = 0; z < 3; z++) {
          raw.addGroup(cursor, counts[z] * 3, z);
          cursor += counts[z] * 3;
        }
        raw.computeBoundingBox();
        fcHousingApcGeometryCache = raw;

        // Build a flat-tip clone for PC ends. The ferrule tip in the imported
        // STL is the cluster of vertices at the maximum Y; flatten any vertex
        // within ±0.5 mm of that y to a single value so the 8° slope becomes
        // perfectly flat. (Sub-millimetre clamp; the rest of the housing is
        // untouched, and BufferGeometry groups are inherited via clone().)
        const pc = raw.clone();
        const pcPos = pc.attributes.position;
        const bbox = pc.boundingBox!;
        const tipY = bbox.max.y;
        const flattenBand = 0.005; // 0.5 mm in scene units
        for (let i = 0; i < pcPos.count; i++) {
          if (pcPos.getY(i) > tipY - flattenBand) {
            pcPos.setY(i, tipY);
          }
        }
        pcPos.needsUpdate = true;
        pc.computeVertexNormals();
        fcHousingPcGeometryCache = pc;
      })
      .catch((err: unknown) => {
        console.warn("[fiber] failed to load FC housing STL, falling back to procedural geometry", err);
      });
  }
  return fcHousingLoadPromise;
}

// Kick off the load eagerly at module init so by the time the user drops a
// fiber on the scene the cache is populated. Errors are swallowed; fall-back
// procedural geometry still renders.
loadFcHousingGeometry();

export function buildFcConnectorMesh(options: FcConnectorOptions = { polish: "PC", bootColor: "#0a0a0c" }): THREE.Group {
  // FC connector model. Stacked along local +Y from the cable side at y=0
  // to the ferrule tip at y ≈ 0.3628 (= 36.28 mm). The caller rotates the
  // group so +Y aligns with the outward direction at the fiber endpoint.
  //
  // No procedural boot: the cable's straight TubeGeometry feeds directly
  // into the imported Thorlabs 30126A9 housing whose rear plastic barrel
  // (group 0, jacket-coloured) provides the visual identity that a rubber
  // boot would give. The 30126A9 STL itself contains the rear barrel,
  // hex coupling nut, body sleeve, chrome shoulder ring and ceramic
  // ferrule — APC ends use the imported geometry as-is (8° polish baked
  // in); PC ends use a clone with the ferrule-tip vertices clamped flat.
  // Falls back to a procedural housing while the STL load is in flight.
  const conn = new THREE.Group();
  conn.userData.fiberRole = "connector";
  conn.userData.fiberPolish = options.polish;

  // ---------- materials ----------------------------------------------
  // Per-zone materials for the imported STL housing:
  //   group 0 (rear barrel): plastic, jacket-coloured for PC, green for APC.
  //   group 1 (coupling nut + body sleeve + chrome ring): silver metal.
  //   group 2 (ceramic ferrule tip): white zirconia.
  const rearPlastic = new THREE.MeshStandardMaterial({
    color: options.bootColor, metalness: 0.0, roughness: 0.85,
  });
  const housingMetal = new THREE.MeshStandardMaterial({
    color: "#c9ccd2", metalness: 0.92, roughness: 0.28,
  });
  const housingCeramic = new THREE.MeshStandardMaterial({
    color: "#f5f3ee", metalness: 0.05, roughness: 0.38,
  });

  // ---------- helpers ------------------------------------------------
  const mm = (v: number) => v / 100;

  // ---------- Thorlabs-imported housing (STL) ------------------------
  const cachedHousing = options.polish === "APC"
    ? fcHousingApcGeometryCache
    : fcHousingPcGeometryCache;

  if (cachedHousing) {
    // Geometry has 3 groups: 0=rear plastic, 1=silver metal, 2=ceramic ferrule.
    // Materials array order must match group materialIndex.
    const housing = new THREE.Mesh(cachedHousing, [rearPlastic, housingMetal, housingCeramic]);
    housing.userData.fiberRole = "housing";
    housing.userData.thorlabsModel = "30126A9";
    conn.add(housing);
  } else {
    // STL still loading — render a slim procedural placeholder so the
    // connector isn't invisible during the brief load window. Replaced
    // with the imported geometry on next fiber re-render once the cache
    // populates.
    const knurlMetal = new THREE.MeshStandardMaterial({
      color: "#a8acb2", metalness: 0.85, roughness: 0.42,
    });
    const sleeveMetal = new THREE.MeshStandardMaterial({
      color: "#8c9098", metalness: 0.88, roughness: 0.34,
    });
    const ceramic = new THREE.MeshStandardMaterial({
      color: "#f5f3ee", metalness: 0.05, roughness: 0.38,
    });
    const chromeRing = new THREE.MeshStandardMaterial({
      color: "#d8dadd", metalness: 0.95, roughness: 0.18,
    });

    let cursorY = 0;
    const rearLen = 16;
    const rearBarrel = new THREE.Mesh(
      new THREE.CylinderGeometry(mm(3.0), mm(2.5), mm(rearLen), 24),
      rearPlastic,
    );
    rearBarrel.position.y = mm(cursorY + rearLen / 2);
    conn.add(rearBarrel);
    cursorY += rearLen;

    const nutLen = 9, nutKnurlLen = 5.5;
    const nutSmoothLen = nutLen - nutKnurlLen;
    const nut = new THREE.Mesh(
      new THREE.CylinderGeometry(mm(4.0), mm(4.0), mm(nutSmoothLen), 6),
      housingMetal,
    );
    nut.position.y = mm(cursorY + nutSmoothLen / 2);
    conn.add(nut);
    const nutKnurl = new THREE.Mesh(
      new THREE.CylinderGeometry(mm(4.05), mm(4.05), mm(nutKnurlLen), 6),
      knurlMetal,
    );
    nutKnurl.position.y = mm(cursorY + nutSmoothLen + nutKnurlLen / 2);
    conn.add(nutKnurl);
    cursorY += nutLen;

    const sleeveLen = 4;
    const sleeve = new THREE.Mesh(
      new THREE.CylinderGeometry(mm(3.0), mm(3.5), mm(sleeveLen), 20),
      sleeveMetal,
    );
    sleeve.position.y = mm(cursorY + sleeveLen / 2);
    conn.add(sleeve);
    cursorY += sleeveLen;

    const shoulderRingLen = 1;
    const shoulderRing = new THREE.Mesh(
      new THREE.CylinderGeometry(mm(2.0), mm(2.0), mm(shoulderRingLen), 24),
      chromeRing,
    );
    shoulderRing.position.y = mm(cursorY + shoulderRingLen / 2);
    conn.add(shoulderRing);
    cursorY += shoulderRingLen;

    const ferruleLen = 10;
    const ferruleHeight = mm(ferruleLen);
    const ferruleGeom = new THREE.CylinderGeometry(mm(1.20), mm(1.25), ferruleHeight, 20);
    if (options.polish === "APC") {
      const pos = ferruleGeom.attributes.position;
      const topY = ferruleHeight / 2;
      const tan8 = Math.tan((8 * Math.PI) / 180);
      for (let i = 0; i < pos.count; i++) {
        if (Math.abs(pos.getY(i) - topY) < 1e-5) {
          pos.setY(i, topY - pos.getZ(i) * tan8);
        }
      }
      pos.needsUpdate = true;
      ferruleGeom.computeVertexNormals();
    }
    const ferrule = new THREE.Mesh(ferruleGeom, ceramic);
    ferrule.position.y = mm(cursorY + ferruleLen / 2);
    conn.add(ferrule);

    const keyPin = new THREE.Mesh(
      new THREE.CylinderGeometry(mm(0.6), mm(0.6), mm(1.6), 14),
      chromeRing,
    );
    keyPin.rotation.z = Math.PI / 2;
    keyPin.position.set(mm(4.05 + 0.8), mm(rearLen + nutSmoothLen + nutKnurlLen + sleeveLen * 0.4), 0);
    conn.add(keyPin);
  }

  // Raycastable port disk at the ferrule tip (2026-05-12 fix). The
  // imported 30126A9 STL housing — and its procedural fallback — is a
  // hollow shell with NO end cap at the ferrule tip. A laser beam
  // travelling exactly along the fiber's optical axis (the well-aligned
  // case) passes through the entire housing without hitting a single
  // triangle, so rayTrace.ts sees no hit and the fiber dispatch never
  // fires. We add an explicit disk perpendicular to outward at the tip
  // so the ray-tracer can intercept dead-center on-axis rays. The disk
  // is INVISIBLE in the render pass (colorWrite/depthWrite off) but the
  // ray-tracer's Raycaster uses default all-layer mask and finds it.
  //
  // Radius matches the FC ferrule sleeve OD (Ø2.5 mm → 1.25 mm radius).
  // For APC tips, the disk is tilted 8° around the local X axis so its
  // normal matches the slanted polish baked into the STL.
  const portDiskRadiusMm = 1.25;
  const portDisk = new THREE.Mesh(
    new THREE.CircleGeometry(portDiskRadiusMm / 100, 24),
    new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  // CircleGeometry's normal is +Z by default. Rotate -π/2 around local X
  // so the normal points +Y (= outward in the connector frame). APC
  // adds +8° about X, tilting the normal 8° toward +Z to match the
  // polish baked into the STL ferrule tip.
  const apcRad = (8 * Math.PI) / 180;
  portDisk.rotation.x = -Math.PI / 2 + (options.polish === "APC" ? apcRad : 0);
  portDisk.position.y = FIBER_FERRULE_TIP_MM / 100;
  portDisk.userData.fiberRole = "portDisk";
  portDisk.userData.fiberPolish = options.polish;
  conn.add(portDisk);

  conn.traverse((c) => {
    c.castShadow = true;
    c.receiveShadow = true;
  });
  return conn;
}
