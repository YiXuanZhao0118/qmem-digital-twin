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
import { loadAssetObject } from "../../three/loadAsset";
import { applyObjectTransform } from "../../three/transformUtils";
import { mmToThree } from "../../optical/frames";
import { FloatingPanel } from "../workspace/FloatingPanel";
import { usePanelLayout } from "../workspace/WorkspaceProvider";
import { BeamScopeContents } from "./BeamScopePanel";

const EMITTER_KINDS: ReadonlySet<string> = new Set([
  "laser_source",
  "tapered_amplifier",
]);

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

/** Effective clear-aperture radius (mm) of the asset anchor closest to the
 *  incoming beam (intercept_in / intercept_face / optical_anchor). Reads
 *  the V2 schema: `apertureMm` = radius (circle); `apertureWidthMm` /
 *  `apertureHeightMm` = full extents (ellipse semi-axis = w/2; rectangle
 *  inscribed circle radius = min(w, h)/2). Returns the limiting radius
 *  for beam-clipping checks. Falls back to PhysicsElement.kindParams
 *  `clearApertureMm` (treated as diameter ↦ /2). Null when undefined. */
function asset_anchor_apertureRadiusMm(
  el: PhysicsElement | undefined,
  asset: Asset3D | undefined,
): number | null {
  if (asset?.anchors) {
    for (const id of ["intercept_in", "intercept_face", "intercept_out", "optical_anchor"]) {
      const anchor = asset.anchors.find((a) => a.id === id);
      if (!anchor) continue;
      const shape = anchor.apertureShape
        ?? (anchor.apertureWidthMm != null && anchor.apertureHeightMm != null ? "rectangle" : "circle");
      if (shape === "circle") {
        if (typeof anchor.apertureMm === "number" && anchor.apertureMm > 0) {
          return anchor.apertureMm;
        }
      } else {
        const w = anchor.apertureWidthMm;
        const h = anchor.apertureHeightMm;
        if (typeof w === "number" && typeof h === "number" && w > 0 && h > 0) {
          return Math.min(w, h) / 2;
        }
      }
    }
  }
  // Legacy kindParams.clearApertureMm is a diameter convention (see
  // apertureCheck.ts: r = apMm / 2). Convert to radius.
  if (el) {
    const params = el.kindParams as Record<string, unknown>;
    const v = params.clearApertureMm;
    if (typeof v === "number" && v > 0) return v / 2;
  }
  return null;
}

/** Passive optical kinds — wavelengthRangeNm warning fires for these
 *  (a beam hitting an out-of-range coating / crystal will not behave as
 *  spec'd, but the solver/ray-tracer doesn't enforce it). Emitter +
 *  fiber-end kinds are excluded — their wavelength is the *source* of
 *  truth, not a constraint imposed on incoming light. */
const PASSIVE_OPTICAL_KINDS: ReadonlySet<string> = new Set([
  "mirror",
  "dichroic_mirror",
  "lens_biconvex",
  "lens_plano_convex",
  "lens_cylindrical",
  "waveplate",
  "polarizer",
  "beam_splitter",
  "isolator",
  "eom",
  "aom",
  "nonlinear_crystal",
  "saturable_absorber",
  "fiber_coupler",
  "fiber",
]);

/** Kinds whose beam acceptance is described by Gaussian modematching
 *  (TA seed mode, fiber MFD) rather than a hard clear aperture. The
 *  Clipping warning is suppressed for these — the matching mode-overlap
 *  warning is the right physical signal. PHY Editor likewise hides
 *  apertureMm for these via `showAperture={false}`. */
const MODEMATCHED_KINDS: ReadonlySet<string> = new Set([
  "laser_source",
  "tapered_amplifier",
  "fiber",
  "fiber_end",
]);

type LinkWarning = {
  key: string;
  kind: "aperture-too-small" | "wavelength-out-of-range" | "mode-mismatch";
  message: string;
};

/** Target Gaussian mode (1/e² waist radius in µm + a human label) the
 *  incoming beam should match for efficient coupling. TA seeds and
 *  fiber inputs are the canonical cases. Returns null for kinds whose
 *  mode acceptance isn't spec'd by a single Gaussian waist. */
function getModeMatchTarget(
  kind: string,
  kindParams: Record<string, unknown>,
  lookupParams?: (objectId: string) => Record<string, unknown> | null,
): { waistUm: number; label: string } | null {
  if (kind === "tapered_amplifier") {
    const x = kindParams.inputSpatialModeX as { waistUm?: number } | undefined;
    const y = kindParams.inputSpatialModeY as { waistUm?: number } | undefined;
    const wx = typeof x?.waistUm === "number" ? x.waistUm : null;
    const wy = typeof y?.waistUm === "number" ? y.waistUm : null;
    const w = wx != null && wy != null ? (wx + wy) / 2 : (wx ?? wy);
    if (w == null || w <= 0) return null;
    return { waistUm: w, label: "TA seed mode" };
  }
  if (kind === "fiber") {
    // Either end may be the input port. Use endA's MFD as the
    // approximation — symmetric patch cables (the default) have endA ==
    // endB, and asymmetric ones are rare. MFD = 2 × 1/e² waist radius.
    const endA = kindParams.endA as { modeFieldDiameterUm?: number } | undefined;
    const mfd = endA?.modeFieldDiameterUm;
    if (typeof mfd !== "number" || mfd <= 0) return null;
    return { waistUm: mfd / 2, label: "fiber MFD" };
  }
  if (kind === "fiber_end") {
    // Resolve MFD from the paired fiber body's per-end spec.
    const bodyId = kindParams.fiberBodyObjectId;
    const role = kindParams.endRole;
    if (typeof bodyId !== "string" || (role !== "A" && role !== "B") || !lookupParams) {
      return null;
    }
    const bodyParams = lookupParams(bodyId);
    if (!bodyParams) return null;
    const end = bodyParams[role === "A" ? "endA" : "endB"] as
      | { modeFieldDiameterUm?: number }
      | undefined;
    const mfd = end?.modeFieldDiameterUm;
    if (typeof mfd !== "number" || mfd <= 0) return null;
    return { waistUm: mfd / 2, label: `fiber MFD (end ${role})` };
  }
  return null;
}

/** Gaussian-to-Gaussian power overlap (same waist position, on-axis).
 *  η = 4 / (w1/w2 + w2/w1)²; ≤ 1. The actual physical coupling is also
 *  limited by tilt / transverse offset / waist-z mismatch, but waist-
 *  ratio overlap alone catches the most common misalignment (wrong
 *  focal length on the coupling lens). */
function gaussianOverlap(w1: number, w2: number): number {
  if (w1 <= 0 || w2 <= 0) return 0;
  const r = w1 / w2 + w2 / w1;
  return 4 / (r * r);
}

const MODE_MATCH_WARN_THRESHOLD = 0.8;

function computeLinkWarnings(
  segments: readonly LiveTraceSegment[],
  objects: readonly SceneObject[],
  components: readonly ComponentItem[],
  assets: readonly Asset3D[],
  physicsElements: readonly PhysicsElement[],
): LinkWarning[] {
  if (segments.length === 0) return [];
  const objectById = new Map(objects.map((o) => [o.id, o]));
  const componentById = new Map(components.map((c) => [c.id, c]));
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const elementByObjectId = new Map<string, PhysicsElement>();
  for (const el of physicsElements) elementByObjectId.set(el.objectId, el);
  const lookupParams = (objectId: string): Record<string, unknown> | null => {
    const e = elementByObjectId.get(objectId);
    return e ? ((e.kindParams ?? {}) as Record<string, unknown>) : null;
  };

  const out: LinkWarning[] = [];
  const seen = new Set<string>();
  for (const seg of segments) {
    if (!seg.hitObjectId) continue;
    const obj = objectById.get(seg.hitObjectId);
    if (!obj) continue;
    const comp = componentById.get(obj.componentId);
    const asset = comp?.asset3dId ? assetById.get(comp.asset3dId) : undefined;
    const el = elementByObjectId.get(seg.hitObjectId);
    const kind = el?.elementKind;

    // [1] Aperture: warn if clear-aperture radius < 3 × beam waist
    //     (1/e² radius). Standard no-clip guideline — at 3 × waist a
    //     Gaussian beam contains > 99.97% of its power. Modematched
    //     kinds (laser/TA/fiber) get the mode-overlap warning instead;
    //     no clear aperture is defined for them.
    const skipAperture = kind != null && MODEMATCHED_KINDS.has(kind);
    const apRadiusMm = skipAperture ? null : asset_anchor_apertureRadiusMm(el, asset);
    const waistEndMm = seg.waistAtEndUm / 1000;
    if (apRadiusMm != null && waistEndMm > 0 && apRadiusMm < 3 * waistEndMm) {
      const key = `ap|${seg.hitObjectId}|${seg.wavelengthNm}`;
      if (!seen.has(key)) {
        seen.add(key);
        const beamDiamMm = waistEndMm * 2;
        const apDiamMm = apRadiusMm * 2;
        out.push({
          key,
          kind: "aperture-too-small",
          message: `${obj.name}: aperture Ø ${apDiamMm.toFixed(2)} mm < 3× beam Ø ${(beamDiamMm * 3).toFixed(2)} mm (beam Ø ${beamDiamMm.toFixed(2)} mm)`,
        });
      }
    }

    // [2] Wavelength range: warn when beam λ is outside the passive
    //     optic's spec'd range.
    if (kind && PASSIVE_OPTICAL_KINDS.has(kind)) {
      const params = (el?.kindParams ?? {}) as { wavelengthRangeNm?: [number, number] };
      const range = params.wavelengthRangeNm;
      if (Array.isArray(range) && range.length === 2) {
        const [minNm, maxNm] = range;
        if (
          typeof minNm === "number" && typeof maxNm === "number"
          && (seg.wavelengthNm < minNm || seg.wavelengthNm > maxNm)
        ) {
          const key = `wl|${seg.hitObjectId}|${seg.wavelengthNm}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({
              key,
              kind: "wavelength-out-of-range",
              message: `${obj.name}: beam λ ${seg.wavelengthNm.toFixed(1)} nm outside spec [${minNm}, ${maxNm}] nm`,
            });
          }
        }
      }
    }

    // [3] Mode matching: warn when incoming beam waist mismatches the
    //     target's accepted Gaussian mode (TA seed input, fiber MFD)
    //     by more than the threshold. Uses the simple same-waist-z
    //     overlap formula η = 4 / (w_in/w_t + w_t/w_in)² — captures
    //     wrong-focal-length coupling lens, the dominant lab error.
    if (kind && el) {
      const target = getModeMatchTarget(
        kind,
        (el.kindParams ?? {}) as Record<string, unknown>,
        lookupParams,
      );
      if (target && seg.waistAtEndUm > 0) {
        const eta = gaussianOverlap(seg.waistAtEndUm, target.waistUm);
        if (eta < MODE_MATCH_WARN_THRESHOLD) {
          const key = `mm|${seg.hitObjectId}|${seg.wavelengthNm}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({
              key,
              kind: "mode-mismatch",
              message: `${obj.name}: mode overlap ${(eta * 100).toFixed(0)}% (beam waist ${seg.waistAtEndUm.toFixed(1)} µm vs ${target.label} ${target.waistUm.toFixed(1)} µm)`,
            });
          }
        }
      }
    }
  }
  return out;
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

  // Aperture / wavelength-range warnings derived from the live ray-trace
  // segments crossed by this chain. Polled at 250 ms (cheap; segments
  // rarely change). The polled effect keys off chainEmitterIds + scene
  // data so warnings refresh when the scene mutates too.
  const [warnings, setWarnings] = useState<LinkWarning[]>([]);

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
  const scopeProbeRef = useRef(scopeProbe);
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
  scopeProbeRef.current = scopeProbe;

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
    let prevProbeKey = "";

    // Async-loaded mesh wireframes, keyed by SceneObject id. Each entry is
    // either a Group whose children are LineSegments with the asset's local
    // transforms baked in, or "pending" while the load is in flight. The
    // group is cloned (shallow — geometry/material shared) per scene to
    // apply the scene-object's world transform without mutating the cache.
    // Filled lazily inside rebuildContent's wireframe pass; survives ticks
    // but is torn down when the useEffect re-fires (eg. panel hide→show).
    const wireframeCache = new Map<string, THREE.Group | "pending">();
    let disposed = false;
    let probeMarkerGroup: THREE.Group | null = null;

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

    // Most recently observed bbox span — used by updateProbeMarker to size
    // the marker proportionally to the current scene without re-walking
    // segments. Updated at the end of rebuildContent.
    let lastBboxSpan = 1;

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

      // Pass 3: object wireframes at every touched scene object. We load
      // the same GLB/STEP asset the main scene uses, then extract per-
      // mesh edge lines via EdgesGeometry(45°). 45° is intentionally
      // looser than the main scene's 30° selection outline so the panel
      // shows a sparser silhouette — enough to identify the optic
      // without cluttering the beam view.
      for (const objectId of touchedObjectIds) {
        const obj = objectById.get(objectId);
        if (!obj) continue;
        const cached = wireframeCache.get(objectId);
        if (cached === "pending") continue;
        if (!cached) {
          // Kick off an async load; the next tick after resolve will
          // see the cache hit and render. We mark "pending" so we don't
          // dispatch a second load for the same object meanwhile.
          wireframeCache.set(objectId, "pending");
          const comp = componentById.get(obj.componentId);
          if (!comp) {
            wireframeCache.delete(objectId);
            continue;
          }
          const asset = comp.asset3dId ? assetById.get(comp.asset3dId) : undefined;
          // Fiber + RF cable wrappers are procedural and read their shape
          // from per-instance properties (fiberNodes / rfCableNodes /
          // radiusMm). Pass the SceneObject's properties so the spline
          // matches what the main scene draws — otherwise loadAssetObject
          // falls back to catalog defaults and the wireframe sits along
          // a completely different curve than the actual beam.
          const loaderProps = (obj.properties ?? null) as
            | { fiberNodes?: unknown[]; rfCableNodes?: unknown[]; radiusMm?: number }
            | null;
          void (async () => {
            let loaded: THREE.Object3D;
            try {
              loaded = await loadAssetObject(
                comp,
                asset,
                undefined,
                loaderProps as Parameters<typeof loadAssetObject>[3],
              );
            } catch {
              if (!disposed) wireframeCache.delete(objectId);
              return;
            }
            const group = new THREE.Group();
            group.name = `wireframe-${objectId}`;
            loaded.updateMatrixWorld(true);
            const lineMat = new THREE.LineBasicMaterial({
              color: 0x94a3b8, // slate-400 — muted against dark bg, doesn't fight beam colours
              transparent: true,
              opacity: 0.55,
              depthTest: true,
            });
            loaded.traverse((child) => {
              const mesh = child as THREE.Mesh;
              if (!(mesh instanceof THREE.Mesh) || !mesh.geometry) return;
              const edges = new THREE.EdgesGeometry(mesh.geometry, 45);
              // Bake the mesh's wrapper-local transform into the line
              // geometry so the group can be cloned-and-translated as a
              // single rigid unit (no nested matrix bookkeeping at use).
              edges.applyMatrix4(mesh.matrixWorld);
              group.add(new THREE.LineSegments(edges, lineMat));
            });
            disposeTree(loaded);
            if (disposed) {
              disposeTree(group);
              return;
            }
            wireframeCache.set(objectId, group);
            // Force the next rebuildContent to redraw even though the
            // segment-key is unchanged — the wireframes are now ready.
            prevContentKey = "";
          })();
          continue;
        }
        // Cache hit: shallow-clone so the cached prototype stays
        // untouched and we can apply the scene-object transform to the
        // clone. EdgesGeometry + LineBasicMaterial are shared by clone(true).
        const wrapper = cached.clone(true);
        applyObjectTransform(wrapper, obj);
        contentGroup.add(wrapper);
      }

      lastBboxSpan = bboxSpan;

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

    // Selection marker at the active scope-probe point. Lives in its own
    // group so beam/wireframe rebuilds don't dispose it (and probe-only
    // changes don't trigger a full rebuild). Rendered through any
    // intervening geometry via depthTest:false + high renderOrder so the
    // user always sees where their click landed even when the beam tube
    // would normally occlude it.
    const updateProbeMarker = () => {
      const probe = scopeProbeRef.current;
      const probeKey = probe
        ? `${probe.pointThree.x.toFixed(3)},${probe.pointThree.y.toFixed(3)},${probe.pointThree.z.toFixed(3)}`
        : "";
      if (probeKey === prevProbeKey) return;
      prevProbeKey = probeKey;
      if (probeMarkerGroup) {
        contentGroup.remove(probeMarkerGroup);
        disposeTree(probeMarkerGroup);
        probeMarkerGroup = null;
      }
      if (!probe) return;
      const span = lastBboxSpan;
      const markerRadius = Math.max(span * 0.0012, 0.004);
      const armLength = Math.max(span * 0.009, 0.03);
      // Orient the marker's local +z along the beam direction at the
      // probe. Walk the trace and pick the segment whose centreline is
      // closest to the probe point — same logic the click handler uses,
      // recomputed here because the user may have set the probe from a
      // different panel (main scene) and we don't carry direction in
      // scopeProbe. Local x is built ⊥ to z via a world-up cross (or
      // world-x when the beam IS world-up), and y completes the basis.
      const segs = (window as unknown as { __rayTraceDebug?: LiveTraceSegment[] }).__rayTraceDebug ?? [];
      const probeVec = new THREE.Vector3(probe.pointThree.x, probe.pointThree.y, probe.pointThree.z);
      let bestDir: THREE.Vector3 | null = null;
      let bestDist = Infinity;
      for (const seg of segs) {
        const a = new THREE.Vector3(seg.startThree.x, seg.startThree.y, seg.startThree.z);
        const b = new THREE.Vector3(seg.endThree.x, seg.endThree.y, seg.endThree.z);
        const ab = b.clone().sub(a);
        const len2 = ab.lengthSq();
        if (len2 < 1e-18) continue;
        let t = probeVec.clone().sub(a).dot(ab) / len2;
        t = Math.max(0, Math.min(1, t));
        const onLine = a.clone().addScaledVector(ab, t);
        const d = onLine.distanceTo(probeVec);
        if (d < bestDist) {
          bestDist = d;
          bestDir = ab.normalize();
        }
      }
      const yellow = 0xfacc15;
      const group = new THREE.Group();
      group.name = "probe-marker";
      group.position.set(probe.pointThree.x, probe.pointThree.y, probe.pointThree.z);
      if (bestDir) {
        const worldUp = new THREE.Vector3(0, 1, 0);
        const seed = Math.abs(bestDir.dot(worldUp)) < 0.95 ? worldUp : new THREE.Vector3(1, 0, 0);
        const xLocal = new THREE.Vector3().crossVectors(seed, bestDir).normalize();
        const yLocal = new THREE.Vector3().crossVectors(bestDir, xLocal).normalize();
        group.quaternion.setFromRotationMatrix(
          new THREE.Matrix4().makeBasis(xLocal, yLocal, bestDir),
        );
      }
      const sphereMat = new THREE.MeshBasicMaterial({
        color: yellow,
        depthTest: false,
        transparent: true,
        opacity: 0.95,
      });
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(markerRadius, 16, 12), sphereMat);
      sphere.renderOrder = 3000;
      group.add(sphere);
      const lineMat = new THREE.LineBasicMaterial({
        color: yellow,
        depthTest: false,
        transparent: true,
        opacity: 0.95,
      });
      for (const ax of ["x", "y", "z"] as const) {
        const a = new THREE.Vector3();
        const b = new THREE.Vector3();
        a[ax] = -armLength;
        b[ax] = armLength;
        const geom = new THREE.BufferGeometry().setFromPoints([a, b]);
        const line = new THREE.Line(geom, lineMat);
        line.renderOrder = 3000;
        group.add(line);
      }
      contentGroup.add(group);
      probeMarkerGroup = group;
    };

    const tick = () => {
      // Skip while the FloatingPanel hosting us is collapsed/hidden — we'd
      // otherwise latch prevContentKey = "(none)" and render into a zero-
      // size viewport before onResize gets a chance to fire.
      if (mount.clientWidth <= 0 || mount.clientHeight <= 0) return;
      rebuildContent();
      updateProbeMarker();
      controls.update();
      renderer.render(scene, camera);
    };
    tick();
    const intervalId = window.setInterval(tick, 16);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      controls.dispose();
      // Wireframe prototypes live outside contentGroup (they get cloned
      // in on each rebuild) so the traverse below misses them.
      for (const entry of wireframeCache.values()) {
        if (entry !== "pending") disposeTree(entry);
      }
      wireframeCache.clear();
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

  // Poll __rayTraceDebug for warnings (aperture clipping + wavelength
  // out-of-range) every 250 ms. State-set only when the warning list
  // actually changes so React doesn't re-render at the polling rate.
  useEffect(() => {
    if (chainEmitterIds.size === 0) {
      setWarnings((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const compute = () => {
      const win = window as unknown as { __rayTraceDebug?: LiveTraceSegment[] };
      const all = win.__rayTraceDebug ?? [];
      const segs = all.filter((s) => chainEmitterIds.has(s.emitterObjectId));
      return computeLinkWarnings(segs, objects, components, assets, physicsElements);
    };
    const sync = () => {
      const next = compute();
      setWarnings((prev) => {
        if (prev.length !== next.length) return next;
        for (let i = 0; i < prev.length; i++) {
          if (prev[i].key !== next[i].key || prev[i].message !== next[i].message) return next;
        }
        return prev;
      });
    };
    sync();
    const id = window.setInterval(sync, 250);
    return () => window.clearInterval(id);
  }, [chainEmitterIds, objects, components, assets, physicsElements]);

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
        {warnings.length > 0 && (
          <div
            style={{
              flexShrink: 0,
              maxHeight: "30%",
              overflow: "auto",
              padding: "6px 8px",
              borderLeft: "2px solid #facc15",
              background: "rgba(250, 204, 21, 0.08)",
              fontSize: 11,
            }}
          >
            <div style={{ color: "#facc15", fontWeight: 600, marginBottom: 4 }}>
              ⚠ {warnings.length} link warning{warnings.length === 1 ? "" : "s"}
            </div>
            {warnings.map((w) => {
              const prefix =
                w.kind === "aperture-too-small"
                  ? "▸ Clipping: "
                  : w.kind === "wavelength-out-of-range"
                    ? "▸ λ range: "
                    : "▸ Mode match: ";
              return (
                <div key={w.key} style={{ marginTop: 2, opacity: 0.9 }}>
                  {prefix}
                  {w.message}
                </div>
              );
            })}
          </div>
        )}
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
