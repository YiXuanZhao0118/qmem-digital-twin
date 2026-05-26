/**
 * ComponentComposer — live-tweak page for a Component's binding tree
 * + per-asset STL partitioning. Today wired to the isolator preset
 * (model dropdown is isolator-only, 3D preview goes through
 * `buildThorlabsIsolatorObject`); planned to generalise to any composite
 * Component as later steps land (root picker / new mode / atomic save).
 *
 * Layout:
 *   ┌─ header ────────────────────────────────────────────────────┐
 *   │ Component composer  [Model ▼]  inner r<  partition toggles  │
 *   │                                          save / reset       │
 *   ├─ link rotation row (only when ≥1 linked tri) ───────────────┤
 *   ├─ Binding tree poses ────────────────────────────────────────┤
 *   │ root(body) / front_mount / front_pbs / front_piece /        │
 *   │ back_mount / back_pbs / back_piece                          │
 *   │ each row: pos[x,y,z] + rot[rx,ry,rz] + Apply button         │
 *   │ Apply PATCHes /api/component-bindings/{id} directly.        │
 *   ├─ 3D preview canvas (full width) ────────────────────────────┤
 *   │ STL housing + PBS / Glan-Laser overlay,                     │
 *   │ pose driven LIVE from in-progress `bindingEdits`.           │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Source of truth: ComponentBinding rows in the database. The page's
 * `bindingEdits` is the in-progress local-edit buffer; the 3D preview's
 * poseOverride is derived from it so edits show before the user clicks
 * Apply (which commits to the server).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

import {
  createComponentBindingApi,
  deleteComponentBindingApi,
  listComponentBindingsApi,
  resolveAssetUrl,
  updateComponentApi,
  updateComponentBindingApi,
} from "../api/client";
import { useSceneStore } from "../store/sceneStore";
import { mmToThree } from "../three/transformUtils";
import type { Asset3D, ComponentBinding, ComponentItem } from "../types/digitalTwin";
import {
  buildIsolatorPbsOverlay,
  buildThorlabsIsolatorObject,
  isolatorCentroidKey,
  ISOLATOR_PBS_DEFAULTS_BY_MODEL,
  type IsolatorLinkedRotationGroup,
  type IsolatorPrismType,
  type PbsPoseEntry,
} from "../kinds/isolator/pbsOverlay";
import { applyIncludeOnlyFilter } from "../three/loadAsset/viewerHints";
import { buildSceneObjectFromBindings } from "../three/bindingRendererGate";

// Model dropdown options. Static isolator list while the composer is
// isolator-only; later steps (root picker / new mode) will replace this
// with a dynamic component picker.
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
// Component
// ────────────────────────────────────────────────────────────────────────

export function ComponentComposer() {
  const scene = useSceneStore((s) => s.scene);
  const components = scene.components;
  const assets = scene.assets;

  // Composite components = any component whose binding tree has at least
  // one non-root binding (i.e. anything actually worth composing /
  // editing). Filters out the 280+ legacy single-asset components that
  // 0062 backfilled into one-row root-only trees.
  const compositeComponents = useMemo(() => {
    const cb = scene.componentBindings ?? [];
    const compositeIds = new Set<string>();
    for (const b of cb) if (b.parentBindingId !== null) compositeIds.add(b.componentId);
    return components.filter((c) => compositeIds.has(c.id))
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  }, [components, scene.componentBindings]);

  // Selected component id (the one being edited). Defaults to the
  // first composite, but if the user hasn't loaded a scene yet
  // (compositeComponents empty), falls back to the first isolator from
  // the static MODELS list so the legacy demo path still has something
  // to show.
  const [selectedComponentId, setSelectedComponentId] = useState<string>(() => {
    return compositeComponents[0]?.id
      ?? components.find((c) => c.model === MODELS[0])?.id
      ?? "";
  });

  // Derived from selectedComponentId — recomputes whenever the scene's
  // component list or the user's selection changes.
  const selectedComponent = useMemo(
    () => components.find((c) => c.id === selectedComponentId) ?? null,
    [components, selectedComponentId],
  );
  // Convenience flag for branching the renderer + showing isolator-only
  // editing UI (STL deletion, link rotation, partition marking).
  const isIsolator = selectedComponent?.kindId === "isolator";
  // `model` kept as a derived string for the isolator-side overlay
  // table lookup (ISOLATOR_PBS_DEFAULTS_BY_MODEL[model]) and for the
  // legacy code paths still keyed on the model name. Non-isolator
  // selections give `model = ""` which the table lookup safely misses.
  const model = selectedComponent?.model ?? "";
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

  // Preview visibility toggles (per-session, not persisted).
  //   partitionsVisible: false = front/back marked triangles get added
  //     to visibleDeletions (current default, lets click-through reach
  //     inner geometry). true = they stay rendered so the user can see
  //     what they've marked in context.
  //   opaqueHousing: false = housing renders at the translucent
  //     opacity=0.35 isolator look. true = fully opaque so the user
  //     can inspect the housing exterior without inner geometry
  //     bleeding through.
  const [partitionsVisible, setPartitionsVisible] = useState<boolean>(false);
  // Default opaque — matches the real metal-housing look. Toggle button
  // (top toolbar) lets the user drop to translucent (opacity 0.35) when
  // they want to inspect the internal prisms / partition marks.
  const [opaqueHousing, setOpaqueHousing] = useState<boolean>(true);

  // Binding tree panel state (Branch A — direct edit of binding rows).
  // Loaded once per model change via listComponentBindingsApi; each
  // row's pose is edited in ``bindingEdits`` (local until Apply →
  // updateComponentBindingApi → PATCH /api/component-bindings/{id}).
  // Lab viewer reflects on hard refresh today; WS broadcast for
  // binding updates is a follow-up commit.
  const [bindings, setBindings] = useState<ComponentBinding[] | null>(null);
  type PoseEdit = { x: number; y: number; z: number; rx: number; ry: number; rz: number };
  const [bindingEdits, setBindingEdits] = useState<Record<string, PoseEdit>>({});
  const [bindingApplyState, setBindingApplyState] = useState<Record<string, "idle" | "saving" | "saved" | "error">>({});

  const reloadBindings = useCallback(async (componentId: string | null) => {
    if (!componentId) {
      setBindings(null);
      setBindingEdits({});
      return;
    }
    try {
      const list = await listComponentBindingsApi(componentId);
      setBindings(list);
      const edits: Record<string, PoseEdit> = {};
      for (const b of list) {
        edits[b.id] = {
          x: b.localXMm, y: b.localYMm, z: b.localZMm,
          rx: b.localRxDeg, ry: b.localRyDeg, rz: b.localRzDeg,
        };
      }
      setBindingEdits(edits);
      setBindingApplyState({});
    } catch {
      setBindings(null);
      setBindingEdits({});
    }
  }, []);

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

  // Model change: seed isolator STL-specific state from the matched
  // Component's persisted `properties` (centroid sets, link rotation
  // group). Pose state used to be seeded from the static
  // ISOLATOR_PBS_DEFAULTS_BY_MODEL table here; after Step 1 the binding
  // tree's rows are the source of truth, so `reloadBindings` below is
  // sufficient.
  useEffect(() => {
    const component = selectedComponent;
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

    // Load binding tree poses for the Bindings panel.
    void reloadBindings(component?.id ?? null);

    setSaveStatus("idle");
  }, [selectedComponent, reloadBindings]);

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
    // Body-frame axes drawn directly on the three.js scene. The
    // bindings store body-local Z-up mm + XYZ-order Euler degrees, but
    // three.js is Y-up; the standard AxesHelper would label the
    // OPTICAL axis (three +Y) as "Y" which doesn't match what a binding
    // rxDeg/ryDeg/rzDeg field rotates around. Draw the body frame
    // instead so a label "Z" sits on the axis that binding rzDeg
    // actually rotates around.
    //   body X  →  three +X  (red)
    //   body Y  →  three -Z  (blue, points in three -Z direction)
    //   body Z  →  three +Y  (green, the optical / housing-long axis)
    const axisLen = mmToThree(120);
    const labelOff = mmToThree(135);
    const addBodyAxis = (
      label: string,
      color: string,
      endThree: [number, number, number],
      labelPos: [number, number, number],
    ) => {
      const geom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(...endThree),
      ]);
      const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color }));
      threeScene.add(line);
      const canvas = document.createElement("canvas");
      canvas.width = 96; canvas.height = 96;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = color;
      ctx.font = "bold 64px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, 48, 50);
      const tex = new THREE.CanvasTexture(canvas);
      tex.needsUpdate = true;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
      sprite.position.set(...labelPos);
      sprite.scale.setScalar(mmToThree(18));
      threeScene.add(sprite);
    };
    addBodyAxis("X", "#dc2626", [axisLen, 0, 0], [labelOff, 0, 0]);
    addBodyAxis("Y", "#2563eb", [0, 0, -axisLen], [0, 0, -labelOff]);
    addBodyAxis("Z", "#16a34a", [0, axisLen, 0], [0, labelOff, 0]);

    // ── Test beams (binding-dev only) ────────────────────────────────
    // Two virtual laser beams travelling along body +Y to validate the
    // GlanLaserCalcitePrism interactions while editing the IO-3-850-HP
    // binding tree. Drawn directly in body-frame; the composer's three
    // mapping is body X → +X, body Y → -Z, body Z → +Y.
    //
    //   beam_y5  : starts at body (0, 5,  0)   direction body +Y
    //   beam_y20 : starts at body (0, 20, 0)   direction body +Y
    //
    // Beam length in body-frame mm. Long enough to cross both Glan
    // slabs of any reasonable IO-*-HP binding-tree pose.
    const addTestBeam = (yStartMm: number, label: string, hueHex: string) => {
      const beamLengthMm = 120;
      // body (0, y, 0) → three (0, 0, -y/100); body +Y → three -Z.
      const startThree = new THREE.Vector3(0, 0, -mmToThree(yStartMm));
      const endThree = new THREE.Vector3(
        0,
        0,
        -mmToThree(yStartMm + beamLengthMm),
      );
      const geom = new THREE.BufferGeometry().setFromPoints([startThree, endThree]);
      const mat = new THREE.LineBasicMaterial({
        color: hueHex,
        linewidth: 2,
        transparent: true,
        opacity: 0.85,
      });
      const line = new THREE.Line(geom, mat);
      line.userData.__testBeam = label;
      threeScene.add(line);
      // Small sphere at the start point so the user sees where it emits.
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(mmToThree(1.5), 12, 12),
        new THREE.MeshBasicMaterial({ color: hueHex }),
      );
      dot.position.copy(startThree);
      threeScene.add(dot);
      // Floating label "Beam y=5" / "Beam y=20" at the start point.
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 64;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = hueHex;
      ctx.font = "bold 32px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, 8, 32);
      const tex = new THREE.CanvasTexture(canvas);
      tex.needsUpdate = true;
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tex, transparent: true }),
      );
      sprite.position.copy(startThree).add(new THREE.Vector3(mmToThree(3), mmToThree(3), 0));
      sprite.scale.set(mmToThree(40), mmToThree(10), 1);
      threeScene.add(sprite);
    };
    addTestBeam(5, "Beam y=5 → +Y", "#ef4444");
    addTestBeam(20, "Beam y=20 → +Y", "#f59e0b");

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

    // The 3D preview's prism poseOverride is derived from `bindingEdits`
    // below (the in-progress edits of the binding-tree rows). We always
    // pass `rotationDeg: [rx, ry, rz]` to the renderer — single-axis
    // yRotationDeg mode no longer has a UI control after Step 1, so the
    // Euler path is the only one. Anchors with `directionBodyLocal` are
    // intentionally omitted so the renderer's `spec.rotationDegBody`
    // branch fires (pbsOverlay.ts line ~396).

    const component = selectedComponent;
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

    if (!isIsolator && component) {
      // Generic path — any composite Component that isn't an isolator
      // goes through the binding-tree renderer (the same one the Lab
      // viewer uses). No STL editing affordances (centroid delete,
      // partition marking, link rotation) — those are isolator-only.
      void buildSceneObjectFromBindings(component, null, scene).then((obj) => {
        if (cancelled) return;
        threeScene.add(obj);
        modelGroupRef.current = obj;
        setTriangleCounts(null);
        refit();
      }).catch(() => { /* silent — empty scene if the tree can't load */ });
    } else if (asset && !asset.filePath.startsWith("primitive://") && component) {
      // Isolator STL path — load & wrap through the bespoke isolator
      // builder so STL editing tools (centroid delete, partition
      // marking, link rotation, PBS / Glan-Laser overlay) work.
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
        // Fake asset with empty anchors so the renderer falls back to
        // poseOverride for prism positions (anchor.positionMmBodyLocal
        // would otherwise win over poseOverride.pos — see pbsOverlay.ts
        // line ~383).
        const fakeAsset: Asset3D = {
          ...asset,
          anchors: [],
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
        // UX: front/back-marked triangles always get stripped from the
        // main housing. When partitionsVisible=false they're just hidden
        // (so mid-click can reach deeper geometry). When true they get
        // re-rendered below as separately-posed sub-meshes following
        // their front_piece / back_piece binding rows — same as the Lab
        // viewer's viewerHints.includeOnlyCentroids path.
        const visibleDeletions = new Set(deletedCentroids);
        for (const k of frontPartCentroids) visibleDeletions.add(k);
        for (const k of backPartCentroids) visibleDeletions.add(k);
        // Derive poseOverride from the in-progress binding edits — the
        // user's slider drags / number edits in the Binding tree poses
        // panel feed into the preview live, before they click Apply.
        // Falls back to the binding row's persisted pose when no edit
        // has been touched yet for that row.
        //
        // prismType is derived from role_label so HP variants (which
        // use Glan-Laser calcite prisms) render correctly. Without this,
        // the renderer defaults to pbs_cube for every PBS slot.
        const poseOverride: { front_pbs?: PbsPoseEntry; back_pbs?: PbsPoseEntry } = {};
        for (const b of bindings ?? []) {
          const role = (b.properties as { role_label?: string } | null)?.role_label;
          const slot: "front_pbs" | "back_pbs" | null =
            role === "front_glan_laser" || role === "front_pbs" ? "front_pbs"
            : role === "back_glan_laser" || role === "back_pbs" ? "back_pbs"
            : null;
          if (!slot) continue;
          const prismType: IsolatorPrismType = role && role.includes("glan_laser")
            ? "glan_laser" : "pbs_cube";
          const edit = bindingEdits[b.id];
          const pos: Vec3 = edit
            ? [edit.x, edit.y, edit.z]
            : [b.localXMm, b.localYMm, b.localZMm];
          const rot: Vec3 = edit
            ? [edit.rx, edit.ry, edit.rz]
            : [b.localRxDeg, b.localRyDeg, b.localRzDeg];
          poseOverride[slot] = { pos, rotationDeg: rot, prismType };
        }
        const group = buildThorlabsIsolatorObject(
          geometry, fakeComponent, fakeAsset,
          innerFilterRadiusMm, visibleDeletions, linkedGroup, poseOverride,
          opaqueHousing,
        );
        // Attach a small body-frame XYZ axis triad to each PBS / Glan-Laser
        // sub-group so the user can see how the front/back prism's local
        // frame is oriented after the binding rotation. Body axes:
        //   X (red)   → three +X
        //   Y (blue)  → three -Z
        //   Z (green) → three +Y
        // (mm units; the parent group's 1/100 scale converts to three).
        const overlayChild = group.children.find((c) => c.name === "isolator_pbs_overlay");
        if (overlayChild) {
          const addLocalAxis = (
            parent: THREE.Object3D,
            label: string,
            color: string,
            endMm: [number, number, number],
            labelPosMm: [number, number, number],
          ) => {
            const lineGeom = new THREE.BufferGeometry().setFromPoints([
              new THREE.Vector3(0, 0, 0),
              new THREE.Vector3(...endMm),
            ]);
            const line = new THREE.Line(
              lineGeom,
              new THREE.LineBasicMaterial({ color, depthTest: false }),
            );
            line.renderOrder = 10;
            parent.add(line);
            const canvas = document.createElement("canvas");
            canvas.width = 64; canvas.height = 64;
            const ctx = canvas.getContext("2d")!;
            ctx.fillStyle = color;
            ctx.font = "bold 44px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(label, 32, 34);
            const tex = new THREE.CanvasTexture(canvas);
            tex.needsUpdate = true;
            const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
              map: tex, transparent: true, depthTest: false,
            }));
            sprite.position.set(...labelPosMm);
            sprite.scale.setScalar(8);
            sprite.renderOrder = 11;
            parent.add(sprite);
          };
          for (const pbs of overlayChild.children) {
            addLocalAxis(pbs, "X", "#dc2626", [20, 0, 0], [25, 0, 0]);
            addLocalAxis(pbs, "Y", "#2563eb", [0, 0, -20], [0, 0, -25]);
            addLocalAxis(pbs, "Z", "#16a34a", [0, 20, 0], [0, 25, 0]);
          }
        }
        // Render front_piece / back_piece partitions as separately-posed
        // sub-meshes so binding-row edits on those rows visibly move the
        // marked tris in the dev preview (matches the Lab viewer's
        // behavior where each piece is its own Asset3D positioned by its
        // ComponentBinding). Position is body-local mm (parent group's
        // scale 1/100 converts to three units); rotation is XYZ Euler
        // degrees as the rest of this page treats it.
        if (partitionsVisible) {
          const bindingFor = (label: string): ComponentBinding | undefined =>
            bindings?.find((b) =>
              (b.properties as { role_label?: string } | null)?.role_label === label,
            );
          // For the prism's "current" rotation we read the in-progress
          // `bindingEdits` entry — the user's slider drags propagate
          // live to the piece's delta rotation. Piece pose is read from
          // the binding row directly (its bindingEdits, if any).
          const currentRotFor = (b: ComponentBinding | undefined): Vec3 => {
            if (!b) return [0, 0, 0];
            const e = bindingEdits[b.id];
            return e ? [e.rx, e.ry, e.rz] : [b.localRxDeg, b.localRyDeg, b.localRzDeg];
          };
          // Pieces preserve their OWN binding pose as a baseline and
          // rotate together with the prism only by the DELTA the user
          // applied via the binding row. So if front_piece was at
          // (0, 0, 0) and front_glan_laser at (0, 270, 0), dragging the
          // slider to (0, 280, 0) shifts both by +10° around Y — piece
          // ends up at (0, 10, 0), glan_laser at (0, 280, 0). The
          // relative offset (270° between them) is kept.
          const toRad = THREE.MathUtils.degToRad;
          const bindingToQuat = (rxDeg: number, ryDeg: number, rzDeg: number): THREE.Quaternion => {
            // Same body-frame mapping as pbsOverlay's overlay builder
            // (rx→three.x, rz→three.y, -ry→three.z) with XYZ Euler so
            // pieces and glan_lasers interpret a binding identically.
            const e = new THREE.Euler(toRad(rxDeg), toRad(rzDeg), toRad(-ryDeg), "XYZ");
            return new THREE.Quaternion().setFromEuler(e);
          };
          const frontPrism = bindingFor("front_glan_laser") ?? bindingFor("front_pbs");
          const backPrism = bindingFor("back_glan_laser") ?? bindingFor("back_pbs");
          const sides: ReadonlyArray<{
            side: "front" | "back";
            tris: Set<string>;
            pieceBinding: ComponentBinding | undefined;
            prismBinding: ComponentBinding | undefined;
            color: string;
            currentRot: Vec3;
          }> = [
            { side: "front", tris: frontPartCentroids,
              pieceBinding: bindingFor("front_piece"),
              prismBinding: frontPrism,
              color: "#1a1a1c",
              currentRot: currentRotFor(frontPrism) },
            { side: "back", tris: backPartCentroids,
              pieceBinding: bindingFor("back_piece"),
              prismBinding: backPrism,
              color: "#1a1a1c",
              currentRot: currentRotFor(backPrism) },
          ];
          for (const { tris, pieceBinding, prismBinding, color, currentRot } of sides) {
            if (tris.size === 0 || !pieceBinding) continue;
            const subGeom = applyIncludeOnlyFilter(geometry, tris);
            const mat = new THREE.MeshStandardMaterial({
              color,
              metalness: 0.55,
              roughness: 0.5,
              transparent: !opaqueHousing,
              opacity: opaqueHousing ? 1 : 0.35,
              depthWrite: opaqueHousing,
            });
            const mesh = new THREE.Mesh(subGeom, mat);
            mesh.position.set(pieceBinding.localXMm, pieceBinding.localYMm, pieceBinding.localZMm);
            // Q_piece = Q_delta * Q_pieceBaseline, where
            //   Q_delta = Q_currentPrism * Q_prismBaseline^-1
            // When the slider hasn't moved (currentRot === prismBinding),
            // Q_delta is identity → piece sits at its own binding pose,
            // preserving the relative angle the user set up. Dragging the
            // slider applies the same delta rotation to both prism and
            // piece, keeping their relative orientation locked.
            const qPieceBase = bindingToQuat(pieceBinding.localRxDeg, pieceBinding.localRyDeg, pieceBinding.localRzDeg);
            if (prismBinding) {
              const qPrismBase = bindingToQuat(prismBinding.localRxDeg, prismBinding.localRyDeg, prismBinding.localRzDeg);
              const qCurrent = bindingToQuat(currentRot[0], currentRot[1], currentRot[2]);
              const qDelta = qCurrent.clone().multiply(qPrismBase.clone().invert());
              mesh.quaternion.copy(qDelta.multiply(qPieceBase));
            } else {
              mesh.quaternion.copy(qPieceBase);
            }
            group.add(mesh);
          }
        }
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
        { id: "fake", name: "fake", assetType: "primitive", filePath: "primitive://box", unit: "mm", scaleFactor: 1, anchors: [] },
        { housingLengthMm: lenMm, opticalAxisBody: "z", unitScale: mmToThree(1) },
      );
      group.add(overlay);
      threeScene.add(group);
      modelGroupRef.current = group;
      refit();
    }

    return () => { cancelled = true; };
  }, [
    selectedComponent, isIsolator, scene, assets,
    innerFilterRadiusMm, deletedCentroids,
    linkedCentroids, linkRotDeg, linkRotAxis, linkRotPivotMm, linkBoundAnchors,
    frontPartCentroids, backPartCentroids,
    partitionsVisible, opaqueHousing,
    bindings, bindingEdits,
  ]);

  // ── Binding tree edit handlers (Branch A) ────────────────────────────
  const setBindingEditField = (
    bindingId: string,
    field: keyof PoseEdit,
    value: number,
  ) => {
    setBindingEdits((prev) => ({
      ...prev,
      [bindingId]: { ...prev[bindingId], [field]: value },
    }));
    setBindingApplyState((prev) => ({ ...prev, [bindingId]: "idle" }));
  };
  const applyBindingEdit = async (bindingId: string) => {
    const edit = bindingEdits[bindingId];
    if (!edit) return;
    setBindingApplyState((prev) => ({ ...prev, [bindingId]: "saving" }));
    try {
      await updateComponentBindingApi(bindingId, {
        localXMm: edit.x, localYMm: edit.y, localZMm: edit.z,
        localRxDeg: edit.rx, localRyDeg: edit.ry, localRzDeg: edit.rz,
      });
      setBindingApplyState((prev) => ({ ...prev, [bindingId]: "saved" }));
      // Refetch so any server-side normalisation lands locally too —
      // bindings list is the persisted truth, bindingEdits the in-progress
      // edits. The preview's poseOverride is derived from bindingEdits so
      // it already reflected the new values before Apply; this refetch
      // just keeps the persisted-side in sync.
      const component = selectedComponent;
      if (component) await reloadBindings(component.id);
    } catch {
      setBindingApplyState((prev) => ({ ...prev, [bindingId]: "error" }));
    }
  };
  /** Apply every dirty binding-row edit in one go. PATCHes run in
   *  parallel; failures are recorded per-row so the user sees which one
   *  blew up. Useful when re-tuning a whole component (e.g. shifting
   *  front_glan_laser + back_glan_laser after the Glan-Laser asset got
   *  geometry-adjusted) without clicking Apply on every row. */
  const applyAllDirtyBindings = async () => {
    if (!bindings) return;
    const dirty = bindings.filter((b) => {
      const e = bindingEdits[b.id];
      if (!e) return false;
      return e.x !== b.localXMm || e.y !== b.localYMm || e.z !== b.localZMm
        || e.rx !== b.localRxDeg || e.ry !== b.localRyDeg || e.rz !== b.localRzDeg;
    });
    if (dirty.length === 0) return;
    setBindingApplyState((prev) => {
      const next = { ...prev };
      for (const b of dirty) next[b.id] = "saving";
      return next;
    });
    const results = await Promise.allSettled(
      dirty.map((b) => {
        const e = bindingEdits[b.id]!;
        return updateComponentBindingApi(b.id, {
          localXMm: e.x, localYMm: e.y, localZMm: e.z,
          localRxDeg: e.rx, localRyDeg: e.ry, localRzDeg: e.rz,
        });
      }),
    );
    setBindingApplyState((prev) => {
      const next = { ...prev };
      results.forEach((r, i) => {
        next[dirty[i].id] = r.status === "fulfilled" ? "saved" : "error";
      });
      return next;
    });
    const component = selectedComponent;
    if (component) await reloadBindings(component.id);
  };
  /** Count of dirty (locally-edited, unsaved) binding rows. Drives the
   *  "Save all" button's badge + disabled state. */
  const dirtyBindingCount = useMemo(() => {
    if (!bindings) return 0;
    let n = 0;
    for (const b of bindings) {
      const e = bindingEdits[b.id];
      if (!e) continue;
      if (e.x !== b.localXMm || e.y !== b.localYMm || e.z !== b.localZMm
        || e.rx !== b.localRxDeg || e.ry !== b.localRyDeg || e.rz !== b.localRzDeg) {
        n += 1;
      }
    }
    return n;
  }, [bindings, bindingEdits]);
  const bindingDisplayLabel = (b: ComponentBinding): string => {
    const role = (b.properties as { role_label?: string } | null)?.role_label;
    if (role) return role;
    if (b.parentBindingId === null) return "root (body)";
    return `${b.role} (${b.targetKind})`;
  };

  // ── Add-child binding state (Step 2) ─────────────────────────────────
  // `addChildOpenFor` holds the parent binding id whose inline "+"
  // form is currently open (null = no form open). Only one form open
  // at a time keeps the UI quiet. Form state lives in `addChildDraft`;
  // submitting POSTs /api/components/{id}/bindings then refreshes the
  // tree.
  type AddChildKind = "asset" | "subcomponent" | "empty";
  type AddChildDraft = {
    targetKind: AddChildKind;
    asset3dId: string;
    subComponentId: string;
    roleLabel: string;
  };
  const [addChildOpenFor, setAddChildOpenFor] = useState<string | null>(null);
  const [addChildDraft, setAddChildDraft] = useState<AddChildDraft>({
    targetKind: "asset",
    asset3dId: "",
    subComponentId: "",
    roleLabel: "",
  });
  const [addChildStatus, setAddChildStatus] = useState<"idle" | "saving" | "error">("idle");
  const [deleteBindingStatus, setDeleteBindingStatus] = useState<Record<string, "idle" | "saving" | "error">>({});

  const openAddChildForm = (parentBindingId: string) => {
    setAddChildOpenFor(parentBindingId);
    setAddChildDraft({
      targetKind: "asset",
      asset3dId: assets[0]?.id ?? "",
      subComponentId: "",
      roleLabel: "",
    });
    setAddChildStatus("idle");
  };

  const submitAddChild = async (parentBindingId: string) => {
    const component = selectedComponent;
    if (!component) return;
    const draft = addChildDraft;
    // Validate per-target-kind required fields up-front so we don't
    // round-trip an obviously-bad POST. Backend's CHECK constraint +
    // Pydantic validator would also catch this but the inline UX is
    // cleaner if we refuse early.
    if (draft.targetKind === "asset" && !draft.asset3dId) {
      setAddChildStatus("error");
      return;
    }
    if (draft.targetKind === "subcomponent" && !draft.subComponentId) {
      setAddChildStatus("error");
      return;
    }
    setAddChildStatus("saving");
    try {
      await createComponentBindingApi(component.id, {
        parentBindingId,
        targetKind: draft.targetKind,
        asset3dId: draft.targetKind === "asset" ? draft.asset3dId : null,
        subComponentId: draft.targetKind === "subcomponent" ? draft.subComponentId : null,
        role: draft.roleLabel || "child",
        properties: draft.roleLabel ? { role_label: draft.roleLabel } : {},
      });
      setAddChildOpenFor(null);
      await reloadBindings(component.id);
    } catch {
      setAddChildStatus("error");
    }
  };

  const deleteBinding = async (b: ComponentBinding) => {
    const component = selectedComponent;
    if (!component) return;
    const label = bindingDisplayLabel(b);
    if (!window.confirm(`Delete binding "${label}"? Child bindings will cascade.`)) return;
    setDeleteBindingStatus((prev) => ({ ...prev, [b.id]: "saving" }));
    try {
      await deleteComponentBindingApi(b.id);
      await reloadBindings(component.id);
    } catch {
      setDeleteBindingStatus((prev) => ({ ...prev, [b.id]: "error" }));
    }
  };
  /** Sort bindings into the canonical "5-element" reading order:
   *  root → front_mount → front_pbs → front_piece → back_mount →
   *  back_pbs → back_piece. Anything else falls to the bottom. */
  const sortedBindings = useMemo(() => {
    if (!bindings) return null;
    const order = (b: ComponentBinding): number => {
      if (b.parentBindingId === null) return 0;
      const role = (b.properties as { role_label?: string } | null)?.role_label ?? "";
      const map: Record<string, number> = {
        front_mount: 1, front_pbs: 2, front_glan_laser: 2, front_piece: 3,
        back_mount: 4, back_pbs: 5, back_glan_laser: 5, back_piece: 6,
      };
      return map[role] ?? 99;
    };
    return [...bindings].sort((a, b) => order(a) - order(b));
  }, [bindings]);

  // ── Handlers ─────────────────────────────────────────────────────────
  // Persist current deletion set + linked rotation group to
  // `component.properties` so Lab viewer + next dev-page session pick
  // them up automatically.
  const onSaveDeletions = async () => {
    const component = selectedComponent;
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
    const component = selectedComponent;
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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: 12, gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <strong>Component composer</strong>
        <label>
          Edit component:{" "}
          <select
            value={selectedComponentId}
            onChange={(e) => setSelectedComponentId(e.target.value)}
            style={{ maxWidth: 260 }}
          >
            {compositeComponents.length === 0 && (
              <option value="">— no composite components in scene —</option>
            )}
            {compositeComponents.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} {c.model ? `· ${c.model}` : ""} ({c.kindId ?? ""})
              </option>
            ))}
          </select>
        </label>
        {selectedComponent
          ? (
            <span style={{ fontSize: 11, opacity: 0.7 }} title={`Component ${selectedComponent.id}`}>
              ✎ editing&nbsp;<b>{selectedComponent.name}</b>&nbsp;
              <span style={{ opacity: 0.7 }}>({selectedComponent.kindId ?? ""})</span>
            </span>
          ) : (
            <span style={{ fontSize: 11, color: "#b91c1c" }} title="No component selected — pick one from the dropdown">
              ⚠ no component selected
            </span>
          )}
        {isIsolator && (<>
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
        <span style={{ fontSize: 11, opacity: 0.65 }} title="Mid-click marks one cluster. Ctrl/Alt + LEFT-drag draws a rectangle that marks every housing triangle whose centroid lands inside.">
          🖱 mid: delete · Shift = link · Ctrl = front · Alt = back · Ctrl/Alt + drag = box
        </span>
        <button
          type="button"
          onClick={() => setPartitionsVisible((v) => !v)}
          style={{
            fontSize: 11,
            background: partitionsVisible ? "#dcfce7" : undefined,
            border: partitionsVisible ? "1px solid #16a34a" : undefined,
            padding: "2px 8px",
          }}
          title="Show the front/back (part 1 & 3) marked triangles back in the preview. Off by default so mid-click can reach deeper geometry."
        >
          {partitionsVisible ? "👁 Parts 1&3 shown" : "👁 Show parts 1&3"}
        </button>
        <button
          type="button"
          onClick={() => setOpaqueHousing((v) => !v)}
          style={{
            fontSize: 11,
            background: opaqueHousing ? "#dcfce7" : undefined,
            border: opaqueHousing ? "1px solid #16a34a" : undefined,
            padding: "2px 8px",
          }}
          title="Render the housing fully opaque instead of the default translucent (0.35) look."
        >
          {opaqueHousing ? "◼ Opaque" : "◻ Make opaque"}
        </button>
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
        </>)}
        {!isIsolator && selectedComponent && (
          <span style={{ fontSize: 11, opacity: 0.55, marginLeft: "auto" }} title="STL editing tools (centroid delete / partition / link rotation) are isolator-only. Other composite components render via the generic binding tree.">
            generic binding tree mode · no STL editing
          </span>
        )}
      </div>

      {/* Link-rotation control row — slider for angle + axis/pivot inputs.
          Shown whenever the group has at least 1 triangle so it doesn't
          clutter the header otherwise. */}
      {isIsolator && linkedCentroids.size > 0 && (
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

      {/* Binding tree pose editor (Branch A — direct edit of the
          ComponentBinding rows). Each row PATCHes
          /api/component-bindings/{id} on Apply. Lab viewer reflects
          changes on hard refresh today; WS broadcast for binding
          updates is a follow-up. */}
      {sortedBindings && sortedBindings.length > 0 && (
        <div style={{
          padding: "6px 0", borderTop: "1px solid #e5e7eb",
          fontSize: 11, display: "flex", flexDirection: "column", gap: 4,
        }}>
          <div style={{ fontWeight: 600, opacity: 0.7, display: "flex", alignItems: "center", gap: 8 }}>
            Binding tree poses ({sortedBindings.length})
            <button
              type="button"
              onClick={() => void applyAllDirtyBindings()}
              disabled={dirtyBindingCount === 0}
              style={{
                fontSize: 11,
                padding: "1px 8px",
                background: dirtyBindingCount > 0 ? "#fde68a" : undefined,
                border: dirtyBindingCount > 0 ? "1px solid #ca8a04" : "1px solid #d1d5db",
              }}
              title="PATCH every row whose pos/rot has been locally edited but not yet Applied. Runs in parallel."
            >
              {dirtyBindingCount > 0
                ? `💾 Save all (${dirtyBindingCount})`
                : "💾 Saved"}
            </button>
            <span style={{ fontSize: 10, opacity: 0.6, fontWeight: 400 }}>
              edits PATCH the binding row directly · Lab viewer needs hard-refresh until WS sync lands
            </span>
          </div>
          {sortedBindings.map((b) => {
            const edit = bindingEdits[b.id];
            if (!edit) return null;
            const applyState = bindingApplyState[b.id] ?? "idle";
            const dirty = edit.x !== b.localXMm || edit.y !== b.localYMm || edit.z !== b.localZMm
              || edit.rx !== b.localRxDeg || edit.ry !== b.localRyDeg || edit.rz !== b.localRzDeg;
            return (
              <div key={b.id} style={{
                display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4,
                opacity: b.parentBindingId === null ? 0.7 : 1, // root usually identity
              }}>
                <b style={{ minWidth: 110, color: b.targetKind === "asset" ? "#1d4ed8"
                  : b.targetKind === "subcomponent" ? "#15803d"
                  : "#7c3aed" }}>
                  {bindingDisplayLabel(b)}
                </b>
                <span style={{ opacity: 0.55 }}>{b.targetKind}</span>
                <span style={{ opacity: 0.6, marginLeft: 4 }}>pos</span>
                {(["x", "y", "z"] as const).map((axis) => (
                  <input
                    key={`p${axis}`}
                    type="number"
                    step={0.5}
                    value={edit[axis]}
                    onChange={(e) => setBindingEditField(b.id, axis, Number(e.target.value))}
                    style={{ width: 56 }}
                    title={`${bindingDisplayLabel(b)}.local_${axis}_mm`}
                  />
                ))}
                <span style={{ opacity: 0.6, marginLeft: 4 }}>rot</span>
                {(["rx", "ry", "rz"] as const).map((axis) => (
                  <input
                    key={`r${axis}`}
                    type="number"
                    step={1}
                    value={edit[axis]}
                    onChange={(e) => setBindingEditField(b.id, axis, Number(e.target.value))}
                    style={{ width: 56 }}
                    title={`${bindingDisplayLabel(b)}.local_${axis}_deg (XYZ order)`}
                  />
                ))}°
                <button
                  type="button"
                  onClick={() => applyBindingEdit(b.id)}
                  disabled={!dirty || applyState === "saving"}
                  style={{
                    fontSize: 11, marginLeft: 4, padding: "1px 8px",
                    background: dirty ? "#fde68a" : undefined,
                    border: dirty ? "1px solid #ca8a04" : "1px solid #d1d5db",
                  }}
                  title="PATCH this binding's local_*_mm/deg to the server"
                >
                  {applyState === "saving" ? "…"
                    : applyState === "saved" ? "✓"
                    : applyState === "error" ? "✗"
                    : "Apply"}
                </button>
                {Object.keys(b.tunableAxes).length > 0 && (
                  <span style={{ fontSize: 10, opacity: 0.55, marginLeft: 4 }}>
                    tunable: {Object.keys(b.tunableAxes).join(",")}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => openAddChildForm(b.id)}
                  style={{
                    fontSize: 11, marginLeft: 4, padding: "1px 6px",
                    background: addChildOpenFor === b.id ? "#dcfce7" : undefined,
                    border: "1px solid #d1d5db",
                  }}
                  title="Add a child binding under this one"
                >
                  + child
                </button>
                {b.parentBindingId !== null && (
                  <button
                    type="button"
                    onClick={() => void deleteBinding(b)}
                    disabled={deleteBindingStatus[b.id] === "saving"}
                    style={{
                      fontSize: 11, marginLeft: 2, padding: "1px 6px",
                      color: "#b91c1c", border: "1px solid #fecaca", background: "transparent",
                    }}
                    title="Delete this binding (cascades to its descendants)"
                  >
                    {deleteBindingStatus[b.id] === "saving" ? "…"
                      : deleteBindingStatus[b.id] === "error" ? "✗" : "🗑"}
                  </button>
                )}
              </div>
            );
          })}

          {/* Inline + child form. Single instance — only one parent
              binding may have the form open at a time. */}
          {addChildOpenFor && sortedBindings.some((b) => b.id === addChildOpenFor) && (() => {
            const parent = sortedBindings.find((b) => b.id === addChildOpenFor)!;
            const draft = addChildDraft;
            const setDraft = (patch: Partial<AddChildDraft>) => setAddChildDraft({ ...draft, ...patch });
            return (
              <div style={{
                marginLeft: 24, marginTop: 4, padding: 8,
                background: "#f3f4f6", borderLeft: "2px solid #16a34a", borderRadius: 4,
                display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, fontSize: 11,
              }}>
                <b style={{ color: "#15803d" }}>+ child of {bindingDisplayLabel(parent)}</b>
                <label>
                  kind:&nbsp;
                  <select
                    value={draft.targetKind}
                    onChange={(e) => setDraft({ targetKind: e.target.value as AddChildKind })}
                  >
                    <option value="asset">asset</option>
                    <option value="subcomponent">subcomponent</option>
                    <option value="empty">empty (transform-only)</option>
                  </select>
                </label>
                {draft.targetKind === "asset" && (
                  <label>
                    asset:&nbsp;
                    <select
                      value={draft.asset3dId}
                      onChange={(e) => setDraft({ asset3dId: e.target.value })}
                      style={{ maxWidth: 220 }}
                    >
                      <option value="">— pick —</option>
                      {assets.map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                  </label>
                )}
                {draft.targetKind === "subcomponent" && (
                  <label>
                    component:&nbsp;
                    <select
                      value={draft.subComponentId}
                      onChange={(e) => setDraft({ subComponentId: e.target.value })}
                      style={{ maxWidth: 240 }}
                    >
                      <option value="">— pick —</option>
                      {components
                        .filter((c) => c.id !== selectedComponentId)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name} {c.model ? `(${c.model})` : `(${c.kindId ?? ""})`}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                <label>
                  role:&nbsp;
                  <input
                    type="text"
                    value={draft.roleLabel}
                    onChange={(e) => setDraft({ roleLabel: e.target.value })}
                    placeholder="e.g. front_mount"
                    style={{ width: 140 }}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void submitAddChild(addChildOpenFor!)}
                  disabled={addChildStatus === "saving"}
                  style={{
                    fontSize: 11, padding: "1px 8px",
                    background: "#86efac", border: "1px solid #16a34a",
                  }}
                >
                  {addChildStatus === "saving" ? "Saving…"
                    : addChildStatus === "error" ? "✗ Retry" : "Create"}
                </button>
                <button
                  type="button"
                  onClick={() => setAddChildOpenFor(null)}
                  style={{ fontSize: 11, padding: "1px 8px" }}
                >
                  Cancel
                </button>
                <span style={{ fontSize: 10, opacity: 0.6 }}>
                  pos / rot default to identity — adjust in the row after creation
                </span>
              </div>
            );
          })()}
        </div>
      )}

      {/* 3D preview canvas — full-width after the textarea pane was
          removed in the Step 1 refactor. Pose edits flow from the
          Binding tree poses panel above into `bindingEdits`, which the
          rebuild useEffect turns into `poseOverride` for the renderer. */}
      <div style={{ display: "flex", flex: 1, gap: 12, minHeight: 0 }}>
        <div style={{ flex: 1, position: "relative", minHeight: 400 }}>
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
      </div>
    </div>
  );
}
