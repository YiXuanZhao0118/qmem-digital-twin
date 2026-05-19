/**
 * IsolatorDevPage — live-tweak page for PBS pose inside an isolator.
 *
 * Layout:
 *   ┌─ header ────────────────────────────────────────────────────┐
 *   │ Isolator dev   [Model ▼]  ↻ Reset   📋 Copy                 │
 *   ├─ 3D canvas ──────────────────┬─ right pane ─────────────────┤
 *   │ Real STL housing (IO series) │ Live-editable TS code:       │
 *   │ or procedural cylinder       │ "{ front_pbs: { pos: [...    │
 *   │ (TORNOS), with PBS overlay   │     ...                      │
 *   │ driven by the right pane.    │ Parse: ✓ / ✗ ...             │
 *   └──────────────────────────────┴──────────────────────────────┘
 *
 * The right pane is the source of truth — typing a number reparses the
 * block and pushes new values into React state, which rebuilds only the
 * PBS overlay (and the housing if the model changed). No page reload.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

import { resolveAssetUrl, updateComponentApi } from "../../api/client";
import { useSceneStore } from "../../store/sceneStore";
import { mmToThree } from "../../three/transformUtils";
import type { Anchor, Asset3D, ComponentItem } from "../../types/digitalTwin";
import {
  buildIsolatorPbsOverlay,
  buildThorlabsIsolatorObject,
  isolatorCentroidKey,
  ISOLATOR_PBS_DEFAULTS_BY_MODEL,
  type IsolatorLinkedRotationGroup,
  type PbsPoseEntry,
} from "./pbsOverlay";
// Whole-file source string for the right-panel editor. Vite resolves `?raw`
// at build time to the file's exact contents (geometry helpers + table +
// PBS overlay assembly + STL wrapper). User can edit anywhere; the parser
// below only watches the current model's row.
import pbsOverlayFileSource from "./pbsOverlay.ts?raw";

const MODELS = Object.keys(ISOLATOR_PBS_DEFAULTS_BY_MODEL);

// Procedural-cylinder fallback dims (used for TORNOS where the asset is
// `primitive://box`, not an STL file).
const HOUSING_LENGTHS_MM: Record<string, number> = {
  "TORNOS-850-4": 51.4,
};
const HOUSING_DIAM_MM: Record<string, number> = {
  "TORNOS-850-4": 22,
};

// One-shot STL geometry cache so dragging sliders doesn't refetch the
// file every keystroke. Cleared on full page reload (which is fine, the
// browser HTTP cache picks up the served file).
const stlLoader = new STLLoader();
const stlGeometryCache = new Map<string, Promise<THREE.BufferGeometry>>();
function loadStlGeometryCached(filePath: string): Promise<THREE.BufferGeometry> {
  if (!stlGeometryCache.has(filePath)) {
    stlGeometryCache.set(
      filePath,
      stlLoader.loadAsync(resolveAssetUrl(filePath)),
    );
  }
  // Clone so each call gets its own BufferGeometry to mutate (computeBoundingBox
  // etc.) without contaminating the cache.
  return stlGeometryCache.get(filePath)!.then((g) => g.clone());
}

type Vec3 = [number, number, number];

// ────────────────────────────────────────────────────────────────────────
// Triangle cluster helpers — find the connected coplanar mesh face that
// the user clicked, then drop all those triangles. STL is non-indexed
// (one BufferGeometry per triangle, 9 floats), so triangle index = faceIndex.
// ────────────────────────────────────────────────────────────────────────

/** Vertex key for BFS edge matching. Uses the same 0.5 mm rounding as
 *  `isolatorCentroidKey` so triangles sharing a "same" vertex resolve
 *  to identical keys despite floating-point drift. */
function vertexKey(positions: Float32Array, vertexOffset: number): string {
  const r = (n: number) => Math.round(n * 2) / 2;
  return `${r(positions[vertexOffset])},${r(positions[vertexOffset + 1])},${r(positions[vertexOffset + 2])}`;
}
function triangleNormal(positions: Float32Array, t: number): [number, number, number] {
  const o = t * 9;
  const e1x = positions[o + 3] - positions[o + 0];
  const e1y = positions[o + 4] - positions[o + 1];
  const e1z = positions[o + 5] - positions[o + 2];
  const e2x = positions[o + 6] - positions[o + 0];
  const e2y = positions[o + 7] - positions[o + 1];
  const e2z = positions[o + 8] - positions[o + 2];
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-9) return [0, 0, 0];
  return [nx / len, ny / len, nz / len];
}

/** BFS from `startTriIdx` over triangles that (a) share an edge with a
 *  triangle already in the cluster AND (b) have a normal within 18° of
 *  the start triangle (cos(18°) ≈ 0.95). Returns the cluster's triangle
 *  indices. Used to spread a single click out to a whole flat face. */
function findCoplanarCluster(
  positions: Float32Array,
  startTriIdx: number,
): Set<number> {
  const triangleCount = Math.floor(positions.length / 9);
  if (startTriIdx >= triangleCount || startTriIdx < 0) return new Set();

  const startNormal = triangleNormal(positions, startTriIdx);
  // Edge key → triangle indices that contain that edge
  const edgeToTris = new Map<string, number[]>();
  for (let t = 0; t < triangleCount; t += 1) {
    const o = t * 9;
    const v0 = vertexKey(positions, o + 0);
    const v1 = vertexKey(positions, o + 3);
    const v2 = vertexKey(positions, o + 6);
    const verts = [v0, v1, v2];
    for (let i = 0; i < 3; i += 1) {
      const a = verts[i];
      const b = verts[(i + 1) % 3];
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      let arr = edgeToTris.get(key);
      if (!arr) {
        arr = [];
        edgeToTris.set(key, arr);
      }
      arr.push(t);
    }
  }

  const cluster = new Set<number>([startTriIdx]);
  const queue = [startTriIdx];
  while (queue.length > 0) {
    const t = queue.shift()!;
    const o = t * 9;
    const verts = [
      vertexKey(positions, o + 0),
      vertexKey(positions, o + 3),
      vertexKey(positions, o + 6),
    ];
    for (let i = 0; i < 3; i += 1) {
      const a = verts[i];
      const b = verts[(i + 1) % 3];
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const neighbors = edgeToTris.get(key);
      if (!neighbors) continue;
      for (const n of neighbors) {
        if (cluster.has(n)) continue;
        const nNorm = triangleNormal(positions, n);
        const dot = nNorm[0] * startNormal[0] + nNorm[1] * startNormal[1] + nNorm[2] * startNormal[2];
        if (dot >= 0.95) {
          cluster.add(n);
          queue.push(n);
        }
      }
    }
  }
  return cluster;
}

function disposeObject3D(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    if (m.material) {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) mat.dispose();
    }
  });
}

// ────────────────────────────────────────────────────────────────────────
// Code parser — find the current model's row inside the whole file text
// and extract its 2 PBS poses. Anything outside that row is left alone.
// ────────────────────────────────────────────────────────────────────────

const POS_RE = /pos\s*:\s*\[\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*\]/g;
const YROT_RE = /yRotationDeg\s*:\s*([+-]?\d+(?:\.\d+)?)/g;
// 3-axis Euler ``rotationDeg: [rx, ry, rz]`` — Stage A''.11-followup
// lets Glan-Laser entries (and any PBS that needs a non-Y-axis tilt)
// override the default alignment.
const ROT_RE = /rotationDeg\s*:\s*\[\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*\]/g;
const MODEL_ROW_WINDOW = 800; // chars after `"MODEL":` to scan for the row

function parseModelRow(text: string, model: string):
  | {
      frontPos: Vec3;
      frontY: number;
      backPos: Vec3;
      backY: number;
      /** Set when the parsed pose entry has an explicit
       *  ``rotationDeg: [rx, ry, rz]``. ``null`` means the entry uses
       *  yRotationDeg only (legacy / single-DOF). */
      frontRot: Vec3 | null;
      backRot: Vec3 | null;
    }
  | null {
  const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`"${escaped}"\\s*:`);
  const m = text.match(re);
  if (!m || m.index === undefined) return null;
  const chunk = text.slice(m.index, m.index + MODEL_ROW_WINDOW);

  POS_RE.lastIndex = 0;
  YROT_RE.lastIndex = 0;
  ROT_RE.lastIndex = 0;
  const positions: Vec3[] = [];
  const yRots: number[] = [];
  const rots: Vec3[] = [];
  let mm: RegExpExecArray | null;
  while ((mm = POS_RE.exec(chunk)) !== null && positions.length < 2) {
    positions.push([Number(mm[1]), Number(mm[2]), Number(mm[3])]);
  }
  while ((mm = YROT_RE.exec(chunk)) !== null && yRots.length < 2) {
    yRots.push(Number(mm[1]));
  }
  while ((mm = ROT_RE.exec(chunk)) !== null && rots.length < 2) {
    rots.push([Number(mm[1]), Number(mm[2]), Number(mm[3])]);
  }
  if (positions.length !== 2 || yRots.length !== 2) return null;
  if (positions.some((p) => p.some((n) => !Number.isFinite(n)))) return null;
  if (yRots.some((y) => !Number.isFinite(y))) return null;
  return {
    frontPos: positions[0],
    frontY: yRots[0],
    backPos: positions[1],
    backY: yRots[1],
    // rotationDeg is sparse — only present on entries that need it.
    // The order matches positions/yRots: first match → front, second → back.
    frontRot: rots[0] ?? null,
    backRot: rots[1] ?? null,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────

export function IsolatorDevPage() {
  const scene = useSceneStore((s) => s.scene);
  const components = scene.components;
  const assets = scene.assets;

  const [model, setModel] = useState<string>(MODELS[0]);
  const [frontPos, setFrontPos] = useState<Vec3>([0, 0, 0]);
  const [backPos, setBackPos] = useState<Vec3>([0, 0, 0]);
  const [frontYRot, setFrontYRot] = useState<number>(0);
  const [backYRot, setBackYRot] = useState<number>(0);
  // 3-axis Euler override (Stage A''.11-followup). Non-null = use
  // ``rotationDeg: [rx, ry, rz]`` instead of the single-axis
  // ``yRotationDeg`` path. Glan-Laser variants typically need this
  // because their default alignment composes -90° around three.X with
  // a y-rotation that single-axis can't express. PBS cubes can use it
  // too for non-face-diagonal cement normals.
  const [frontRotXYZ, setFrontRotXYZ] = useState<Vec3 | null>(null);
  const [backRotXYZ, setBackRotXYZ] = useState<Vec3 | null>(null);
  // The full pbsOverlay.ts file source, editable. State (frontPos/...)
  // is the source of truth for the 3D view; the textarea is the source
  // of truth for the file source. They sync one-way (textarea → state)
  // via parseModelRow on every edit.
  const [code, setCode] = useState<string>(pbsOverlayFileSource as string);
  const [parseStatus, setParseStatus] = useState<"ok" | "error" | "idle">("idle");
  // STL interior-trim filter — drops triangles within `innerFilterRadiusMm`
  // of the STL's Z axis (= optical axis in IO-series STL frame). 0 = no
  // filter. Two reference clicks in the dev page showed the IO-3-850-HP
  // interior baffles cluster around r ≈ 1.7 / 3.9 mm from Z, so a value
  // around 4–6 mm cuts them out without touching the outer housing.
  // 0 = no auto-trim (the user picks faces to remove via middle-click,
  // then saves them to component.properties via the Save button).
  const [innerFilterRadiusMm, setInnerFilterRadiusMm] = useState<number>(0);
  // Triangle counts for the visible STL housing — set by the build effect
  // so the user can see at a glance whether the filter actually dropped
  // anything ("12340 → 12180 after filter" etc.).
  const [triangleCounts, setTriangleCounts] = useState<{ raw: number; rendered: number } | null>(null);
  // Click-to-delete-face state. Middle-click (scroll wheel button) deletes
  // the coplanar cluster under the pointer; left-click stays for orbit /
  // inspect so the user can rotate the scene without accidentally
  // deleting. Cluster centroids accumulate in `deletedCentroids` and pass
  // straight to `buildThorlabsIsolatorObject`. "Save" persists them to
  // `component.properties.isolatorDeletedCentroids` so Lab viewer + the
  // next dev-page session pick up the deletions automatically.
  const [deletedCentroids, setDeletedCentroids] = useState<Set<string>>(() => new Set());
  const [savedCentroids, setSavedCentroids] = useState<Set<string>>(() => new Set());
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const deletedCentroidsRef = useRef(deletedCentroids);
  useEffect(() => { deletedCentroidsRef.current = deletedCentroids; }, [deletedCentroids]);

  // Front / back STL partition (Stage A''.11-followup-2). User marks
  // triangles via Ctrl/Alt + mid-click; those subsets eventually
  // bake into their own Asset3Ds via viewerHints.includeOnlyCentroids
  // so the Lab viewer's binding tree can render them as separate
  // sub-Assets that move + rotate with their Mount binding. Remaining
  // (un-marked, un-deleted, un-linked) triangles form the Faraday
  // body asset.
  const [frontPartCentroids, setFrontPartCentroids] = useState<Set<string>>(() => new Set());
  const [backPartCentroids, setBackPartCentroids] = useState<Set<string>>(() => new Set());
  const frontPartCentroidsRef = useRef(frontPartCentroids);
  const backPartCentroidsRef = useRef(backPartCentroids);
  useEffect(() => { frontPartCentroidsRef.current = frontPartCentroids; }, [frontPartCentroids]);
  useEffect(() => { backPartCentroidsRef.current = backPartCentroids; }, [backPartCentroids]);
  const [savedFrontPart, setSavedFrontPart] = useState<Set<string>>(() => new Set());
  const [savedBackPart, setSavedBackPart] = useState<Set<string>>(() => new Set());

  // Linked-rotation group — Shift + middle-click adds a coplanar cluster
  // to this set; the slider rotates them around `linkRotAxis` at
  // `linkRotPivotMm` (both in body-local STL frame). Default axis (0,0,1)
  // matches the STL native long axis for IO/IOT isolators.
  const [linkedCentroids, setLinkedCentroids] = useState<Set<string>>(() => new Set());
  const [linkRotDeg, setLinkRotDeg] = useState<number>(0);
  const [linkRotAxis, setLinkRotAxis] = useState<Vec3>([0, 0, 1]);
  const [linkRotPivotMm, setLinkRotPivotMm] = useState<Vec3>([0, 0, 0]);
  // Anchor names whose PBS cube rotates rigidly with the link group. Lock
  // the crystal's relative pose (pos + yRotationDeg) at link rotationDeg
  // = 0, then ticking the box makes it rotate along with the marked
  // triangles when the slider moves.
  const [linkBoundAnchors, setLinkBoundAnchors] = useState<Set<string>>(() => new Set());
  const [savedLinked, setSavedLinked] = useState<IsolatorLinkedRotationGroup | null>(null);
  const linkedCentroidsRef = useRef(linkedCentroids);
  useEffect(() => { linkedCentroidsRef.current = linkedCentroids; }, [linkedCentroids]);

  // Click-inspect: click a triangle in the 3D viewer to get its centroid /
  // normal / distances. Useful for working out the right filter condition
  // when you want to drop interior STL features (PBS mounts, baffles, etc.).
  const [hitInfo, setHitInfo] = useState<
    | {
        which: "housing" | "pbs-overlay" | "other";
        centroidMm: Vec3;
        normalMmLocal: Vec3;
        distFromAxisMm: { x: number; y: number; z: number };
        areaMm2: number;
      }
    | null
  >(null);

  // Load row values from the table whenever the model changes, AND reset
  // the textarea to the file source so the visible row matches. Also
  // seed `deletedCentroids` from the matching component's persisted
  // `properties.isolatorDeletedCentroids` so prior saved deletions show.
  useEffect(() => {
    const def = ISOLATOR_PBS_DEFAULTS_BY_MODEL[model];
    if (def) {
      setFrontPos([...def.front_pbs.pos]);
      setBackPos([...def.back_pbs.pos]);
      setFrontYRot(def.front_pbs.yRotationDeg ?? 0);
      setBackYRot(def.back_pbs.yRotationDeg ?? 0);
      // Pre-seed Euler from rotationDeg if the entry has it; else null
      // (page falls back to yRot path until the user opts in).
      setFrontRotXYZ(def.front_pbs.rotationDeg ? [...def.front_pbs.rotationDeg] : null);
      setBackRotXYZ(def.back_pbs.rotationDeg ? [...def.back_pbs.rotationDeg] : null);
    }
    setCode(pbsOverlayFileSource as string);
    setParseStatus("idle");

    const component = components.find((c) => c.model === model);
    const props = component?.properties as {
      isolatorDeletedCentroids?: string[];
      isolatorLinkedRotationGroup?: IsolatorLinkedRotationGroup;
      isolatorFrontPartCentroids?: string[];
      isolatorBackPartCentroids?: string[];
    } | undefined;
    const persistedDel = props?.isolatorDeletedCentroids ?? [];
    setDeletedCentroids(new Set(persistedDel));
    setSavedCentroids(new Set(persistedDel));

    const persistedLink = props?.isolatorLinkedRotationGroup ?? null;
    setLinkedCentroids(new Set(persistedLink?.centroids ?? []));
    setLinkRotDeg(persistedLink?.rotationDeg ?? 0);
    setLinkRotAxis(persistedLink?.axis ?? [0, 0, 1]);
    setLinkRotPivotMm(persistedLink?.pivotMm ?? [0, 0, 0]);
    setLinkBoundAnchors(new Set(persistedLink?.boundAnchors ?? []));
    setSavedLinked(persistedLink);

    const persistedFront = props?.isolatorFrontPartCentroids ?? [];
    const persistedBack = props?.isolatorBackPartCentroids ?? [];
    setFrontPartCentroids(new Set(persistedFront));
    setBackPartCentroids(new Set(persistedBack));
    setSavedFrontPart(new Set(persistedFront));
    setSavedBackPart(new Set(persistedBack));

    setSaveStatus("idle");
  }, [model, components]);

  // ── Three.js scene ───────────────────────────────────────────────────
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const modelGroupRef = useRef<THREE.Object3D | null>(null);
  // Overlay div for the Ctrl/Alt + left-drag box-select rectangle.
  // Updated imperatively from the pointer handlers inside the
  // init useEffect to avoid React re-render storm at 60fps.
  const boxOverlayElRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const threeScene = new THREE.Scene();
    threeScene.background = new THREE.Color("#f6f7f9");
    threeScene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.75);
    dirLight.position.set(2, 3, 4);
    threeScene.add(dirLight);
    threeScene.add(new THREE.AxesHelper(mmToThree(40)));

    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 100);
    camera.position.set(0.8, 0.5, 0.8);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(mount.clientWidth, mount.clientHeight, false);
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(threeScene, camera);
    };
    animate();

    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    });
    ro.observe(mount);

    sceneRef.current = threeScene;
    cameraRef.current = camera;
    controlsRef.current = controls;

    // ── Raycast + click handlers. Left-click → just inspect (so the user
    // can orbit / pan via OrbitControls without accidentally deleting).
    // Middle-click (scroll wheel button), if it wasn't a drag, runs the
    // same raycast PLUS BFS-and-delete on the housing.
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    type ClusterAction = "delete" | "link" | "front" | "back" | null;
    const performRaycast = (event: MouseEvent, deleteCluster: boolean, linkCluster: boolean = false, partitionCluster: ClusterAction = null) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const target = modelGroupRef.current;
      if (!target) { setHitInfo(null); return; }
      const hits = raycaster.intersectObject(target, true);
      if (hits.length === 0) { setHitInfo(null); return; }
      const hit = hits[0];
      const mesh = hit.object as THREE.Mesh;
      const geo = mesh.geometry as THREE.BufferGeometry | undefined;
      const face = hit.face;
      if (!geo || !face) { setHitInfo(null); return; }
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const v1 = new THREE.Vector3().fromBufferAttribute(pos, face.a);
      const v2 = new THREE.Vector3().fromBufferAttribute(pos, face.b);
      const v3 = new THREE.Vector3().fromBufferAttribute(pos, face.c);
      const centroid = new THREE.Vector3().add(v1).add(v2).add(v3).divideScalar(3);
      const edge1 = new THREE.Vector3().subVectors(v2, v1);
      const edge2 = new THREE.Vector3().subVectors(v3, v1);
      const cross = new THREE.Vector3().crossVectors(edge1, edge2);
      const area = cross.length() / 2;
      const normal = cross.normalize();

      const which: "housing" | "pbs-overlay" | "other" =
        mesh.userData.__pbsAnchorName ? "pbs-overlay"
        : mesh.parent?.name === "isolator_pbs_overlay" ? "pbs-overlay"
        : "housing";

      const hasClusterAction = deleteCluster || linkCluster || partitionCluster !== null;
      if (hasClusterAction && which === "housing" && typeof hit.faceIndex === "number") {
        const positions = (geo.attributes.position.array as Float32Array);
        const cluster = findCoplanarCluster(positions, hit.faceIndex);
        if (cluster.size > 0) {
          // Dispatch which set to mutate based on the action priority:
          // partition > link > delete (only one fires per click — see
          // onAuxClick's modifier-key switch).
          let targetRef: typeof deletedCentroidsRef;
          let targetSetter: typeof setDeletedCentroids;
          if (partitionCluster === "front") {
            targetRef = frontPartCentroidsRef;
            targetSetter = setFrontPartCentroids;
          } else if (partitionCluster === "back") {
            targetRef = backPartCentroidsRef;
            targetSetter = setBackPartCentroids;
          } else if (linkCluster) {
            targetRef = linkedCentroidsRef;
            targetSetter = setLinkedCentroids;
          } else {
            targetRef = deletedCentroidsRef;
            targetSetter = setDeletedCentroids;
          }
          const next = new Set(targetRef.current);
          for (const t of cluster) {
            const o = t * 9;
            const cx = (positions[o + 0] + positions[o + 3] + positions[o + 6]) / 3;
            const cy = (positions[o + 1] + positions[o + 4] + positions[o + 7]) / 3;
            const cz = (positions[o + 2] + positions[o + 5] + positions[o + 8]) / 3;
            next.add(isolatorCentroidKey(cx, cy, cz));
          }
          targetSetter(next);
        }
      }

      setHitInfo({
        which,
        centroidMm: [centroid.x, centroid.y, centroid.z],
        normalMmLocal: [normal.x, normal.y, normal.z],
        distFromAxisMm: {
          x: Math.sqrt(centroid.y * centroid.y + centroid.z * centroid.z),
          y: Math.sqrt(centroid.x * centroid.x + centroid.z * centroid.z),
          z: Math.sqrt(centroid.x * centroid.x + centroid.y * centroid.y),
        },
        areaMm2: area,
      });
    };

    const onLeftClick = (event: MouseEvent) => {
      // Suppress single-click raycast when the user just finished a
      // box-select drag — pointerup fires before "click" so we'd
      // double-handle.
      if (boxJustSelected) {
        boxJustSelected = false;
        return;
      }
      performRaycast(event, false);
    };

    // ── Box-select (Ctrl/Alt + left-drag) ─────────────────────────
    // While a Ctrl/Alt + left button is held, we draw a dashed
    // rectangle on top of the canvas. On release every housing
    // triangle whose projected centroid lands inside the rect gets
    // added to the matching front/back partition set. OrbitControls
    // is temporarily disabled during the drag so the left-drag-to-
    // rotate gesture doesn't fire.
    let boxSelectMode: "front" | "back" | null = null;
    let boxStartX = 0;
    let boxStartY = 0;
    let boxEndX = 0;
    let boxEndY = 0;
    let boxJustSelected = false;
    const updateBoxOverlay = () => {
      const el = boxOverlayElRef.current;
      if (!el) return;
      if (boxSelectMode === null) {
        el.style.display = "none";
        return;
      }
      const x = Math.min(boxStartX, boxEndX);
      const y = Math.min(boxStartY, boxEndY);
      const w = Math.abs(boxEndX - boxStartX);
      const h = Math.abs(boxEndY - boxStartY);
      el.style.display = "block";
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      el.style.borderColor = boxSelectMode === "front" ? "#1d4ed8" : "#b91c1c";
      el.style.background = boxSelectMode === "front"
        ? "rgba(59, 130, 246, 0.12)"
        : "rgba(239, 68, 68, 0.12)";
    };
    const collectTrianglesInRect = (mode: "front" | "back") => {
      const target = modelGroupRef.current;
      if (!target) return;
      const canvasRect = renderer.domElement.getBoundingClientRect();
      // Box coords are page-relative; convert to canvas-relative.
      const xmin = Math.min(boxStartX, boxEndX) - canvasRect.left;
      const ymin = Math.min(boxStartY, boxEndY) - canvasRect.top;
      const xmax = Math.max(boxStartX, boxEndX) - canvasRect.left;
      const ymax = Math.max(boxStartY, boxEndY) - canvasRect.top;
      if (xmax - xmin < 2 || ymax - ymin < 2) return; // tiny drag = no-op
      const collected = new Set<string>();
      const worldVec = new THREE.Vector3();
      target.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        // Skip PBS / Glan-Laser overlay meshes (housing only).
        if (mesh.userData.__pbsAnchorName) return;
        if (mesh.parent?.name === "isolator_pbs_overlay") return;
        const positions = (mesh.geometry as THREE.BufferGeometry).attributes
          .position?.array as Float32Array | undefined;
        if (!positions) return;
        const triCount = Math.floor(positions.length / 9);
        mesh.updateMatrixWorld();
        for (let t = 0; t < triCount; t += 1) {
          const o = t * 9;
          const cx = (positions[o + 0] + positions[o + 3] + positions[o + 6]) / 3;
          const cy = (positions[o + 1] + positions[o + 4] + positions[o + 7]) / 3;
          const cz = (positions[o + 2] + positions[o + 5] + positions[o + 8]) / 3;
          worldVec.set(cx, cy, cz).applyMatrix4(mesh.matrixWorld);
          worldVec.project(camera);
          if (worldVec.z < -1 || worldVec.z > 1) continue;
          const sx = ((worldVec.x + 1) / 2) * canvasRect.width;
          const sy = ((1 - worldVec.y) / 2) * canvasRect.height;
          if (sx < xmin || sx > xmax || sy < ymin || sy > ymax) continue;
          collected.add(isolatorCentroidKey(cx, cy, cz));
        }
      });
      if (collected.size === 0) return;
      const ref = mode === "front" ? frontPartCentroidsRef : backPartCentroidsRef;
      const setter = mode === "front" ? setFrontPartCentroids : setBackPartCentroids;
      const next = new Set(ref.current);
      for (const k of collected) next.add(k);
      setter(next);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const mode: "front" | "back" | null = event.ctrlKey ? "front"
        : event.altKey ? "back"
        : null;
      if (mode === null) return;
      boxSelectMode = mode;
      boxStartX = boxEndX = event.clientX;
      boxStartY = boxEndY = event.clientY;
      updateBoxOverlay();
      controls.enabled = false; // suppress orbit rotate during drag
      event.preventDefault();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (boxSelectMode === null) return;
      boxEndX = event.clientX;
      boxEndY = event.clientY;
      updateBoxOverlay();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (boxSelectMode === null) return;
      const mode = boxSelectMode;
      boxSelectMode = null;
      controls.enabled = true;
      const dx = Math.abs(event.clientX - boxStartX);
      const dy = Math.abs(event.clientY - boxStartY);
      if (dx > 2 || dy > 2) {
        collectTrianglesInRect(mode);
        boxJustSelected = true; // swallow the upcoming "click" event
      }
      updateBoxOverlay();
    };

    // Middle-click delete: `auxclick` fires for non-primary buttons (middle
    // + right) and — unlike mousedown — only fires after the button is
    // released without a significant drag. OrbitControls handles middle-
    // drag via pointer events, so auxclick stays out of its way.
    const onAuxClick = (event: MouseEvent) => {
      if (event.button !== 1) return; // middle button only
      event.preventDefault();
      // Modifier-key dispatch — order matters: partition > link > delete.
      //   Ctrl + mid-click   → mark as front-part STL subset
      //   Alt  + mid-click   → mark as back-part STL subset
      //   Shift + mid-click  → add to link-rotation group
      //   plain mid-click    → add to delete set
      if (event.ctrlKey) {
        performRaycast(event, false, false, "front");
      } else if (event.altKey) {
        performRaycast(event, false, false, "back");
      } else if (event.shiftKey) {
        performRaycast(event, /* deleteCluster */ false, /* linkCluster */ true);
      } else {
        performRaycast(event, /* deleteCluster */ true);
      }
    };
    // Also suppress the browser's default middle-button auto-scroll cursor
    // by preventing the mousedown default. Doesn't interfere with
    // OrbitControls (which uses pointerdown).
    const onMiddleMouseDown = (event: MouseEvent) => {
      if (event.button === 1) event.preventDefault();
    };

    renderer.domElement.addEventListener("click", onLeftClick);
    renderer.domElement.addEventListener("auxclick", onAuxClick);
    renderer.domElement.addEventListener("mousedown", onMiddleMouseDown);
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.removeEventListener("click", onLeftClick);
      renderer.domElement.removeEventListener("auxclick", onAuxClick);
      renderer.domElement.removeEventListener("mousedown", onMiddleMouseDown);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
      disposeObject3D(threeScene);
    };
  }, []);

  // Build / rebuild the visible model whenever state or model changes.
  useEffect(() => {
    let cancelled = false;
    const threeScene = sceneRef.current;
    if (!threeScene) return;

    if (modelGroupRef.current) {
      threeScene.remove(modelGroupRef.current);
      disposeObject3D(modelGroupRef.current);
      modelGroupRef.current = null;
    }

    // Build state-driven anchors that buildIsolatorPbsOverlay (and
    // buildThorlabsIsolatorObject which calls it) will use to position
    // the PBS cubes.
    //
    // ``directionBodyLocal`` is the legacy single-axis hint
    // (cement-normal vector derived from yRotationDeg). It's ONLY
    // emitted when frontRotXYZ/backRotXYZ are null (yRot mode). When
    // the user opted into 3-axis Euler, omitting directionBodyLocal
    // lets the renderer's ``spec.rotationDegBody`` branch fire — the
    // anchor-direction check (line 398 of pbsOverlay.ts) would
    // otherwise win and silently ignore the Euler values.
    const frontYRad = (frontYRot * Math.PI) / 180;
    const backYRad = (backYRot * Math.PI) / 180;
    const anchors: Anchor[] = [
      {
        id: "front_pbs",
        positionMmBodyLocal: { x: frontPos[0], y: frontPos[1], z: frontPos[2] },
        ...(frontRotXYZ === null ? {
          directionBodyLocal: {
            x: Math.cos(frontYRad), y: 1, z: -Math.sin(frontYRad),
          },
        } : {}),
      },
      {
        id: "back_pbs",
        positionMmBodyLocal: { x: backPos[0], y: backPos[1], z: backPos[2] },
        ...(backRotXYZ === null ? {
          directionBodyLocal: {
            x: Math.cos(backYRad), y: 1, z: -Math.sin(backYRad),
          },
        } : {}),
      },
    ];

    const component = components.find((c) => c.model === model);
    const asset = component && component.asset3dId
      ? assets.find((a) => a.id === component.asset3dId)
      : undefined;

    const refit = () => {
      const cam = cameraRef.current;
      const ctrl = controlsRef.current;
      const target = modelGroupRef.current;
      if (!cam || !ctrl || !target) return;
      const bbox = new THREE.Box3().setFromObject(target);
      if (bbox.isEmpty()) return;
      const size = bbox.getSize(new THREE.Vector3());
      const center = bbox.getCenter(new THREE.Vector3());
      const r = Math.max(size.x, size.y, size.z) * 1.8;
      cam.position.copy(center).add(new THREE.Vector3(r, r * 0.7, r));
      cam.lookAt(center);
      cam.near = Math.max(0.001, r / 200);
      cam.far = Math.max(50, r * 50);
      cam.updateProjectionMatrix();
      ctrl.target.copy(center);
      ctrl.update();
    };

    if (asset && !asset.filePath.startsWith("primitive://") && component) {
      // Real STL — load & wrap through the same builder the lab viewer uses.
      loadStlGeometryCached(asset.filePath).then((geometry) => {
        if (cancelled) return;
        // IsolatorDevPage edits the bundled PBS / Glan-Laser overlay
        // directly. Stage A''.9/A''.11 set
        // viewerHints.bundledOverlay=false on migrated isolator assets
        // so the Lab viewer doesn't double-render the PBS cubes (the
        // binding tree now adds them as sub-Components there). That
        // flag is meaningless here — this page IS the overlay editor.
        // Force the overlay on regardless, by overriding the flag in
        // a per-render fakeAsset.
        const fakeAsset: Asset3D = {
          ...asset,
          anchors,
          properties: {
            ...(asset.properties ?? {}),
            viewerHints: {
              ...(asset.properties?.viewerHints ?? {}),
              bundledOverlay: true,
            },
          },
        };
        const fakeComponent: ComponentItem = component;
        const rawTris = Math.floor((geometry.attributes.position.array as Float32Array).length / 9);
        // Builder accepts explicit deletion set + linked rotation group so
        // the dev page's in-progress state overrides the persisted values.
        const linkedGroup: IsolatorLinkedRotationGroup | null = linkedCentroids.size > 0
          ? {
              centroids: [...linkedCentroids],
              axis: linkRotAxis,
              pivotMm: linkRotPivotMm,
              rotationDeg: linkRotDeg,
              boundAnchors: [...linkBoundAnchors],
            }
          : null;
        // UX: front/back-marked triangles need to disappear from the
        // dev preview so the user can keep mid-clicking inwards (the
        // first-marked layer would otherwise block raycasts to deeper
        // geometry). We do that by feeding the marked sets in as
        // additional deletions to the Mark-housing renderer — the
        // actual front/back state stays separate in the
        // ``frontPartCentroids`` / ``backPartCentroids`` Sets so the
        // bake-to-assets step can recover the partitions later.
        const visibleDeletions = new Set(deletedCentroids);
        for (const k of frontPartCentroids) visibleDeletions.add(k);
        for (const k of backPartCentroids) visibleDeletions.add(k);
        // poseOverride feeds the in-page front/back pos + yRot + Euler
        // edits straight to the overlay. yRotationDeg path takes
        // precedence when frontRotXYZ is null; explicit Euler wins
        // when set (the user opted into 3-axis mode).
        //
        // CRITICAL: carry prismType from the pose table. Without
        // this, the renderer falls back to the default ``pbs_cube``
        // and HP variants (which the table marks as ``glan_laser``)
        // get rendered as PBS cubes — Stage A''.11-followup oversight
        // before this fix.
        const tableDef = ISOLATOR_PBS_DEFAULTS_BY_MODEL[model];
        const buildPbsEntry = (
          pos: Vec3, yRot: number, rot: Vec3 | null,
          tableEntry: typeof tableDef extends undefined ? undefined : PbsPoseEntry | undefined,
        ): PbsPoseEntry => {
          const base: PbsPoseEntry = rot !== null
            ? { pos, rotationDeg: rot }
            : { pos, yRotationDeg: yRot };
          if (tableEntry?.prismType) base.prismType = tableEntry.prismType;
          return base;
        };
        const poseOverride = {
          front_pbs: buildPbsEntry(frontPos, frontYRot, frontRotXYZ, tableDef?.front_pbs),
          back_pbs: buildPbsEntry(backPos, backYRot, backRotXYZ, tableDef?.back_pbs),
        };
        const group = buildThorlabsIsolatorObject(
          geometry, fakeComponent, fakeAsset,
          innerFilterRadiusMm, visibleDeletions, linkedGroup, poseOverride,
        );
        // Count rendered tris by walking the result tree (housing mesh).
        let renderedTris = 0;
        group.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh && m.geometry && (m.geometry as THREE.BufferGeometry).attributes.position) {
            renderedTris += Math.floor(((m.geometry as THREE.BufferGeometry).attributes.position.array as Float32Array).length / 9);
          }
        });
        setTriangleCounts({ raw: rawTris, rendered: renderedTris });
        // STL geometry is in raw mm; the lab viewer applies
        // `applyAssetScale` (÷100) to convert to three units. Same here.
        group.scale.setScalar(1 / 100);
        threeScene.add(group);
        modelGroupRef.current = group;
        refit();
      }).catch(() => { /* swallow — keeps the scene empty if the STL can't load */ });
    } else {
      // Procedural cylinder fallback (TORNOS or unknown).
      const lenMm = HOUSING_LENGTHS_MM[model] ?? 50;
      const diamMm = HOUSING_DIAM_MM[model] ?? 30;
      const group = new THREE.Group();
      const housing = new THREE.Mesh(
        new THREE.CylinderGeometry(
          mmToThree(diamMm / 2),
          mmToThree(diamMm / 2),
          mmToThree(lenMm),
          48,
        ),
        new THREE.MeshStandardMaterial({
          color: "#b8211b",
          metalness: 0.55,
          roughness: 0.5,
          transparent: true,
          opacity: 0.25,
          depthWrite: false,
        }),
      );
      group.add(housing);
      const overlay = buildIsolatorPbsOverlay(
        { id: "fake", name: "fake", assetType: "primitive", filePath: "primitive://box", unit: "mm", scaleFactor: 1, anchors },
        { housingLengthMm: lenMm, opticalAxisBody: "z", unitScale: mmToThree(1) },
      );
      group.add(overlay);
      threeScene.add(group);
      modelGroupRef.current = group;
      refit();
    }

    return () => { cancelled = true; };
  }, [
    model, frontPos, backPos, frontYRot, backYRot,
    frontRotXYZ, backRotXYZ,
    components, assets,
    innerFilterRadiusMm, deletedCentroids,
    linkedCentroids, linkRotDeg, linkRotAxis, linkRotPivotMm, linkBoundAnchors,
    frontPartCentroids, backPartCentroids,
  ]);

  // ── Handlers ─────────────────────────────────────────────────────────
  const onCodeChange = (next: string) => {
    setCode(next);
    const parsed = parseModelRow(next, model);
    if (!parsed) {
      setParseStatus("error");
      return;
    }
    setParseStatus("ok");
    setFrontPos(parsed.frontPos);
    setFrontYRot(parsed.frontY);
    setBackPos(parsed.backPos);
    setBackYRot(parsed.backY);
    setFrontRotXYZ(parsed.frontRot);
    setBackRotXYZ(parsed.backRot);
  };

  const onCopy = () => {
    // Emit rotationDeg when the user opted into 3-axis Euler;
    // otherwise the legacy single-axis yRotationDeg syntax. Parser
    // reads both back into state via parseModelRow.
    const rotSnippet = (yRot: number, rot: Vec3 | null): string =>
      rot !== null
        ? `rotationDeg: [${rot.join(", ")}]`
        : `yRotationDeg: ${yRot}`;
    const tableLine =
      `  "${model}":    { front_pbs: { pos: [${frontPos.join(", ")}], ${rotSnippet(frontYRot, frontRotXYZ)} },\n` +
      `                      back_pbs:  { pos: [${backPos.join(", ")}], ${rotSnippet(backYRot, backRotXYZ)} } },`;
    void navigator.clipboard.writeText(tableLine);
  };

  const onResetFromTable = () => {
    const def = ISOLATOR_PBS_DEFAULTS_BY_MODEL[model];
    if (!def) return;
    setFrontPos([...def.front_pbs.pos]);
    setBackPos([...def.back_pbs.pos]);
    setFrontYRot(def.front_pbs.yRotationDeg ?? 0);
    setBackYRot(def.back_pbs.yRotationDeg ?? 0);
    setFrontRotXYZ(def.front_pbs.rotationDeg ? [...def.front_pbs.rotationDeg] : null);
    setBackRotXYZ(def.back_pbs.rotationDeg ? [...def.back_pbs.rotationDeg] : null);
    setCode(pbsOverlayFileSource as string);
    setParseStatus("idle");
  };

  // Persist current deletion set + linked rotation group to
  // `component.properties` so Lab viewer + next dev-page session pick
  // them up automatically.
  const onSaveDeletions = async () => {
    const component = components.find((c) => c.model === model);
    if (!component) return;
    setSaveStatus("saving");
    try {
      const linkedGroupOut: IsolatorLinkedRotationGroup | null = linkedCentroids.size > 0
        ? {
            centroids: [...linkedCentroids],
            axis: linkRotAxis,
            pivotMm: linkRotPivotMm,
            rotationDeg: linkRotDeg,
            boundAnchors: [...linkBoundAnchors],
          }
        : null;
      const nextProperties = {
        ...(component.properties ?? {}),
        isolatorDeletedCentroids: [...deletedCentroids],
        isolatorLinkedRotationGroup: linkedGroupOut,
        isolatorFrontPartCentroids: [...frontPartCentroids],
        isolatorBackPartCentroids: [...backPartCentroids],
      };
      await updateComponentApi(component.id, { properties: nextProperties });
      setSavedCentroids(new Set(deletedCentroids));
      setSavedLinked(linkedGroupOut);
      setSavedFrontPart(new Set(frontPartCentroids));
      setSavedBackPart(new Set(backPartCentroids));
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 1500);
    } catch {
      setSaveStatus("error");
    }
  };

  // Wipe ALL saved deletions for the current model (factory reset). Asks
  // for confirmation since this is destructive of prior edits — the user
  // can re-make them but they'd be lost.
  const onResetModel = async () => {
    const component = components.find((c) => c.model === model);
    if (!component) return;
    if (savedCentroids.size === 0 && deletedCentroids.size === 0
        && !savedLinked && linkedCentroids.size === 0) return;
    if (!window.confirm(`Reset model ${model}? This wipes ${savedCentroids.size} saved deletion(s) and the link-rotation group — the original raw STL will be shown.`)) {
      return;
    }
    setSaveStatus("saving");
    try {
      const nextProperties = {
        ...(component.properties ?? {}),
        isolatorDeletedCentroids: [],
        isolatorLinkedRotationGroup: null,
        isolatorFrontPartCentroids: [],
        isolatorBackPartCentroids: [],
      };
      await updateComponentApi(component.id, { properties: nextProperties });
      setDeletedCentroids(new Set());
      setSavedCentroids(new Set());
      setLinkedCentroids(new Set());
      setLinkRotDeg(0);
      setLinkBoundAnchors(new Set());
      setSavedLinked(null);
      setFrontPartCentroids(new Set());
      setBackPartCentroids(new Set());
      setSavedFrontPart(new Set());
      setSavedBackPart(new Set());
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 1500);
    } catch {
      setSaveStatus("error");
    }
  };

  const deletionsDirty = useMemo(() => {
    if (deletedCentroids.size !== savedCentroids.size) return true;
    for (const k of deletedCentroids) {
      if (!savedCentroids.has(k)) return true;
    }
    return false;
  }, [deletedCentroids, savedCentroids]);

  const linkedDirty = useMemo(() => {
    const savedSize = savedLinked?.centroids.length ?? 0;
    if (linkedCentroids.size !== savedSize) return true;
    if (savedLinked && linkedCentroids.size > 0) {
      const savedSet = new Set(savedLinked.centroids);
      for (const k of linkedCentroids) if (!savedSet.has(k)) return true;
      if (savedLinked.rotationDeg !== linkRotDeg) return true;
      if (savedLinked.axis.some((v, i) => v !== linkRotAxis[i])) return true;
      if (savedLinked.pivotMm.some((v, i) => v !== linkRotPivotMm[i])) return true;
      const savedBound = new Set(savedLinked.boundAnchors ?? []);
      if (savedBound.size !== linkBoundAnchors.size) return true;
      for (const a of linkBoundAnchors) if (!savedBound.has(a)) return true;
    } else if (linkBoundAnchors.size > 0) {
      return true;
    }
    return false;
  }, [linkedCentroids, savedLinked, linkRotDeg, linkRotAxis, linkRotPivotMm, linkBoundAnchors]);

  const setsEqual = (a: Set<string>, b: Set<string>): boolean => {
    if (a.size !== b.size) return false;
    for (const k of a) if (!b.has(k)) return false;
    return true;
  };
  const frontPartDirty = useMemo(
    () => !setsEqual(frontPartCentroids, savedFrontPart),
    [frontPartCentroids, savedFrontPart],
  );
  const backPartDirty = useMemo(
    () => !setsEqual(backPartCentroids, savedBackPart),
    [backPartCentroids, savedBackPart],
  );

  const anyDirty = deletionsDirty || linkedDirty || frontPartDirty || backPartDirty;

  const statusText = useMemo(() => {
    if (parseStatus === "idle") return "in sync with state";
    if (parseStatus === "ok") return "✓ parsed";
    return "✗ parse failed — keep typing";
  }, [parseStatus]);
  const statusColour =
    parseStatus === "error" ? "#c2410c"
    : parseStatus === "ok" ? "#15803d"
    : "#64748b";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: 12, gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <strong>Isolator dev</strong>
        <label>
          Model:{" "}
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          Drop interior r&nbsp;&lt;
          <input
            type="number"
            value={innerFilterRadiusMm}
            step={0.5}
            min={0}
            max={30}
            onChange={(e) => setInnerFilterRadiusMm(Math.max(0, Number(e.target.value)))}
            style={{ width: 56 }}
          />
          <input
            type="range"
            min={0}
            max={20}
            step={0.5}
            value={innerFilterRadiusMm}
            onChange={(e) => setInnerFilterRadiusMm(Number(e.target.value))}
            style={{ width: 120 }}
          />
          mm
        </label>
        <button type="button" onClick={onResetFromTable}>↻ Reset from table</button>
        <button type="button" onClick={onCopy}>📋 Copy table line</button>
        <span style={{ fontSize: 11, opacity: 0.65 }} title="Mid-click marks one cluster. Ctrl/Alt + LEFT-drag draws a rectangle that marks every housing triangle whose centroid lands inside.">
          🖱 mid: delete · Shift = link · Ctrl = front · Alt = back · Ctrl/Alt + drag = box
        </span>
        {frontPartCentroids.size > 0 && (
          <button
            type="button"
            onClick={() => setFrontPartCentroids(new Set(savedFrontPart))}
            style={{ fontSize: 11, color: "#1d4ed8" }}
            title="Revert front-partition marks to last saved"
          >
            front ({frontPartCentroids.size}) ↻
          </button>
        )}
        {backPartCentroids.size > 0 && (
          <button
            type="button"
            onClick={() => setBackPartCentroids(new Set(savedBackPart))}
            style={{ fontSize: 11, color: "#b91c1c" }}
            title="Revert back-partition marks to last saved"
          >
            back ({backPartCentroids.size}) ↻
          </button>
        )}
        {deletedCentroids.size > 0 && (
          <button
            type="button"
            onClick={() => setDeletedCentroids(new Set(savedCentroids))}
            style={{ fontSize: 11 }}
            title="Reset deletions to last saved state (loses unsaved edits)"
          >
            ↻ Revert ({deletedCentroids.size})
          </button>
        )}
        <button
          type="button"
          onClick={onSaveDeletions}
          disabled={!anyDirty || saveStatus === "saving"}
          style={{
            fontSize: 11,
            background: anyDirty ? "#fde68a" : undefined,
            border: anyDirty ? "1px solid #ca8a04" : undefined,
            padding: "2px 8px",
          }}
          title="Persist current deletion set + linked rotation group to the component's properties so Lab viewer picks them up too."
        >
          {saveStatus === "saving" ? "Saving…"
            : saveStatus === "saved" ? "✓ Saved"
            : saveStatus === "error" ? "✗ Save failed"
            : anyDirty ? "💾 Save changes" : "💾 Saved"}
        </button>
        {(savedCentroids.size > 0 || deletedCentroids.size > 0
          || savedLinked || linkedCentroids.size > 0) && (
          <button
            type="button"
            onClick={onResetModel}
            disabled={saveStatus === "saving"}
            style={{
              fontSize: 11,
              color: "#b91c1c",
              border: "1px solid #fecaca",
              background: "transparent",
              padding: "2px 8px",
            }}
            title="Wipe all saved deletions and the link-rotation group — back to raw STL."
          >
            🔄 Reset model
          </button>
        )}
        {triangleCounts && (
          <span style={{ fontSize: 11, opacity: 0.7, marginLeft: "auto" }}>
            tris: {triangleCounts.raw}
            {triangleCounts.rendered !== triangleCounts.raw &&
              ` → ${triangleCounts.rendered}`}
          </span>
        )}
      </div>

      {/* Link-rotation control row — slider for angle + axis/pivot inputs.
          Shown whenever the group has at least 1 triangle so it doesn't
          clutter the header otherwise. */}
      {linkedCentroids.size > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11, flexWrap: "wrap", padding: "4px 0", borderTop: "1px solid #e5e7eb", borderBottom: "1px solid #e5e7eb" }}>
          <strong>🔗 Link rotation</strong>
          <span style={{ opacity: 0.7 }}>{linkedCentroids.size} tris</span>
          <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
            angle
            <input
              type="number"
              value={linkRotDeg}
              step={1}
              min={-180}
              max={180}
              onChange={(e) => setLinkRotDeg(Number(e.target.value))}
              style={{ width: 56 }}
            />
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={linkRotDeg}
              onChange={(e) => setLinkRotDeg(Number(e.target.value))}
              style={{ width: 150 }}
            />
            °
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 2 }}>
            axis
            {(["x", "y", "z"] as const).map((axis, i) => (
              <input
                key={axis}
                type="number"
                step={0.1}
                value={linkRotAxis[i]}
                onChange={(e) => {
                  const next: Vec3 = [...linkRotAxis];
                  next[i] = Number(e.target.value);
                  setLinkRotAxis(next);
                }}
                style={{ width: 48 }}
                title={`axis.${axis} (body-local)`}
              />
            ))}
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 2 }}>
            pivot
            {(["x", "y", "z"] as const).map((axis, i) => (
              <input
                key={axis}
                type="number"
                step={1}
                value={linkRotPivotMm[i]}
                onChange={(e) => {
                  const next: Vec3 = [...linkRotPivotMm];
                  next[i] = Number(e.target.value);
                  setLinkRotPivotMm(next);
                }}
                style={{ width: 56 }}
                title={`pivot.${axis} (body-local mm)`}
              />
            ))}
          </label>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            bind:
            {(["front_pbs", "back_pbs"] as const).map((name) => (
              <label
                key={name}
                style={{ display: "flex", alignItems: "center", gap: 2, cursor: "pointer", fontSize: 11 }}
                title={`Lock ${name}'s crystal pose to this link group — rotates together with the marked triangles`}
              >
                <input
                  type="checkbox"
                  checked={linkBoundAnchors.has(name)}
                  onChange={(e) => {
                    const next = new Set(linkBoundAnchors);
                    if (e.target.checked) next.add(name);
                    else next.delete(name);
                    setLinkBoundAnchors(next);
                  }}
                />
                {name === "front_pbs" ? "front" : "back"}
              </label>
            ))}
          </span>
          <button
            type="button"
            onClick={() => {
              setLinkedCentroids(new Set(savedLinked?.centroids ?? []));
              setLinkBoundAnchors(new Set(savedLinked?.boundAnchors ?? []));
              setLinkRotDeg(savedLinked?.rotationDeg ?? 0);
              setLinkRotAxis(savedLinked?.axis ?? [0, 0, 1]);
              setLinkRotPivotMm(savedLinked?.pivotMm ?? [0, 0, 0]);
            }}
            style={{ fontSize: 11 }}
            title="Revert link-rotation group to last saved"
          >
            ↻ Revert
          </button>
        </div>
      )}

      {/* Per-prism pose editor (Stage A''.11-followup).
          Glan-Laser variants frequently need free 3-axis Euler since
          their default optical-axis alignment can't be expressed by a
          single yRotationDeg. The "↻" button next to each Euler row
          collapses back to yRot mode (sets rotXYZ → null). */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", padding: "4px 0", borderTop: "1px solid #e5e7eb", fontSize: 11 }}>
        {(["front", "back"] as const).map((side) => {
          const pos = side === "front" ? frontPos : backPos;
          const setPos = side === "front" ? setFrontPos : setBackPos;
          const yRot = side === "front" ? frontYRot : backYRot;
          const setYRot = side === "front" ? setFrontYRot : setBackYRot;
          const rot = side === "front" ? frontRotXYZ : backRotXYZ;
          const setRot = side === "front" ? setFrontRotXYZ : setBackRotXYZ;
          return (
            <div key={side} style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <b style={{ minWidth: 38 }}>{side}</b>
              <span style={{ opacity: 0.6 }}>pos</span>
              {(["x", "y", "z"] as const).map((axis, i) => (
                <input
                  key={`p${axis}`}
                  type="number"
                  step={0.5}
                  value={pos[i]}
                  onChange={(e) => {
                    const next: Vec3 = [...pos];
                    next[i] = Number(e.target.value);
                    setPos(next);
                  }}
                  style={{ width: 50 }}
                  title={`${side}.pos.${axis} body-local mm`}
                />
              ))}
              {rot === null ? (
                <>
                  <span style={{ opacity: 0.6, marginLeft: 4 }}>yRot</span>
                  <input
                    type="number"
                    step={1}
                    value={yRot}
                    onChange={(e) => setYRot(Number(e.target.value))}
                    style={{ width: 50 }}
                    title={`${side}.yRotationDeg around body Y`}
                  />°
                  <button
                    type="button"
                    onClick={() => setRot([0, yRot, 0])}
                    style={{ fontSize: 10, marginLeft: 4 }}
                    title="Switch to 3-axis Euler (rotationDeg). Needed for Glan-Laser."
                  >
                    → rxryrz
                  </button>
                </>
              ) : (
                <>
                  <span style={{ opacity: 0.6, marginLeft: 4 }}>rotDeg</span>
                  {(["rx", "ry", "rz"] as const).map((axis, i) => (
                    <input
                      key={`r${axis}`}
                      type="number"
                      step={1}
                      value={rot[i]}
                      onChange={(e) => {
                        const next: Vec3 = [...rot];
                        next[i] = Number(e.target.value);
                        setRot(next);
                      }}
                      style={{ width: 50 }}
                      title={`${side}.rotationDeg.${axis} body-local (XYZ order)`}
                    />
                  ))}°
                  <button
                    type="button"
                    onClick={() => setRot(null)}
                    style={{ fontSize: 10, marginLeft: 4 }}
                    title="Switch back to single-axis yRotationDeg"
                  >
                    ↻ yRot
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", flex: 1, gap: 12, minHeight: 0 }}>
        <div style={{ flex: 2, position: "relative", minHeight: 400 }}>
          <div
            ref={mountRef}
            style={{ position: "absolute", inset: 0, background: "#fff", borderRadius: 4 }}
          />
          {/* Box-select rectangle overlay — updated imperatively via
              boxOverlayElRef from the pointer handlers. Fixed-position
              so the rect aligns with page-relative pointer coords. */}
          <div
            ref={boxOverlayElRef}
            style={{
              position: "fixed",
              display: "none",
              pointerEvents: "none",
              border: "1.5px dashed currentColor",
              boxSizing: "border-box",
              zIndex: 10,
            }}
          />
          {hitInfo && (
            <div
              style={{
                position: "absolute",
                left: 8,
                bottom: 8,
                maxWidth: 320,
                background: "rgba(15, 23, 42, 0.92)",
                color: "#e2e8f0",
                fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
                fontSize: 11,
                lineHeight: 1.4,
                padding: 10,
                borderRadius: 4,
                pointerEvents: "none",
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                Triangle hit — {hitInfo.which}
              </div>
              <div>centroid (mm):  ({hitInfo.centroidMm.map((n) => n.toFixed(2)).join(", ")})</div>
              <div>normal:         ({hitInfo.normalMmLocal.map((n) => n.toFixed(2)).join(", ")})</div>
              <div>dist from X axis: {hitInfo.distFromAxisMm.x.toFixed(2)} mm</div>
              <div>dist from Y axis: {hitInfo.distFromAxisMm.y.toFixed(2)} mm</div>
              <div>dist from Z axis: {hitInfo.distFromAxisMm.z.toFixed(2)} mm</div>
              <div>area:           {hitInfo.areaMm2.toFixed(3)} mm²</div>
              <div style={{ marginTop: 4, opacity: 0.7 }}>Click empty space to clear.</div>
            </div>
          )}
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, minWidth: 380 }}>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            Whole-file source of <code>pbsOverlay.ts</code>. Edits to the
            current model's <code>pos</code> / <code>yRotationDeg</code>
            flow into the 3D view live. Edits elsewhere (materials,
            geometry) are scratchpad — copy back to the file manually.
          </div>
          <textarea
            value={code}
            onChange={(e) => onCodeChange(e.target.value)}
            spellCheck={false}
            wrap="off"
            style={{
              flex: 1,
              fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
              fontSize: 11,
              lineHeight: 1.5,
              padding: 10,
              border: `1px solid ${parseStatus === "error" ? "#fda4af" : "#d0d4d9"}`,
              borderRadius: 4,
              outline: "none",
              resize: "none",
              minHeight: 320,
              whiteSpace: "pre",
              overflow: "auto",
            }}
          />
          <div style={{ fontSize: 11, color: statusColour }}>{statusText}</div>
          <div style={{ fontSize: 11, opacity: 0.6, lineHeight: 1.5 }}>
            <div><b>pos</b> body-local Z-up mm. z = along optical axis.</div>
            <div><b>yRotationDeg</b> 0° → cement normal [1, 1, 0]. 90° → [0, 1, -1].</div>
            <div>Use <b>📋 Copy table line</b> to grab the current row, then paste into the actual file.</div>
          </div>
        </div>
      </div>
    </div>
  );
}
