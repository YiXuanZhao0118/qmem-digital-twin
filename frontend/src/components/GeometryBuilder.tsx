/**
 * Geometry construction page (Asset-layer M2 §B). A PhyEditor tab, independent of
 * the anchor editor. Each source (uploaded STEP / picked asset) is ONE unit with
 * its own position + rotation + removable sub-meshes; preview/export is the merge
 * of the included, transformed sources, coloured, saved as a viewer-ready GLB via
 * the existing upload route (no server-side CAD conversion). Decimate live
 * (meshoptimizer). Anchors are placed afterwards in the ASSET3D tab.
 *
 * Region editing (§B-3 / III-4, mirrors the Asset3DEditor cluster tooling, but
 * here deletions are BAKED into the exported GLB rather than stored as a runtime
 * viewerHint): Ctrl+mid-click deletes a coplanar cluster, Ctrl+mid-drag box-
 * deletes; Shift+mid locks ("keep") clusters so a box-delete skips them. Locks
 * are UI-only; Save only commits deletions. Cluster picks raycast a full-res
 * (un-decimated) hidden mesh so centroid keys stay stable while decimating.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Save } from "lucide-react";

import occtWasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";

import { importStep, occtMeshToGeometry, type OcctLocateFile } from "../three/occtImport";
import { exportGlb, geometryToColoredMesh, glbToFile, mergeColoredGeometries } from "../three/glbExport";
import { decimateWelded, estimateGlbBytes, triangleCount, weldForSimplify } from "../three/decimate";
import { loadAssetGeometry, type LoadedSubMesh } from "../three/loadAssetGeometry";
import { centroidKey, findCoplanarCluster } from "../three/loadAsset/viewerHints";
import { resolveAssetUrl } from "../api/client";
import { useV3Catalog, type V3AssetUsage } from "../store/catalogStore";
import {
  ASIDE_STYLE,
  ASIDE_WIDTH,
  BORDER_LIGHT,
  BORDER_STRONG,
  ICON_BUTTON,
  INPUT,
  MAIN_HEADER_STYLE,
  MUTED,
  PRIMARY_BUTTON,
  SECTION_LABEL,
  SELECTED,
  SHELL_BG,
  SHELL_COLOR,
} from "./phyEditorTheme";

const locateOcctWasm: OcctLocateFile = (path) => (path.endsWith(".wasm") ? occtWasmUrl : path);

const PRESETS: { label: string; tris: number }[] = [
  { label: "Detail", tris: 300_000 },
  { label: "Balanced", tris: 100_000 },
  { label: "Light", tris: 30_000 },
];

const VIEWER_EXTS = new Set(["glb", "gltf", "obj", "stl"]);
const DRAG_THRESHOLD_PX = 5;

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
}

function extOf(pathOrType: string): string {
  return (pathOrType.split("?")[0].split(".").pop() ?? pathOrType).toLowerCase();
}

type Status = "idle" | "parsing" | "ready" | "saving";
type SubMesh = { id: string; label: string; included: boolean };
type Source = {
  id: string;
  label: string;
  included: boolean;
  expanded: boolean;
  tx: number; ty: number; tz: number;
  rx: number; ry: number; rz: number;
  subMeshes: SubMesh[];
};

function hasTransform(s: Source): boolean {
  return s.tx || s.ty || s.tz || s.rx || s.ry || s.rz ? true : false;
}

/** Merge a list of geometries into one, disposing the inputs (single → as-is). */
function mergeAndDispose(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (geoms.length === 1) return geoms[0];
  const merged = mergeColoredGeometries(geoms);
  for (const g of geoms) if (g !== merged) g.dispose();
  return merged;
}

/** Colour-preserving triangle filter keyed on the 0.5 mm centroid grid
 *  (same key as findCoplanarCluster / box-select). mode "drop" removes
 *  triangles whose centroid is in `keys`; "only" keeps only those. */
function filterColored(
  geom: THREE.BufferGeometry,
  keys: ReadonlySet<string>,
  mode: "drop" | "only",
): THREE.BufferGeometry {
  const pos = geom.attributes.position.array as Float32Array;
  const col = geom.attributes.color?.array as Float32Array | undefined;
  const triCount = Math.floor(pos.length / 9);
  const oPos: number[] = [];
  const oCol: number[] = [];
  for (let t = 0; t < triCount; t += 1) {
    const o = t * 9;
    const cx = (pos[o] + pos[o + 3] + pos[o + 6]) / 3;
    const cy = (pos[o + 1] + pos[o + 4] + pos[o + 7]) / 3;
    const cz = (pos[o + 2] + pos[o + 5] + pos[o + 8]) / 3;
    const inSet = keys.has(centroidKey(cx, cy, cz));
    if (mode === "drop" ? inSet : !inSet) continue;
    for (let k = 0; k < 9; k += 1) {
      oPos.push(pos[o + k]);
      if (col) oCol.push(col[o + k]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(oPos, 3));
  if (col && oCol.length) g.setAttribute("color", new THREE.Float32BufferAttribute(oCol, 3));
  g.computeVertexNormals();
  return g;
}

export function GeometryBuilder() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const modelGroupRef = useRef<THREE.Group | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const subGeomsRef = useRef<Map<string, THREE.BufferGeometry>>(new Map()); // subMeshId -> geom
  const idRef = useRef(0);
  const composedFullRef = useRef<THREE.BufferGeometry | null>(null); // merged, transformed, coloured (no deletions)
  const editGeomRef = useRef<THREE.BufferGeometry | null>(null);     // composedFull minus deletions (full-res, pick mesh)
  const weldedEditRef = useRef<THREE.BufferGeometry | null>(null);   // weld of editGeom for decimation
  const decimatedRef = useRef<THREE.BufferGeometry | null>(null);    // decimated display geom (or null = full-res)
  const displayGeomRef = useRef<THREE.BufferGeometry | null>(null);  // geom currently shown (editGeom or decimated)
  const lockGeomRef = useRef<THREE.BufferGeometry | null>(null);     // green overlay (locked subset)
  const pickMeshRef = useRef<THREE.Mesh | null>(null);
  const sourceTrisRef = useRef(0);
  const [editNonce, setEditNonce] = useState(0);

  // Origin axes + left-click "measure" pick (face-cluster centre → origin).
  const axesRef = useRef<THREE.AxesHelper | null>(null);
  const faceMarkerRef = useRef<THREE.Mesh | null>(null);
  const faceLineRef = useRef<THREE.Line | null>(null);
  const [facePick, setFacePick] = useState<
    { x: number; y: number; z: number; dist: number } | null
  >(null);
  const clearFacePick = useCallback(() => {
    if (faceMarkerRef.current) faceMarkerRef.current.visible = false;
    if (faceLineRef.current) faceLineRef.current.visible = false;
    setFacePick(null);
  }, []);

  const uploadAsset = useV3Catalog((s) => s.uploadAsset);
  const updateAssetGeometry = useV3Catalog((s) => s.updateAssetGeometry);
  const fetchAssetUsage = useV3Catalog((s) => s.fetchAssetUsage);
  const assets = useV3Catalog((s) => s.assets);
  const refreshCatalog = useV3Catalog((s) => s.refresh);

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [existingPick, setExistingPick] = useState("");
  const [editingCatalogId, setEditingCatalogId] = useState<string | null>(null);
  const [editUsage, setEditUsage] = useState<V3AssetUsage | null>(null);
  const [catalogId, setCatalogId] = useState("");
  const [name, setName] = useState("");
  const [domain, setDomain] = useState<"optical" | "rf" | "mechanical">("mechanical");
  const [sourceTris, setSourceTris] = useState(0);
  const [displayTris, setDisplayTris] = useState(0);
  const [estMB, setEstMB] = useState(0);
  const [targetTris, setTargetTris] = useState(0);
  const [decimating, setDecimating] = useState(false);

  // Region-edit state (mirror into refs for the one-time viewer effect).
  const [deletedKeys, setDeletedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [lockedKeys, setLockedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [showLocks, setShowLocks] = useState(true);
  const deletedRef = useRef(deletedKeys); deletedRef.current = deletedKeys;
  const lockedRef = useRef(lockedKeys); lockedRef.current = lockedKeys;
  const showLocksRef = useRef(showLocks); showLocksRef.current = showLocks;

  useEffect(() => {
    if (assets.length === 0) void refreshCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshCatalog]);

  // Rebuild the group meshes from the current display / pick / lock geometries.
  const mountMeshes = useCallback(() => {
    const group = modelGroupRef.current;
    if (!group) return;
    for (const child of [...group.children]) {
      group.remove(child);
      if (child instanceof THREE.Mesh) (child.material as THREE.Material).dispose();
    }
    pickMeshRef.current = null;
    const display = displayGeomRef.current;
    if (display) group.add(geometryToColoredMesh(display));
    const edit = editGeomRef.current;
    if (edit) {
      // Invisible full-res mesh: cluster picks + box-select raycast THIS so
      // centroid keys stay stable even when the visible mesh is decimated.
      const pick = geometryToColoredMesh(edit);
      pick.visible = false;
      pickMeshRef.current = pick;
      group.add(pick);
    }
    const lock = lockGeomRef.current;
    if (showLocksRef.current && lock && (lock.attributes.position?.count ?? 0) > 0) {
      const lockMesh = new THREE.Mesh(
        lock,
        new THREE.MeshStandardMaterial({ color: "#22c55e", transparent: true, opacity: 0.55, depthWrite: false }),
      );
      lockMesh.renderOrder = 20;
      group.add(lockMesh);
    }
  }, []);

  const fitCamera = useCallback((geometry: THREE.BufferGeometry) => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere;
    const radius = sphere && sphere.radius > 0 ? sphere.radius : 50;
    const center = sphere ? sphere.center : new THREE.Vector3();
    // Keep the origin axes proportional to the part so they're neither a
    // dot nor off-screen after the camera fits.
    if (axesRef.current) axesRef.current.scale.setScalar(Math.max(2, radius * 0.6));
    controls.target.copy(center);
    camera.position.copy(center).add(new THREE.Vector3(1, 0.8, 1).normalize().multiplyScalar(radius * 3));
    camera.near = radius / 100;
    camera.far = radius * 100;
    camera.updateProjectionMatrix();
    controls.update();
  }, []);

  // Apply deletions (+ hidden locks) to composedFull → editGeom, rebuild the
  // lock overlay + welded copy, and trigger a redisplay (decimation effect).
  const applyEdits = useCallback(() => {
    const composed = composedFullRef.current;
    editGeomRef.current?.dispose();
    weldedEditRef.current?.dispose();
    lockGeomRef.current?.dispose();
    lockGeomRef.current = null;
    decimatedRef.current?.dispose();
    decimatedRef.current = null;

    if (!composed) {
      editGeomRef.current = null;
      weldedEditRef.current = null;
      displayGeomRef.current = null;
      sourceTrisRef.current = 0;
      mountMeshes();
      setSourceTris(0);
      setDisplayTris(0);
      setEstMB(0);
      setEditNonce((n) => n + 1);
      return;
    }

    const hide = new Set(deletedRef.current);
    if (!showLocksRef.current) for (const k of lockedRef.current) hide.add(k);
    const editGeom = hide.size > 0 ? filterColored(composed, hide, "drop") : composed.clone();
    editGeomRef.current = editGeom;
    weldedEditRef.current = weldForSimplify(editGeom);

    if (showLocksRef.current && lockedRef.current.size > 0) {
      lockGeomRef.current = filterColored(composed, lockedRef.current, "only");
    }

    const tris = triangleCount(editGeom);
    sourceTrisRef.current = tris;
    // Show full-res immediately (single synchronous swap → no flicker or
    // render of a just-disposed geometry); the decimation effect refines
    // to the current budget if it is below full.
    displayGeomRef.current = editGeom;
    mountMeshes();
    setSourceTris(tris);
    setDisplayTris(tris);
    setEstMB(estimateGlbBytes(editGeom) / 1e6);
    setEditNonce((n) => n + 1);
  }, [mountMeshes]);

  // Rebuild the merge: per source, merge its included sub-meshes, bake the
  // source transform, then merge across sources. Re-fits the camera + re-applies
  // region edits.
  const recompose = useCallback(
    (nextSources: Source[]) => {
      clearFacePick(); // geometry changed → any measured face is now stale
      const sourceGeoms: THREE.BufferGeometry[] = [];
      for (const s of nextSources) {
        if (!s.included) continue;
        const subClones = s.subMeshes
          .filter((m) => m.included)
          .map((m) => subGeomsRef.current.get(m.id))
          .filter((g): g is THREE.BufferGeometry => Boolean(g))
          .map((g) => g.clone());
        if (subClones.length === 0) continue;
        const srcGeom = mergeAndDispose(subClones);
        if (hasTransform(s)) {
          srcGeom.applyMatrix4(
            new THREE.Matrix4().compose(
              new THREE.Vector3(s.tx, s.ty, s.tz),
              new THREE.Quaternion().setFromEuler(
                new THREE.Euler(
                  THREE.MathUtils.degToRad(s.rx),
                  THREE.MathUtils.degToRad(s.ry),
                  THREE.MathUtils.degToRad(s.rz),
                ),
              ),
              new THREE.Vector3(1, 1, 1),
            ),
          );
        }
        sourceGeoms.push(srcGeom);
      }

      composedFullRef.current?.dispose();

      if (sourceGeoms.length === 0) {
        composedFullRef.current = null;
        applyEdits(); // clears edit/display geometry + readouts
        setTargetTris(0);
        return;
      }

      const composed = mergeAndDispose(sourceGeoms);
      composedFullRef.current = composed;
      applyEdits();
      fitCamera(composed);
    },
    [applyEdits, fitCamera, clearFacePick],
  );

  const recomposeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const recomposeSoon = useCallback(
    (next: Source[]) => {
      setSources(next);
      if (recomposeTimer.current) clearTimeout(recomposeTimer.current);
      recomposeTimer.current = setTimeout(() => recompose(next), 120);
    },
    [recompose],
  );

  // Region-edit callbacks. Declared before the viewer effect so the gesture
  // handlers can read them through refs (kept current below).
  // These only mutate the key sets; a useEffect on [deletedKeys, lockedKeys,
  // showLocks] re-runs applyEdits AFTER the render that refreshes the *Ref
  // mirrors, so applyEdits always reads the up-to-date sets.
  const deleteClusters = useCallback((keys: string[]) => {
    setDeletedKeys((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const k of keys) if (!next.has(k)) { next.add(k); changed = true; }
      return changed ? next : prev;
    });
  }, []);

  const toggleLock = useCallback((keys: string[]) => {
    setLockedKeys((prev) => {
      const next = new Set(prev);
      const allIn = keys.every((k) => next.has(k));
      if (allIn) for (const k of keys) next.delete(k);
      else for (const k of keys) next.add(k);
      return next;
    });
  }, []);

  const addLock = useCallback((keys: string[]) => {
    if (keys.length === 0) return;
    setLockedKeys((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const k of keys) if (!next.has(k)) { next.add(k); changed = true; }
      return changed ? next : prev;
    });
  }, []);

  const deleteClustersRef = useRef(deleteClusters); deleteClustersRef.current = deleteClusters;
  const toggleLockRef = useRef(toggleLock); toggleLockRef.current = toggleLock;
  const addLockRef = useRef(addLock); addLockRef.current = addLock;

  // One-time three.js viewport + region-edit pointer gestures.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const scene = new THREE.Scene();
    // Builder viewport stays dark: it bakes raw STEP/STL into generic
    // vertex-coloured geometry whose effective base is a near-white grey.
    // On a dark backdrop + bright key/fill the model reads as a bright,
    // well-shaded solid (high contrast); the light VIEWER_BG the other
    // previews use washes that same grey out. The editor chrome around it
    // is still the shared light PHY-Editor theme.
    scene.background = new THREE.Color(0x16161a);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
    camera.position.set(120, 120, 120);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    // Fill the mount via CSS so the canvas is always full-size even before the
    // ResizeObserver's first setSize (which only sets the drawing-buffer size,
    // updateStyle=false). Without this the canvas keeps its 300x150 default
    // until a resize fires, showing as a blank/clipped viewport on first paint.
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    mount.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    const group = new THREE.Group();
    scene.add(group);
    // Bright key + low ambient: lit faces read ~200 while shadowed faces stay
    // dark so the form is legible (not a flat blown-out blob) on the dark bg.
    scene.add(new THREE.HemisphereLight(0xbcc8ff, 0x2a2d36, 0.8));
    scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(30, 45, 60);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xfff0e0, 0.7);
    fill.position.set(-40, 20, -30);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xbfd4ff, 0.6);
    rim.position.set(0, -45, 30);
    scene.add(rim);
    // Grid lines bright enough to read clearly against the dark backdrop.
    scene.add(new THREE.GridHelper(500, 20, 0x6b7280, 0x3b414e));

    // Origin marker: RGB axes (X=red, Y=green, Z=blue) meeting at (0,0,0).
    // depthTest off so it stays visible through the model; scaled to the part
    // in fitCamera so it reads at any size.
    const axes = new THREE.AxesHelper(1);
    axes.scale.setScalar(20);
    (axes.material as THREE.Material).depthTest = false;
    axes.renderOrder = 5;
    scene.add(axes);
    axesRef.current = axes;

    // Left-click measure: a marker at the picked face centre + a line to origin.
    const faceMarker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x22d3ee, depthTest: false }),
    );
    faceMarker.visible = false;
    faceMarker.renderOrder = 31;
    scene.add(faceMarker);
    faceMarkerRef.current = faceMarker;
    const faceLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0x22d3ee, depthTest: false, transparent: true, opacity: 0.85 }),
    );
    faceLine.visible = false;
    faceLine.renderOrder = 30;
    scene.add(faceLine);
    faceLineRef.current = faceLine;

    cameraRef.current = camera;
    controlsRef.current = controls;
    rendererRef.current = renderer;
    modelGroupRef.current = group;

    // --- region-edit gestures (Ctrl/Shift + middle button) ---
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const middleAction = {
      active: false,
      mode: null as null | "delete" | "lock",
      startX: 0, startY: 0, currentX: 0, currentY: 0,
      dragged: false,
      overlay: null as HTMLDivElement | null,
    };
    // Plain left-click (no drag, no modifier) = measure a face: its coplanar
    // cluster's centre and that centre's distance to the origin. A drag is an
    // OrbitControls rotate, so we only pick when the pointer didn't move.
    const leftPick = { down: false, startX: 0, startY: 0, moved: false };

    function pickMeshes(): THREE.Mesh[] {
      return pickMeshRef.current ? [pickMeshRef.current] : [];
    }
    function setPointer(event: PointerEvent) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
    }
    function ensureOverlay() {
      if (middleAction.overlay) return;
      const overlay = document.createElement("div");
      overlay.style.position = "absolute";
      const isLock = middleAction.mode === "lock";
      overlay.style.border = `1px solid ${isLock ? "#22c55e" : "#fbbf24"}`;
      overlay.style.background = isLock ? "rgba(34,197,94,0.16)" : "rgba(251,191,36,0.16)";
      overlay.style.pointerEvents = "none";
      overlay.style.zIndex = "2";
      middleAction.overlay = overlay;
      mount!.appendChild(overlay);
    }
    function updateOverlay() {
      if (!middleAction.overlay) return;
      const rect = renderer.domElement.getBoundingClientRect();
      middleAction.overlay.style.left = `${Math.min(middleAction.startX, middleAction.currentX) - rect.left}px`;
      middleAction.overlay.style.top = `${Math.min(middleAction.startY, middleAction.currentY) - rect.top}px`;
      middleAction.overlay.style.width = `${Math.abs(middleAction.currentX - middleAction.startX)}px`;
      middleAction.overlay.style.height = `${Math.abs(middleAction.currentY - middleAction.startY)}px`;
    }
    function keysInsideBox(): string[] {
      const rect = renderer.domElement.getBoundingClientRect();
      const minX = Math.min(middleAction.startX, middleAction.currentX);
      const maxX = Math.max(middleAction.startX, middleAction.currentX);
      const minY = Math.min(middleAction.startY, middleAction.currentY);
      const maxY = Math.max(middleAction.startY, middleAction.currentY);
      const keys = new Set<string>();
      const c = new THREE.Vector3();
      const w = new THREE.Vector3();
      for (const mesh of pickMeshes()) {
        const positions = mesh.geometry.attributes.position?.array as Float32Array | undefined;
        if (!positions) continue;
        mesh.updateMatrixWorld(true);
        const triCount = Math.floor(positions.length / 9);
        for (let t = 0; t < triCount; t += 1) {
          const o = t * 9;
          c.set(
            (positions[o] + positions[o + 3] + positions[o + 6]) / 3,
            (positions[o + 1] + positions[o + 4] + positions[o + 7]) / 3,
            (positions[o + 2] + positions[o + 5] + positions[o + 8]) / 3,
          );
          w.copy(c).applyMatrix4(mesh.matrixWorld).project(camera);
          if (w.z < -1 || w.z > 1) continue;
          const sx = rect.left + ((w.x + 1) / 2) * rect.width;
          const sy = rect.top + ((-w.y + 1) / 2) * rect.height;
          if (sx < minX || sx > maxX || sy < minY || sy > maxY) continue;
          keys.add(centroidKey(c.x, c.y, c.z));
        }
      }
      return [...keys];
    }
    function clusterKeysAtPointer(): string[] | null {
      const hit = raycaster.intersectObjects(pickMeshes(), false)[0];
      if (!hit || typeof hit.faceIndex !== "number") return null;
      const positions = (hit.object as THREE.Mesh).geometry.attributes.position.array as Float32Array;
      const cluster = findCoplanarCluster(positions, hit.faceIndex);
      if (cluster.size === 0) return null;
      const keys: string[] = [];
      for (const t of cluster) {
        const o = t * 9;
        keys.push(centroidKey(
          (positions[o] + positions[o + 3] + positions[o + 6]) / 3,
          (positions[o + 1] + positions[o + 4] + positions[o + 7]) / 3,
          (positions[o + 2] + positions[o + 5] + positions[o + 8]) / 3,
        ));
      }
      return keys;
    }
    function pickFaceAtPointer() {
      const hit = raycaster.intersectObjects(pickMeshes(), false)[0];
      if (!hit || typeof hit.faceIndex !== "number") return;
      const mesh = hit.object as THREE.Mesh;
      const positions = mesh.geometry.attributes.position.array as Float32Array;
      const cluster = findCoplanarCluster(positions, hit.faceIndex);
      const acc = new THREE.Vector3();
      const c = new THREE.Vector3();
      let n = 0;
      for (const t of cluster) {
        const o = t * 9;
        c.set(
          (positions[o] + positions[o + 3] + positions[o + 6]) / 3,
          (positions[o + 1] + positions[o + 4] + positions[o + 7]) / 3,
          (positions[o + 2] + positions[o + 5] + positions[o + 8]) / 3,
        );
        acc.add(c);
        n += 1;
      }
      if (n === 0) return;
      acc.multiplyScalar(1 / n);
      mesh.updateMatrixWorld(true);
      acc.applyMatrix4(mesh.matrixWorld); // local → world (group is at origin)
      const marker = faceMarkerRef.current;
      if (marker) {
        marker.scale.setScalar(axesRef.current ? Math.max(0.4, axesRef.current.scale.x / 12) : 1.5);
        marker.position.copy(acc);
        marker.visible = true;
      }
      const line = faceLineRef.current;
      if (line) {
        (line.geometry as THREE.BufferGeometry).setFromPoints([new THREE.Vector3(0, 0, 0), acc.clone()]);
        line.visible = true;
      }
      setFacePick({ x: acc.x, y: acc.y, z: acc.z, dist: acc.length() });
    }

    function onPointerDown(event: PointerEvent) {
      if (
        event.button === 0 &&
        !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey
      ) {
        leftPick.down = true;
        leftPick.startX = event.clientX;
        leftPick.startY = event.clientY;
        leftPick.moved = false;
      }
      if (event.button === 1 && (event.ctrlKey || event.shiftKey) && pickMeshRef.current) {
        event.preventDefault();
        middleAction.active = true;
        middleAction.mode = event.ctrlKey ? "delete" : "lock";
        middleAction.startX = middleAction.currentX = event.clientX;
        middleAction.startY = middleAction.currentY = event.clientY;
        middleAction.dragged = false;
        controls.enabled = false;
        try { renderer.domElement.setPointerCapture(event.pointerId); } catch { /* no active pointer */ }
      }
    }
    function onPointerMove(event: PointerEvent) {
      if (
        leftPick.down && !leftPick.moved &&
        Math.hypot(event.clientX - leftPick.startX, event.clientY - leftPick.startY) >= DRAG_THRESHOLD_PX
      ) {
        leftPick.moved = true; // became an OrbitControls rotate, not a pick
      }
      if (!middleAction.active) return;
      middleAction.currentX = event.clientX;
      middleAction.currentY = event.clientY;
      if (Math.hypot(middleAction.currentX - middleAction.startX, middleAction.currentY - middleAction.startY) >= DRAG_THRESHOLD_PX) {
        if (!middleAction.dragged) { middleAction.dragged = true; ensureOverlay(); }
        updateOverlay();
      }
    }
    function onPointerUp(event: PointerEvent) {
      if (leftPick.down) {
        const wasClick = event.type === "pointerup" && event.button === 0 && !leftPick.moved;
        leftPick.down = false;
        if (wasClick && pickMeshRef.current) {
          setPointer(event);
          pickFaceAtPointer();
        }
      }
      if (!middleAction.active) return;
      middleAction.currentX = event.clientX;
      middleAction.currentY = event.clientY;
      const mode = middleAction.mode;
      const wasDrag = middleAction.dragged;
      middleAction.overlay?.remove();
      middleAction.overlay = null;
      middleAction.active = false;
      middleAction.mode = null;
      middleAction.dragged = false;
      controls.enabled = true;
      try { renderer.domElement.releasePointerCapture(event.pointerId); } catch { /* already released */ }
      if (!mode) return;
      if (wasDrag) {
        const allKeys = keysInsideBox();
        if (allKeys.length === 0) return;
        if (mode === "delete") {
          const locked = lockedRef.current;
          const target = locked.size > 0 ? allKeys.filter((k) => !locked.has(k)) : allKeys;
          if (target.length > 0) deleteClustersRef.current(target);
        } else {
          addLockRef.current(allKeys);
        }
      } else {
        setPointer(event);
        const keys = clusterKeysAtPointer();
        if (!keys || keys.length === 0) return;
        if (mode === "delete") deleteClustersRef.current(keys);
        else toggleLockRef.current(keys);
      }
    }
    const onMouseDownNoMid = (e: MouseEvent) => { if (e.button === 1) e.preventDefault(); };

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointerleave", onPointerUp);
    renderer.domElement.addEventListener("mousedown", onMouseDownNoMid);

    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w === 0 || h === 0) return;
      const dpr = renderer.getPixelRatio();
      // Idempotent: only touch the drawing buffer when it no longer matches the
      // CSS-sized canvas, so resize() is cheap to call every frame. Driven from
      // the render loop (below) rather than relying solely on the
      // ResizeObserver, which proved unreliable for the freshly-mounted canvas.
      if (
        renderer.domElement.width !== Math.floor(w * dpr) ||
        renderer.domElement.height !== Math.floor(h * dpr)
      ) {
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
    };
    let raf = 0;
    const animate = () => {
      resize();
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    animate();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointerleave", onPointerUp);
      renderer.domElement.removeEventListener("mousedown", onMouseDownNoMid);
      middleAction.overlay?.remove();
      controls.dispose();
      for (const child of [...group.children]) {
        if (child instanceof THREE.Mesh) (child.material as THREE.Material).dispose();
      }
      decimatedRef.current?.dispose();
      editGeomRef.current?.dispose();
      weldedEditRef.current?.dispose();
      lockGeomRef.current?.dispose();
      composedFullRef.current?.dispose();
      for (const geom of subGeomsRef.current.values()) geom.dispose();
      subGeomsRef.current.clear();
      axes.dispose();
      faceMarker.geometry.dispose();
      (faceMarker.material as THREE.Material).dispose();
      faceLine.geometry.dispose();
      (faceLine.material as THREE.Material).dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      cameraRef.current = null;
      controlsRef.current = null;
      rendererRef.current = null;
      modelGroupRef.current = null;
      axesRef.current = null;
      faceMarkerRef.current = null;
      faceLineRef.current = null;
    };
  }, []);

  // Decimation + display: re-runs whenever the edit geometry changes (editNonce)
  // or the target triangle budget moves.
  useEffect(() => {
    const editGeom = editGeomRef.current;
    const welded = weldedEditRef.current;
    if (!editGeom) {
      displayGeomRef.current = null;
      mountMeshes();
      setDisplayTris(0);
      setEstMB(0);
      return;
    }
    const id = setTimeout(async () => {
      setDecimating(true);
      setError(null);
      try {
        let display: THREE.BufferGeometry;
        if (targetTris >= sourceTrisRef.current || !welded) {
          decimatedRef.current?.dispose();
          decimatedRef.current = null;
          display = editGeom;
        } else {
          const next = await decimateWelded(welded, targetTris);
          decimatedRef.current?.dispose();
          decimatedRef.current = next;
          display = next;
        }
        displayGeomRef.current = display;
        mountMeshes();
        setDisplayTris(triangleCount(display));
        setEstMB(estimateGlbBytes(display) / 1e6);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setDecimating(false);
      }
    }, 150);
    return () => clearTimeout(id);
  }, [targetTris, editNonce, mountMeshes]);

  // When sourceTris first becomes known (new compose), default the budget to Full.
  useEffect(() => {
    setTargetTris((prev) => (prev === 0 && sourceTris > 0 ? sourceTris : prev));
  }, [sourceTris]);

  const seedNaming = useCallback((stem: string) => {
    setCatalogId((c) => c || slugify(stem));
    setName((n) => n || stem);
  }, []);

  const makeSource = useCallback((label: string, loaded: LoadedSubMesh[]): Source => {
    const sourceId = `src_${idRef.current++}`;
    const subMeshes: SubMesh[] = loaded.map((s, i) => {
      const subId = `${sourceId}_m${i}`;
      subGeomsRef.current.set(subId, s.geometry);
      return { id: subId, label: s.label, included: true };
    });
    return { id: sourceId, label, included: true, expanded: false, tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, subMeshes };
  }, []);

  const handleFiles = useCallback(
    async (files: File[]) => {
      setError(null);
      setInfo(null);
      const steps = files.filter((f) => ["step", "stp"].includes(extOf(f.name)));
      if (steps.length === 0) {
        setError("Pick STEP file(s) (.step / .stp).");
        return;
      }
      setStatus("parsing");
      try {
        const added: Source[] = [];
        for (const file of steps) {
          const data = new Uint8Array(await file.arrayBuffer());
          const result = await importStep(data, { linearUnit: "millimeter" }, locateOcctWasm);
          const loaded: LoadedSubMesh[] = result.meshes.map((mesh, i) => ({
            geometry: occtMeshToGeometry(mesh),
            label: mesh.name && mesh.name.trim() ? mesh.name : `mesh ${i + 1}`,
          }));
          added.push(makeSource(file.name.replace(/\.[^.]+$/, ""), loaded));
        }
        const next = [...sources, ...added];
        setSources(next);
        recompose(next);
        if (sources.length === 0 && steps[0]) seedNaming(steps[0].name.replace(/\.[^.]+$/, ""));
        setInfo(`Added ${added.length} source(s). ${next.length} total.`);
        setStatus("ready");
      } catch (e) {
        setStatus("ready");
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [sources, recompose, seedNaming, makeSource],
  );

  const handleAddExisting = useCallback(async () => {
    const asset = assets.find((a) => a.catalogId === existingPick);
    if (!asset) {
      setError("Pick an existing asset to add.");
      return;
    }
    const ext = extOf(asset.assetType || asset.filePath);
    if (!VIEWER_EXTS.has(ext)) {
      setError(`"${asset.catalogId}" is .${ext} — only GLB/GLTF/OBJ/STL assets can be loaded as a source.`);
      return;
    }
    setError(null);
    setInfo(null);
    setStatus("parsing");
    try {
      const loaded = await loadAssetGeometry(resolveAssetUrl(asset.filePath), ext, {
        unit: asset.unit,
        scaleFactor: asset.scaleFactor,
      });
      const next = [...sources, makeSource(asset.name || asset.catalogId, loaded)];
      setSources(next);
      recompose(next);
      if (sources.length === 0) seedNaming(`${asset.catalogId}_edit`);
      setInfo(`Added existing asset "${asset.catalogId}" (${loaded.length} mesh(es)).`);
      setStatus("ready");
    } catch (e) {
      setStatus("ready");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [assets, existingPick, sources, recompose, seedNaming, makeSource]);

  // Edit-in-place: load an asset as the sole source, lock its catalog_id, and
  // overwrite it on Save (transforms baked into the geometry). You can still add
  // more sources / trim / delete regions before saving.
  const enterEditMode = useCallback(
    async (catId: string) => {
      const asset = assets.find((a) => a.catalogId === catId);
      if (!asset) return;
      const ext = extOf(asset.assetType || asset.filePath);
      if (!VIEWER_EXTS.has(ext)) {
        setError(`"${catId}" is .${ext} — only GLB/GLTF/OBJ/STL assets can be edited here.`);
        return;
      }
      if (sources.length > 0 && !window.confirm(`Replace the current build with "${catId}" for editing?`)) return;
      setError(null);
      setInfo(null);
      setStatus("parsing");
      try {
        const loaded = await loadAssetGeometry(resolveAssetUrl(asset.filePath), ext, {
          unit: asset.unit,
          scaleFactor: asset.scaleFactor,
        });
        for (const s of sources) {
          for (const m of s.subMeshes) {
            subGeomsRef.current.get(m.id)?.dispose();
            subGeomsRef.current.delete(m.id);
          }
        }
        setDeletedKeys(new Set());
        setLockedKeys(new Set());
        const src = makeSource(asset.name || catId, loaded);
        setSources([src]);
        recompose([src]);
        setEditingCatalogId(catId);
        setCatalogId(catId);
        setName(asset.name || catId);
        const domains = (asset.properties as { domains?: string[] } | undefined)?.domains;
        const d = Array.isArray(domains) ? domains[0] : undefined;
        if (d === "optical" || d === "rf" || d === "mechanical") setDomain(d);
        setInfo(`Editing "${catId}" (${loaded.length} mesh(es)) — Save overwrites it.`);
        setStatus("ready");
        try { setEditUsage(await fetchAssetUsage(catId)); } catch { setEditUsage(null); }
      } catch (e) {
        setStatus("ready");
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [assets, sources, recompose, makeSource, fetchAssetUsage],
  );

  const exitEditMode = useCallback(() => {
    setEditingCatalogId(null);
    setEditUsage(null);
    setInfo("Edit mode off — Save now creates a new asset (set a catalog_id).");
  }, []);

  const toggleSource = useCallback(
    (id: string) => {
      const next = sources.map((s) => (s.id === id ? { ...s, included: !s.included } : s));
      setSources(next);
      recompose(next);
    },
    [sources, recompose],
  );

  const toggleSubMesh = useCallback(
    (sourceId: string, subId: string) => {
      const next = sources.map((s) =>
        s.id === sourceId
          ? { ...s, subMeshes: s.subMeshes.map((m) => (m.id === subId ? { ...m, included: !m.included } : m)) }
          : s,
      );
      setSources(next);
      recompose(next);
    },
    [sources, recompose],
  );

  const toggleExpand = useCallback((id: string) => {
    setSources((prev) => prev.map((s) => (s.id === id ? { ...s, expanded: !s.expanded } : s)));
  }, []);

  const removeSource = useCallback(
    (id: string) => {
      const src = sources.find((s) => s.id === id);
      src?.subMeshes.forEach((m) => {
        subGeomsRef.current.get(m.id)?.dispose();
        subGeomsRef.current.delete(m.id);
      });
      const next = sources.filter((s) => s.id !== id);
      setSources(next);
      recompose(next);
    },
    [sources, recompose],
  );

  const setTransform = useCallback(
    (id: string, field: "tx" | "ty" | "tz" | "rx" | "ry" | "rz", value: number) => {
      recomposeSoon(sources.map((s) => (s.id === id ? { ...s, [field]: value } : s)));
    },
    [sources, recomposeSoon],
  );

  const revertGeometry = useCallback(() => {
    if (deletedKeys.size === 0) return;
    if (!window.confirm(`Revert ${deletedKeys.size} deleted cluster${deletedKeys.size === 1 ? "" : "s"}? (only affects this unsaved build)`)) return;
    setDeletedKeys(new Set());
  }, [deletedKeys]);

  const clearLocks = useCallback(() => setLockedKeys(new Set()), []);
  const toggleShowLocks = useCallback(() => setShowLocks((v) => !v), []);

  // Re-bake the geometry whenever the edit sets change. Runs after render, so
  // deletedRef / lockedRef / showLocksRef are already current. (recompose calls
  // applyEdits directly for source changes; those leave these sets untouched so
  // this effect doesn't double-fire.)
  useEffect(() => {
    applyEdits();
  }, [deletedKeys, lockedKeys, showLocks, applyEdits]);

  const handleSave = useCallback(async () => {
    const geometry = decimatedRef.current ?? editGeomRef.current;
    if (!geometry) {
      setError("Add at least one source first.");
      return;
    }
    if (!editingCatalogId && !/^[a-z0-9_]+$/.test(catalogId)) {
      setError("catalog_id must be lower-snake-case ([a-z0-9_]+).");
      return;
    }
    if (!name.trim()) {
      setError("name is required.");
      return;
    }
    setError(null);
    setInfo(null);
    setStatus("saving");
    try {
      const glb = await exportGlb(geometry);
      const mb = (glb.byteLength / 1e6).toFixed(1);
      if (editingCatalogId) {
        // Baked merge is mm — force unit=mm scale=1 so the row's old scale
        // (e.g. a metre asset's 1000) can't re-scale the new geometry.
        await updateAssetGeometry(editingCatalogId, {
          file: glbToFile(glb, editingCatalogId),
          catalogId: editingCatalogId,
          name: name.trim(),
          domain,
          unit: "mm",
          scaleFactor: 1,
          preserveColors: true,
        });
        setInfo(`Updated “${editingCatalogId}” (${mb} MB). Re-check anchors in the ASSET3D tab.`);
      } else {
        await uploadAsset({
          file: glbToFile(glb, catalogId),
          catalogId,
          name: name.trim(),
          domain,
          preserveColors: true,
        });
        setInfo(`Saved “${catalogId}” (${mb} MB). Place anchors in the ASSET3D tab.`);
      }
      setStatus("ready");
    } catch (e) {
      setStatus("ready");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [catalogId, name, domain, uploadAsset, updateAssetGeometry, editingCatalogId]);

  const hasModel = sourceTris > 0;
  const busy = status === "parsing" || status === "saving";
  const includedCount = sources.filter((s) => s.included).length;
  const importableAssets = assets.filter((a) => VIEWER_EXTS.has(extOf(a.assetType || a.filePath)));
  const saveTitle =
    status === "saving"
      ? "Saving…"
      : editingCatalogId
        ? `Save changes to ${editingCatalogId}`
        : "Save as GLB asset";

  return (
    // Flex shell (not the shared SHELL_STYLE grid): the BUILD main is a
    // full-height 3D canvas, and a grid `minmax(0,1fr)` track collapses to 0
    // when its only child is an overflow-hidden canvas with no intrinsic
    // height. Flex column + `flex:1` mount sizes the canvas robustly. Colours
    // still come from the shared light PHY-Editor tokens so it reads unified.
    <div style={{ display: "flex", height: "100%", minHeight: 0, background: SHELL_BG, color: SHELL_COLOR }}>
      <aside style={{ ...ASIDE_STYLE, flex: `0 0 ${ASIDE_WIDTH}px`, display: "flex", flexDirection: "column", gap: 10 }}>
        <p style={{ margin: 0, fontSize: 11, color: MUTED, lineHeight: 1.4 }}>
          Add sources (each uploaded STEP / picked asset = one unit), position &
          rotate each, remove unwanted sub-meshes or regions, then save merged into
          one coloured GLB. Anchors are placed afterwards in the ASSET3D tab.
        </p>

        <input
          ref={fileInputRef}
          type="file"
          accept=".step,.stp"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files ?? []);
            e.currentTarget.value = "";
            if (files.length) void handleFiles(files);
          }}
        />
        <button type="button" disabled={busy} onClick={() => fileInputRef.current?.click()} style={importButton(busy)}>
          {status === "parsing" ? "Working…" : sources.length === 0 ? "Import STEP…" : "Import more STEP…"}
        </button>

        <div style={{ display: "flex", gap: 6 }}>
          <select value={existingPick} onChange={(e) => setExistingPick(e.target.value)} disabled={busy} style={{ ...INPUT, flex: 1 }}>
            <option value="">add existing asset…</option>
            {importableAssets.map((a) => (
              <option key={a.catalogId} value={a.catalogId}>
                {a.name || a.catalogId} (.{extOf(a.assetType || a.filePath)})
              </option>
            ))}
          </select>
          <button type="button" disabled={busy || !existingPick} onClick={() => void handleAddExisting()} style={chipButton(false)}>
            Add
          </button>
        </div>

        <select
          value={editingCatalogId ?? ""}
          onChange={(e) => { const v = e.target.value; if (v) void enterEditMode(v); else exitEditMode(); }}
          disabled={busy}
          style={{ ...INPUT, width: "100%" }}
          title="Load an asset to edit; Save overwrites it in place."
        >
          <option value="">edit existing asset… (overwrite on save)</option>
          {importableAssets.map((a) => (
            <option key={a.catalogId} value={a.catalogId}>
              {a.name || a.catalogId} (.{extOf(a.assetType || a.filePath)})
            </option>
          ))}
        </select>

        {editingCatalogId && (
          <div style={{ fontSize: 11, padding: 8, background: "#eff6ff", border: "1px solid #bfdbfe", display: "grid", gap: 6 }}>
            <div>✎ Editing <b>{editingCatalogId}</b> — Save overwrites this asset.</div>
            {editUsage && editUsage.objectCount > 0 && (
              <div style={{ color: "#b45309" }}>
                ⚠ Used by {editUsage.objectCount} placed object(s)
                {editUsage.componentCount ? ` + ${editUsage.componentCount} component ref(s)` : ""} — overwriting changes them; re-check anchors after.
              </div>
            )}
            <button type="button" onClick={exitEditMode} style={chipButton(false)}>Exit edit (save as new instead)</button>
          </div>
        )}

        {sources.length > 0 && (
          <div style={{ display: "grid", gap: 6 }}>
            <div style={{ ...SECTION_LABEL, marginTop: 0 }}>
              Sources ({includedCount}/{sources.length}) — position / rotate / trim each
            </div>
            <div style={{ display: "grid", gap: 8, maxHeight: 300, overflow: "auto" }}>
              {sources.map((s) => {
                const keptSub = s.subMeshes.filter((m) => m.included).length;
                return (
                  <div
                    key={s.id}
                    style={{
                      display: "grid", gap: 4, padding: 6, background: "#ffffff",
                      border: `1px solid ${BORDER_LIGHT}`, opacity: s.included ? 1 : 0.5,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                      <input type="checkbox" checked={s.included} onChange={() => toggleSource(s.id)} title="include this source" />
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.label}>
                        {s.label}
                      </span>
                      <button type="button" onClick={() => removeSource(s.id)} title="Remove this source"
                        style={{ background: "none", border: "none", color: "#dc2626", cursor: "pointer", fontSize: 13, lineHeight: 1 }}>
                        ×
                      </button>
                    </div>

                    {/* pos (xyz, mm) + rot (xyz, deg) on one compact row.
                        P/R chips disambiguate; full meaning is in each title. */}
                    <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
                      <span style={{ fontSize: 9, color: MUTED }} title="position (mm)">P</span>
                      {(["tx", "ty", "tz"] as const).map((f, i) => (
                        <input key={f} type="number" step={1} value={s[f]} title={`pos ${"xyz"[i]} (mm)`}
                          onChange={(e) => setTransform(s.id, f, Number(e.target.value) || 0)}
                          className="gb-num"
                          style={{ ...INPUT, flex: 1, minWidth: 0, padding: "3px 4px" }} />
                      ))}
                      <span style={{ width: 1, alignSelf: "stretch", background: BORDER_STRONG, margin: "0 1px" }} />
                      <span style={{ fontSize: 9, color: MUTED }} title="rotation (deg)">R</span>
                      {(["rx", "ry", "rz"] as const).map((f, i) => (
                        <input key={f} type="number" step={5} value={s[f]} title={`rot ${"xyz"[i]} (deg)`}
                          onChange={(e) => setTransform(s.id, f, Number(e.target.value) || 0)}
                          className="gb-num"
                          style={{ ...INPUT, flex: 1, minWidth: 0, padding: "3px 4px" }} />
                      ))}
                    </div>

                    {s.subMeshes.length > 1 && (
                      <div style={{ display: "grid", gap: 2 }}>
                        <button type="button" onClick={() => toggleExpand(s.id)}
                          style={{ background: "none", border: "none", color: "#2563eb", cursor: "pointer", fontSize: 10, textAlign: "left", padding: 0 }}>
                          {s.expanded ? "▾" : "▸"} sub-meshes ({keptSub}/{s.subMeshes.length} kept)
                        </button>
                        {s.expanded && (
                          <div style={{ display: "grid", gap: 1, maxHeight: 120, overflow: "auto", paddingLeft: 8 }}>
                            {s.subMeshes.map((m) => (
                              <label key={m.id} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, opacity: m.included ? 0.9 : 0.45 }}>
                                <input type="checkbox" checked={m.included} onChange={() => toggleSubMesh(s.id, m.id)} />
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={m.label}>{m.label}</span>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {hasModel && (
          <>
            <div style={{ display: "grid", gap: 4, padding: 8, background: "#ffffff", border: `1px solid ${BORDER_LIGHT}` }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: MUTED }}>Region edit</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button type="button" onClick={revertGeometry} disabled={deletedKeys.size === 0} style={editChip(deletedKeys.size > 0, "#d97706")}>
                  Revert geometry{deletedKeys.size > 0 ? ` (${deletedKeys.size} deleted)` : ""}
                </button>
                <button type="button" onClick={clearLocks} disabled={lockedKeys.size === 0} style={editChip(lockedKeys.size > 0, "#16a34a")}>
                  Clear locks{lockedKeys.size > 0 ? ` (${lockedKeys.size} locked)` : ""}
                </button>
                <button type="button" onClick={toggleShowLocks} disabled={lockedKeys.size === 0} style={editChip(lockedKeys.size > 0, "#16a34a")}>
                  {showLocks ? "Hide locks" : "Show locks"}
                </button>
              </div>
              <div style={{ fontSize: 9, color: MUTED, lineHeight: 1.4 }}>
                Ctrl+mid-click = delete cluster | Ctrl+mid-drag = box delete | Shift+mid-click = lock (keep) | Shift+mid-drag = box lock. Locks aren't saved; Save only commits deletions.
              </div>
            </div>

            <div style={{ display: "grid", gap: 6 }}>
              <div style={{ ...SECTION_LABEL, marginTop: 0 }}>Decimation</div>
              <div style={{ display: "flex", gap: 6 }}>
                {PRESETS.map((p) => (
                  <button key={p.label} type="button" onClick={() => setTargetTris(Math.min(sourceTris, p.tris))} style={chipButton(targetTris === Math.min(sourceTris, p.tris))}>
                    {p.label}
                  </button>
                ))}
                <button type="button" onClick={() => setTargetTris(sourceTris)} style={chipButton(targetTris >= sourceTris)}>
                  Full
                </button>
              </div>
              <input type="range" min={Math.min(1000, sourceTris)} max={sourceTris} step={1000} value={Math.min(targetTris, sourceTris)} onChange={(e) => setTargetTris(Number(e.target.value))} />
              <div style={{ fontSize: 11, color: SHELL_COLOR }}>
                {displayTris.toLocaleString()} tris · ~{estMB.toFixed(1)} MB
                {decimating && <span style={{ color: MUTED }}> · simplifying…</span>}
              </div>
            </div>

            <div style={{ ...SECTION_LABEL, marginTop: 0 }}>Metadata</div>
            <label style={{ fontSize: 11, display: "grid", gap: 4 }}>
              catalog_id{editingCatalogId ? " (locked while editing)" : ""}
              <input value={catalogId} onChange={(e) => setCatalogId(e.target.value)} readOnly={!!editingCatalogId} placeholder="lower_snake_case" style={{ ...INPUT, opacity: editingCatalogId ? 0.6 : 1 }} />
            </label>
            <label style={{ fontSize: 11, display: "grid", gap: 4 }}>
              name
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" style={INPUT} />
            </label>
            <label style={{ fontSize: 11, display: "grid", gap: 4 }}>
              domain
              <select value={domain} onChange={(e) => setDomain(e.target.value as typeof domain)} style={INPUT}>
                <option value="mechanical">mechanical</option>
                <option value="optical">optical</option>
                <option value="rf">rf</option>
              </select>
            </label>
          </>
        )}

        {error && <div style={{ fontSize: 11, color: "#b91c1c", whiteSpace: "pre-wrap" }}>{error}</div>}
        {info && !error && <div style={{ fontSize: 11, color: "#15803d", whiteSpace: "pre-wrap" }}>{info}</div>}
      </aside>

      <main style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={MAIN_HEADER_STYLE}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Geometry Builder</div>
            <div style={{ fontSize: 11, color: MUTED }}>import CAD → coloured GLB</div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <IconButton title={saveTitle} onClick={() => void handleSave()} disabled={busy || !hasModel}>
              <Save size={14} />
            </IconButton>
          </div>
        </div>
        <div style={{ position: "relative", flex: 1, minHeight: 0, minWidth: 0 }}>
          {/* Canvas host (React renders nothing inside; renderer.domElement is
              appended imperatively). Overlays are siblings so React never
              reconciles around the imperative canvas. */}
          <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />
          <div
            style={{
              position: "absolute", top: 8, left: 8, zIndex: 3, pointerEvents: "none",
              fontSize: 10, fontFamily: "ui-monospace, monospace", lineHeight: 1.5,
              color: "#9fb3c8", background: "rgba(22,22,26,0.6)", padding: "3px 6px", borderRadius: 3,
            }}
          >
            <div>
              <span style={{ color: "#ff6b6b" }}>X</span>{" "}
              <span style={{ color: "#51cf66" }}>Y</span>{" "}
              <span style={{ color: "#4dabf7" }}>Z</span> axes · origin (0, 0, 0)
            </div>
            <div style={{ opacity: 0.85 }}>left-click a face → distance to origin</div>
          </div>
          {facePick && (
            <div
              style={{
                position: "absolute", left: 8, bottom: 8, zIndex: 3,
                background: "rgba(22,22,26,0.9)", color: "#e6f6ff",
                border: "1px solid #22d3ee", borderRadius: 4, padding: "6px 8px",
                fontSize: 11, fontFamily: "ui-monospace, monospace", display: "grid", gap: 2,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <span style={{ color: "#22d3ee", fontWeight: 700 }}>Face centre → origin</span>
                <button
                  type="button"
                  onClick={clearFacePick}
                  title="clear measurement"
                  style={{ background: "none", border: "none", color: "#9fb3c8", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0 }}
                >
                  ×
                </button>
              </div>
              <div>
                x {facePick.x.toFixed(1)}  y {facePick.y.toFixed(1)}  z {facePick.z.toFixed(1)} mm
              </div>
              <div>distance <b>{facePick.dist.toFixed(2)}</b> mm</div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function IconButton({
  title,
  onClick,
  disabled = false,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        ...ICON_BUTTON,
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

// "+ New X" amber primary, shared with the sibling editors, full-width for
// the aside. The Import button is the BUILD tab's create action.
function importButton(disabled: boolean): React.CSSProperties {
  return {
    ...PRIMARY_BUTTON,
    width: "100%",
    padding: "7px 10px",
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function chipButton(active: boolean): React.CSSProperties {
  return {
    flex: 1, padding: "4px 6px", fontSize: 11,
    border: `1px solid ${active ? SELECTED : BORDER_STRONG}`,
    background: active ? "#f3f4f1" : "#ffffff",
    color: SHELL_COLOR, cursor: "pointer",
  };
}

function editChip(enabled: boolean, accent: string): React.CSSProperties {
  return {
    padding: "4px 8px", fontSize: 10,
    border: `1px solid ${enabled ? accent : BORDER_STRONG}`,
    background: "#ffffff", color: enabled ? SHELL_COLOR : MUTED,
    cursor: enabled ? "pointer" : "not-allowed", opacity: enabled ? 1 : 0.6,
  };
}
