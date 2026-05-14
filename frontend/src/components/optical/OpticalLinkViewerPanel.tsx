// Optical link viewer panel.
//
// Lets the user pick an emitter (laser_source, or standalone tapered_amplifier)
// and renders that emitter's full beam chain in an isolated mini 3D viewport.
// Key design choices:
//   - "Same optical link" rule: when a TA sits downstream of a laser on the
//     optical_link graph, it is NOT a standalone option in the dropdown — the
//     laser's selection automatically pulls in the TA's emitted segments too.
//     A TA only appears as its own choice when nothing upstream feeds into it.
//   - Component meshes (the GLB / STEP solid bodies in the main scene) are
//     NOT loaded here. Instead each scene object the beam touches contributes
//     a small anchor-sphere overlay using the same colour scheme as the PHY
//     Editor, so the user sees where each port physically sits in 3D.
//   - Beam profile is the real Gaussian taper: each segment's
//     waistAtStartUm / waistAtEndUm (published by the ray tracer) drives a
//     tapered cylinder with a visibility floor so micron-scale waists stay
//     drawable at scene scale.
//   - Clicking on a beam segment inside this mini viewport sets the global
//     `scopeProbe` and reveals an inline BeamScopeContents grid below the
//     viewport. The main-scene click handler no longer auto-opens the
//     standalone beam scope panel; this panel is now the single entry point.

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { useSceneStore } from "../../store/sceneStore";
import type {
  Asset3D,
  ComponentItem,
  PhysicsElement,
  OpticalLink,
  SceneObject,
} from "../../types/digitalTwin";
import { wavelengthToColor } from "../../three/opticalBeams";
import { gaussianWaistAtZ, type BeamState } from "../../three/rayTrace";
import { labMmToThree, mmToThree } from "../../optical/frames";
import { FloatingPanel } from "../workspace/FloatingPanel";
import { usePanelLayout } from "../workspace/WorkspaceProvider";
import { BeamScopeContents } from "./BeamScopePanel";

const EMITTER_KINDS: ReadonlySet<string> = new Set([
  "laser_source",
  "tapered_amplifier",
]);

/** Anchor colour scheme matching OpticalComponentEditor's `anchorColour()`. */
function anchorColour(id: string): number {
  switch (id) {
    case "intercept_in":
    case "in":
    case "seed":
      return 0x22c55e; // green — input port
    case "intercept_out":
    case "out":
      return 0xef4444; // red — output port
    case "intercept_face":
      return 0x3b82f6; // blue — reflective face
    case "optical_anchor":
      return 0xa855f7; // purple
    case "center":
      return 0xfacc15; // yellow
    default:
      return 0xf97316; // orange — bbox / helper anchors
  }
}

/** Aperture diameter in mm — first checks the PhysicsElement's
 *  `clearApertureMm` / `apertureDiameterMm`, then falls back to the
 *  Asset3D's intercept anchor `apertureMm`. Returns null only when nothing
 *  meaningful is configured. */
function apertureDiameterMm(
  el: PhysicsElement | undefined,
  asset: Asset3D | undefined,
): number | null {
  if (el) {
    const params = el.kindParams as Record<string, unknown>;
    for (const key of ["clearApertureMm", "apertureDiameterMm"]) {
      const v = params[key];
      if (typeof v === "number" && v > 0) return v;
    }
  }
  if (asset?.anchors) {
    for (const id of ["intercept_in", "intercept_out", "optical_anchor"]) {
      const anchor = asset.anchors.find((a) => a.id === id);
      const v = anchor?.apertureMm;
      if (typeof v === "number" && v > 0) return v;
    }
  }
  return null;
}

/** Loose subset of `TraceSegment` we read off `window.__rayTraceDebug`. */
type LiveTraceSegment = {
  startThree: { x: number; y: number; z: number };
  endThree: { x: number; y: number; z: number };
  emitterObjectId: string;
  sourceObjectId: string;
  sourceComponentId: string;
  hitObjectId: string | null;
  wavelengthNm: number;
  pathLengthFromSourceMmAtStart: number;
  lengthMm: number;
  waistAtStartUm: number;
  waistAtEndUm: number;
  powerFactorAtStart: number;
  polarizationAtStart: [number, number, number, number];
};

/** Walk the OpticalLink graph forward from `rootObjectId`, returning every
 *  object on a downstream emitter chain (ie. follow links whose `toObject`
 *  is itself a TA so its emitted segments fold into the parent laser).
 *  Result always contains `rootObjectId`. */
function downstreamEmitterChainFromLinks(
  rootObjectId: string,
  opticalLinks: readonly OpticalLink[],
  emitterIds: ReadonlySet<string>,
): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [rootObjectId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const link of opticalLinks) {
      if (link.fromObjectId !== current) continue;
      if (emitterIds.has(link.toObjectId) && !visited.has(link.toObjectId)) {
        queue.push(link.toObjectId);
      }
    }
  }
  return visited;
}

/** Trace-data version of the same walk: starting from `rootObjectId`,
 *  find every TA whose seed comes (transitively) from `rootObjectId`'s
 *  emitted beam. We rely on this when the user hasn't drawn an
 *  optical_link from the laser to the TA: the geometry-driven ray
 *  tracer still detects that the laser hits the TA, so we treat them
 *  as the same chain. */
function downstreamEmitterChainFromTrace(
  rootObjectId: string,
  segments: readonly LiveTraceSegment[],
  emitterIds: ReadonlySet<string>,
): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [rootObjectId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const seg of segments) {
      if (seg.emitterObjectId !== current) continue;
      const next = seg.hitObjectId;
      if (next && emitterIds.has(next) && !visited.has(next)) {
        queue.push(next);
      }
    }
  }
  return visited;
}

/** Union of the link-graph chain and the trace-data chain — covers
 *  both authored topology and the geometric "ray actually hits this TA"
 *  case. */
function downstreamEmitterChain(
  rootObjectId: string,
  opticalLinks: readonly OpticalLink[],
  segments: readonly LiveTraceSegment[],
  emitterIds: ReadonlySet<string>,
): Set<string> {
  const out = downstreamEmitterChainFromLinks(rootObjectId, opticalLinks, emitterIds);
  const traceChain = downstreamEmitterChainFromTrace(rootObjectId, segments, emitterIds);
  for (const id of traceChain) out.add(id);
  return out;
}

type EmitterChoice = {
  objectId: string;
  name: string;
  kind: "laser" | "tapered_amplifier";
};

export function OpticalLinkViewerPanel() {
  // FloatingPanel returns null when invisible (see FloatingPanel.tsx#L139), so
  // the mount DIV doesn't exist in the DOM until the user opens the panel.
  // The Three.js setup useEffect below has `deps: []` and runs once at app
  // mount — at which point mountRef.current is null and the effect bails. We
  // re-fire it whenever the panel transitions from hidden → visible so the
  // renderer gets created at the moment the mount DIV first appears.
  const panelVisible = usePanelLayout("optical-link-viewer").visible;
  const objects = useSceneStore((s) => s.scene.objects);
  const physicsElements = useSceneStore((s) => s.scene.physicsElements);
  const opticalLinks = useSceneStore((s) => s.scene.opticalLinks);
  const components = useSceneStore((s) => s.scene.components);
  const assets = useSceneStore((s) => s.scene.assets);
  const selectedObjectId = useSceneStore((s) => s.selectedObjectId);
  const scopeProbe = useSceneStore((s) => s.scopeProbe);
  const setScopeProbe = useSceneStore((s) => s.setScopeProbe);

  // `tasFoldedIntoLaser` is the set of tapered-amplifier object IDs that
  // sit on some laser's downstream chain (either via authored
  // opticalLinks or via the geometry-driven ray tracer). Maintained by
  // the tick loop below — using the tick instead of useMemo means the
  // value reflects the LATEST `window.__rayTraceDebug` publication
  // rather than a stale snapshot captured at React render time.
  const [tasFoldedIntoLaser, setTasFoldedIntoLaser] = useState<Set<string>>(new Set());

  // Build the dropdown:
  //   - Every laser_source object
  //   - Every standalone tapered_amplifier (one not folded into any laser)
  const emitterChoices = useMemo<EmitterChoice[]>(() => {
    const choices: EmitterChoice[] = [];
    for (const el of physicsElements) {
      const obj = objects.find((o) => o.id === el.objectId);
      if (!obj) continue;
      if (el.elementKind === "laser_source") {
        choices.push({ objectId: obj.id, name: obj.name, kind: "laser" });
      } else if (
        el.elementKind === "tapered_amplifier" &&
        !tasFoldedIntoLaser.has(el.objectId)
      ) {
        choices.push({
          objectId: obj.id,
          name: `${obj.name} (TA)`,
          kind: "tapered_amplifier",
        });
      }
    }
    choices.sort((a, b) => a.name.localeCompare(b.name));
    return choices;
  }, [objects, physicsElements, tasFoldedIntoLaser]);

  const [selectedEmitterId, setSelectedEmitterId] = useState<string | null>(null);

  // Auto-pick:
  //   1. If the user has selected an emitter object in the main scene, sync.
  //   2. Else, if the current selection is invalid (no longer in choices),
  //      fall back to the first emitter.
  useEffect(() => {
    if (
      selectedObjectId &&
      emitterChoices.some((c) => c.objectId === selectedObjectId)
    ) {
      setSelectedEmitterId(selectedObjectId);
      return;
    }
    setSelectedEmitterId((cur) => {
      if (cur && emitterChoices.some((c) => c.objectId === cur)) return cur;
      return emitterChoices[0]?.objectId ?? null;
    });
  }, [selectedObjectId, emitterChoices]);

  // `chainEmitterIds` is also tick-maintained — the segment filter
  // depends on it, and so does the inline-scope visibility check, so we
  // need it to reflect live trace data.
  const [chainEmitterIds, setChainEmitterIds] = useState<Set<string>>(new Set());

  // ─── Three.js viewport ────────────────────────────────────────────────
  const mountRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const contentGroupRef = useRef<THREE.Group | null>(null);
  // The tick loop reads the latest store data via refs so the loop itself
  // doesn't need to be rebuilt on every dep change.
  const chainEmitterIdsRef = useRef<Set<string>>(chainEmitterIds);
  const opticalElementsRef = useRef(physicsElements);
  const opticalLinksRef = useRef(opticalLinks);
  const objectsRef = useRef(objects);
  const componentsRef = useRef(components);
  const assetsRef = useRef(assets);
  const selectedEmitterIdRef = useRef<string | null>(null);
  const tasFoldedIntoLaserRef = useRef<Set<string>>(tasFoldedIntoLaser);
  const setScopeProbeRef = useRef(setScopeProbe);
  const setChainEmitterIdsRef = useRef(setChainEmitterIds);
  const setTasFoldedIntoLaserRef = useRef(setTasFoldedIntoLaser);
  chainEmitterIdsRef.current = chainEmitterIds;
  opticalElementsRef.current = physicsElements;
  opticalLinksRef.current = opticalLinks;
  objectsRef.current = objects;
  componentsRef.current = components;
  assetsRef.current = assets;
  selectedEmitterIdRef.current = selectedEmitterId;
  tasFoldedIntoLaserRef.current = tasFoldedIntoLaser;
  setScopeProbeRef.current = setScopeProbe;
  setChainEmitterIdsRef.current = setChainEmitterIds;
  setTasFoldedIntoLaserRef.current = setTasFoldedIntoLaser;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0b1120");

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambient);
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(5, 10, 7);
    scene.add(dir);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 5000);
    camera.position.set(8, 6, 8);
    camera.lookAt(0, 0, 0);

    // WebGLRenderer can throw if the browser has hit its per-page WebGL
    // context cap — happens transiently in React StrictMode dev because the
    // previous renderer's context isn't released synchronously when we
    // dispose it. Swallow the failure and let a fresh effect run pick up.
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    renderer.domElement.style.cursor = "crosshair";
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    const contentGroup = new THREE.Group();
    contentGroup.name = "optical-link-content";
    scene.add(contentGroup);
    // Beam tubes are added to a child group so the click raycaster can hit
    // ONLY them (anchor spheres / aperture rings on the same scene shouldn't
    // intercept a beam-segment probe click).
    const beamGroup = new THREE.Group();
    beamGroup.name = "beam-tubes";
    contentGroup.add(beamGroup);

    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;
    controlsRef.current = controls;
    contentGroupRef.current = contentGroup;

    // Content-rebuild cache keys. Declared here (not next to rebuildContent
    // below) because onResize also needs to invalidate prevCameraFitKey when
    // the panel first transitions from hidden (0×0) to visible — see comment
    // on `firstRealResize` in onResize.
    let prevContentKey = "";
    let prevCameraFitKey = "";

    // First-real-resize flag: when the panel is mounted inside a hidden
    // FloatingPanel, mount.clientWidth/Height are 0 at this useEffect
    // (deps: []) firing. Clamping to Math.max(1, …) here would lock a 1×1
    // viewport and the camera-fit (gated by prevCameraFitKey above) would
    // latch a stale aspect. We instead skip while hidden and, on the FIRST
    // tick that sees real dimensions, reset prevCameraFitKey so the next
    // rebuildContent() re-fits the camera against the actual viewport.
    let firstRealResize = true;
    const onResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w <= 0 || h <= 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (firstRealResize) {
        firstRealResize = false;
        prevCameraFitKey = "";
      }
    };
    onResize();
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    // ─── Click-to-probe ────────────────────────────────────────────────
    // OrbitControls swallows pointermove/up but lets pointerdown reach the
    // canvas. We treat a press-without-drag as a click (movement <
    // CLICK_PX_THRESHOLD between down and up). On a beam tube hit, project
    // the intersection point onto the segment's centre axis and publish to
    // `scopeProbe` — exactly what the main scene's beam click handler
    // produces.
    const raycaster = new THREE.Raycaster();
    raycaster.params.Line = { threshold: 0.01 };
    const pointer = new THREE.Vector2();
    const CLICK_PX_THRESHOLD = 4;
    let pressX = 0;
    let pressY = 0;
    let pressed = false;

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      pressed = true;
      pressX = event.clientX;
      pressY = event.clientY;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!pressed) return;
      pressed = false;
      if (
        Math.abs(event.clientX - pressX) > CLICK_PX_THRESHOLD ||
        Math.abs(event.clientY - pressY) > CLICK_PX_THRESHOLD
      ) {
        return; // user was dragging the camera, not clicking a beam
      }
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(beamGroup.children, false);
      if (hits.length === 0) return;
      const hit = hits[0];
      const segment = hit.object.userData.segment as LiveTraceSegment | undefined;
      if (!segment) return;
      // Project the click onto the segment's centre axis so the probe
      // marker sits on the central ray rather than on the tube surface.
      const start = new THREE.Vector3(segment.startThree.x, segment.startThree.y, segment.startThree.z);
      const end = new THREE.Vector3(segment.endThree.x, segment.endThree.y, segment.endThree.z);
      const seg = new THREE.Vector3().subVectors(end, start);
      const len2 = seg.lengthSq();
      let t = 0;
      if (len2 > 1e-18) {
        t = hit.point.clone().sub(start).dot(seg) / len2;
        t = Math.max(0, Math.min(1, t));
      }
      const onAxis = start.clone().addScaledVector(seg, t);
      // segment.lengthMm is in lab mm; pathLengthFromSourceMmAtStart is
      // also in lab mm. setScopeProbe.zMm is "distance from source along
      // the beam", matching what the main scene's click handler stores.
      const zMm = segment.pathLengthFromSourceMmAtStart + segment.lengthMm * t;
      setScopeProbeRef.current({
        sourceComponentId: segment.sourceComponentId,
        zMm,
        pointThree: { x: onAxis.x, y: onAxis.y, z: onAxis.z },
        powerFactor: typeof segment.powerFactorAtStart === "number"
          ? segment.powerFactorAtStart
          : 1.0,
        polarization: Array.isArray(segment.polarizationAtStart) &&
          segment.polarizationAtStart.length === 4
          ? segment.polarizationAtStart
          : [1, 0, 0, 0],
      });
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);

    // ─── Content rebuild loop ─────────────────────────────────────────
    // Polled inside a setInterval so we always pick up the most recent
    // `__rayTraceDebug` publication regardless of when DigitalTwinViewer's
    // async render effect lands relative to ours.
    // (prevContentKey + prevCameraFitKey are declared above so onResize
    // can invalidate the camera-fit cache on first real resize.)

    const VISUAL_BOOST = 4; // amplify Gaussian waist for visibility
    const VISUAL_FLOOR_UM = 30; // never draw thinner than this in µm

    const disposeTree = (root: THREE.Object3D) => {
      root.traverse((obj) => {
        const m = obj as THREE.Mesh | THREE.Line | THREE.Sprite;
        const g = (m as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
        if (g) g.dispose();
        const mat = (m as THREE.Mesh).material;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else if (mat) mat.dispose();
      });
    };

    const clearGroup = (group: THREE.Group) => {
      while (group.children.length > 0) {
        const child = group.children.pop()!;
        disposeTree(child);
      }
    };

    /** Compare two Sets by membership only (order-agnostic). */
    const sameSet = <T,>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean => {
      if (a.size !== b.size) return false;
      for (const x of a) if (!b.has(x)) return false;
      return true;
    };

    const rebuildContent = () => {
      const win = window as unknown as { __rayTraceDebug?: LiveTraceSegment[] };
      const allSegments = win.__rayTraceDebug ?? [];

      // ── Recompute "TAs folded into a laser's chain" + "current
      // selected emitter's chain" from live data each tick. Push back
      // to React state only when the membership actually changes.
      const allEmitterIds = new Set<string>();
      const taIds = new Set<string>();
      for (const el of opticalElementsRef.current) {
        if (!EMITTER_KINDS.has(el.elementKind)) continue;
        allEmitterIds.add(el.objectId);
        if (el.elementKind === "tapered_amplifier") taIds.add(el.objectId);
      }
      const foldedTAs = new Set<string>();
      for (const el of opticalElementsRef.current) {
        if (el.elementKind !== "laser_source") continue;
        const chain = downstreamEmitterChain(
          el.objectId,
          opticalLinksRef.current,
          allSegments,
          allEmitterIds,
        );
        for (const id of chain) {
          if (id !== el.objectId && taIds.has(id)) foldedTAs.add(id);
        }
      }
      if (!sameSet(foldedTAs, tasFoldedIntoLaserRef.current)) {
        tasFoldedIntoLaserRef.current = foldedTAs;
        setTasFoldedIntoLaserRef.current(foldedTAs);
      }

      const selectedId = selectedEmitterIdRef.current;
      const chainIds = selectedId
        ? downstreamEmitterChain(
            selectedId,
            opticalLinksRef.current,
            allSegments,
            allEmitterIds,
          )
        : new Set<string>();
      if (!sameSet(chainIds, chainEmitterIdsRef.current)) {
        chainEmitterIdsRef.current = chainIds;
        setChainEmitterIdsRef.current(chainIds);
      }

      const segments = chainIds.size === 0
        ? []
        : allSegments.filter((s) => chainIds.has(s.emitterObjectId));

      const key = chainIds.size === 0
        ? "(none)"
        : segments
            .map(
              (s) =>
                `${s.startThree.x},${s.startThree.y},${s.startThree.z}|` +
                `${s.endThree.x},${s.endThree.y},${s.endThree.z}|` +
                `${s.hitObjectId ?? ""}|${s.wavelengthNm}|` +
                `${s.waistAtStartUm.toFixed(3)}|${s.waistAtEndUm.toFixed(3)}`,
            )
            .join(";");
      if (key === prevContentKey) return;
      prevContentKey = key;

      // Wipe the previous content (beams + anchors + rings).
      while (contentGroup.children.length > 0) {
        const child = contentGroup.children.pop()!;
        if (child === beamGroup) continue; // keep the beam group container alive
        disposeTree(child);
      }
      clearGroup(beamGroup);
      contentGroup.add(beamGroup);

      if (segments.length === 0) return;

      const elementByObjectId = new Map<string, PhysicsElement>();
      for (const el of opticalElementsRef.current) elementByObjectId.set(el.objectId, el);
      const objectById = new Map<string, SceneObject>(
        objectsRef.current.map((o) => [o.id, o]),
      );
      const componentById = new Map<string, ComponentItem>(
        componentsRef.current.map((c) => [c.id, c]),
      );
      const assetById = new Map<string, Asset3D>(
        assetsRef.current.map((a) => [a.id, a]),
      );
      const assetForObjectId = (objectId: string): Asset3D | undefined => {
        const obj = objectById.get(objectId);
        if (!obj) return undefined;
        const comp = componentById.get(obj.componentId);
        if (!comp?.asset3dId) return undefined;
        return assetById.get(comp.asset3dId);
      };

      // Pass 1: bbox + collect every distinct scene object the chain
      // touches (emitters + every hit). Used to size anchor markers and
      // to drive the camera-fit step at the end.
      const bbox = new THREE.Box3();
      const touchedObjectIds = new Set<string>();
      for (const seg of segments) {
        bbox.expandByPoint(new THREE.Vector3(seg.startThree.x, seg.startThree.y, seg.startThree.z));
        bbox.expandByPoint(new THREE.Vector3(seg.endThree.x, seg.endThree.y, seg.endThree.z));
        touchedObjectIds.add(seg.sourceObjectId);
        if (seg.hitObjectId) touchedObjectIds.add(seg.hitObjectId);
      }
      const bboxSpan = bbox.isEmpty()
        ? 1
        : Math.max(bbox.getSize(new THREE.Vector3()).length(), 1e-3);

      const yAxis = new THREE.Vector3(0, 1, 0);
      const apertureDrawn = new Set<string>();

      // Pass 2: build the beam tubes with Gaussian taper.
      for (const seg of segments) {
        const start = new THREE.Vector3(seg.startThree.x, seg.startThree.y, seg.startThree.z);
        const end = new THREE.Vector3(seg.endThree.x, seg.endThree.y, seg.endThree.z);
        const direction = new THREE.Vector3().subVectors(end, start);
        const length = direction.length();
        if (length < 1e-9) continue;
        direction.normalize();

        const colour = wavelengthToColor(seg.wavelengthNm);

        // CylinderGeometry supports independent top/bottom radii — perfect
        // for a Gaussian taper between waistAtStartUm and waistAtEndUm.
        // The geometry runs along +Y from -length/2 to +length/2 with the
        // BOTTOM at -Y (start) and TOP at +Y (end), so radiusTop ↔ end.
        const wStartUm = Math.max(seg.waistAtStartUm, VISUAL_FLOOR_UM);
        const wEndUm = Math.max(seg.waistAtEndUm, VISUAL_FLOOR_UM);
        // µm → mm → Three units (1 Three unit = 100 mm), with the same
        // VISUAL_BOOST multiplier the main scene uses so the panel's
        // beams match the main viewer's apparent thickness.
        const radiusStartScene = mmToThree(wStartUm / 1000) * VISUAL_BOOST;
        const radiusEndScene = mmToThree(wEndUm / 1000) * VISUAL_BOOST;
        const tubeGeom = new THREE.CylinderGeometry(
          radiusEndScene, // radiusTop
          radiusStartScene, // radiusBottom
          length,
          16,
          1,
          true,
        );
        const tubeMat = new THREE.MeshBasicMaterial({
          color: colour,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.55,
        });
        const tube = new THREE.Mesh(tubeGeom, tubeMat);
        tube.position.copy(start).addScaledVector(direction, length / 2);
        tube.quaternion.setFromUnitVectors(yAxis, direction);
        // Skinny centreline so a near-focus pinch is still visible.
        const lineGeom = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, -length / 2, 0),
          new THREE.Vector3(0, length / 2, 0),
        ]);
        const lineMat = new THREE.LineBasicMaterial({ color: colour });
        const centreline = new THREE.Line(lineGeom, lineMat);
        tube.add(centreline);
        tube.userData.segment = seg;
        beamGroup.add(tube);

        // Aperture ring at the hit point.
        if (seg.hitObjectId && !apertureDrawn.has(seg.hitObjectId)) {
          const el = elementByObjectId.get(seg.hitObjectId);
          const asset = assetForObjectId(seg.hitObjectId);
          const diameterMm = apertureDiameterMm(el, asset);
          if (diameterMm !== null && diameterMm > 0) {
            // diameterMm is physical mm; convert to Three units (1 Three
            // unit ≡ 100 mm via `MM_PER_THREE_UNIT`) and scale by the
            // same `VISUAL_BOOST` we use for the beam tube so the
            // physical beam-to-aperture clearance ratio stays accurate
            // while both stay visible at scene scale.
            const radius = mmToThree(diameterMm) / 2 * VISUAL_BOOST;
            const ringThickness = Math.max(
              radius * 0.08,
              bboxSpan * 0.003,
            );
            const ringGeom = new THREE.RingGeometry(
              Math.max(radius - ringThickness, radius * 0.5),
              radius,
              64,
            );
            const ringMat = new THREE.MeshBasicMaterial({
              color: 0x60a5fa,
              side: THREE.DoubleSide,
              transparent: true,
              opacity: 1.0,
              depthTest: false,
            });
            const ring = new THREE.Mesh(ringGeom, ringMat);
            ring.position.copy(end);
            ring.lookAt(start);
            ring.renderOrder = 2000; // above beam tubes
            contentGroup.add(ring);
            apertureDrawn.add(seg.hitObjectId);
          }
        }
      }

      // Pass 3: anchor spheres at every touched scene object. We render
      // ALL anchors (excluding bbox-helper face anchors `+x` / `-x` / ...)
      // so the user can see the optic's port topology without seeing the
      // solid body.
      const sphereRadius = Math.max(bboxSpan * 0.01, 0.04);
      for (const objectId of touchedObjectIds) {
        const obj = objectById.get(objectId);
        const asset = assetForObjectId(objectId);
        if (!obj || !asset?.anchors) continue;
        for (const anchor of asset.anchors) {
          // Skip the auto-generated bbox face anchors (`+x`, `-x`, `+y`,
          // `-y`, `+z`, `-z`) — they're helper origins, not meaningful
          // optical ports.
          if (/^[+-][xyz]$/.test(anchor.id)) continue;
          const local = anchor.positionMmBodyLocal ?? { x: 0, y: 0, z: 0 };
          // Body-local mm (Z-up) → Three units (Y-up). The axis swap
          // (z → y, -y → z) matches OpticalComponentEditor's anchor
          // marker placement, and mmToThree divides by MM_PER_THREE_UNIT
          // (100) so the panel uses the same scale as the main scene.
          const localThree = new THREE.Vector3(
            mmToThree(local.x),
            mmToThree(local.z),
            mmToThree(-local.y),
          );
          // Apply the object's intrinsic XYZ Euler rotation.
          const euler = new THREE.Euler(
            THREE.MathUtils.degToRad(obj.rxDeg),
            THREE.MathUtils.degToRad(obj.ryDeg),
            THREE.MathUtils.degToRad(obj.rzDeg),
            "XYZ",
          );
          const quat = new THREE.Quaternion().setFromEuler(euler);
          localThree.applyQuaternion(quat);
          // Object origin: lab mm → Three units (frames.labMmToThree
          // applies the same axis swap + scale used by every other
          // scene-object renderer in this codebase).
          const objThree = labMmToThree({ xMm: obj.xMm, yMm: obj.yMm, zMm: obj.zMm });
          const worldThree = objThree.clone().add(localThree);

          const colour = anchorColour(anchor.id);
          const sphereGeom = new THREE.SphereGeometry(sphereRadius, 16, 12);
          const sphereMat = new THREE.MeshBasicMaterial({
            color: colour,
            depthTest: false,
            transparent: true,
            opacity: 0.9,
          });
          const sphere = new THREE.Mesh(sphereGeom, sphereMat);
          sphere.position.copy(worldThree);
          sphere.renderOrder = 1000;
          contentGroup.add(sphere);
        }
      }

      // Camera fit — only when the bbox actually changed.
      if (!bbox.isEmpty()) {
        const min = bbox.min;
        const max = bbox.max;
        const fitKey = `${min.x.toFixed(2)},${min.y.toFixed(2)},${min.z.toFixed(2)}|${max.x.toFixed(2)},${max.y.toFixed(2)},${max.z.toFixed(2)}`;
        if (fitKey !== prevCameraFitKey) {
          prevCameraFitKey = fitKey;
          const center = bbox.getCenter(new THREE.Vector3());
          const size = bbox.getSize(new THREE.Vector3());
          const span = Math.max(size.length(), 1);
          controls.target.copy(center);
          const offset = new THREE.Vector3(1, 0.8, 1)
            .normalize()
            .multiplyScalar(span * 1.0);
          camera.position.copy(center).add(offset);
          camera.near = Math.max(0.001, span * 0.001);
          camera.far = Math.max(5000, span * 50);
          camera.updateProjectionMatrix();
          controls.update();
        }
      }
    };

    const tick = () => {
      // Skip while the FloatingPanel hosting us is collapsed/hidden — we'd
      // otherwise latch prevContentKey = "(none)" and render into a zero-
      // size viewport before onResize gets a chance to fire.
      if (mount.clientWidth <= 0 || mount.clientHeight <= 0) return;
      rebuildContent();
      controls.update();
      renderer.render(scene, camera);
    };
    tick();
    const intervalId = window.setInterval(tick, 16);

    return () => {
      window.clearInterval(intervalId);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      controls.dispose();
      contentGroup.traverse((obj) => {
        const m = obj as THREE.Mesh | THREE.Line;
        const g = (m as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
        if (g) g.dispose();
        const mat = (m as THREE.Mesh).material;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else if (mat) mat.dispose();
      });
      renderer.forceContextLoss();
      renderer.dispose();
      if (renderer.domElement.parentElement === mount) {
        mount.removeChild(renderer.domElement);
      }
      sceneRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
      controlsRef.current = null;
      contentGroupRef.current = null;
    };
    // Re-run whenever the panel transitions from hidden→visible. FloatingPanel
    // returns null while hidden, so the mount DIV doesn't exist on initial
    // render — the effect bails at the `if (!mount) return;` guard above.
    // Adding `panelVisible` as a dep means the effect re-fires after the
    // FloatingPanel renders its children for the first time, at which point
    // mountRef.current is set and the renderer can attach.
  }, [panelVisible]);

  // Does the current scope probe live on one of our chain's segments? Only
  // show the inline BeamScope plots when it does — otherwise the user has
  // probed a beam from a different emitter and the plots would be confusing.
  const probeBelongsToChain = useMemo(() => {
    if (!scopeProbe) return false;
    const win = window as unknown as { __rayTraceDebug?: LiveTraceSegment[] };
    const allSegments = win.__rayTraceDebug ?? [];
    const px = scopeProbe.pointThree.x;
    const py = scopeProbe.pointThree.y;
    const pz = scopeProbe.pointThree.z;
    let bestSeg: LiveTraceSegment | null = null;
    let bestDist = Infinity;
    for (const seg of allSegments) {
      const a = seg.startThree;
      const b = seg.endThree;
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const abz = b.z - a.z;
      const len2 = abx * abx + aby * aby + abz * abz;
      if (len2 < 1e-18) continue;
      let t = ((px - a.x) * abx + (py - a.y) * aby + (pz - a.z) * abz) / len2;
      t = Math.max(0, Math.min(1, t));
      const cx = a.x + abx * t;
      const cy = a.y + aby * t;
      const cz = a.z + abz * t;
      const d2 = (px - cx) ** 2 + (py - cy) ** 2 + (pz - cz) ** 2;
      if (d2 < bestDist) {
        bestDist = d2;
        bestSeg = seg;
      }
    }
    return !!bestSeg && chainEmitterIds.has(bestSeg.emitterObjectId);
    // Re-run when scope probe OR chain set changes, AND also when underlying
    // trace data could have shifted via store updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeProbe, chainEmitterIds, physicsElements]);

  const noEmitters = emitterChoices.length === 0;

  return (
    <FloatingPanel id="optical-link-viewer" title="Optical link viewer">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          minHeight: 0,
          gap: 8,
        }}
      >
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
          }}
        >
          <span style={{ color: "#9ca3af" }}>Emitter</span>
          <select
            value={selectedEmitterId ?? ""}
            onChange={(e) => setSelectedEmitterId(e.target.value || null)}
            style={{ flex: 1, minWidth: 0 }}
            disabled={noEmitters}
          >
            {noEmitters ? (
              <option value="">(no emitters)</option>
            ) : (
              emitterChoices.map((c) => (
                <option key={c.objectId} value={c.objectId}>
                  {c.name}
                </option>
              ))
            )}
          </select>
        </label>
        <div
          style={{
            flex: probeBelongsToChain ? 1.2 : 1,
            minHeight: 0,
            position: "relative",
            borderRadius: 4,
            overflow: "hidden",
            background: "#0b1120",
          }}
        >
          <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />
          {noEmitters && (
            <p
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#9ca3af",
                fontSize: 12,
                margin: 0,
                pointerEvents: "none",
              }}
            >
              No laser sources or standalone tapered amplifiers in the scene.
            </p>
          )}
        </div>
        {probeBelongsToChain && (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflow: "auto",
              borderTop: "1px solid rgba(255,255,255,0.07)",
              paddingTop: 6,
            }}
          >
            <BeamScopeContents />
          </div>
        )}
      </div>
    </FloatingPanel>
  );
}
