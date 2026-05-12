import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, Crosshair, Eye, EyeOff, Grid3x3, Move, RotateCw, Sparkles } from "lucide-react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { applyFiberConnectorTransform, buildFiberCurvePath, refreshFiberWrapperGeometry, type FiberNode } from "../three/loadAsset";

import { useSceneStore, TOUCH_OPS, TOUCH_OP_BY_ID, type FeatureKind, type TouchOp } from "../store/sceneStore";
import { createBeamPath } from "../three/beamPath";
import { disposeObject, loadAssetObject } from "../three/loadAsset";
import { wavelengthToColor } from "../three/opticalBeams";
import { traceBeamsFromLasers, _testReflect, gaussianWaistAtZ, type TraceSegment } from "../three/rayTrace";
import { getEmissionVisual } from "../utils/emissionVisuals";
import { PlacementGizmo } from "../three/placement/gizmo";
import { SnapOverlay } from "../three/placement/snapOverlay";
import {
  bodyLocalDirToThree,
  labDirToThree,
  labMmToThree,
  threeDirToLab,
  threeToLabPointMm,
} from "../optical/frames";
import { ToolbarHint } from "./ToolbarHint";

(window as unknown as { __testReflect?: typeof _testReflect }).__testReflect = _testReflect;

function buildTraceLine(
  segment: TraceSegment,
  maxPowerOnPath: number,
  colorOverrideHex: string | null,
): THREE.Object3D {
  const colour = colorOverrideHex
    ? new THREE.Color(colorOverrideHex)
    : wavelengthToColor(segment.aomSideband?.centerWavelengthNm ?? segment.wavelengthNm);
  // Colour stays constant along the chain: a beam keeps its source colour
  // through mirrors / PBS / AOM / lens / waveplate / etc. Reflected vs
  // transmitted branches are distinguished by position and power-driven
  // opacity, not by a hue shift.

  // Visual radius is now drawn at TRUE 1× scale with no minimum-width floor
  // (2026-05-12, per user). Earlier versions had VISUAL_BOOST=4 and
  // VISUAL_FLOOR_UM=30 to keep narrow beams visually obvious, but that made
  // a fiber output (MFD/2 ≈ 5 µm) render ≈ 120 µm wide right at the ferrule
  // and never visibly diverge — the user couldn't see Gaussian expansion at
  // all. With BOOST=1 / floor=0, a fiber-output beam starts at its true
  // ~5 µm radius (effectively a line at scene scale) and fans out following
  // the real w(z) = w0·√(1 + (z/zR)²) curve. The centerline (Line geometry
  // below) keeps the beam visible even where the tube radius is sub-pixel.
  const VISUAL_BOOST = 1;
  const VISUAL_FLOOR_UM = 0;

  const start = segment.startThree.clone();
  const end = segment.endThree.clone();
  const length = start.distanceTo(end);
  if (length < 1e-6) return new THREE.Group();

  // Sample w(z) at N points along the segment and revolve the resulting
  // profile with LatheGeometry. A single CylinderGeometry from waistStart →
  // waistEnd produces a LINEAR taper which silently flattens any focus pinch
  // that falls between the endpoints (e.g. lens → distant element with the
  // focal point in between would render as a monotonically expanding wedge
  // even though the real Gaussian beam pinches and re-expands). Sampling
  // along z makes the focus visible, and means moving a pass-through optic
  // (HWP / polarizer) along the beam doesn't change the apparent profile.
  const startZUm = segment.pathLengthFromSourceMmAtStart * 1000;
  const endZUm = (segment.pathLengthFromSourceMmAtStart + segment.lengthMm) * 1000;
  const N = 32;
  const profile: THREE.Vector2[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const zUm = startZUm + (endZUm - startZUm) * t;
    const radiusUm = Math.max(gaussianWaistAtZ(zUm, segment.beamMode), VISUAL_FLOOR_UM);
    // 1e-9 Three units floor prevents zero-radius geometry (NaN normals)
    // without imposing a visually meaningful minimum.
    const radiusThree = Math.max(mmToThree(radiusUm / 1000) * VISUAL_BOOST, 1e-9);
    profile.push(new THREE.Vector2(radiusThree, length * t));
  }
  const geometry = new THREE.LatheGeometry(profile, 24);

  // Power-driven opacity. Stronger beam → more opaque, weaker → faded;
  // normalised against the brightest segment from the same emitter so HWP
  // rotation that shifts power between two PBS arms is visible as opacity
  // asymmetry. Curve: alpha = 1 - exp(-K · relPower), normalised so
  // relPower=0 maps to ALPHA_MIN and relPower=1 maps to ALPHA_MAX. ALPHA_MAX
  // < 1 keeps a baseline transparency on even the strongest beam so
  // overlapping segments don't fully occlude each other.
  const ALPHA_MIN = 0.04;
  const ALPHA_MAX = 0.7;
  const ALPHA_K = 2.5;
  // Absolute mW = nominal × factor. Caller (DigitalTwinViewer) computes
  // maxPowerOnPath in the SAME absolute-mW unit so this division stays in
  // [0, 1]. For backward TA emission the factor is 1.0 but the nominal is
  // small, so the product is small → low alpha → faded backward beam.
  const segPowerMw = segment.nominalPowerMwAtSource * segment.powerFactorAtStart;
  const relPower = maxPowerOnPath > 1e-12
    ? Math.max(0, Math.min(1, segPowerMw / maxPowerOnPath))
    : 0;
  const curve = (1 - Math.exp(-ALPHA_K * relPower)) / (1 - Math.exp(-ALPHA_K));
  const tubeAlpha = ALPHA_MIN + curve * (ALPHA_MAX - ALPHA_MIN);
  // Centerline gets a stronger floor so a near-extinct branch still shows
  // *where* it goes (faint hair-line) while the volumetric tube can fade
  // almost entirely.
  const lineAlpha = Math.max(0.25, ALPHA_MIN + curve * (0.95 - 0.25));

  const material = new THREE.MeshBasicMaterial({
    color: colour,
    transparent: true,
    opacity: tubeAlpha,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const tube = new THREE.Mesh(geometry, material);
  tube.position.copy(start);
  const dir = end.clone().sub(start).normalize();
  const yAxis = new THREE.Vector3(0, 1, 0);
  tube.quaternion.setFromUnitVectors(yAxis, dir);
  tube.renderOrder = 900;

  // Add a thin centerline so very narrow beams are still visible
  const lineGeom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, length, 0),
  ]);
  const line = new THREE.Line(
    lineGeom,
    new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: lineAlpha, depthWrite: false }),
  );
  line.renderOrder = 901;
  tube.add(line);

  tube.userData.traceBranch = segment.branch;
  tube.userData.traceDepth = segment.depth;
  tube.userData.beamSegment = segment;
  return tube;
}
import { createLabPhotoRoom } from "../three/photoRoom";
import { applyObjectGeometryOffset, applyObjectTransform, mmToThree } from "../three/transformUtils";
import { relationTarget, worldAnchor } from "../utils/relationAnchors";
import { computeBraggTiltAxisFromRfDirectionBodyLocal } from "../optical/kinds/aom/physics";
import type { Asset3D, ComponentItem, DeviceState, OpticalElement, SceneObject } from "../types/digitalTwin";
import {
  isAssemblyRelationVisible,
  isBeamPathVisible,
  isObjectVisible,
  makeRenderableContext,
} from "../utils/visibility";

type RoomDimensions = {
  widthMm: number;
  depthMm: number;
  heightMm: number;
};

type ViewerDisplayMode = "wireframe" | "rendered";
type AxisView = "xPos" | "xNeg" | "yPos" | "yNeg" | "zPos" | "zNeg";
type AxisViewTarget = AxisView | "home";

type LabPoint = {
  x: number;
  y: number;
  z: number;
};

const HOME_CAMERA_POSITION = new THREE.Vector3(28, 16, 19);
const HOME_CAMERA_TARGET = new THREE.Vector3(0, 5.2, 0);
const HOME_CAMERA_OFFSET = HOME_CAMERA_POSITION.clone().sub(HOME_CAMERA_TARGET);
const AXIS_GIZMO_SIZE = 132;

const DISPLAY_MODE_OPTIONS: Array<{
  mode: ViewerDisplayMode;
  title: string;
  Icon: typeof Grid3x3;
}> = [
  { mode: "wireframe", title: "Wireframe display", Icon: Grid3x3 },
  { mode: "rendered", title: "Rendered display", Icon: Sparkles },
];

const AXIS_VIEW_CONFIG: Record<
  AxisView,
  {
    label: string;
    title: string;
    direction: THREE.Vector3;
    up: THREE.Vector3;
    className: string;
  }
> = {
  xPos: {
    label: "+X",
    title: "View from +X",
    direction: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    className: "axis-x",
  },
  xNeg: {
    label: "-X",
    title: "View from -X",
    direction: new THREE.Vector3(-1, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    className: "axis-x",
  },
  yPos: {
    label: "+Y",
    title: "View from +Y",
    direction: new THREE.Vector3(0, 0, -1),
    up: new THREE.Vector3(0, 1, 0),
    className: "axis-y",
  },
  yNeg: {
    label: "-Y",
    title: "View from -Y",
    direction: new THREE.Vector3(0, 0, 1),
    up: new THREE.Vector3(0, 1, 0),
    className: "axis-y",
  },
  zPos: {
    label: "+Z",
    title: "View from +Z",
    direction: new THREE.Vector3(0, 1, 0),
    up: new THREE.Vector3(0, 0, -1),
    className: "axis-z",
  },
  zNeg: {
    label: "-Z",
    title: "View from -Z",
    direction: new THREE.Vector3(0, -1, 0),
    up: new THREE.Vector3(0, 0, 1),
    className: "axis-z",
  },
};

function clearGroup(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child);
    disposeObject(child);
  }
}

function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(material)) {
    material.forEach((item) => item.dispose());
    return;
  }
  material.dispose();
}

function firstMaterial(material: THREE.Material | THREE.Material[] | undefined): THREE.Material | undefined {
  if (!material) return undefined;
  return Array.isArray(material) ? material[0] : material;
}

function materialSide(material: THREE.Material | THREE.Material[] | undefined): THREE.Side {
  return firstMaterial(material)?.side ?? THREE.FrontSide;
}

function replaceMeshMaterial(mesh: THREE.Mesh, material: THREE.Material): void {
  const previous = mesh.material;
  mesh.material = material;
  disposeMaterial(previous);
}

/** Switch the viewer's component meshes between rendered + wireframe modes.
 *
 *  Wireframe mode swaps every Mesh's material for an unlit MeshBasicMaterial
 *  with `wireframe: true`. The original material is stashed on
 *  `mesh.userData.__rendered{Material,CastShadow,ReceiveShadow}` BEFORE
 *  the swap so we can hand it back when the user flips back to "rendered".
 *  Without that cache, switching back left the wireframe material in place
 *  (the original was disposed inside replaceMeshMaterial) — see the
 *  "wireframe sticks" bug.
 *
 *  Re-runs of this function (e.g. wrapper cache hit + decoration rebuild)
 *  are idempotent: switching wireframe→wireframe doesn't re-stash, and
 *  switching rendered→rendered is a no-op.
 */
function applyViewerDisplayMode(object: THREE.Object3D, mode: ViewerDisplayMode): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;

    const cached = child.userData.__renderedMaterial as THREE.Material | THREE.Material[] | undefined;
    const isCurrentlyWireframe = cached !== undefined;

    if (mode === "wireframe") {
      if (isCurrentlyWireframe) return;
      // Stash originals; do NOT dispose — they have to survive the swap
      // so we can restore them on the way back.
      child.userData.__renderedMaterial = child.material;
      child.userData.__renderedCastShadow = child.castShadow;
      child.userData.__renderedReceiveShadow = child.receiveShadow;
      const side = materialSide(child.material);
      child.material = new THREE.MeshBasicMaterial({
        color: "#c9f1e8",
        wireframe: true,
        transparent: true,
        opacity: 0.84,
        depthWrite: false,
        side,
      });
      child.castShadow = false;
      child.receiveShadow = false;
      return;
    }

    // mode === "rendered"
    if (!isCurrentlyWireframe) return;
    // The current material is the wireframe MeshBasicMaterial we made
    // above; dispose it before swapping the cached original back in.
    disposeMaterial(child.material);
    child.material = cached;
    child.castShadow = (child.userData.__renderedCastShadow as boolean | undefined) ?? true;
    child.receiveShadow = (child.userData.__renderedReceiveShadow as boolean | undefined) ?? true;
    delete child.userData.__renderedMaterial;
    delete child.userData.__renderedCastShadow;
    delete child.userData.__renderedReceiveShadow;
  });
}

function applyEnvironmentDisplayMode(object: THREE.Object3D, mode: ViewerDisplayMode): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if ("wireframe" in material) {
        (material as THREE.MeshBasicMaterial | THREE.MeshStandardMaterial).wireframe = mode === "wireframe";
        material.needsUpdate = true;
      }
    }
  });
}

function addSelectionMarker(object: THREE.Object3D, container: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());

  const padded = box.clone().expandByScalar(Math.max(0.015, Math.max(size.x, size.y, size.z) * 0.02));
  const boxHelper = new THREE.Box3Helper(padded, new THREE.Color("#facc15"));
  const boxMaterial = boxHelper.material as THREE.LineBasicMaterial;
  boxMaterial.depthTest = false;
  boxMaterial.transparent = true;
  boxMaterial.opacity = 0.95;
  boxHelper.renderOrder = 999;
  boxHelper.name = "selection-box";
  container.add(boxHelper);

  const corners: Array<[THREE.Vector3, THREE.Vector3, THREE.Vector3]> = [];
  const min = padded.min;
  const max = padded.max;
  const cornerLen = Math.max(0.06, Math.min(0.35, Math.max(size.x, size.y, size.z) * 0.18));
  const verts: Array<[number, number, number]> = [
    [min.x, min.y, min.z],
    [max.x, min.y, min.z],
    [min.x, max.y, min.z],
    [max.x, max.y, min.z],
    [min.x, min.y, max.z],
    [max.x, min.y, max.z],
    [min.x, max.y, max.z],
    [max.x, max.y, max.z],
  ];
  for (const [vx, vy, vz] of verts) {
    const center = new THREE.Vector3(vx, vy, vz);
    const sx = vx === min.x ? 1 : -1;
    const sy = vy === min.y ? 1 : -1;
    const sz = vz === min.z ? 1 : -1;
    corners.push([center, new THREE.Vector3(sx * cornerLen, 0, 0).add(center), new THREE.Vector3(0, sy * cornerLen, 0).add(center)]);
    corners.push([center, new THREE.Vector3(0, sy * cornerLen, 0).add(center), new THREE.Vector3(0, 0, sz * cornerLen).add(center)]);
    corners.push([center, new THREE.Vector3(0, 0, sz * cornerLen).add(center), new THREE.Vector3(sx * cornerLen, 0, 0).add(center)]);
  }
  const cornerPoints: THREE.Vector3[] = [];
  for (const [a, b] of corners.flatMap(([c, x, y]) => [[c, x], [c, y]] as Array<[THREE.Vector3, THREE.Vector3]>)) {
    cornerPoints.push(a, b);
  }
  const cornerGeometry = new THREE.BufferGeometry().setFromPoints(cornerPoints);
  const cornerLines = new THREE.LineSegments(
    cornerGeometry,
    new THREE.LineBasicMaterial({ color: "#fde047", transparent: true, opacity: 1, depthTest: false }),
  );
  cornerLines.renderOrder = 1000;
  cornerLines.name = "selection-corners";
  container.add(cornerLines);

  const radius = Math.max(0.48, Math.min(19, Math.max(size.x, size.z) * 0.52));
  const marker = new THREE.Mesh(
    new THREE.TorusGeometry(radius, 0.018, 10, 120),
    new THREE.MeshBasicMaterial({
      color: "#38bdf8",
      transparent: true,
      opacity: 0.95,
    }),
  );
  marker.name = "selection-marker";
  marker.rotation.x = Math.PI / 2;
  marker.position.y = 0.035;
  object.add(marker);
}

/** Add INPUT / OUTPUT port labels to a tapered-amplifier mesh wrapper.
 *  Reads the same aperture coordinates the ray-tracer uses
 *  (`apertureBackwardLocalMm` = INPUT seed port, `apertureForwardLocalMm`
 *  = OUTPUT amplified port; both in Blender Z-up frame, mm), converts to
 *  glTF/three coords, and places a billboard sprite with text + small
 *  arrow indicator at each aperture.
 *
 *  Sprites are children of the wrapper Group, so the SceneObject's
 *  rotation/translation carry them automatically. They get
 *  userData.isPortLabel so raycasts (selection / face-touch) skip them. */
function addTaPortLabels(wrapper: THREE.Object3D, _component: ComponentItem): void {
  // Position labels relative to the BODY CENTRE (= wrapper origin after
  // bbox-centering in loadAssetObject) using the bbox extent. Labels sit
  // just OUTSIDE the +X (OUTPUT) and -X (INPUT) faces of the bbox along
  // the body axis, vertically/laterally centred.
  //
  // Earlier this used apertureForwardLocalMm / apertureBackwardLocalMm
  // which carry the user-supplied Blender-frame aperture coords —
  // accurate for the ray-tracer, but visually the labels ended up at
  // the wrong place because the GLB's coordinate system after
  // bbox-centering interacts oddly with those numbers. Body-center
  // placement always lands the labels at the housing's left/right side
  // regardless of where the GLB's authored origin sits.

  // Build a CanvasTexture with the label text. Re-creating per call is
  // cheap (called once per TA per scene rebuild) and keeps the sprite
  // self-contained.
  const makeLabel = (text: string, fg: string, accent: string): THREE.Sprite => {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 80;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
      const radius = 10;
      ctx.beginPath();
      ctx.moveTo(radius, 0);
      ctx.arcTo(canvas.width, 0, canvas.width, canvas.height, radius);
      ctx.arcTo(canvas.width, canvas.height, 0, canvas.height, radius);
      ctx.arcTo(0, canvas.height, 0, 0, radius);
      ctx.arcTo(0, 0, canvas.width, 0, radius);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = fg;
      ctx.font = "bold 36px 'Inter', 'Segoe UI', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 4;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }),
    );
    sprite.scale.set(0.6, 0.19, 1);  // ~60 mm × 19 mm at scene scale
    sprite.userData.isPortLabel = true;
    sprite.renderOrder = 1000;
    return sprite;
  };

  // Compute the loaded mesh's bbox in WRAPPER-local space. The GLB's
  // authored origin is NOT necessarily at the body centre — for the
  // BoosTA pro it's offset to one face — so we must use the bbox MIN/MAX
  // directly to find the +X / -X faces in wrapper coords, not assume
  // ±halfX symmetry around origin.
  wrapper.updateMatrixWorld(true);
  const bboxLocal = new THREE.Box3();
  wrapper.traverse((m) => {
    if (!(m as THREE.Mesh).isMesh) return;
    const mesh = m as THREE.Mesh;
    if (!mesh.geometry) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    if (!bb) return;
    mesh.updateMatrixWorld(true);
    // Mesh local bbox → world via mesh.matrixWorld → wrapper-local via
    // wrapper.matrixWorld.invert().
    const meshWorld = bb.clone().applyMatrix4(mesh.matrixWorld);
    const inv = new THREE.Matrix4().copy(wrapper.matrixWorld).invert();
    const localCorner = (sx: number, sy: number, sz: number) =>
      new THREE.Vector3(
        sx ? meshWorld.max.x : meshWorld.min.x,
        sy ? meshWorld.max.y : meshWorld.min.y,
        sz ? meshWorld.max.z : meshWorld.min.z,
      ).applyMatrix4(inv);
    for (let i = 0; i < 8; i++) {
      bboxLocal.expandByPoint(localCorner((i & 1) as 0 | 1, ((i >> 1) & 1) as 0 | 1, ((i >> 2) & 1) as 0 | 1));
    }
  });
  if (bboxLocal.isEmpty()) return;
  const centerY = (bboxLocal.min.y + bboxLocal.max.y) / 2;
  const centerZ = (bboxLocal.min.z + bboxLocal.max.z) / 2;
  // 5 mm outside the +X / -X faces.
  const labelOffset = 0.05;
  // Lift labels ~25 mm above the optical axis so the 19 mm-tall sprite
  // does not cover the laser-port aperture. Scene unit = 100 mm.
  const labelLiftY = 0.25;

  const placeAt = (xPos: number, label: string, fg: string, accent: string) => {
    const sprite = makeLabel(label, fg, accent);
    sprite.position.set(xPos, centerY + labelLiftY, centerZ);
    wrapper.add(sprite);
  };

  // The user-supplied BoosTA pro GLB has its OUTPUT (amplified beam) on
  // the -X side and the INPUT (seed) on the +X side — opposite of the
  // generic "+X = forward" convention because of how the model was
  // authored / exported. Swap the labels accordingly so they land at the
  // actual port faces.
  placeAt(bboxLocal.min.x - labelOffset, "OUTPUT", "#ffffff", "#22c55e");
  placeAt(bboxLocal.max.x + labelOffset, "INPUT", "#ffffff", "#ef4444");
}

/** Bragg tilt-axis indicator for a selected AOM. Phase 7.1 (vibe-coding-
 *  log 2026-05-08): replaced the previous "ABC + body+Z arrow" markers
 *  with a single arrow showing the user-selected Bragg tilt axis that the
 *  AOM align routine actually uses:
 *
 *      τ̂_body = cos(α)·ê₀ + sin(α)·(ê₀ × b̂)
 *
 *  where b̂ = (intercept_out − intercept_in) / ‖…‖ is the body-local
 *  port-to-port (= optical) axis, ê₀ is body+X projected onto ⊥-b̂, and
 *  α is component.properties.braggTiltAngleDegBodyLocal. The arrow is
 *  anchored at the midpoint pivot — same point the body rocks around
 *  during align.
 *
 *  The OLD ABC markers (A on +X face, B on -X, C on +Y, with an orange
 *  arrow along body+Z) were misleading on two counts:
 *    - Sphere positions assumed body axes that don't match GLBs whose
 *      optical hole runs along Y (e.g. the user's MT80).
 *    - The orange arrow was drawn along three's wrapper-local (0,0,1)
 *      = body-local +Y, NOT body-local +Z as the comment claimed; even
 *      worse, "body+Z" was already not the rotation axis under the new
 *      Phase 7.1 align (which uses b̂×â, not â).
 *  Renders only when an AOM is selected, so the scene isn't permanently
 *  decorated. */
function addAomTiltAxisMarker(
  wrapper: THREE.Object3D,
  asset: Asset3D | undefined,
  opticalElement: OpticalElement | undefined,
  component: ComponentItem,
): void {
  if (!asset) return;
  const inAnchor = asset.anchors.find((a) => a.id === "intercept_in");
  const outAnchor = asset.anchors.find((a) => a.id === "intercept_out");
  if (!inAnchor || !outAnchor) return;

  // Phase 7.3: τ̂(α) is â-independent. Only b̂ + α determine the arrow
  // direction. acousticAxisBodyLocal is no longer read here; degeneracy
  // (τ̂ ‖ â) is surfaced as a runtime warning in the align feedback,
  // not by hiding the arrow.
  void opticalElement;
  const compProps = (component.properties ?? {}) as {
    rfPropagationDirectionBodyLocal?: number[];
    rfPropagationDirectionLocal?: number[];
    acousticAxisBodyLocal?: number[];
    acousticAxisLocal?: number[];
  };
  const rfArr =
    compProps.rfPropagationDirectionBodyLocal ??
    compProps.rfPropagationDirectionLocal ??
    compProps.acousticAxisBodyLocal ??
    compProps.acousticAxisLocal ??
    [-1, 0, 0];
  const rfBody = Array.isArray(rfArr) && rfArr.length >= 3
    ? { x: Number(rfArr[0]) || 0, y: Number(rfArr[1]) || 0, z: Number(rfArr[2]) || 0 }
    : { x: -1, y: 0, z: 0 };

  // body-local Z-up vectors (mm for positions, unitless for direction)
  const inP = inAnchor.positionMmBodyLocal;
  const outP = outAnchor.positionMmBodyLocal;
  const bBody = { x: outP.x - inP.x, y: outP.y - inP.y, z: outP.z - inP.z };
  const bMag = Math.hypot(bBody.x, bBody.y, bBody.z);
  if (bMag < 1e-6) return;
  const bUnit = { x: bBody.x / bMag, y: bBody.y / bMag, z: bBody.z / bMag };
  // τ_body in the ⊥-b̂ plane, parameterised by α. ê₀ = body+X (or
  // fallback) projected onto ⊥-b̂; ê₁ = ê₀ × b̂. So α=0° → body+X
  // direction (typical), α=90° → body+Z, etc.
  const tUnit = computeBraggTiltAxisFromRfDirectionBodyLocal(bUnit, rfBody);
  if (!tUnit) return;

  // Pivot in body-local Z-up mm (midpoint of the two port anchors).
  const pivotBody = {
    x: (inP.x + outP.x) / 2,
    y: (inP.y + outP.y) / 2,
    z: (inP.z + outP.z) / 2,
  };

  // Body-local Z-up → wrapper three (Y-up) frame swap; positions get
  // /100 (mm → three units), directions are pure axis swap.
  const pivotThree = new THREE.Vector3(
    pivotBody.x / 100,
    pivotBody.z / 100,
    -pivotBody.y / 100,
  );
  const tiltDirThree = new THREE.Vector3(
    tUnit.x,
    tUnit.z,
    -tUnit.y,
  ).normalize();

  // Arrow length scales with the port separation so it stays visible
  // on small (1–2 mm aperture) AOMs as well as large modules.
  const portSepMm = bMag;
  const arrowLength = Math.max(0.05, (portSepMm * 0.6) / 100);
  const arrow = new THREE.ArrowHelper(
    tiltDirThree,
    pivotThree,
    arrowLength,
    0xf97316,  // orange — distinct from anchor colours (red / green)
    arrowLength * 0.25,
    arrowLength * 0.15,
  );
  arrow.userData.isAomTiltAxisMarker = true;
  arrow.traverse((child) => {
    child.userData.isAomTiltAxisMarker = true;
  });
  wrapper.add(arrow);
}

/** Outline a selected object with wireframe-style edge lines that follow
 *  the actual mesh silhouettes (EdgesGeometry, threshold 30°). Drawn with
 *  depthTest off + high renderOrder so the lines glow through nearby
 *  geometry — matching the "selected wireframe" look from Blender. Skips
 *  the optical_table since selecting it is rare and a full table-edge
 *  highlight is visually noisy.
 *
 *  Lines are added as children of each mesh inside the wrapper, so they
 *  inherit the mesh's local transform and stay aligned even if the
 *  wrapper rotates / translates. They get marked with userData.isOutline
 *  so future raycasts ignore them. */
function addWireframeOutline(wrapper: THREE.Object3D): void {
  const lineMaterial = new THREE.LineBasicMaterial({
    color: 0xfacc15,  // amber — matches the selection swatch convention
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
  });
  wrapper.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !child.geometry) return;
    if (child.userData?.isOutline) return;
    const edges = new THREE.EdgesGeometry(child.geometry, 30);
    const lines = new THREE.LineSegments(edges, lineMaterial);
    lines.userData.isOutline = true;
    lines.name = "selection-outline";
    lines.renderOrder = 998;
    child.add(lines);
  });
}

/** Remove all decorations that the rebuild useEffect attaches per-frame
 *  (selection wireframe outline, TA port labels, AOM Bragg-tilt arrow,
 *  fiber beam-flow indicators, relation axes / ring markers). Used by
 *  the incremental rebuild path before re-applying decorations from the
 *  current selection / relation state — the geometric asset itself stays
 *  put. Geometries / materials are disposed so we don't leak GPU memory
 *  across rebuilds.
 *
 *  Each of the helpers below tags its own outputs (`userData.isOutline`,
 *  `userData.isPortLabel`, `userData.isAomTiltAxisMarker`,
 *  `userData.isBeamFlowIndicator`, plus the four `relation-*` names
 *  from `addObjectAxesHelper`). Anything not tagged is part of the
 *  loaded asset and is preserved. */
function stripDynamicDecorations(wrapper: THREE.Object3D): void {
  const toRemove: THREE.Object3D[] = [];
  wrapper.traverse((child) => {
    if (child === wrapper) return;
    const ud = child.userData ?? {};
    if (
      ud.isOutline ||
      ud.isPortLabel ||
      ud.isAomTiltAxisMarker ||
      ud.isBeamFlowIndicator ||
      child.name === "relation-driver-axes" ||
      child.name === "relation-driven-axes" ||
      child.name === "relation-driver-marker" ||
      child.name === "relation-driven-marker"
    ) {
      toRemove.push(child);
    }
  });
  for (const obj of toRemove) {
    obj.parent?.remove(obj);
    disposeObject(obj);
  }
}

/** Visual indicator for a fiber's beam-entry / beam-exit assignment.
 *  The user clicks one of the ferrule connectors to designate which end
 *  the beam enters from; this helper draws:
 *    - a green torus around the entry connector ferrule
 *    - a red torus around the exit connector
 *    - an orange arrow at the spline midpoint pointing entry → exit
 *  All children carry `userData.isBeamFlowIndicator = true` so the
 *  rebuild useEffect's stripDynamicDecorations cleans them up before
 *  redecorating from the current state. Returns silently if the wrapper
 *  has no fiber connectors or no beamEntryEnd is set. */
function addFiberBeamFlowIndicator(
  wrapper: THREE.Object3D,
  beamEntryEnd: "A" | "B",
  fiberAnchors: { id: string; positionMmBodyLocal?: { x: number; y: number; z: number } }[] | undefined,
): void {
  // Connectors are children of the loaded asset object (one level below
  // the wrapper since the rebuild useEffect wraps the asset in a fresh
  // group). Traverse to find them rather than scanning wrapper.children
  // directly. The asset object also has a non-identity position from
  // applyObjectGeometryOffset, so we attach the arrow to assetObject —
  // not wrapper — to keep the midpoint maths in the same frame as the
  // connector positions.
  let connA: THREE.Object3D | null = null;
  let connB: THREE.Object3D | null = null;
  let assetObject: THREE.Object3D | null = null;
  wrapper.traverse((child) => {
    if (!assetObject && child.userData?.isLoadedAsset) {
      assetObject = child;
    }
    const ep = child.userData?.fiberConnectorEndpoint;
    if (ep === "A") connA = child;
    else if (ep === "B") connB = child;
  });
  if (!connA || !connB) return;
  const aObj: THREE.Object3D = assetObject ?? wrapper;
  const aConn: THREE.Object3D = connA;
  const bConn: THREE.Object3D = connB;

  const entryConn = beamEntryEnd === "A" ? aConn : bConn;
  const exitConn = beamEntryEnd === "A" ? bConn : aConn;
  // Ring haloes the optical port. Position is read from the corresponding
  // fiberAnchors record in connector body-local mm (default (0, 36.28, 0)
  // = ferrule tip); falls back to a ferrule-tip approximation if anchors
  // are missing. Rings are children of the connector group so coordinates
  // stay connector-local even after the spline rotates / translates.
  const findAnchorPos = (anchorId: string) => {
    const a = (fiberAnchors ?? []).find((x) => x.id === anchorId);
    const p = a?.positionMmBodyLocal;
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
      return { x: p.x, y: p.y, z: p.z };
    }
    return { x: 0, y: 36.28, z: 0 };
  };
  const entryPosMm = findAnchorPos(beamEntryEnd === "A" ? "intercept_in" : "intercept_out");
  const exitPosMm = findAnchorPos(beamEntryEnd === "A" ? "intercept_out" : "intercept_in");
  const ringRadius = 0.035;
  const ringTube = 0.005;
  const buildRing = (color: number, posMm: { x: number; y: number; z: number }): THREE.Mesh => {
    const torus = new THREE.Mesh(
      new THREE.TorusGeometry(ringRadius, ringTube, 10, 48),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthTest: false,
      }),
    );
    // TorusGeometry's disc lies in the XY plane with axis along +Z. The
    // connector's outward direction is local +Y, so rotate the torus 90°
    // about X to face the ring opening along +Y, then position at the
    // anchor (mm → three units = /100).
    torus.rotation.x = Math.PI / 2;
    torus.position.set(posMm.x / 100, posMm.y / 100, posMm.z / 100);
    torus.renderOrder = 1099;
    torus.userData.isBeamFlowIndicator = true;
    return torus;
  };
  entryConn.add(buildRing(0x22c55e, entryPosMm)); // green = entry
  exitConn.add(buildRing(0xef4444, exitPosMm));   // red   = exit

  // Arrow at the straight-line midpoint of the two connector positions
  // (in assetObject-local frame, where connector.position lives), pointing
  // entry → exit. Approximate for curved fibers, but a clear flow cue.
  const mid = entryConn.position.clone().add(exitConn.position).multiplyScalar(0.5);
  const dir = exitConn.position.clone().sub(entryConn.position);
  const len = dir.length();
  if (len < 1e-4) return;
  dir.divideScalar(len);
  const shaftLen = Math.min(0.08, len * 0.25);
  const arrow = new THREE.ArrowHelper(
    dir,
    mid.clone().sub(dir.clone().multiplyScalar(shaftLen / 2)),
    shaftLen,
    0xf97316, // orange — distinct from anchor / selection swatches
    shaftLen * 0.4,
    shaftLen * 0.25,
  );
  arrow.userData.isBeamFlowIndicator = true;
  arrow.traverse((child) => {
    child.userData.isBeamFlowIndicator = true;
  });
  aObj.add(arrow);
}

function addObjectAxesHelper(object: THREE.Object3D, isDriven = false): void {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const maxSize = Math.max(size.x, size.y, size.z, 1);

  const axes = new THREE.AxesHelper(Math.max(1.2, maxSize * 0.72));
  axes.name = isDriven ? "relation-driven-axes" : "relation-driver-axes";

  const center = box.getCenter(new THREE.Vector3());
  const localCenter = object.worldToLocal(center.clone());
  axes.position.copy(localCenter);

  object.add(axes);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(Math.max(0.5, maxSize * 0.5), 0.025, 10, 120),
    new THREE.MeshBasicMaterial({
      color: isDriven ? "#f97316" : "#22c55e",
      transparent: true,
      opacity: 0.95,
    }),
  );

  ring.name = isDriven ? "relation-driven-marker" : "relation-driver-marker";
  ring.rotation.x = Math.PI / 2;
  ring.position.copy(localCenter);
  object.add(ring);
}

function labToThree(point: LabPoint): THREE.Vector3 {
  return new THREE.Vector3(point.x / 100, point.z / 100, -point.y / 100);
}

function objectOrigin(object: SceneObject): LabPoint {
  return { x: object.xMm, y: object.yMm, z: object.zMm };
}

function addLabPoints(a: LabPoint, b: LabPoint): LabPoint {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function averageLabPoints(points: LabPoint[]): LabPoint | null {
  if (points.length === 0) return null;
  const sum = points.reduce(
    (acc, point) => ({
      x: acc.x + point.x,
      y: acc.y + point.y,
      z: acc.z + point.z,
    }),
    { x: 0, y: 0, z: 0 },
  );
  return {
    x: sum.x / points.length,
    y: sum.y / points.length,
    z: sum.z / points.length,
  };
}

function parseMmInput(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatMm(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

function formatLabPoint(point: LabPoint): string {
  return `X ${formatMm(point.x)} / Y ${formatMm(point.y)} / Z ${formatMm(point.z)} mm`;
}

function createViewCenterMarker(): THREE.Group {
  const group = new THREE.Group();
  group.name = "view-center-marker";

  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.04, 18, 18),
    new THREE.MeshBasicMaterial({ color: "#f59e0b", depthTest: false }),
  );
  dot.renderOrder = 1102;
  group.add(dot);

  const ringMaterial = new THREE.MeshBasicMaterial({
    color: "#facc15",
    transparent: true,
    opacity: 0.94,
    depthTest: false,
  });
  const horizontalRing = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.007, 10, 96), ringMaterial.clone());
  horizontalRing.rotation.x = Math.PI / 2;
  horizontalRing.renderOrder = 1100;
  group.add(horizontalRing);

  const verticalRing = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.007, 10, 96), ringMaterial.clone());
  verticalRing.rotation.y = Math.PI / 2;
  verticalRing.renderOrder = 1100;
  group.add(verticalRing);

  const axisMaterial = new THREE.LineBasicMaterial({
    color: "#fde68a",
    transparent: true,
    opacity: 0.9,
    depthTest: false,
  });
  const points = [
    new THREE.Vector3(-0.24, 0, 0),
    new THREE.Vector3(0.24, 0, 0),
    new THREE.Vector3(0, -0.24, 0),
    new THREE.Vector3(0, 0.24, 0),
    new THREE.Vector3(0, 0, -0.24),
    new THREE.Vector3(0, 0, 0.24),
  ];
  const crosshair = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), axisMaterial);
  crosshair.renderOrder = 1101;
  group.add(crosshair);

  return group;
}

function directionToThree(direction?: { x: number; y: number; z: number }): THREE.Vector3 | null {
  if (!direction) return null;
  const vector = labDirToThree(direction);
  return vector.lengthSq() > 0 ? vector.normalize() : null;
}

function addAnchorAxis(
  group: THREE.Group,
  origin: THREE.Vector3,
  direction: { x: number; y: number; z: number } | undefined,
  color: string,
): void {
  const axis = directionToThree(direction);
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.055, 12, 12),
    new THREE.MeshBasicMaterial({ color }),
  );
  dot.position.copy(origin);
  group.add(dot);
  if (!axis) return;
  const arrow = new THREE.ArrowHelper(axis, origin, 0.75, color, 0.18, 0.08);
  group.add(arrow);
}

function createAxisLabel(text: string, color: string, position: THREE.Vector3, viewTarget?: AxisViewTarget): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (context) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = color;
    context.beginPath();
    context.arc(64, 64, 44, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#ffffff";
    // Bigger label font — user requested "加大字體".
    context.font = `800 ${text.length > 1 ? 56 : 68}px Arial`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, 64, 68);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
  sprite.position.copy(position);
  // Slightly larger sprite scale to match the bigger canvas.
  sprite.scale.set(0.42, 0.42, 0.42);
  sprite.renderOrder = 20;
  if (sprite.material instanceof THREE.SpriteMaterial) {
    sprite.material.depthTest = false;
  }
  if (viewTarget) sprite.userData.viewTarget = viewTarget;
  return sprite;
}

function createAxisHitTarget(position: THREE.Vector3, color: string, viewTarget: AxisViewTarget, radius = 0.25): THREE.Mesh {
  const hitTarget = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 18, 18),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.02,
      depthWrite: false,
    }),
  );
  hitTarget.position.copy(position);
  hitTarget.userData.viewTarget = viewTarget;
  return hitTarget;
}

function createGlobalAxesGizmo(): THREE.Group {
  const group = new THREE.Group();
  const axes = [
    { label: "X", color: "#ef4444", direction: new THREE.Vector3(1, 0, 0), viewTarget: "xPos" as const },
    { label: "-X", color: "#ef4444", direction: new THREE.Vector3(-1, 0, 0), viewTarget: "xNeg" as const },
    { label: "Y", color: "#22c55e", direction: new THREE.Vector3(0, 0, -1), viewTarget: "yPos" as const },
    { label: "-Y", color: "#22c55e", direction: new THREE.Vector3(0, 0, 1), viewTarget: "yNeg" as const },
    { label: "Z", color: "#3b82f6", direction: new THREE.Vector3(0, 1, 0), viewTarget: "zPos" as const },
    { label: "-Z", color: "#3b82f6", direction: new THREE.Vector3(0, -1, 0), viewTarget: "zNeg" as const },
  ];

  const home = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 16, 16),
    new THREE.MeshBasicMaterial({ color: "#f8fafc" }),
  );
  home.userData.viewTarget = "home";
  group.add(home);
  group.add(createAxisLabel("H", "#64748b", new THREE.Vector3(0, 0, 0), "home"));
  group.add(createAxisHitTarget(new THREE.Vector3(0, 0, 0), "#f8fafc", "home", 0.34));

  for (const axis of axes) {
    // Thicker shaft + bigger arrow head per user request "軸也加粗".
    // ArrowHelper(dir, origin, length, color, headLength, headWidth).
    // Shaft thickness comes from a wrapping cylinder (Line is 1px on most
    // GPUs) — wrap the ArrowHelper with an extra cylinder along the axis.
    const arrow = new THREE.ArrowHelper(axis.direction, new THREE.Vector3(0, 0, 0), 0.86, axis.color, 0.26, 0.13);
    group.add(arrow);
    const shaftLen = 0.86 - 0.26; // shaft = total length minus arrow head
    const shaftMat = new THREE.MeshBasicMaterial({ color: axis.color });
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, shaftLen, 16),
      shaftMat,
    );
    // Default cylinder orientation is along +Y. Align it with the axis dir.
    const up = new THREE.Vector3(0, 1, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(up, axis.direction.clone().normalize());
    shaft.quaternion.copy(q);
    shaft.position.copy(axis.direction.clone().normalize().multiplyScalar(shaftLen / 2));
    group.add(shaft);
    const labelPosition = axis.direction.clone().multiplyScalar(1.22);
    group.add(createAxisLabel(axis.label, axis.color, labelPosition, axis.viewTarget));
    group.add(createAxisHitTarget(labelPosition, axis.color, axis.viewTarget));
  }

  return group;
}

function getAxisViewTargetFromObject(object: THREE.Object3D): AxisViewTarget | null {
  let current: THREE.Object3D | null = object;
  while (current) {
    const viewTarget = current.userData.viewTarget;
    if (viewTarget === "home") return "home";
    if (typeof viewTarget === "string" && viewTarget in AXIS_VIEW_CONFIG) return viewTarget as AxisView;
    current = current.parent;
  }
  return null;
}

type DigitalTwinViewerProps = {
  roomDimensions: RoomDimensions;
  /** Which panel slot this instance occupies. Used to read/write the
   *  panel-keyed slices of zustand state (transformCursorMm, gizmoMode).
   *  In single-view there is only "left". */
  panelKey: "left" | "right";
  /** Display mode for THIS viewer instance (Render vs Wireframe). Controlled
   *  by the parent so each panel in dual-view can hold its own value while
   *  sharing every other piece of scene state via zustand. */
  displayMode: ViewerDisplayMode;
  onDisplayModeChange: (mode: ViewerDisplayMode) => void;
};

/** Pie-chart overlay for the 6 face-touch ops with this fixed wedge order
 *  (per user request "上 1 2 3 / 下 1 2 3"):
 *    Top half left→right    : V·E (upper-left), V·F (top), E·F (upper-right)
 *    Bottom half left→right : V·V (lower-left), E·E (bottom), F·F (lower-right)
 *  Centre button toggles the snap direction (A→B / B→A). Only visible when
 *  the scene is in wireframe display mode. */
function ToolsPie({
  activeTool,
  faceTouchOp,
  faceTouchDirection,
  setFaceTouchOp,
  setActiveTool,
  setFaceTouchDirection,
}: {
  activeTool: string;
  faceTouchOp: TouchOp["id"];
  faceTouchDirection: "a-to-b" | "b-to-a";
  setFaceTouchOp: (op: TouchOp["id"]) => void;
  setActiveTool: (tool: "select" | "face-touch") => void;
  setFaceTouchDirection: (d: "a-to-b" | "b-to-a") => void;
}) {
  // Wedge index → op id (CCW from left starting at -180°):
  //   0 upper-left, 1 top, 2 upper-right,
  //   3 lower-right, 4 bottom, 5 lower-left
  const wedgeOps: TouchOp["id"][] = ["ve", "vf", "ef", "ff", "ee", "vv"];
  const cx = 60;
  const cy = 60;
  const rOuter = 56;
  const rInner = 22;
  // Wedge i goes from (-180 + i*60) to (-180 + (i+1)*60). Mid is at the
  // wedge centre.
  const wedgePath = (i: number): string => {
    const startDeg = -180 + i * 60;
    const endDeg = startDeg + 60;
    const a0 = (startDeg * Math.PI) / 180;
    const a1 = (endDeg * Math.PI) / 180;
    const x0o = cx + rOuter * Math.cos(a0);
    const y0o = cy + rOuter * Math.sin(a0);
    const x1o = cx + rOuter * Math.cos(a1);
    const y1o = cy + rOuter * Math.sin(a1);
    const x0i = cx + rInner * Math.cos(a0);
    const y0i = cy + rInner * Math.sin(a0);
    const x1i = cx + rInner * Math.cos(a1);
    const y1i = cy + rInner * Math.sin(a1);
    return [
      `M ${x0o.toFixed(2)} ${y0o.toFixed(2)}`,
      `A ${rOuter} ${rOuter} 0 0 1 ${x1o.toFixed(2)} ${y1o.toFixed(2)}`,
      `L ${x1i.toFixed(2)} ${y1i.toFixed(2)}`,
      `A ${rInner} ${rInner} 0 0 0 ${x0i.toFixed(2)} ${y0i.toFixed(2)}`,
      "Z",
    ].join(" ");
  };
  const iconCenter = (i: number): { x: number; y: number } => {
    const midDeg = -180 + i * 60 + 30;
    const r = (rInner + rOuter) / 2;
    return {
      x: cx + r * Math.cos((midDeg * Math.PI) / 180),
      y: cy + r * Math.sin((midDeg * Math.PI) / 180),
    };
  };
  const featureGlyph = (kind: "vertex" | "edge" | "face", px: number, py: number): JSX.Element => {
    if (kind === "vertex") return <circle cx={px} cy={py} r={2.6} fill="currentColor" />;
    if (kind === "edge") return (
      <line
        x1={px - 5} y1={py} x2={px + 5} y2={py}
        stroke="currentColor" strokeWidth={2.2} strokeLinecap="round"
      />
    );
    return (
      <rect x={px - 4.5} y={py - 4.5} width={9} height={9} rx={1}
        fill="none" stroke="currentColor" strokeWidth={1.6} />
    );
  };
  return (
    <div className="viewer-tools-pie" role="group" aria-label="Face-touch tools">
      <svg width={120} height={120} viewBox="0 0 120 120">
        {wedgeOps.map((opId, i) => {
          const op = TOUCH_OP_BY_ID[opId];
          const isActive = activeTool === "face-touch" && faceTouchOp === op.id;
          const ic = iconCenter(i);
          const dir = faceTouchDirection === "a-to-b" ? +1 : -1;
          // Two glyphs per wedge: separate horizontally (tangent direction
          // would rotate them with the wedge; horizontal keeps them legible
          // regardless of position around the pie).
          const ax = { x: ic.x - 7 * dir, y: ic.y };
          const bx = { x: ic.x + 7 * dir, y: ic.y };
          return (
            <g
              key={op.id}
              className={`tools-pie-wedge${isActive ? " active" : ""}`}
              onClick={() => {
                if (isActive) setActiveTool("select");
                else setFaceTouchOp(op.id);
              }}
            >
              <path d={wedgePath(i)} />
              <title>{`${op.label} — ${op.description}${isActive ? " (Esc to cancel)" : ""}`}</title>
              {featureGlyph(op.firstKind, ax.x, ax.y)}
              {featureGlyph(op.secondKind, bx.x, bx.y)}
            </g>
          );
        })}
        {/* Centre direction toggle */}
        <g
          className="tools-pie-centre"
          onClick={() => setFaceTouchDirection(faceTouchDirection === "a-to-b" ? "b-to-a" : "a-to-b")}
        >
          <circle cx={cx} cy={cy} r={rInner - 2} />
          <title>{faceTouchDirection === "a-to-b" ? "A → B (click again to flip to B → A)" : "B → A (click again to flip to A → B)"}</title>
          <text x={cx} y={cy + 4} textAnchor="middle" fontSize={11} fontWeight={600}>
            {faceTouchDirection === "a-to-b" ? "A→B" : "B→A"}
          </text>
        </g>
      </svg>
    </div>
  );
}

/** Top-left overlay: live editor for the transform cursor's lab-frame
 *  position. Reads `transformCursorMm` from the store so any external
 *  update (clicking the cursor in the scene, programmatic changes) flows
 *  back into the inputs; writes `setTransformCursorMm` on Enter / blur so
 *  the user can directly type a position. Local draft state during typing
 *  prevents focus-loss between keystrokes. */
function ViewerCursorEditor({ panelKey }: { panelKey: "left" | "right" }) {
  const cursor = useSceneStore((state) => state.transformCursorMm[panelKey]);
  const setCursorRaw = useSceneStore((state) => state.setTransformCursorMm);
  const setCursor = (point: { x: number; y: number; z: number }) => setCursorRaw(panelKey, point);
  const cursorHidden = useSceneStore((state) => state.transformCursorHidden[panelKey]);
  const toggleCursorHidden = useSceneStore((state) => state.toggleTransformCursorHidden);
  const [draft, setDraft] = useState({
    x: cursor.x.toFixed(1),
    y: cursor.y.toFixed(1),
    z: cursor.z.toFixed(1),
  });
  // Re-sync whenever the cursor changes externally (scene click, snap,
  // store hydrate). Skips updates when the user is mid-edit on that axis.
  const focusedAxisRef = useRef<"x" | "y" | "z" | null>(null);
  useEffect(() => {
    setDraft((prev) => ({
      x: focusedAxisRef.current === "x" ? prev.x : cursor.x.toFixed(1),
      y: focusedAxisRef.current === "y" ? prev.y : cursor.y.toFixed(1),
      z: focusedAxisRef.current === "z" ? prev.z : cursor.z.toFixed(1),
    }));
  }, [cursor.x, cursor.y, cursor.z]);

  const commit = (axis: "x" | "y" | "z", raw: string) => {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    if (Math.abs(v - cursor[axis]) < 1e-3) return;
    setCursor({ ...cursor, [axis]: v });
  };

  const renderField = (axis: "x" | "y" | "z") => (
    <label className={`viewer-cursor-field axis-${axis}`}>
      <span>{axis.toUpperCase()}</span>
      <input
        type="number"
        step={1}
        value={draft[axis]}
        onChange={(e) => setDraft((p) => ({ ...p, [axis]: e.target.value }))}
        onFocus={() => { focusedAxisRef.current = axis; }}
        onBlur={(e) => { focusedAxisRef.current = null; commit(axis, e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(axis, (e.target as HTMLInputElement).value);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </label>
  );

  return (
    <div className="viewer-cursor-editor" role="group" aria-label="Cursor position (mm)">
      <span className="viewer-cursor-label">Cursor (mm)</span>
      {renderField("x")}
      {renderField("y")}
      {renderField("z")}
      <button
        type="button"
        className="viewer-cursor-toggle"
        onClick={() => toggleCursorHidden(panelKey)}
        aria-pressed={cursorHidden}
        aria-label={cursorHidden ? "Show cursor marker" : "Hide cursor marker"}
        title={cursorHidden ? "Show cursor marker" : "Hide cursor marker"}
      >
        {cursorHidden ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  );
}

export function DigitalTwinViewer({
  roomDimensions,
  panelKey,
  displayMode,
  onDisplayModeChange,
}: DigitalTwinViewerProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const marqueeRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const orientationRendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const environmentGroupRef = useRef<THREE.Group | null>(null);
  const componentGroupRef = useRef<THREE.Group>(new THREE.Group());
  // Per-objectId cache of loaded asset wrappers, used by the rebuild useEffect
  // to avoid re-loading STL / GLB geometry on every dep change. Cache hit when
  // (component, asset, deviceState) all hold reference equality vs last build —
  // i.e. only `placement` (transform) or unrelated state changed. Drag, edit,
  // select, hover all hit the cache and just re-apply transform + decorations.
  // A full scene reload from the server invalidates everything (new array refs).
  const objectWrappersRef = useRef<
    Map<
      string,
      {
        wrapper: THREE.Group;
        componentRef: ComponentItem | undefined;
        assetRef: Asset3D | undefined;
        stateRef: DeviceState | undefined;
        // Fiber-only: last-seen per-instance procedural inputs. Reference
        // equality is enough — `updateFiberNodes` always emits a fresh
        // array. Used by the cache-hit refresh to skip rebuilding tube +
        // connector geometry when nothing fiber-specific changed.
        fiberNodesRef?: unknown;
        fiberRadiusMmRef?: number;
      }
    >
  >(new Map());
  const beamGroupRef = useRef<THREE.Group>(new THREE.Group());
  const relationGroupRef = useRef<THREE.Group>(new THREE.Group());
  const viewCenterGroupRef = useRef<THREE.Group>(new THREE.Group());
  const globalAxesGizmoRef = useRef<THREE.Group | null>(null);
  const resolvedViewCenterThreeRef = useRef<THREE.Vector3>(HOME_CAMERA_TARGET.clone());
  const animationFrameRef = useRef<number>();
  // On-demand rendering. The animate loop only re-renders when this ref's
  // function is called or when OrbitControls reports the camera moved (damping
  // settling). Outside callers (gizmo drag, hover highlight, scene rebuild)
  // call requestRenderRef.current() to schedule a single frame. Default is a
  // no-op so calls before the init useEffect mounts are safe.
  const requestRenderRef = useRef<() => void>(() => {});
  const placementGizmoRef = useRef<PlacementGizmo | null>(null);
  const snapOverlayRef = useRef<SnapOverlay | null>(null);
  const faceHighlightRef = useRef<THREE.Group | null>(null);
  const hoverHighlightRef = useRef<THREE.Group | null>(null);
  /** Overlay holding the fast-axis indicator drawn on the selected
   *  waveplate. Populated by an effect below; cleared when the selection
   *  changes or the selected object isn't a waveplate. */
  const fastAxisOverlayRef = useRef<THREE.Group | null>(null);
  /** Overlay holding the scope-probe marker — a small ring + label drawn
   *  at scopeProbe.pointThree so the user knows exactly which segment /
   *  position the BeamScopePanel is reading from. */
  const scopeProbeOverlayRef = useRef<THREE.Group | null>(null);
  /** Increments after every async renderComponents() finishes. The gizmo
   *  attach useEffect depends on this so it re-runs against the latest
   *  wrappers — without it, gizmo attaches to a wrapper that the next
   *  rebuild then disposes, leaving controls.object orphaned. */
  const [componentsBuildVersion, setComponentsBuildVersion] = useState(0);

  const sceneData = useSceneStore((state) => state.scene);
  const scopeProbe = useSceneStore((state) => state.scopeProbe);
  const selectedComponentId = useSceneStore((state) => state.selectedComponentId);
  const fiberEditingComponentId = useSceneStore((state) => state.fiberEditingComponentId);
  const updateFiberNodes = useSceneStore((state) => state.updateFiberNodes);
  const insertFiberNode = useSceneStore((state) => state.insertFiberNode);
  const removeFiberNode = useSceneStore((state) => state.removeFiberNode);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const selectedObjectIds = useSceneStore((state) => state.selectedObjectIds);
  const selectedRelationId = useSceneStore((state) => state.selectedRelationId);
  const previewObjectTransforms = useSceneStore((state) => state.previewObjectTransforms);
  const relationDraftTarget = useSceneStore((state) => state.relationDraftTarget);
  const selectObject = useSceneStore((state) => state.selectObject);
  const overlayFlags = useSceneStore((state) => state.overlayFlags);
  const session = useSceneStore((state) => state.session);
  const activeViewId = useSceneStore((state) => state.activeViewId);
  const toggleSessionHiddenObject = useSceneStore((state) => state.toggleSessionHiddenObject);
  const updateSceneObject = useSceneStore((state) => state.updateSceneObject);
  const toggleSoloObject = useSceneStore((state) => state.toggleSoloObject);
  const showAllHidden = useSceneStore((state) => state.showAllHidden);
  const deleteSceneObject = useSceneStore((state) => state.deleteObject);
  const gizmoOrientation = useSceneStore((state) => state.gizmoOrientation);
  const gizmoMode = useSceneStore((state) => state.gizmoMode[panelKey]);
  const setGizmoModeRaw = useSceneStore((state) => state.setGizmoMode);
  const setGizmoMode = useCallback(
    (mode: "translate" | "rotate" | "scale") => setGizmoModeRaw(panelKey, mode),
    [setGizmoModeRaw, panelKey],
  );
  const activeTool = useSceneStore((state) => state.activeTool);
  const setActiveTool = useSceneStore((state) => state.setActiveTool);
  const setFaceTouchOp = useSceneStore((state) => state.setFaceTouchOp);
  const faceTouchDirection = useSceneStore((state) => state.faceTouchDirection);
  const setFaceTouchDirection = useSceneStore((state) => state.setFaceTouchDirection);
  const faceTouchPending = useSceneStore((state) => state.faceTouchPending);
  const faceTouchOp = useSceneStore((state) => state.faceTouchOp);

  type CtxMenu = { x: number; y: number; objectId: string; componentId: string };
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  // displayMode is now a controlled prop (so each panel in dual-view holds
  // its own). The parent calls onDisplayModeChange when the user clicks the
  // overlay buttons; the parent in turn writes to zustand under the right
  // panel key so the face-touch cancel logic still fires.

  const transformCursorMm = useSceneStore((state) => state.transformCursorMm[panelKey]);

  const selectedObjects = useMemo(
    () => sceneData.objects.filter((object) => selectedObjectIds.includes(object.id)),
    [sceneData.objects, selectedObjectIds],
  );
  const selectedObject = useMemo(
    () => sceneData.objects.find((object) => object.id === selectedObjectId) ?? null,
    [sceneData.objects, selectedObjectId],
  );

  // Fast-axis indicator on the selected waveplate. Drawn as a thin yellow
  // line lying in the waveplate's transverse plane (perpendicular to the
  // beam-axis = local +X), oriented at fastAxisDeg measured CCW from local
  // +Y in the Y-Z plane. Visualises the angle the user dialled in via the
  // OE panel's Fast-axis field. Cleared when a non-waveplate is selected.
  useEffect(() => {
    const overlay = fastAxisOverlayRef.current;
    if (!overlay) return;
    while (overlay.children.length > 0) {
      const child = overlay.children[0];
      overlay.remove(child);
      if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments || child instanceof THREE.Line) {
        if (child.geometry) child.geometry.dispose();
        const m = (child as THREE.Mesh).material;
        if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
        else if (m) m.dispose();
      }
    }
    if (!selectedObject) return;
    const oe = sceneData.opticalElements.find((e) => e.objectId === selectedObject.id);
    if (!oe || oe.elementKind !== "waveplate") return;

    const params = (oe.kindParams ?? {}) as {
      fastAxisDegBeamLocal?: number;
      fastAxisDeg?: number;
      diameterMm?: number;
      clearApertureMm?: number;
    };
    // Phase 5: kindParams field renamed `fastAxisDeg` →
    // `fastAxisDegBeamLocal`. Read both for backward compat.
    const fastAxisDeg = typeof params.fastAxisDegBeamLocal === "number"
      ? params.fastAxisDegBeamLocal
      : typeof params.fastAxisDeg === "number" ? params.fastAxisDeg : 0;
    // Length of the indicator: a bit longer than the clear aperture so the
    // line clearly extends past the waveplate body (default ~12.7 mm dia,
    // so 18 mm half-length gives an extension on each side).
    const halfLengthMm = (params.diameterMm ?? params.clearApertureMm ?? 12.7) / 2 + 4;
    // Local-frame axis in the waveplate's Y-Z plane (perpendicular to the
    // beam axis = local +X). +Y at fastAxisDeg=0, rotates CCW about +X.
    const theta = (fastAxisDeg * Math.PI) / 180;
    const localAxis = new THREE.Vector3(0, Math.cos(theta), Math.sin(theta));
    // Body-local Z-up → three Y-up axis swap.
    const localThree = bodyLocalDirToThree(localAxis);
    // Rotate by SceneObject's Euler (same convention as
    // transformUtils.applyObjectTransform: YXZ with three's rotation set to
    // (rxDeg, rzDeg, -ryDeg)).
    const euler = new THREE.Euler(
      THREE.MathUtils.degToRad(selectedObject.rxDeg),
      THREE.MathUtils.degToRad(selectedObject.rzDeg),
      THREE.MathUtils.degToRad(-selectedObject.ryDeg),
      "YXZ",
    );
    const worldAxis = localThree.clone().applyEuler(euler).normalize();
    // World position of the waveplate's mesh centre.
    const center = new THREE.Vector3(
      mmToThree(selectedObject.xMm),
      mmToThree(selectedObject.zMm),
      mmToThree(-selectedObject.yMm),
    );
    const halfLengthThree = mmToThree(halfLengthMm);
    const a = center.clone().addScaledVector(worldAxis, +halfLengthThree);
    const b = center.clone().addScaledVector(worldAxis, -halfLengthThree);
    const lineMat = new THREE.LineBasicMaterial({
      color: 0xfacc15,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    });
    const lineGeo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const line = new THREE.Line(lineGeo, lineMat);
    line.renderOrder = 1200;
    overlay.add(line);
    // Small caps at each tip so the axis is easy to spot.
    const capMat = new THREE.MeshBasicMaterial({ color: 0xfacc15, depthTest: false });
    for (const tip of [a, b]) {
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(mmToThree(0.6), 8, 8), capMat);
      sphere.position.copy(tip);
      sphere.renderOrder = 1201;
      overlay.add(sphere);
    }
  }, [selectedObject, sceneData.opticalElements]);

  // Beam-scope probe marker — when the user Alt+clicks a beam tube, draw a
  // small cyan ring + "src → hit" label at probe.pointThree so they can see
  // exactly which segment / position the BeamScopePanel is reading from.
  useEffect(() => {
    const overlay = scopeProbeOverlayRef.current;
    if (!overlay) return;
    while (overlay.children.length > 0) {
      const child = overlay.children[0];
      overlay.remove(child);
      const obj = child as THREE.Mesh & { material?: THREE.Material | THREE.Material[] };
      if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
      const m = (obj as { material?: THREE.Material | THREE.Material[] }).material;
      if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
      else if (m) m.dispose();
    }
    if (!scopeProbe) return;

    const segs = ((window as unknown as { __rayTraceDebug?: TraceSegment[] }).__rayTraceDebug) ?? [];
    const px = scopeProbe.pointThree.x;
    const py = scopeProbe.pointThree.y;
    const pz = scopeProbe.pointThree.z;
    let bestSeg: TraceSegment | null = null;
    let bestDist = Infinity;
    for (const seg of segs) {
      const a = seg.startThree;
      const b = seg.endThree;
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const len2 = dx * dx + dy * dy + dz * dz;
      if (len2 < 1e-18) continue;
      let t = ((px - a.x) * dx + (py - a.y) * dy + (pz - a.z) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
      const cx = a.x + dx * t, cy = a.y + dy * t, cz = a.z + dz * t;
      const d2 = (px - cx) ** 2 + (py - cy) ** 2 + (pz - cz) ** 2;
      if (d2 < bestDist) { bestDist = d2; bestSeg = seg; }
    }

    const probePoint = new THREE.Vector3(px, py, pz);
    // Cyan torus pointing toward the camera plane — flat ring around the
    // probe point. Use a billboard via lookAt the camera each frame? Simpler
    // for now: just a small ring oriented in three.XZ plane (looks like a
    // glowing dot from most angles).
    const ringGeom = new THREE.TorusGeometry(0.03, 0.006, 12, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    });
    const ring = new THREE.Mesh(ringGeom, ringMat);
    ring.position.copy(probePoint);
    ring.renderOrder = 1300;
    overlay.add(ring);

    // Inner solid dot.
    const dotGeom = new THREE.SphereGeometry(0.012, 16, 16);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xfde047, depthTest: false });
    const dot = new THREE.Mesh(dotGeom, dotMat);
    dot.position.copy(probePoint);
    dot.renderOrder = 1301;
    overlay.add(dot);

    // Highlight the matching segment by overlaying a brighter line on top.
    // (No text label in the 3D scene — the segment identity is shown in
    // the BeamScopePanel header instead.)
    if (bestSeg) {
      const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(bestSeg.startThree.x, bestSeg.startThree.y, bestSeg.startThree.z),
        new THREE.Vector3(bestSeg.endThree.x, bestSeg.endThree.y, bestSeg.endThree.z),
      ]);
      const lineMat = new THREE.LineBasicMaterial({
        color: 0x22d3ee,
        transparent: true,
        opacity: 0.55,
        depthTest: false,
      });
      const highlight = new THREE.Line(lineGeo, lineMat);
      highlight.renderOrder = 1299;
      overlay.add(highlight);
    }
  }, [scopeProbe, sceneData.objects]);
  // The 3D cursor IS the orbit / view centre. Initial value comes from
  // localStorage (default 0,0,0); changes via Shift+S menu, snap commands,
  // or the cursor-pos field persist immediately.
  const resolvedViewCenterLab = transformCursorMm;
  const resolvedViewCenterThree = useMemo(
    () => labToThree(resolvedViewCenterLab),
    [resolvedViewCenterLab],
  );

  const snapCameraToView = useCallback((view: AxisViewTarget) => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;

    const target = resolvedViewCenterThreeRef.current.clone();
    const previousTarget = controls.target.clone();

    if (view === "home") {
      controls.target.copy(target);
      camera.position.copy(target).add(HOME_CAMERA_OFFSET);
      camera.up.set(0, 1, 0);
      camera.lookAt(controls.target);
      controls.update();
      return;
    }

    const config = AXIS_VIEW_CONFIG[view];
    const distance = Math.max(camera.position.distanceTo(previousTarget), 12);
    controls.target.copy(target);
    camera.up.copy(config.up);
    camera.position.copy(target).addScaledVector(config.direction, distance);
    camera.lookAt(target);
    controls.update();
  }, []);

  const activeView = useMemo(
    () =>
      activeViewId
        ? (sceneData.sceneViews ?? []).find((view) => view.id === activeViewId) ?? null
        : null,
    [activeViewId, sceneData.sceneViews],
  );
  const renderCtx = useMemo(
    () => makeRenderableContext(overlayFlags, session, activeView, sceneData),
    [overlayFlags, session, activeView, sceneData],
  );

  const cursorHidden = useSceneStore((state) => state.transformCursorHidden[panelKey]);
  useEffect(() => {
    resolvedViewCenterThreeRef.current.copy(resolvedViewCenterThree);
    const markerGroup = viewCenterGroupRef.current;
    clearGroup(markerGroup);
    const marker = createViewCenterMarker();
    marker.position.copy(resolvedViewCenterThree);
    markerGroup.add(marker);
    // Cursor IS the orbit pivot now — keep OrbitControls.target in sync so
    // the camera orbits around the visible cursor marker.
    const controls = controlsRef.current;
    if (controls) {
      controls.target.copy(resolvedViewCenterThree);
      controls.update();
    }
    return () => clearGroup(markerGroup);
  }, [resolvedViewCenterThree]);
  useEffect(() => {
    viewCenterGroupRef.current.visible = !cursorHidden;
  }, [cursorHidden]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#151715");
    scene.fog = new THREE.Fog("#151715", 45, 90);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 220);
    camera.position.set(28, 16, 19);
    cameraRef.current = camera;

    // logarithmicDepthBuffer is INCOMPATIBLE with polygon offset on most
    // hardware: log depth writes gl_FragDepth in the fragment shader,
    // which overrides the rasterizer's polygon-offset bias. We rely on
    // polygon offset (set per-mesh in loadAssetObject) to break z-ties on
    // user-supplied GLBs where the CAD has coplanar surfaces, so log
    // depth is OFF. The Newport optical-table z-fighting issue (which
    // log depth originally addressed) is now solved by lowering the body
    // top below the stainless plate's bottom in addOpticalTable.
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // PBR environment map — required for `MeshPhysicalMaterial.transmission`
    // and iridescence to render as glass / colour-shifting reflections rather
    // than flat opaque surfaces. RoomEnvironment is a procedural neutral IBL
    // baked once at scene init via PMREMGenerator. environmentIntensity is
    // dialled down to 0.4 so existing matte/metal materials elsewhere in the
    // scene don't suddenly look chrome.
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.4;
    pmrem.dispose();

    const orientationScene = new THREE.Scene();
    const orientationCamera = new THREE.PerspectiveCamera(42, 1, 0.1, 8);
    orientationCamera.position.set(0, 0, 3.6);
    const orientationRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    orientationRenderer.outputColorSpace = THREE.SRGBColorSpace;
    orientationRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    orientationRenderer.setSize(AXIS_GIZMO_SIZE, AXIS_GIZMO_SIZE, false);
    orientationRenderer.domElement.className = "global-axis-gizmo";
    orientationRenderer.domElement.title = "Click H for Home, or X/Y/Z/-X/-Y/-Z to align around the current center";
    mount.appendChild(orientationRenderer.domElement);
    orientationRendererRef.current = orientationRenderer;
    const globalAxesGizmo = createGlobalAxesGizmo();
    globalAxesGizmoRef.current = globalAxesGizmo;
    orientationScene.add(globalAxesGizmo);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    // Initial target = current cursor position (loaded from localStorage if
    // any, otherwise 0,0,0). The marker-effect later keeps it in sync as
    // the user moves the cursor.
    controls.target.copy(resolvedViewCenterThreeRef.current);
    controlsRef.current = controls;

    // Mouse mapping (post-rewrite, user request 2026-05-08):
    //   LEFT     : ROTATE (camera orbit)
    //   RIGHT    : PAN
    //   MIDDLE   : marquee select (handled by our pointer handler; null in
    //              OrbitControls so it doesn't fight us)
    //   wheel    : zoom (default OrbitControls behaviour)
    // Modifier+button combos (Shift) are left to OrbitControls' built-in
    // auto-swap (Shift+ROTATE → PAN) so users can still pan via Shift+LEFT
    // if they prefer.
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: null,
      RIGHT: THREE.MOUSE.PAN,
    };

    // On-demand render gate. Initially true so the very first frame paints
    // the freshly-built scene. controls.update() returns true while damping
    // is still settling, so we keep rendering the tail of a rotate/pan after
    // the user releases the mouse. The 'change' listener catches programmatic
    // camera changes (snapCameraToView) and the resize/scene-rebuild paths
    // call requestRender() directly.
    let pendingRender = true;
    const requestRender = () => {
      pendingRender = true;
    };
    requestRenderRef.current = requestRender;
    controls.addEventListener("change", requestRender);

    // Placement gizmo — drives all object positioning through the smart
    // placement engine. See PLACEMENT_DESIGN.md.
    const snapOverlay = new SnapOverlay();
    snapOverlayRef.current = snapOverlay;
    scene.add(snapOverlay.group);

    // Face-touch highlight — a Group containing one shape per feature kind:
    // a translucent disc for face picks, a small sphere for vertex picks,
    // and a thick line segment for edge picks. Only the matching child is
    // visible at a time. The whole group hides when faceTouchPending is null.
    const faceHighlight = new THREE.Group();
    const highlightMat = new THREE.MeshBasicMaterial({
      color: 0x00ffee,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const faceDisc = new THREE.Mesh(new THREE.CircleGeometry(0.15, 32), highlightMat);
    faceDisc.name = "face-highlight-disc";
    faceDisc.visible = false;
    faceDisc.renderOrder = 990;
    faceHighlight.add(faceDisc);
    const vertexBall = new THREE.Mesh(
      new THREE.SphereGeometry(0.04, 18, 18),
      new THREE.MeshBasicMaterial({
        color: 0x00ffee,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      }),
    );
    vertexBall.name = "face-highlight-vertex";
    vertexBall.visible = false;
    vertexBall.renderOrder = 991;
    faceHighlight.add(vertexBall);
    const edgeLineGeom = new THREE.BufferGeometry();
    edgeLineGeom.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0, 0, 0]), 3),
    );
    const edgeLine = new THREE.Line(
      edgeLineGeom,
      new THREE.LineBasicMaterial({
        color: 0x00ffee,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
      }),
    );
    edgeLine.name = "face-highlight-edge";
    edgeLine.visible = false;
    edgeLine.renderOrder = 992;
    faceHighlight.add(edgeLine);
    faceHighlight.visible = false;
    scene.add(faceHighlight);
    faceHighlightRef.current = faceHighlight;

    // Hover preview — same shapes as the picked highlight but in YELLOW so
    // the user knows what they're about to click before clicking. Wireframe
    // is blue, picked highlight is cyan, so yellow is the obvious contrast.
    const hoverHighlight = new THREE.Group();
    const hoverYellow = 0xffd400;
    const hoverDisc = new THREE.Mesh(
      new THREE.CircleGeometry(0.15, 32),
      new THREE.MeshBasicMaterial({
        color: hoverYellow,
        transparent: true,
        opacity: 0.18,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    hoverDisc.name = "hover-highlight-disc";
    hoverDisc.visible = false;
    hoverDisc.renderOrder = 985;
    hoverHighlight.add(hoverDisc);
    const hoverFaceOutlineGeom = new THREE.BufferGeometry();
    hoverFaceOutlineGeom.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(12), 3), // 4 verts (closed loop)
    );
    const hoverFaceOutline = new THREE.LineLoop(
      hoverFaceOutlineGeom,
      new THREE.LineBasicMaterial({
        color: hoverYellow,
        transparent: true,
        opacity: 1,
        depthTest: false,
        linewidth: 2,
      }),
    );
    hoverFaceOutline.name = "hover-highlight-face-outline";
    hoverFaceOutline.visible = false;
    hoverFaceOutline.renderOrder = 986;
    hoverHighlight.add(hoverFaceOutline);
    const hoverVertexBall = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 18, 18),
      new THREE.MeshBasicMaterial({
        color: hoverYellow,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        depthTest: false,
      }),
    );
    hoverVertexBall.name = "hover-highlight-vertex";
    hoverVertexBall.visible = false;
    hoverVertexBall.renderOrder = 987;
    hoverHighlight.add(hoverVertexBall);
    const hoverEdgeLineGeom = new THREE.BufferGeometry();
    hoverEdgeLineGeom.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(6), 3),
    );
    const hoverEdgeLine = new THREE.Line(
      hoverEdgeLineGeom,
      new THREE.LineBasicMaterial({
        color: hoverYellow,
        transparent: true,
        opacity: 1,
        depthTest: false,
        linewidth: 3,
      }),
    );
    hoverEdgeLine.name = "hover-highlight-edge";
    hoverEdgeLine.visible = false;
    hoverEdgeLine.renderOrder = 988;
    hoverHighlight.add(hoverEdgeLine);
    hoverHighlight.visible = false;
    scene.add(hoverHighlight);
    hoverHighlightRef.current = hoverHighlight;

    const placementGizmo = new PlacementGizmo({
      camera,
      domElement: renderer.domElement,
      scene,
      callbacks: {
        onDraggingChange: (dragging) => {
          controls.enabled = !dragging;
          if (!dragging) snapOverlay.hide();
          requestRender();
        },
        onDragUpdate: (result) => {
          useSceneStore.getState().setLastPlacementResult(result);
          // Anchor overlay's line at the dragged object's wrapper position.
          const sel = useSceneStore.getState().selectedObjectId;
          if (sel) {
            let wrapper: THREE.Group | null = null;
            componentGroupRef.current.traverse((node) => {
              if (
                wrapper === null &&
                !(node as THREE.Mesh).isMesh &&
                String(node.userData?.objectId) === sel
              ) {
                wrapper = node as THREE.Group;
              }
            });
            if (wrapper) {
              const w = wrapper as THREE.Group;
              snapOverlay.update(result, w.position.clone());
            }
          }
          requestRender();
        },
        onDragEnd: ({ primary, followers }) => {
          useSceneStore.getState().setLastPlacementResult(primary.result);
          // Primary: full pose + intent metadata.
          const primaryProps = useSceneStore
            .getState()
            .scene.objects.find((o) => o.id === primary.objectId)
            ?.properties as Record<string, unknown> | undefined;
          void useSceneStore.getState().updateSceneObject(primary.objectId, {
            xMm: primary.result.positionLab.x,
            yMm: primary.result.positionLab.y,
            zMm: primary.result.positionLab.z,
            ...(primary.result.rotationLab
              ? {
                  rxDeg: primary.result.rotationLab.rxDeg,
                  ryDeg: primary.result.rotationLab.ryDeg,
                  rzDeg: primary.result.rotationLab.rzDeg,
                }
              : {}),
            properties: {
              ...(primaryProps ?? {}),
              placedRelativeTo: primary.result.intentMetadata,
            },
          });
          // Followers: position + rotation (multi-rotate semantics — each
          // follower orbits the collective centroid AND rotates itself).
          // Persisted as absolute; no per-object snap intent metadata.
          for (const f of followers) {
            const props = useSceneStore
              .getState()
              .scene.objects.find((o) => o.id === f.objectId)
              ?.properties as Record<string, unknown> | undefined;
            void useSceneStore.getState().updateSceneObject(f.objectId, {
              xMm: f.positionLab.x,
              yMm: f.positionLab.y,
              zMm: f.positionLab.z,
              rxDeg: f.rotationLab.rxDeg,
              ryDeg: f.rotationLab.ryDeg,
              rzDeg: f.rotationLab.rzDeg,
              properties: {
                ...(props ?? {}),
                placedRelativeTo: {
                  kind: "absolute",
                  recordedAt: new Date().toISOString(),
                },
              },
            });
          }
        },
      },
      config: {
        snapEnabled: () => useSceneStore.getState().snapEnabled,
        snapCategories: () => useSceneStore.getState().snapCategories,
        thresholdsMm: () => useSceneStore.getState().snapThresholdsMm,
        gridStepMm: () => useSceneStore.getState().snapGridStepMm,
        cursorMm: () => useSceneStore.getState().transformCursorMm[panelKey],
        scene: () => {
          const s = useSceneStore.getState().scene;
          return {
            components: s.components,
            objects: s.objects,
            assets: s.assets,
            opticalElements: s.opticalElements,
            opticalLinks: s.opticalLinks,
          };
        },
        componentGroup: () => componentGroupRef.current,
      },
    });
    placementGizmoRef.current = placementGizmo;

    const ambient = new THREE.AmbientLight("#ffffff", 1.08);
    const key = new THREE.DirectionalLight("#ffffff", 2.05);
    key.position.set(16, 22, 14);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -24;
    key.shadow.camera.right = 24;
    key.shadow.camera.top = 18;
    key.shadow.camera.bottom = -18;
    const environmentGroup = createLabPhotoRoom(roomDimensions);
    applyEnvironmentDisplayMode(environmentGroup, displayMode);
    environmentGroupRef.current = environmentGroup;
    scene.add(environmentGroup, ambient, key);

    componentGroupRef.current.name = "components";
    beamGroupRef.current.name = "beam-paths";
    relationGroupRef.current.name = "relations";
    viewCenterGroupRef.current.name = "view-center";
    if (!fastAxisOverlayRef.current) {
      fastAxisOverlayRef.current = new THREE.Group();
      fastAxisOverlayRef.current.name = "fast-axis-overlay";
    }
    if (!scopeProbeOverlayRef.current) {
      scopeProbeOverlayRef.current = new THREE.Group();
      scopeProbeOverlayRef.current.name = "scope-probe-overlay";
    }
    scene.add(
      componentGroupRef.current,
      beamGroupRef.current,
      relationGroupRef.current,
      viewCenterGroupRef.current,
      fastAxisOverlayRef.current,
      scopeProbeOverlayRef.current,
    );

    const resize = () => {
      const width = Math.max(mount.clientWidth, 320);
      const height = Math.max(mount.clientHeight, 260);
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      pendingRender = true;
    };
    resize();

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const axisRaycaster = new THREE.Raycaster();
    const axisPointer = new THREE.Vector2();
    const pickObject = (event: { clientX: number; clientY: number }) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(componentGroupRef.current.children, true);
      return hits.find((item) => item.object.userData.objectId);
    };
    const pickBeam = (event: { clientX: number; clientY: number }) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(beamGroupRef.current.children, true);
      return hits.find((item) => {
        let n: THREE.Object3D | null = item.object;
        while (n) {
          if (n.userData?.beamSegment) return true;
          n = n.parent;
        }
        return false;
      });
    };
    /** Pick a geometric feature on the mesh under the cursor, of the kind
     *  the user has pre-selected on the toolbar. No auto-detection — for
     *  "vertex" it always returns the closest of the hit triangle's three
     *  vertices, for "edge" the closest of the three edges, and for "face"
     *  the face itself. Returns null if the raycast misses everything.
     *
     *  Used by both the click handler and the hover-highlight tracker, so
     *  the highlight you see while hovering is exactly what gets committed
     *  on click.
     */
    const pickFeature = (
      event: { clientX: number; clientY: number },
      kind: "vertex" | "edge" | "face",
    ) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(componentGroupRef.current.children, true);
      const hit = hits.find(
        (item) => item.object.userData?.objectId && item.face !== null && item.face !== undefined,
      );
      if (!hit || !hit.face) return null;
      const objectId = String(hit.object.userData.objectId);
      const componentId = String(hit.object.userData.componentId ?? "");
      const mesh = hit.object as THREE.Mesh;
      mesh.updateMatrixWorld(true);

      // World-space triangle vertices
      const pos = mesh.geometry.attributes.position;
      const idx = hit.face;
      const vA = new THREE.Vector3().fromBufferAttribute(pos, idx.a).applyMatrix4(mesh.matrixWorld);
      const vB = new THREE.Vector3().fromBufferAttribute(pos, idx.b).applyMatrix4(mesh.matrixWorld);
      const vC = new THREE.Vector3().fromBufferAttribute(pos, idx.c).applyMatrix4(mesh.matrixWorld);

      // Project to screen space (NDC → CSS px) — used to find which vertex /
      // edge of the hit triangle is closest to the cursor on screen.
      const project = (v: THREE.Vector3) => {
        const ndc = v.clone().project(camera);
        return {
          x: ((ndc.x + 1) / 2) * rect.width + rect.left,
          y: ((-ndc.y + 1) / 2) * rect.height + rect.top,
        };
      };
      const sA = project(vA);
      const sB = project(vB);
      const sC = project(vC);
      const cx = event.clientX;
      const cy = event.clientY;
      const distToVertex = (s: { x: number; y: number }) => Math.hypot(s.x - cx, s.y - cy);
      const distToSegment = (p1: { x: number; y: number }, p2: { x: number; y: number }) => {
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const lenSq = dx * dx + dy * dy;
        if (lenSq < 1e-6) return distToVertex(p1);
        const t = Math.max(0, Math.min(1, ((cx - p1.x) * dx + (cy - p1.y) * dy) / lenSq));
        const projX = p1.x + t * dx;
        const projY = p1.y + t * dy;
        return Math.hypot(cx - projX, cy - projY);
      };

      // Face normal (world-space, camera-facing flipped)
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
      const worldNormal = hit.face.normal.clone().applyMatrix3(normalMatrix).normalize();
      const camDir = new THREE.Vector3();
      camera.getWorldDirection(camDir);
      if (worldNormal.dot(camDir) > 0) worldNormal.negate();

      const threeToLabMm = threeToLabPointMm;
      const normalMm = threeDirToLab(worldNormal);

      if (kind === "vertex") {
        const best = [
          { v: vA, d: distToVertex(sA) },
          { v: vB, d: distToVertex(sB) },
          { v: vC, d: distToVertex(sC) },
        ].sort((a, b) => a.d - b.d)[0];
        return {
          kind: "vertex" as const,
          objectId,
          componentId,
          pointMm: threeToLabMm(best.v),
          normalMm,
          sizeMm: 0,
          edgeEndpointsMm: undefined,
        };
      }

      if (kind === "edge") {
        const best = (
          [
            [vA, vB, sA, sB],
            [vB, vC, sB, sC],
            [vC, vA, sC, sA],
          ] as Array<[THREE.Vector3, THREE.Vector3, { x: number; y: number }, { x: number; y: number }]>
        )
          .map(([p1, p2, sp1, sp2]) => ({ p1, p2, d: distToSegment(sp1, sp2) }))
          .sort((a, b) => a.d - b.d)[0];
        const mid = best.p1.clone().add(best.p2).multiplyScalar(0.5);
        const lengthMm = best.p1.distanceTo(best.p2) * 100;
        return {
          kind: "edge" as const,
          objectId,
          componentId,
          pointMm: threeToLabMm(mid),
          normalMm,
          sizeMm: lengthMm,
          edgeEndpointsMm: [threeToLabMm(best.p1), threeToLabMm(best.p2)] as [
            { x: number; y: number; z: number },
            { x: number; y: number; z: number },
          ],
        };
      }

      // kind === "face"
      const worldPoint = hit.point.clone();
      let sizeMm = 25;
      if (mesh.geometry?.boundingBox || mesh.geometry?.computeBoundingBox) {
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        const bbox = mesh.geometry.boundingBox?.clone().applyMatrix4(mesh.matrixWorld);
        if (bbox) {
          const size = bbox.getSize(new THREE.Vector3());
          sizeMm = Math.max(8, Math.min(80, ((size.x + size.y + size.z) / 3) * 100 * 0.5));
        }
      }
      return {
        kind: "face" as const,
        objectId,
        componentId,
        pointMm: threeToLabMm(worldPoint),
        normalMm,
        sizeMm,
        edgeEndpointsMm: undefined,
        // Face hover renders a triangle outline — give caller the 3 vertices.
        triangleMm: [threeToLabMm(vA), threeToLabMm(vB), threeToLabMm(vC)] as [
          { x: number; y: number; z: number },
          { x: number; y: number; z: number },
          { x: number; y: number; z: number },
        ],
      };
    };

    /** Hide every child of the hover-highlight group + the group itself. */
    const clearHoverHighlight = () => {
      const grp = hoverHighlightRef.current;
      if (!grp) return;
      grp.children.forEach((child) => (child.visible = false));
      grp.visible = false;
    };

    /** Drive the yellow hover preview while the touch tool is active.
     *  Called from pointermove. The expected kind depends on the active op
     *  AND whether we're on the first or second pick — e.g. for "ve" the
     *  first pick is a vertex but the second is an edge. */
    const expectedNextKind = (op: TouchOp, hasPending: boolean): FeatureKind =>
      hasPending ? op.secondKind : op.firstKind;
    const updateHoverHighlight = (event: { clientX: number; clientY: number }) => {
      const state = useSceneStore.getState();
      if (state.activeTool !== "face-touch") {
        clearHoverHighlight();
        return;
      }
      const grp = hoverHighlightRef.current;
      if (!grp) return;
      const op = TOUCH_OP_BY_ID[state.faceTouchOp];
      const kind = expectedNextKind(op, !!state.faceTouchPending);
      const hit = pickFeature(event, kind);
      if (!hit) {
        clearHoverHighlight();
        return;
      }
      const labToThree = (mm: { x: number; y: number; z: number }) =>
        new THREE.Vector3(mm.x / 100, mm.z / 100, -mm.y / 100);

      const disc = grp.getObjectByName("hover-highlight-disc") as THREE.Mesh | null;
      const outline = grp.getObjectByName("hover-highlight-face-outline") as THREE.LineLoop | null;
      const ball = grp.getObjectByName("hover-highlight-vertex") as THREE.Mesh | null;
      const line = grp.getObjectByName("hover-highlight-edge") as THREE.Line | null;
      if (disc) disc.visible = false;
      if (outline) outline.visible = false;
      if (ball) ball.visible = false;
      if (line) line.visible = false;

      if (hit.kind === "vertex" && ball) {
        ball.position.copy(labToThree(hit.pointMm));
        ball.visible = true;
      } else if (hit.kind === "edge" && line && hit.edgeEndpointsMm) {
        const a = labToThree(hit.edgeEndpointsMm[0]);
        const b = labToThree(hit.edgeEndpointsMm[1]);
        const positions = line.geometry.getAttribute("position") as THREE.BufferAttribute;
        positions.setXYZ(0, a.x, a.y, a.z);
        positions.setXYZ(1, b.x, b.y, b.z);
        positions.needsUpdate = true;
        line.geometry.computeBoundingSphere();
        line.visible = true;
      } else if (hit.kind === "face") {
        // Disc on the face hit-point + yellow triangle outline so the user
        // sees exactly which triangle is under the cursor.
        if (disc) {
          const posThree = labToThree(hit.pointMm);
          const normalThree = new THREE.Vector3(
            hit.normalMm.x,
            hit.normalMm.z,
            -hit.normalMm.y,
          ).normalize();
          disc.position.copy(posThree);
          const z = new THREE.Vector3(0, 0, 1);
          disc.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(z, normalThree));
          const scale = Math.max(0.5, hit.sizeMm / 15);
          disc.scale.setScalar(scale);
          disc.visible = true;
        }
        if (outline && hit.triangleMm) {
          const tri = hit.triangleMm.map(labToThree);
          const positions = outline.geometry.getAttribute("position") as THREE.BufferAttribute;
          positions.setXYZ(0, tri[0].x, tri[0].y, tri[0].z);
          positions.setXYZ(1, tri[1].x, tri[1].y, tri[1].z);
          positions.setXYZ(2, tri[2].x, tri[2].y, tri[2].z);
          positions.setXYZ(3, tri[0].x, tri[0].y, tri[0].z);
          positions.needsUpdate = true;
          outline.geometry.computeBoundingSphere();
          outline.visible = true;
        }
      }
      grp.visible = true;
    };

    const handleFaceTouchClick = (event: { clientX: number; clientY: number }) => {
      const state = useSceneStore.getState();
      const op = TOUCH_OP_BY_ID[state.faceTouchOp];
      const pending = state.faceTouchPending;
      // Pick the kind matching the current step (first vs second).
      const kind = pending ? op.secondKind : op.firstKind;
      const hit = pickFeature(event, kind);
      if (!hit) {
        state.setFaceTouchError("Click hit empty space — try again on a wireframe");
        window.setTimeout(() => useSceneStore.getState().setFaceTouchError(null), 2500);
        return;
      }
      if (!pending) {
        // First feature pick — record and wait for second click.
        state.setFaceTouchPending({
          kind: hit.kind,
          objectId: hit.objectId,
          pointMm: hit.pointMm,
          normal: hit.normalMm,
          sizeMm: hit.sizeMm,
          edgeEndpointsMm: hit.edgeEndpointsMm,
        });
        state.setFaceTouchError(null);
        return;
      }
      // Reject same object on second pick.
      if (hit.objectId === pending.objectId) {
        state.setFaceTouchError(`Pick a ${op.secondKind} on a different object`);
        window.setTimeout(() => useSceneStore.getState().setFaceTouchError(null), 2500);
        return;
      }
      // Direction-aware target selection.
      //   "b-to-a" (default): the SECOND-clicked object moves so its anchor
      //                       lands on the FIRST anchor. target = hit (B).
      //   "a-to-b":           the FIRST-clicked object moves to the SECOND
      //                       anchor. target = pending (A) — we logically
      //                       SWAP A and B for the rest of the math.
      const direction = state.faceTouchDirection;
      let movingPick = pending;
      let stationaryPick: typeof pending = {
        kind: hit.kind as typeof pending.kind,
        objectId: hit.objectId,
        pointMm: hit.pointMm,
        normal: hit.normalMm,
        sizeMm: hit.sizeMm,
        edgeEndpointsMm: hit.edgeEndpointsMm,
      };
      if (direction === "b-to-a") {
        // Default behaviour: B moves to coincide with A. So `pending` is
        // the stationary reference (A), and the new target is B (hit).
        movingPick = stationaryPick;
        stationaryPick = pending;
      }
      const target = state.scene.objects.find((o) => o.id === movingPick.objectId);
      if (!target) {
        state.setFaceTouchError("Target object disappeared — try again");
        return;
      }

      if (target.locked) {
        state.setFaceTouchError("Target object is locked; unlock it before moving with face-touch.");
        window.setTimeout(() => useSceneStore.getState().setFaceTouchError(null), 3000);
        return;
      }

      // Per-op alignment constraint check. vv/ve/vf have no constraint.
      const v3dot = (
        a: { x: number; y: number; z: number },
        b: { x: number; y: number; z: number },
      ) => a.x * b.x + a.y * b.y + a.z * b.z;

      if (op.id === "ff") {
        // Face normals must be parallel within ~4°.
        const d = v3dot(pending.normal, hit.normalMm);
        if (Math.abs(d) < 0.997) {
          const ang = ((Math.acos(Math.min(1, Math.abs(d))) * 180) / Math.PI).toFixed(1);
          state.setFaceTouchError(
            `Faces are not parallel (${ang}° off). Rotate one until both face normals align.`,
          );
          window.setTimeout(() => useSceneStore.getState().setFaceTouchError(null), 4000);
          return;
        }
      } else if (op.id === "ee") {
        // Edge directions must be parallel within ~10°.
        if (pending.edgeEndpointsMm && hit.edgeEndpointsMm) {
          const ax = pending.edgeEndpointsMm[1].x - pending.edgeEndpointsMm[0].x;
          const ay = pending.edgeEndpointsMm[1].y - pending.edgeEndpointsMm[0].y;
          const az = pending.edgeEndpointsMm[1].z - pending.edgeEndpointsMm[0].z;
          const bx = hit.edgeEndpointsMm[1].x - hit.edgeEndpointsMm[0].x;
          const by = hit.edgeEndpointsMm[1].y - hit.edgeEndpointsMm[0].y;
          const bz = hit.edgeEndpointsMm[1].z - hit.edgeEndpointsMm[0].z;
          const aLen = Math.hypot(ax, ay, az);
          const bLen = Math.hypot(bx, by, bz);
          if (aLen > 1e-6 && bLen > 1e-6) {
            const d = (ax * bx + ay * by + az * bz) / (aLen * bLen);
            if (Math.abs(d) < 0.985) {
              const ang = ((Math.acos(Math.min(1, Math.abs(d))) * 180) / Math.PI).toFixed(1);
              state.setFaceTouchError(
                `Edges are not parallel (${ang}° off). Align both edges first.`,
              );
              window.setTimeout(() => useSceneStore.getState().setFaceTouchError(null), 4000);
              return;
            }
          }
        }
      } else if (op.id === "ef") {
        // Edge direction must be perpendicular to face normal within ~10°
        // (i.e. edge lies parallel to the face plane). Edge is on pending,
        // face normal is on hit.
        if (pending.edgeEndpointsMm) {
          const ex = pending.edgeEndpointsMm[1].x - pending.edgeEndpointsMm[0].x;
          const ey = pending.edgeEndpointsMm[1].y - pending.edgeEndpointsMm[0].y;
          const ez = pending.edgeEndpointsMm[1].z - pending.edgeEndpointsMm[0].z;
          const eLen = Math.hypot(ex, ey, ez);
          const nLen = Math.hypot(hit.normalMm.x, hit.normalMm.y, hit.normalMm.z);
          if (eLen > 1e-6 && nLen > 1e-6) {
            const d = Math.abs(
              (ex * hit.normalMm.x + ey * hit.normalMm.y + ez * hit.normalMm.z) /
                (eLen * nLen),
            );
            // d = sin(angle between edge and face plane); want it small.
            if (d > 0.174 /* sin(10°) */) {
              const ang = ((Math.asin(Math.min(1, d)) * 180) / Math.PI).toFixed(1);
              state.setFaceTouchError(
                `Edge is not parallel to face (${ang}° off the plane). Rotate until the edge lies in the face plane.`,
              );
              window.setTimeout(() => useSceneStore.getState().setFaceTouchError(null), 4000);
              return;
            }
          }
        }
      }
      // vv / ve / vf: no alignment constraint.

      // Per-op default translation. The ff op uses along-normal projection
      // (preserves moving object's lateral position); every other op makes
      // movingPick's anchor coincide with stationaryPick's anchor. Use the
      // direction-aware moving/stationary pair so the offset translates the
      // moving object onto the stationary one, regardless of which was
      // clicked first.
      let baseOffset: { dx: number; dy: number; dz: number };
      if (op.id === "ff") {
        const dx = stationaryPick.pointMm.x - movingPick.pointMm.x;
        const dy = stationaryPick.pointMm.y - movingPick.pointMm.y;
        const dz = stationaryPick.pointMm.z - movingPick.pointMm.z;
        const signed =
          dx * stationaryPick.normal.x +
          dy * stationaryPick.normal.y +
          dz * stationaryPick.normal.z;
        baseOffset = {
          dx: stationaryPick.normal.x * signed,
          dy: stationaryPick.normal.y * signed,
          dz: stationaryPick.normal.z * signed,
        };
      } else {
        baseOffset = {
          dx: stationaryPick.pointMm.x - movingPick.pointMm.x,
          dy: stationaryPick.pointMm.y - movingPick.pointMm.y,
          dz: stationaryPick.pointMm.z - movingPick.pointMm.z,
        };
      }

      // Compute DOF basis vectors per op. Lab frame, unit vectors.
      //   vv → 0 DOF (no axes)
      //   ve → 1 DOF along B's edge direction
      //   vf → 2 DOF in B's face plane
      //   ee → 1 DOF along the (parallel) shared edge direction (use B's)
      //   ef → 2 DOF in B's face plane
      //   ff → 2 DOF in the shared plane (use A's normal as plane normal)
      const v3normalize = (v: { x: number; y: number; z: number }) => {
        const l = Math.hypot(v.x, v.y, v.z);
        return l > 1e-9 ? { x: v.x / l, y: v.y / l, z: v.z / l } : { x: 1, y: 0, z: 0 };
      };
      const v3cross = (
        a: { x: number; y: number; z: number },
        b: { x: number; y: number; z: number },
      ) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
      // Pick a unit vector perpendicular to `n`, biased toward world Z then X.
      const perp = (n: { x: number; y: number; z: number }) => {
        const candidate = Math.abs(n.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
        return v3normalize(v3cross(n, candidate));
      };
      let uAxis: { x: number; y: number; z: number } | null = null;
      let vAxis: { x: number; y: number; z: number } | null = null;
      if (op.id === "ve" || op.id === "ee") {
        // 1 DOF along B's edge direction (or A's for vv-edge — both parallel
        // for ee, only B has an edge for ve).
        const ee = hit.edgeEndpointsMm;
        if (ee) {
          uAxis = v3normalize({ x: ee[1].x - ee[0].x, y: ee[1].y - ee[0].y, z: ee[1].z - ee[0].z });
        }
      } else if (op.id === "vf" || op.id === "ef" || op.id === "ff") {
        // 2 DOF in plane. For vf/ef, plane normal is hit's face normal. For
        // ff, A and B normals are parallel — use A's.
        const planeNormal = op.id === "ff" ? pending.normal : hit.normalMm;
        uAxis = perp(planeNormal);
        vAxis = v3normalize(v3cross(planeNormal, uAxis));
      }

      // Preview: A is the first-clicked feature, B is the second-clicked,
      // regardless of which one is actually moving. drivenObjectId points
      // to whichever object was selected as `target` (moving) above.
      state.setFaceTouchPreview({
        op: op.id,
        a: pending,
        b: {
          kind: hit.kind,
          objectId: hit.objectId,
          pointMm: hit.pointMm,
          normal: hit.normalMm,
          sizeMm: hit.sizeMm,
          edgeEndpointsMm: hit.edgeEndpointsMm,
        },
        drivenObjectId: target.id,
        drivenOriginalPos: { xMm: target.xMm, yMm: target.yMm, zMm: target.zMm },
        baseOffset,
        uAxis,
        vAxis,
        du: 0,
        dv: 0,
      });
      state.setFaceTouchPending(null);
      // Stay in face-touch tool so user can keep working — the panel handles
      // final commit / cancel.
    };

    const DRAG_THRESHOLD_PX = 5;
    const DOUBLE_CLICK_MS = 350;
    const DOUBLE_CLICK_PX = 6;
    // pendingPick.button distinguishes:
    //   0 = LEFT  → click-only object pick (drag is owned by OrbitControls = ROTATE)
    //   1 = MIDDLE → marquee select on drag (OrbitControls.MIDDLE is null)
    let pendingPick: {
      pointerId: number;
      startX: number;
      startY: number;
      dragged: boolean;
      button: 0 | 1;
    } | null = null;
    // Track the previous click for double-click detection. Beam scope only
    // opens on a double-click on a beam tube (single click → object
    // selection / deselection only).
    let lastClick: { t: number; x: number; y: number } | null = null;
    const handlePointerDown = (event: PointerEvent) => {
      // LEFT (button 0) drives single-click object pick; MIDDLE (button 1)
      // drives marquee select. Right button is owned by OrbitControls (PAN).
      if (event.button !== 0 && event.button !== 1) return;
      setCtxMenu(null);
      pendingPick = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        dragged: false,
        button: event.button as 0 | 1,
      };
    };
    const handlePointerMove = (event: PointerEvent) => {
      // Always run hover-preview when face-touch is active so the user sees
      // the yellow highlight regardless of mouse-button state.
      updateHoverHighlight(event);
      requestRender();
      if (!pendingPick || event.pointerId !== pendingPick.pointerId) return;
      const dx = event.clientX - pendingPick.startX;
      const dy = event.clientY - pendingPick.startY;
      if (dx * dx + dy * dy > DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
        pendingPick.dragged = true;
        // Marquee overlay only fires for MIDDLE-button drags now. LEFT
        // drags are owned by OrbitControls (ROTATE); face-touch tool also
        // suppresses it because that tool owns the click + hover flow.
        const isFaceTouch = useSceneStore.getState().activeTool === "face-touch";
        const marquee = marqueeRef.current;
        if (marquee && pendingPick.button === 1 && !isFaceTouch) {
          const canvasRect = renderer.domElement.getBoundingClientRect();
          const x0 = Math.min(pendingPick.startX, event.clientX) - canvasRect.left;
          const y0 = Math.min(pendingPick.startY, event.clientY) - canvasRect.top;
          const w = Math.abs(event.clientX - pendingPick.startX);
          const h = Math.abs(event.clientY - pendingPick.startY);
          marquee.style.display = "block";
          marquee.style.left = `${x0}px`;
          marquee.style.top = `${y0}px`;
          marquee.style.width = `${w}px`;
          marquee.style.height = `${h}px`;
        }
      }
    };
    const handlePointerLeave = () => {
      clearHoverHighlight();
      requestRender();
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (!pendingPick || event.pointerId !== pendingPick.pointerId) return;
      const wasDrag = pendingPick.dragged;
      const startX = pendingPick.startX;
      const startY = pendingPick.startY;
      const button = pendingPick.button;
      pendingPick = null;
      if (wasDrag) {
        // Hide the marquee overlay regardless of how we got here.
        const marquee = marqueeRef.current;
        if (marquee) marquee.style.display = "none";
        // Marquee select fires on MIDDLE-button drags only. LEFT-button
        // drags are camera rotates owned by OrbitControls — don't touch
        // selection. Face-touch tool intercepts everything.
        const isFaceTouch = useSceneStore.getState().activeTool === "face-touch";
        if (button !== 1 || isFaceTouch) return;
        const canvasRect = renderer.domElement.getBoundingClientRect();
        const x0 = Math.min(startX, event.clientX);
        const x1 = Math.max(startX, event.clientX);
        const y0 = Math.min(startY, event.clientY);
        const y1 = Math.max(startY, event.clientY);
        if (x1 - x0 < 4 && y1 - y0 < 4) return;
        camera.updateMatrixWorld(true);
        const stateNow = useSceneStore.getState();
        const objects = stateNow.scene.objects;
        // Reuse the renderer's visibility context so the marquee enforces
        // the same gate that hides the mesh (overlay flags + per-object
        // db visible + session hide + solo + collection cascade + active
        // view filter). Keeps "viewBox false → can't select" consistent
        // across click and marquee paths.
        const marqueeVisCtx = makeRenderableContext(
          stateNow.overlayFlags,
          stateNow.session,
          stateNow.scene.sceneViews?.find((v) => v.id === stateNow.activeViewId) ?? null,
          stateNow.scene,
        );
        const selected: string[] = [];
        const v = new THREE.Vector3();
        for (const obj of objects) {
          // Skip the optical table — selecting it via a marquee that grazes
          // the floor is almost always unintended.
          const cmpType = stateNow.scene.components.find((c) => c.id === obj.componentId)?.componentType;
          if (cmpType === "optical_table") continue;
          // Hidden objects are not selectable. Per-object override of
          // collection visibility (request #2) is plumbed through
          // isObjectVisible, so this naturally lets a force-shown object
          // inside an otherwise-hidden collection still be selectable.
          if (!isObjectVisible(obj, marqueeVisCtx)) continue;
          v.copy(labMmToThree({ xMm: obj.xMm, yMm: obj.yMm, zMm: obj.zMm }));
          v.project(camera);
          if (v.z < -1 || v.z > 1) continue; // behind camera or beyond far plane
          const sx = canvasRect.left + ((v.x + 1) / 2) * canvasRect.width;
          const sy = canvasRect.top + ((-v.y + 1) / 2) * canvasRect.height;
          if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) {
            selected.push(obj.id);
          }
        }
        useSceneStore.getState().setSelectedObjects(selected);
        return;
      }

      // No drag — click-only path. Only LEFT-button clicks trigger
      // selection / beam scope; MIDDLE clicks (without drag) are no-ops.
      if (button !== 0) return;

      // Face-touch tool intercepts clicks before normal selection.
      if (useSceneStore.getState().activeTool === "face-touch") {
        handleFaceTouchClick(event);
        return;
      }

      // Detect double-click: same position (within DOUBLE_CLICK_PX) and
      // within DOUBLE_CLICK_MS of the previous click. Beam scope ONLY
      // opens on a double-click on a beam tube — never on a single click.
      const now = performance.now();
      const dxFromLast = lastClick ? Math.abs(event.clientX - lastClick.x) : Infinity;
      const dyFromLast = lastClick ? Math.abs(event.clientY - lastClick.y) : Infinity;
      const isDoubleClick = lastClick !== null
        && now - lastClick.t < DOUBLE_CLICK_MS
        && dxFromLast < DOUBLE_CLICK_PX
        && dyFromLast < DOUBLE_CLICK_PX;
      lastClick = { t: now, x: event.clientX, y: event.clientY };

      if (isDoubleClick) {
        const beamHit2 = pickBeam(event);
        if (beamHit2) {
          let n2: THREE.Object3D | null = beamHit2.object;
          let seg2: TraceSegment | null = null;
          while (n2 && !seg2) {
            seg2 = (n2.userData?.beamSegment as TraceSegment | undefined) ?? null;
            n2 = n2.parent;
          }
          if (seg2) {
            // Project the click point (which lands on the cylindrical tube
            // surface) onto the segment's centre axis A → B. The result is
            // the closest point on the line where the beam actually
            // travels, so the BeamScope reads at "the centre of the beam"
            // rather than at the tube surface — and the marker (cyan ring
            // + dot) sits exactly on the central axis.
            const a = seg2.startThree;
            const b = seg2.endThree;
            const abx = b.x - a.x;
            const aby = b.y - a.y;
            const abz = b.z - a.z;
            const len2 = abx * abx + aby * aby + abz * abz;
            const px = beamHit2.point.x, py = beamHit2.point.y, pz = beamHit2.point.z;
            let t = len2 > 1e-12
              ? ((px - a.x) * abx + (py - a.y) * aby + (pz - a.z) * abz) / len2
              : 0;
            t = Math.max(0, Math.min(1, t));
            const cx = a.x + abx * t;
            const cy = a.y + aby * t;
            const cz = a.z + abz * t;
            const distAlongMm2 = Math.sqrt(len2) * t * 100;
            const totalZMm2 = seg2.pathLengthFromSourceMmAtStart + distAlongMm2;
            useSceneStore.getState().setScopeProbe({
              sourceComponentId: seg2.sourceComponentId,
              zMm: totalZMm2,
              pointThree: { x: cx, y: cy, z: cz },
              powerFactor: typeof seg2.powerFactorAtStart === "number" ? seg2.powerFactorAtStart : 1.0,
              polarization: Array.isArray(seg2.polarizationAtStart) && seg2.polarizationAtStart.length === 4
                ? (seg2.polarizationAtStart as [number, number, number, number])
                : [1, 0, 0, 0],
            });
            // Beam scope no longer auto-opens from the main scene — the
            // scope contents now live inside the Optical link viewer
            // panel, which the user opens explicitly via the Window menu.
            // We still update `scopeProbe` so the cyan probe marker
            // renders at the clicked point; the link-viewer panel reads
            // the same store value to populate its plots.
            return;
          }
        }
      }

      // Single click → object-selection-only. Beam tubes are intentionally
      // ignored in the main object scene so a click near a beam can't grab
      // the click off the object behind it. Beam-picking is reserved for
      // the Optical link viewer panel (its own click-on-beam handler still
      // sets `scopeProbe`); double-click here also still picks beams for
      // power-user precise scope placement.
      const objectHit = pickObject(event);
      if (objectHit) {
        const objectId = String(objectHit.object.userData.objectId);
        // If the click landed on a fiber connector (housing, ferrule, body
        // sleeve, …) walk the parent chain to find which endpoint we hit.
        // userData.fiberConnectorEndpoint is set on the connector group in
        // createFiberSplineObject. Toggling the beam-entry on this end runs
        // alongside the normal selection so the panel shows up too.
        let connectorEnd: "A" | "B" | null = null;
        for (let n: THREE.Object3D | null = objectHit.object; n; n = n.parent) {
          const ep = n.userData?.fiberConnectorEndpoint;
          if (ep === "A" || ep === "B") {
            connectorEnd = ep;
            break;
          }
        }
        if (connectorEnd) {
          void useSceneStore.getState().toggleFiberBeamEntry(objectId, connectorEnd);
        }
        selectObject(objectId, {
          additive: event.ctrlKey || event.metaKey || event.shiftKey,
        });
        return;
      }
      // Click missed every object → deselect (no fallback to beam picking
      // in the main object scene, by design).
      selectObject(null, {
        additive: event.ctrlKey || event.metaKey || event.shiftKey,
      });
    };
    const handlePointerCancel = (event: PointerEvent) => {
      if (!pendingPick || event.pointerId !== pendingPick.pointerId) return;
      pendingPick = null;
    };
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      const hit = pickObject(event);
      if (!hit) {
        setCtxMenu(null);
        return;
      }
      const objectId = String(hit.object.userData.objectId);
      const componentId = String(hit.object.userData.componentId);
      // Skip the optical_table — right-click is now used primarily for
      // camera PAN, and the table fills most of the viewport so popping a
      // Hide/Solo menu on every pan release is noisy. Other components
      // still get the menu.
      const stateNow = useSceneStore.getState();
      const cmpType = stateNow.scene.components.find((c) => c.id === componentId)?.componentType;
      if (cmpType === "optical_table") {
        setCtxMenu(null);
        return;
      }
      setCtxMenu({ x: event.clientX, y: event.clientY, objectId, componentId });
    };
    const handleAxisGizmoPointerDown = (event: PointerEvent) => {
      event.stopPropagation();
    };
    const handleAxisGizmoClick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = orientationRenderer.domElement.getBoundingClientRect();
      axisPointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      axisPointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      axisRaycaster.setFromCamera(axisPointer, orientationCamera);
      const hits = axisRaycaster.intersectObjects([globalAxesGizmo], true);
      const target = hits.reduce<AxisViewTarget | null>(
        (found, hit) => found ?? getAxisViewTargetFromObject(hit.object),
        null,
      );
      if (target) snapCameraToView(target);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const state = useSceneStore.getState();
      if (state.activeTool === "face-touch") {
        state.setActiveTool("select");
      }
    };
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);
    renderer.domElement.addEventListener("pointercancel", handlePointerCancel);
    renderer.domElement.addEventListener("pointerleave", handlePointerLeave);
    renderer.domElement.addEventListener("contextmenu", handleContextMenu);
    window.addEventListener("keydown", handleEscape);
    orientationRenderer.domElement.addEventListener("pointerdown", handleAxisGizmoPointerDown);
    orientationRenderer.domElement.addEventListener("click", handleAxisGizmoClick);

    const animate = () => {
      // controls.update() returns true while the camera is still moving
      // (active drag or damping settling). Combined with pendingRender — set
      // by 'change' events, hover, gizmo drag, scene rebuild, and the safety-
      // net useEffect — this gates rendering so an idle scene draws zero
      // frames per second instead of 60.
      const cameraMoved = controls.update();
      if (cameraMoved || pendingRender) {
        if (environmentGroupRef.current) {
          const halfWidth = roomDimensions.widthMm / 200;
          const halfDepth = roomDimensions.depthMm / 200;
          for (const wall of environmentGroupRef.current.children) {
            const material = wall instanceof THREE.Mesh ? wall.material : null;
            if (!(material instanceof THREE.MeshStandardMaterial) || !wall.userData.fadeWhenBlocking) continue;
            const side = wall.userData.roomSide;
            const isBlocking =
              (side === "left" && camera.position.x < -halfWidth) ||
              (side === "right" && camera.position.x > halfWidth) ||
              (side === "back" && camera.position.z < -halfDepth) ||
              (side === "ceiling" && camera.position.y > roomDimensions.heightMm / 100);
            material.opacity = isBlocking ? 0.22 : 0.9;
            material.transparent = true;
            material.depthWrite = !isBlocking;
            material.needsUpdate = true;
          }
        }
        if (globalAxesGizmoRef.current) {
          globalAxesGizmoRef.current.quaternion.copy(camera.quaternion).invert();
        }
        renderer.render(scene, camera);
        orientationRenderer.render(orientationScene, orientationCamera);
        pendingRender = false;
      }
      animationFrameRef.current = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      renderer.domElement.removeEventListener("pointercancel", handlePointerCancel);
      renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
      renderer.domElement.removeEventListener("contextmenu", handleContextMenu);
      window.removeEventListener("keydown", handleEscape);
      orientationRenderer.domElement.removeEventListener("pointerdown", handleAxisGizmoPointerDown);
      orientationRenderer.domElement.removeEventListener("click", handleAxisGizmoClick);
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      controls.removeEventListener("change", requestRender);
      requestRenderRef.current = () => {};
      clearGroup(componentGroupRef.current);
      // The wrapper cache references THREE objects that clearGroup just
      // disposed; drop the map so the next mount starts cold.
      objectWrappersRef.current.clear();
      clearGroup(beamGroupRef.current);
      clearGroup(relationGroupRef.current);
      clearGroup(viewCenterGroupRef.current);
      if (environmentGroupRef.current) {
        scene.remove(environmentGroupRef.current);
        disposeObject(environmentGroupRef.current);
        environmentGroupRef.current = null;
      }
      controls.dispose();
      renderer.dispose();
      orientationRenderer.dispose();
      orientationRenderer.domElement.remove();
      disposeObject(orientationScene);
      renderer.domElement.remove();
      scene.clear();
    };
  }, [roomDimensions, selectObject, snapCameraToView]);

  // Attach / detach placement gizmo as selection or orientation changes.
  useEffect(() => {
    const gizmo = placementGizmoRef.current;
    if (!gizmo) return;
    gizmo.setOrientation(gizmoOrientation);
    gizmo.setMode(gizmoMode);
    if (!selectedObjectId) {
      gizmo.detach();
      return;
    }
    const sceneObj = sceneData.objects.find((o) => o.id === selectedObjectId);
    if (!sceneObj) {
      gizmo.detach();
      return;
    }
    if (sceneObj.locked) {
      gizmo.detach();
      return;
    }
    // Helper: find the wrapper Group in componentGroup for a given objectId.
    const findWrapper = (objectId: string): THREE.Group | null => {
      let wrapper: THREE.Group | null = null;
      componentGroupRef.current.traverse((node) => {
        if (
          wrapper === null &&
          !(node as THREE.Mesh).isMesh &&
          String(node.userData?.objectId) === objectId
        ) {
          wrapper = node as THREE.Group;
        }
      });
      return wrapper;
    };
    const primaryWrapper = findWrapper(selectedObjectId);
    if (!primaryWrapper) {
      gizmo.detach();
      return;
    }
    // Followers = other selected objects (not the active one).
    const followers = selectedObjectIds
      .filter((id) => id !== selectedObjectId)
      .map((id) => {
        const obj = sceneData.objects.find((o) => o.id === id);
        const w = findWrapper(id);
        if (!obj || obj.locked || !w) return null;
        return { id: obj.id, componentId: obj.componentId, group: w };
      })
      .filter((x): x is { id: string; componentId: string; group: THREE.Group } => x !== null);
    // Pivot point. Single-object: centre of the wrapper's WORLD bbox (so
    // the gizmo arrows appear at the visual body centre regardless of
    // where the local origin happens to sit — relevant for primitives
    // whose origin is at a face rather than the centre).
    // Multi-object: collective centroid = mean of every selected wrapper's
    // bbox centre. Per the user spec, two objects at A=(0,0,0) and B=(2,2,2)
    // pivot at (1,1,1).
    const pivotLabMm = (() => {
      const wrappers = [primaryWrapper, ...followers.map((f) => f.group)];
      let sumX = 0, sumY = 0, sumZ = 0;
      const tmp = new THREE.Vector3();
      for (const w of wrappers) {
        const box = new THREE.Box3().setFromObject(w);
        if (box.isEmpty()) {
          // Fallback: wrapper world position.
          w.getWorldPosition(tmp);
        } else {
          box.getCenter(tmp);
        }
        // Three → lab mm (three.X = sceneX, three.Y = sceneZ, three.Z = -sceneY).
        sumX += tmp.x * 100;
        sumY += -tmp.z * 100;
        sumZ += tmp.y * 100;
      }
      return {
        x: sumX / wrappers.length,
        y: sumY / wrappers.length,
        z: sumZ / wrappers.length,
      };
    })();
    gizmo.attach({
      primary: { id: sceneObj.id, componentId: sceneObj.componentId, group: primaryWrapper },
      followers,
      pivotLabMm,
    });
    // Re-apply mode AFTER attach so TransformControls' visible helper
    // geometry rebuilds for the current mode. Without this, attach can
    // leave the gizmo invisible/stale until the user toggles the mode
    // button, which is the bug the 2026-05-02 user report flagged.
    gizmo.setMode(gizmoMode);
  }, [selectedObjectId, selectedObjectIds, sceneData.objects, gizmoOrientation, gizmoMode, componentsBuildVersion]);

  useEffect(() => {
    if (environmentGroupRef.current) {
      applyEnvironmentDisplayMode(environmentGroupRef.current, displayMode);
    }
  }, [displayMode]);

  // Update the face-touch highlight when the pending pick changes. The
  // group contains a disc (face), a sphere (vertex) and a line (edge) —
  // we hide everything then turn on whichever matches the pending kind.
  useEffect(() => {
    const group = faceHighlightRef.current;
    if (!group) return;
    const disc = group.getObjectByName("face-highlight-disc") as THREE.Mesh | null;
    const ball = group.getObjectByName("face-highlight-vertex") as THREE.Mesh | null;
    const line = group.getObjectByName("face-highlight-edge") as THREE.Line | null;
    if (disc) disc.visible = false;
    if (ball) ball.visible = false;
    if (line) line.visible = false;
    group.visible = false;
    group.position.set(0, 0, 0);
    group.quaternion.identity();
    group.scale.setScalar(1);
    if (!faceTouchPending) return;

    const labToThree = (mm: { x: number; y: number; z: number }) =>
      new THREE.Vector3(mm.x / 100, mm.z / 100, -mm.y / 100);

    if (faceTouchPending.kind === "face" && disc) {
      const posThree = labToThree(faceTouchPending.pointMm);
      const normalThree = new THREE.Vector3(
        faceTouchPending.normal.x,
        faceTouchPending.normal.z,
        -faceTouchPending.normal.y,
      ).normalize();
      disc.position.copy(posThree);
      const z = new THREE.Vector3(0, 0, 1);
      disc.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(z, normalThree));
      const scale = Math.max(0.5, faceTouchPending.sizeMm / 15);
      disc.scale.setScalar(scale);
      disc.visible = true;
      group.visible = true;
      return;
    }

    if (faceTouchPending.kind === "vertex" && ball) {
      ball.position.copy(labToThree(faceTouchPending.pointMm));
      ball.visible = true;
      group.visible = true;
      return;
    }

    if (faceTouchPending.kind === "edge" && line && faceTouchPending.edgeEndpointsMm) {
      const a = labToThree(faceTouchPending.edgeEndpointsMm[0]);
      const b = labToThree(faceTouchPending.edgeEndpointsMm[1]);
      const positions = line.geometry.getAttribute("position") as THREE.BufferAttribute;
      positions.setXYZ(0, a.x, a.y, a.z);
      positions.setXYZ(1, b.x, b.y, b.z);
      positions.needsUpdate = true;
      line.geometry.computeBoundingSphere();
      line.visible = true;
      group.visible = true;
    }
  }, [faceTouchPending]);

  // Clear the yellow hover preview whenever the touch tool turns off or
  // the user switches op — otherwise a stale highlight (wrong kind/shape)
  // hangs around until the next pointermove.
  useEffect(() => {
    const grp = hoverHighlightRef.current;
    if (!grp) return;
    grp.children.forEach((child) => (child.visible = false));
    grp.visible = false;
  }, [activeTool, faceTouchOp]);

  useEffect(() => {
    let cancelled = false;
    const componentGroup = componentGroupRef.current;
    const beamGroup = beamGroupRef.current;
    const relationGroup = relationGroupRef.current;
    const wrapperCache = objectWrappersRef.current;

    // Beams + relations are cheap line-geometry rebuilds.
    //
    // We deliberately DO NOT clear them here at the top of the useEffect any
    // more (2026-05-11 fix). Previously this ran unconditionally, but the
    // matching repopulation (`renderRayTraces` / `renderRelations`) is gated
    // by `if (cancelled) return;` inside the async IIFE — when a useEffect
    // run gets cancelled (which happens whenever two store updates arrive
    // close together, e.g. `updateSceneObject` fires a manual `set()` AND
    // the backend WS broadcast also calls `applyEvent`, giving 2 useEffect
    // fires for one user click) the beams got cleared but never repopulated,
    // and the reflected/transmitted segments stayed missing until F5. Now
    // both groups are cleared + rebuilt atomically inside the async IIFE
    // after the cancelled check, so a cancelled run leaves the previous
    // frame's beams visible until the new run paints fresh ones.

    const assetById = new Map(sceneData.assets.map((asset) => [asset.id, asset]));
    const componentById = new Map(sceneData.components.map((component) => [component.id, component]));
    // Per-object device state (alembic 0015) — index by object_id.
    const stateByObjectId = new Map(
      sceneData.deviceStates.map((deviceState) => [deviceState.objectId, deviceState]),
    );
    const selectedRelation = selectedRelationId
      ? sceneData.assemblyRelations.find((relation) => relation.id === selectedRelationId)
      : undefined;
    const selectedObjectIdSet = new Set(selectedObjectIds);

    const selectedRelationObjectIds = selectedRelation
      ? new Set([selectedRelation.objectAId, selectedRelation.objectBId])
      : new Set<string>();
    const draftRelationObjectIds = relationDraftTarget
      ? new Set([relationDraftTarget.objectAId, relationDraftTarget.objectBId])
      : new Set<string>();

    const selectedDrivenObjectId = selectedRelation
      ? String(selectedRelation.properties?.drivenObjectId ?? selectedRelation.objectBId)
      : null;

    /** Apply selection wireframe + port labels + AOM tilt arrow + fiber
     *  beam-flow indicator + relation axes to a wrapper based on the
     *  current selection / relation / per-object state. Caller must call
     *  `stripDynamicDecorations` first if the wrapper is a reused cached
     *  one. */
    function decorate(wrapper: THREE.Group, placement: SceneObject, component: ComponentItem): void {
      if (selectedObjectIdSet.has(placement.id) && component.componentType !== "optical_table") {
        addWireframeOutline(wrapper);
      }
      if (component.componentType === "tapered_amplifier") {
        addTaPortLabels(wrapper, component);
      }
      if (component.componentType === "aom" && selectedObjectIdSet.has(placement.id)) {
        const aomAsset = component.asset3dId ? assetById.get(component.asset3dId) : undefined;
        const aomElement = sceneData.opticalElements.find((e) => e.objectId === placement.id);
        addAomTiltAxisMarker(wrapper, aomAsset, aomElement, component);
      }
      if (component.componentType === "fiber") {
        const beamEntryEnd =
          (placement.properties as { beamEntryEnd?: "A" | "B" } | undefined)?.beamEntryEnd;
        if (beamEntryEnd === "A" || beamEntryEnd === "B") {
          const fiberAnchors =
            (component.properties as
              | {
                  fiberAnchors?: {
                    id: string;
                    positionMmBodyLocal?: { x: number; y: number; z: number };
                  }[];
                }
              | undefined)?.fiberAnchors;
          addFiberBeamFlowIndicator(wrapper, beamEntryEnd, fiberAnchors);
        }
      }
      if (selectedRelationObjectIds.has(placement.id) || draftRelationObjectIds.has(placement.id)) {
        addObjectAxesHelper(
          wrapper,
          placement.id === selectedDrivenObjectId || placement.id === relationDraftTarget?.objectBId,
        );
      }
    }

    /** Idempotent — applies regardless of previous state so toggling
     *  visibility on a reused cached wrapper works correctly. */
    function applyVisibilityFlags(wrapper: THREE.Object3D, visible: boolean): void {
      wrapper.visible = visible;
      wrapper.traverse((child) => {
        if (visible) {
          delete child.userData.physicallyHidden;
        } else {
          child.userData.physicallyHidden = true;
        }
      });
    }

    async function renderComponents() {
      if (!renderCtx.overlayFlags.components) {
        // Overlay was just turned off — drop everything from the cache.
        for (const cached of wrapperCache.values()) {
          componentGroup.remove(cached.wrapper);
          disposeObject(cached.wrapper);
        }
        wrapperCache.clear();
        return;
      }

      const seenObjectIds = new Set<string>();

      for (const placement of sceneData.objects) {
        if (cancelled) return;
        seenObjectIds.add(placement.id);

        const component = componentById.get(placement.componentId);
        if (!component) continue;

        const preview = previewObjectTransforms[placement.id];
        const effectivePlacement = preview ? { ...placement, ...preview } : placement;
        // Visibility: hidden objects are still LOADED into the scene tree
        // (so the ray-tracer can interact with them) but their group is
        // marked invisible — they don't render on screen, but the
        // ray-tracer in `traceBeamsFromLasers` opts in to invisible
        // targets so optical effects (mirror reflection, lens, PBS split,
        // …) keep working through the hidden element.
        const visibleInView = isObjectVisible(placement, renderCtx);
        const asset = component.asset3dId ? assetById.get(component.asset3dId) : undefined;
        // Per-object device state — look up by the SceneObject's id, not
        // the component template id.
        const deviceState = stateByObjectId.get(placement.id);

        const cached = wrapperCache.get(placement.id);
        const canReuse =
          cached !== undefined &&
          cached.componentRef === component &&
          cached.assetRef === asset &&
          cached.stateRef === deviceState;

        let wrapper: THREE.Group;
        if (canReuse && cached) {
          // Cache hit — strip prior decorations, re-apply transform / display
          // mode / decorations against the current selection state. Asset
          // geometry (the heavy STL/GLB load) is preserved.
          wrapper = cached.wrapper;
          stripDynamicDecorations(wrapper);
          // The asset object is the wrapper's first child (added in the
          // miss-path below). applyObjectGeometryOffset re-targets the
          // asset's own offset; it's safe to call repeatedly.
          const assetObject = wrapper.children.find((c) => c.userData?.isLoadedAsset);
          if (assetObject) applyObjectGeometryOffset(assetObject, effectivePlacement);
          // Fiber has procedural Bezier geometry that lives on
          // `SceneObject.properties.fiberNodes` / `.radiusMm` — fields that
          // aren't part of `canReuse`'s identity check (which only watches
          // componentRef / assetRef / stateRef). Without an explicit refresh,
          // changing the spline or jacket radius would update the data store
          // but the rendered tube + connectors would visually freeze on
          // their initial pose. Re-apply the tube geometry and connector
          // transforms when those per-instance refs change.
          if (component.componentType === "fiber") {
            const objProps = (placement.properties ?? {}) as {
              fiberNodes?: FiberNode[]; radiusMm?: number;
            };
            const compProps = (component.properties ?? {}) as {
              fiberNodes?: FiberNode[]; radiusMm?: number;
            };
            const nodes =
              (objProps.fiberNodes && objProps.fiberNodes.length >= 2)
                ? objProps.fiberNodes
                : compProps.fiberNodes;
            const radiusMm =
              typeof objProps.radiusMm === "number"
                ? objProps.radiusMm
                : typeof compProps.radiusMm === "number"
                  ? compProps.radiusMm
                  : 1.0;
            const fiberRefsChanged =
              cached.fiberNodesRef !== nodes || cached.fiberRadiusMmRef !== radiusMm;
            if (fiberRefsChanged && nodes && nodes.length >= 2) {
              refreshFiberWrapperGeometry(wrapper, nodes, radiusMm);
              cached.fiberNodesRef = nodes;
              cached.fiberRadiusMmRef = radiusMm;
            }
          }
        } else {
          // Cache miss — dispose the stale wrapper (if any) and load fresh
          // geometry. Async; the cancelled flag guards against teardown
          // races and the cache-key mismatch case where multiple rebuilds
          // happen back-to-back.
          if (cached) {
            componentGroup.remove(cached.wrapper);
            disposeObject(cached.wrapper);
            wrapperCache.delete(placement.id);
          }
          const assetObject = await loadAssetObject(
            component,
            asset,
            deviceState,
            // Per-instance fiberNodes / radiusMm live on the SceneObject;
            // see loadAssetObject signature for the V2 contract.
            placement.properties as { fiberNodes?: FiberNode[]; radiusMm?: number } | null,
          );
          if (cancelled) {
            disposeObject(assetObject);
            return;
          }
          wrapper = new THREE.Group();
          wrapper.name = assetObject.name;
          assetObject.userData.isLoadedAsset = true;
          wrapper.add(assetObject);
          applyObjectGeometryOffset(assetObject, effectivePlacement);
          wrapper.userData.componentId = component.id;
          wrapper.userData.objectId = placement.id;
          wrapper.traverse((child) => {
            child.userData.componentId = component.id;
            child.userData.objectId = placement.id;
          });
          componentGroup.add(wrapper);
          // Seed fiberNodesRef / fiberRadiusMmRef on initial build so the
          // cache-hit refresh path doesn't rebuild on the first cache hit
          // when nothing actually changed.
          const fiberObjProps = (placement.properties ?? {}) as {
            fiberNodes?: FiberNode[]; radiusMm?: number;
          };
          const fiberCompProps = (component.properties ?? {}) as {
            fiberNodes?: FiberNode[]; radiusMm?: number;
          };
          const seedFiberNodes =
            component.componentType === "fiber"
              ? ((fiberObjProps.fiberNodes && fiberObjProps.fiberNodes.length >= 2)
                  ? fiberObjProps.fiberNodes
                  : fiberCompProps.fiberNodes)
              : undefined;
          const seedFiberRadius =
            component.componentType === "fiber"
              ? (typeof fiberObjProps.radiusMm === "number"
                  ? fiberObjProps.radiusMm
                  : typeof fiberCompProps.radiusMm === "number"
                    ? fiberCompProps.radiusMm
                    : 1.0)
              : undefined;
          wrapperCache.set(placement.id, {
            wrapper,
            componentRef: component,
            assetRef: asset,
            stateRef: deviceState,
            fiberNodesRef: seedFiberNodes,
            fiberRadiusMmRef: seedFiberRadius,
          });
        }

        applyObjectTransform(wrapper, effectivePlacement);
        applyViewerDisplayMode(wrapper, displayMode);
        applyVisibilityFlags(wrapper, visibleInView);
        decorate(wrapper, placement, component);
        // Request a paint at the moment of the transform itself. The async
        // IIFE that wraps renderComponents() also fires requestRender at the
        // end, but that one's gated by `if (cancelled) return;` — if a
        // follow-up state change cancels this run before the IIFE wraps up
        // (common when the WS broadcasts an Object + OpticalElement +
        // anchorBindings bootstrap as three quick updates after a drag-in),
        // the wrapper still HAS the correct transform but never gets
        // painted. Firing here means every applyObjectTransform leaves a
        // pending render for the animate loop, regardless of cancellation.
        requestRenderRef.current?.();
        void selectedComponentId;
      }

      // Drop wrappers for objects that were removed from the scene.
      for (const [id, entry] of wrapperCache) {
        if (!seenObjectIds.has(id)) {
          componentGroup.remove(entry.wrapper);
          disposeObject(entry.wrapper);
          wrapperCache.delete(id);
        }
      }
    }

    function renderRelations() {
      const objectById = new Map(
        sceneData.objects.map((object) => [
          object.id,
          previewObjectTransforms[object.id] ? { ...object, ...previewObjectTransforms[object.id] } : object,
        ]),
      );
      for (const relation of sceneData.assemblyRelations) {
        if (!relation.enabled) continue;
        if (!isAssemblyRelationVisible(relation, renderCtx)) continue;
        const targetA = relationTarget(relation, "a");
        const targetB = relationTarget(relation, "b");
        const objectA = objectById.get(targetA.objectId);
        const objectB = objectById.get(targetB.objectId);
        if (!objectA || !objectB) continue;
        const compA = componentById.get(objectA.componentId);
        const compB = componentById.get(objectB.componentId);
        const anchorA = worldAnchor(objectA, compA, targetA.anchorId, compA?.asset3dId ? assetById.get(compA.asset3dId) : null);
        const anchorB = worldAnchor(objectB, compB, targetB.anchorId, compB?.asset3dId ? assetById.get(compB.asset3dId) : null);
        const pointA = labToThree(anchorA.position);
        const pointB = labToThree(anchorB.position);
        const material = new THREE.LineBasicMaterial({
          color: relation.solved ? "#22c55e" : "#f97316",
          transparent: true,
          opacity: 0.92,
        });
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([pointA, pointB]), material);
        relationGroup.add(line);
        addAnchorAxis(relationGroup, pointA, anchorA.direction, "#38bdf8");
        addAnchorAxis(relationGroup, pointB, anchorB.direction, "#f59e0b");
      }

      if (!relationDraftTarget) return;
      const objectA = objectById.get(relationDraftTarget.objectAId);
      const objectB = objectById.get(relationDraftTarget.objectBId);
      if (!objectA || !objectB) return;
      const draftCompA = componentById.get(objectA.componentId);
      const draftCompB = componentById.get(objectB.componentId);
      const anchorA = worldAnchor(objectA, draftCompA, relationDraftTarget.anchorAId, draftCompA?.asset3dId ? assetById.get(draftCompA.asset3dId) : null);
      const anchorB = worldAnchor(objectB, draftCompB, relationDraftTarget.anchorBId, draftCompB?.asset3dId ? assetById.get(draftCompB.asset3dId) : null);
      const pointA = labToThree(anchorA.position);
      const pointB = labToThree(anchorB.position);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([pointA, pointB]),
        new THREE.LineDashedMaterial({
          color: "#eab308",
          dashSize: 0.28,
          gapSize: 0.16,
          transparent: true,
          opacity: 0.95,
        }),
      );
      line.computeLineDistances();
      relationGroup.add(line);
      addAnchorAxis(relationGroup, pointA, anchorA.direction, "#38bdf8");
      addAnchorAxis(relationGroup, pointB, anchorB.direction, "#f59e0b");
    }

    if (renderCtx.overlayFlags.beam_paths) {
      for (const beamPath of sceneData.beamPaths) {
        if (!isBeamPathVisible(beamPath, renderCtx)) continue;
        // BeamPath.sourceObjectId points at a SceneObject (alembic 0015).
        const sourceState = beamPath.sourceObjectId
          ? stateByObjectId.get(beamPath.sourceObjectId)
          : undefined;
        const active = sourceState?.state.enabled !== false;
        beamGroup.add(createBeamPath(beamPath, active));
      }
    }

    // NB: legacy topology beam rendering (buildBeamSegmentMesh /
    // buildEmitterPreviewRays) is intentionally not called here. It drew
    // diagonal lines from laser-emission to target-component-center based on
    // OpticalLink rows, which is visually wrong when the laser isn't actually
    // pointing at the target. The geometry tracer in renderRayTraces is the
    // source of truth for beam visualisation now.

    function renderRayTraces() {
      if (!renderCtx.overlayFlags.beam_segments) return;
      const traces = traceBeamsFromLasers({
        scene: sceneData,
        componentGroup,
      });
      const win = window as unknown as {
        __rayTraceDebug?: TraceSegment[];
        __beamGroup?: THREE.Group;
      };
      win.__rayTraceDebug = traces;
      win.__beamGroup = beamGroup;
      // Per-emitter max ABSOLUTE power so each tube's opacity scales against
      // the brightest beam from the same source. Absolute = factor × source
      // nominal — needed because a tapered amplifier emits forward AND
      // backward beams that share the sourceComponentId but have very
      // different absolute powers (forward typically 10-100× backward at
      // saturated drive). Normalising on factor alone would make both look
      // equally bright, hiding the asymmetry. Using absolute keeps the
      // forward beam much more opaque than the backward one — matching
      // physical intuition.
      const maxBySource = new Map<string, number>();
      for (const seg of traces) {
        const absMw = seg.nominalPowerMwAtSource * seg.powerFactorAtStart;
        const cur = maxBySource.get(seg.sourceComponentId) ?? 0;
        if (absMw > cur) maxBySource.set(seg.sourceComponentId, absMw);
      }
      for (const segment of traces) {
        const maxP = maxBySource.get(segment.sourceComponentId) ?? 1.0;
        // emitterObjectId stays constant from the original emitter down to
        // every descendant segment (unlike sourceObjectId which becomes the
        // last-hit optic on recursive calls). Using it here means a custom
        // beam colour set on a laser/TA carries through AOM diffraction,
        // PBS splits, mirror reflections, lens passes, etc.
        const emitterObj = sceneData.objects.find((o) => o.id === segment.emitterObjectId);
        const colorOverride = getEmissionVisual(emitterObj, segment.emissionKey).colorHex;
        beamGroup.add(buildTraceLine(segment, maxP, colorOverride));
      }
    }

    void (async () => {
      await renderComponents();
      if (cancelled) return;
      // Beams + relations are cleared + rebuilt atomically here, inside the
      // async block after the cancelled check (2026-05-11 fix — see comment
      // above where the old top-of-effect clearGroup calls used to live).
      // If this run is cancelled by a quick follow-up store update, the
      // previous frame's beams stay visible until the new run paints fresh
      // ones, instead of going blank and never recovering until F5.
      clearGroup(beamGroup);
      clearGroup(relationGroup);
      renderRayTraces();
      renderRelations();
      // Tell the gizmo attach effect "wrappers are fresh — re-attach now"
      // so it picks up the wrapper from THIS build instead of the disposed
      // one from the previous build.
      setComponentsBuildVersion((v) => v + 1);
      // The on-demand animate() loop only paints when pendingRender or the
      // camera is moving. Cache-hit transforms (applyObjectTransform on a
      // reused wrapper) mutate three.js state without flipping that flag,
      // so an "Align to Beam" / move-without-reload would sit invisible
      // until the next mouse hover. The no-deps safety-net useEffect runs
      // synchronously on each React commit but resolves before this async
      // IIFE completes, so we have to request a render explicitly here.
      requestRenderRef.current?.();
    })();

    return () => {
      // Set cancelled so any in-flight async loadAssetObject aborts before
      // adding to the scene. We deliberately DON'T clear componentGroup or
      // dispose the wrapper cache here — the cache is what makes the next
      // rebuild fast. Beams + relations get cleared at the top of the next
      // run anyway, and the init useEffect's unmount handler tears down the
      // cache entirely.
      cancelled = true;
    };
  }, [sceneData, selectedComponentId, selectedObjectId, selectedObjectIds, selectedRelationId, previewObjectTransforms, relationDraftTarget, renderCtx, displayMode]);

  // -----------------------------------------------------------------
  // Fiber Bezier-spline edit overlay. Active only when
  // fiberEditingComponentId is non-null. Shows:
  //   - One anchor sphere per node (yellow on endpoints A/B, orange on
  //     interior). Drag = move the anchor (its handles move with it as
  //     fixed offsets). Right-click on an interior anchor = delete.
  //   - Tangent-handle "arrow": a thin line from each anchor to a small
  //     cyan tip sphere. Endpoint A only carries handleOut (toward B);
  //     endpoint B only carries handleIn (toward A); interior anchors
  //     carry both. Drag the tip sphere = adjust that handle's offset
  //     (tension direction + magnitude).
  //   - Double-click on the fiber tube body = insert a new interior
  //     anchor at the click point with default smooth handles.
  // Live drags mutate tubeMesh.geometry locally; pointer-up commits the
  // new node array to the store, which triggers an STL-style rebuild.
  // -----------------------------------------------------------------
  useEffect(() => {
    if (!fiberEditingComponentId) return;
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    const componentGroup = componentGroupRef.current;
    const controls = controlsRef.current;
    if (!renderer || !camera || !componentGroup) return;

    let fiberWrapper: THREE.Object3D | null = null;
    let tubeMesh: THREE.Mesh | null = null;
    componentGroup.traverse((node) => {
      if (
        !fiberWrapper
        && node.userData?.fiberComponentId === fiberEditingComponentId
        && node.userData?.fiberRole === undefined
      ) {
        fiberWrapper = node;
      }
      if (
        !tubeMesh
        && (node as THREE.Mesh).isMesh
        && node.userData?.fiberRole === "tube"
        && node.parent?.userData?.fiberComponentId === fiberEditingComponentId
      ) {
        tubeMesh = node as THREE.Mesh;
      }
    });
    if (!fiberWrapper || !tubeMesh) return;

    const component = sceneData.components.find((c) => c.id === fiberEditingComponentId);
    if (!component) return;
    // Per-instance fiberNodes / radiusMm live on the SceneObject's
    // properties (V2 layer separation; pre-2026-05-11 the values were
    // mutated on Component.properties, which incorrectly propagated edits
    // to all instances of the same fiber type). Prefer per-instance; fall
    // back to the catalog template for legacy data.
    const editingObject = sceneData.objects.find((o) => o.componentId === fiberEditingComponentId);
    const objProps = (editingObject?.properties ?? {}) as {
      fiberNodes?: FiberNode[]; radiusMm?: number;
    };
    const compProps = (component.properties ?? {}) as {
      fiberNodes?: FiberNode[]; radiusMm?: number;
    };
    const resolvedNodes =
      (objProps.fiberNodes && objProps.fiberNodes.length >= 2)
        ? objProps.fiberNodes
        : compProps.fiberNodes;
    // Deep clone so live mutations during a drag don't leak into the store
    // until pointer-up explicitly commits.
    const nodes: FiberNode[] = (resolvedNodes ?? [
      { posMm: [0, 0, 50], handleOutMm: [100, 0, 0] },
      { posMm: [300, 0, 50], handleInMm: [-100, 0, 0] },
    ]).map((n) => ({
      posMm: [n.posMm[0], n.posMm[1], n.posMm[2]],
      handleInMm: n.handleInMm ? [n.handleInMm[0], n.handleInMm[1], n.handleInMm[2]] : undefined,
      handleOutMm: n.handleOutMm ? [n.handleOutMm[0], n.handleOutMm[1], n.handleOutMm[2]] : undefined,
    }));
    const radiusMm =
      typeof objProps.radiusMm === "number" ? objProps.radiusMm :
      typeof compProps.radiusMm === "number" ? compProps.radiusMm : 1.0;

    const labMmToLocalThree = (xMm: number, yMm: number, zMm: number) =>
      new THREE.Vector3(xMm / 100, zMm / 100, -yMm / 100);
    const offsetMmToLocalThree = (dxMm: number, dyMm: number, dzMm: number) =>
      new THREE.Vector3(dxMm / 100, dzMm / 100, -dyMm / 100);
    const localThreeToLabMm = (v: THREE.Vector3): [number, number, number] => [
      v.x * 100,
      -v.z * 100,
      v.y * 100,
    ];
    const offsetLocalThreeToLabMm = (v: THREE.Vector3): [number, number, number] => [
      v.x * 100,
      -v.z * 100,
      v.y * 100,
    ];

    // Dim every component except the fiber being edited.
    const dimmedRecords: { material: THREE.Material; prevOpacity: number; prevTransparent: boolean }[] = [];
    componentGroup.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      let p: THREE.Object3D | null = mesh;
      while (p) {
        if (p.userData?.fiberComponentId === fiberEditingComponentId) return;
        p = p.parent;
      }
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const mat = m as THREE.Material & { opacity?: number; transparent?: boolean };
        if (typeof mat.opacity === "number") {
          dimmedRecords.push({
            material: mat,
            prevOpacity: mat.opacity,
            prevTransparent: !!mat.transparent,
          });
          mat.transparent = true;
          mat.opacity = 0.18;
        }
      }
    });

    // Materials for the gizmo
    const anchorEndMat = new THREE.MeshBasicMaterial({ color: 0xffd166, depthTest: false });
    const anchorInteriorMat = new THREE.MeshBasicMaterial({ color: 0xff8844, depthTest: false });
    const handleTipMat = new THREE.MeshBasicMaterial({ color: 0x66d9ff, depthTest: false });
    const handleLineMat = new THREE.LineBasicMaterial({
      color: 0x66d9ff,
      depthTest: false,
      transparent: true,
      opacity: 0.85,
    });
    const anchorGeometry = new THREE.SphereGeometry(0.045, 16, 12); // 4.5 mm
    const handleTipGeometry = new THREE.SphereGeometry(0.028, 14, 10); // 2.8 mm

    // Track all gizmo meshes so we can find them by raycast.
    type AnchorRef = { mesh: THREE.Mesh; nodeIndex: number };
    type HandleRef = {
      mesh: THREE.Mesh;
      line: THREE.Line;
      nodeIndex: number;
      side: "in" | "out";
    };
    const anchorRefs: AnchorRef[] = [];
    const handleRefs: HandleRef[] = [];

    // Build the gizmo overlay. Re-built from the current `nodes` array each
    // time we need to refresh after a structural change (insert / delete).
    const buildGizmo = () => {
      // Tear down any previous gizmo state.
      for (const a of anchorRefs) (fiberWrapper as THREE.Object3D).remove(a.mesh);
      for (const h of handleRefs) {
        (fiberWrapper as THREE.Object3D).remove(h.mesh);
        (fiberWrapper as THREE.Object3D).remove(h.line);
        h.line.geometry.dispose();
      }
      anchorRefs.length = 0;
      handleRefs.length = 0;

      nodes.forEach((node, index) => {
        const isEnd = index === 0 || index === nodes.length - 1;
        const anchor = new THREE.Mesh(anchorGeometry, isEnd ? anchorEndMat : anchorInteriorMat);
        anchor.position.copy(labMmToLocalThree(node.posMm[0], node.posMm[1], node.posMm[2]));
        anchor.userData.fiberAnchorIndex = index;
        anchor.renderOrder = 1000;
        (fiberWrapper as THREE.Object3D).add(anchor);
        anchorRefs.push({ mesh: anchor, nodeIndex: index });

        const buildHandle = (side: "in" | "out", offsetMm: [number, number, number]) => {
          const tipPos = labMmToLocalThree(
            node.posMm[0] + offsetMm[0],
            node.posMm[1] + offsetMm[1],
            node.posMm[2] + offsetMm[2],
          );
          const tip = new THREE.Mesh(handleTipGeometry, handleTipMat);
          tip.position.copy(tipPos);
          tip.userData.fiberHandleNodeIndex = index;
          tip.userData.fiberHandleSide = side;
          tip.renderOrder = 1001;
          (fiberWrapper as THREE.Object3D).add(tip);
          const lineGeom = new THREE.BufferGeometry().setFromPoints([
            anchor.position.clone(),
            tipPos.clone(),
          ]);
          const line = new THREE.Line(lineGeom, handleLineMat);
          line.renderOrder = 999;
          line.userData.fiberHandleLine = true;
          (fiberWrapper as THREE.Object3D).add(line);
          handleRefs.push({ mesh: tip, line, nodeIndex: index, side });
        };
        if (node.handleOutMm) buildHandle("out", node.handleOutMm);
        if (node.handleInMm) buildHandle("in", node.handleInMm);
      });
    };
    buildGizmo();

    // ---------------------------------------------------------------
    // Phase E: PM slow-axis indicator + aperture overlay rings.
    //
    // For PM fibers, draw a thin coloured tube along the connector's
    // body section in the direction of `slowAxisDegInBodyFrame` so the
    // user can see the slow axis orientation in 3D. For all fiber
    // types, draw a semi-transparent ring at each ferrule tip showing
    // the cladding aperture (Ø typically 125 µm — small at scene
    // scale; we render at the visible ferrule OD = 2.5 mm with a thin
    // edge to be perceptible).
    //
    // Reads spec from the OpticalElement (kindParams.endA / endB).
    // No-op if no OpticalElement exists for this SceneObject.
    // ---------------------------------------------------------------
    type SpecOverlay = { meshes: THREE.Mesh[] };
    const specOverlay: SpecOverlay = { meshes: [] };
    const buildSpecOverlay = () => {
      // Tear down existing overlay
      for (const m of specOverlay.meshes) {
        m.parent?.remove(m);
        m.geometry.dispose();
        if (Array.isArray(m.material)) m.material.forEach((mm) => mm.dispose());
        else (m.material as THREE.Material).dispose();
      }
      specOverlay.meshes = [];

      // Find the OpticalElement for this fiber's first SceneObject.
      // (If multiple instances of the catalog exist, we attach the
      // overlay to whichever wrapper we picked above.)
      const objectIdOnWrapper = String(
        (fiberWrapper as THREE.Object3D).userData?.objectId ?? "",
      );
      const opticalElement = sceneData.opticalElements.find(
        (e) => String(e.objectId) === objectIdOnWrapper,
      );
      if (!opticalElement || opticalElement.elementKind !== "fiber") return;
      const kp = (opticalElement.kindParams ?? {}) as {
        fiberType?: string;
        endA?: { slowAxisDegInBodyFrame?: number | null };
        endB?: { slowAxisDegInBodyFrame?: number | null };
      };
      const isPM = kp.fiberType === "polarization_maintaining";

      // Per connector: locate the connector group, build slow-axis line +
      // aperture ring as children of the connector group so they inherit
      // the connector's quaternion (already aligned with outward).
      const connectors: { conn: THREE.Object3D; tag: "A" | "B" }[] = [];
      (fiberWrapper as THREE.Object3D).traverse((node) => {
        const tag = node.userData?.fiberConnectorEndpoint;
        if (tag === "A" || tag === "B") {
          connectors.push({ conn: node, tag });
        }
      });

      const slowAxisMat = new THREE.MeshBasicMaterial({
        color: 0x66d9ff,
        depthTest: false,
        transparent: true,
        opacity: 0.95,
      });
      const apertureRingMat = new THREE.MeshBasicMaterial({
        color: 0xffd166,
        depthTest: false,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
      });

      for (const { conn, tag } of connectors) {
        // 1. Slow axis indicator — a 1mm-diameter cyan tube running along
        //    the connector body (between cursorY = bootLen+shoulderLen and
        //    + nutLen, i.e. y = 32 mm to 41 mm in connector-local space).
        if (isPM) {
          const phiDeg = (tag === "A" ? kp.endA?.slowAxisDegInBodyFrame : kp.endB?.slowAxisDegInBodyFrame) ?? 0;
          const phi = (phiDeg * Math.PI) / 180;
          const len = 9 / 100; // 9 mm in three units
          const tubeRadius = 0.5 / 100; // 0.5 mm
          const lineGeom = new THREE.CylinderGeometry(tubeRadius, tubeRadius, len, 8);
          const line = new THREE.Mesh(lineGeom, slowAxisMat);
          // Position along connector +Y at the body section midpoint, offset
          // outward by the body radius so it sits ON the body surface.
          const bodyR = 4.05 / 100;
          line.position.set(
            bodyR * Math.cos(phi),
            (32 + 9 / 2) / 100,
            bodyR * Math.sin(phi),
          );
          line.renderOrder = 1002;
          conn.add(line);
          specOverlay.meshes.push(line);
        }

        // 2. Aperture ring — a thin ring at the ferrule tip (y ≈ 56 mm).
        //    We draw at the ferrule OD (2.5 mm) since the actual cladding
        //    aperture (125 µm) is too small to perceive.
        const ringInnerR = 1.25 / 100;
        const ringOuterR = 1.6 / 100;
        const ringGeom = new THREE.RingGeometry(ringInnerR, ringOuterR, 32);
        const ring = new THREE.Mesh(ringGeom, apertureRingMat);
        // Place at the ferrule tip, facing outward (along connector +Y).
        // RingGeometry is in the XY plane normal to +Z by default, so we
        // rotate so its normal is +Y in connector-local frame.
        ring.rotation.x = Math.PI / 2;
        ring.position.set(0, 56 / 100, 0);
        ring.renderOrder = 1003;
        conn.add(ring);
        specOverlay.meshes.push(ring);
      }
    };
    buildSpecOverlay();

    // Update the line geometry connecting an anchor to one of its handle
    // tips, after the anchor or tip has moved.
    const refreshHandleLine = (handle: HandleRef) => {
      const anchor = anchorRefs.find((a) => a.nodeIndex === handle.nodeIndex);
      if (!anchor) return;
      const points = [anchor.mesh.position.clone(), handle.mesh.position.clone()];
      handle.line.geometry.dispose();
      handle.line.geometry = new THREE.BufferGeometry().setFromPoints(points);
    };

    // Live tube rebuild during a drag. Also re-applies the FC connector
    // transforms so the heads track the endpoint anchor and tangent
    // direction as the user drags A.handleOut / B.handleIn.
    const rebuildTube = () => {
      const path = buildFiberCurvePath(nodes);
      const tubularSegments = Math.max(64, (nodes.length - 1) * 32);
      const newGeom = new THREE.TubeGeometry(path, tubularSegments, radiusMm / 100, 12, false);
      const old = (tubeMesh as THREE.Mesh).geometry;
      (tubeMesh as THREE.Mesh).geometry = newGeom;
      old.dispose();
      const wrapper = fiberWrapper as THREE.Object3D;
      for (const child of wrapper.children) {
        const tag = child.userData?.fiberConnectorEndpoint;
        if (tag === "A" || tag === "B") applyFiberConnectorTransform(child, nodes, tag);
      }
    };

    // Pointer handling
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    type DragKind =
      | { kind: "anchor"; nodeIndex: number; startAnchorWorld: THREE.Vector3 }
      | { kind: "handle"; nodeIndex: number; side: "in" | "out" };
    let drag: DragKind | null = null;
    let dragPlane: THREE.Plane | null = null;

    const updatePointer = (event: { clientX: number; clientY: number }) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
    };

    const screenAlignedPlaneAt = (worldPos: THREE.Vector3) => {
      const camDir = new THREE.Vector3();
      camera.getWorldDirection(camDir);
      return new THREE.Plane(camDir.clone().negate(), camDir.clone().dot(worldPos));
    };

    const onContextMenu = (event: MouseEvent) => event.preventDefault();

    const onPointerDown = (event: PointerEvent) => {
      // Right-click on an interior anchor → delete that node.
      if (event.button === 2) {
        updatePointer(event);
        const anchorMeshes = anchorRefs.map((r) => r.mesh);
        const hits = raycaster.intersectObjects(anchorMeshes, false);
        if (hits.length > 0) {
          const idx = hits[0].object.userData.fiberAnchorIndex as number;
          event.preventDefault();
          event.stopPropagation();
          if (idx > 0 && idx < nodes.length - 1) {
            void removeFiberNode(fiberEditingComponentId, idx);
          }
        }
        return;
      }
      if (event.button !== 0) return;
      updatePointer(event);

      // 1. Handle tip beats anchor (smaller, sits on top).
      const handleMeshes = handleRefs.map((r) => r.mesh);
      const handleHits = raycaster.intersectObjects(handleMeshes, false);
      if (handleHits.length > 0) {
        const tip = handleHits[0].object as THREE.Mesh;
        const nodeIndex = tip.userData.fiberHandleNodeIndex as number;
        const side = tip.userData.fiberHandleSide as "in" | "out";
        const wp = new THREE.Vector3();
        tip.getWorldPosition(wp);
        dragPlane = screenAlignedPlaneAt(wp);
        drag = { kind: "handle", nodeIndex, side };
        if (controls) controls.enabled = false;
        try { renderer.domElement.setPointerCapture(event.pointerId); } catch { /* ignore */ }
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      // 2. Anchor.
      const anchorMeshes = anchorRefs.map((r) => r.mesh);
      const anchorHits = raycaster.intersectObjects(anchorMeshes, false);
      if (anchorHits.length > 0) {
        const anchor = anchorHits[0].object as THREE.Mesh;
        const nodeIndex = anchor.userData.fiberAnchorIndex as number;
        const wp = new THREE.Vector3();
        anchor.getWorldPosition(wp);
        dragPlane = screenAlignedPlaneAt(wp);
        drag = { kind: "anchor", nodeIndex, startAnchorWorld: wp.clone() };
        if (controls) controls.enabled = false;
        try { renderer.domElement.setPointerCapture(event.pointerId); } catch { /* ignore */ }
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!drag || !dragPlane) return;
      updatePointer(event);
      const worldHit = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(dragPlane, worldHit)) return;
      const wrapperInv = new THREE.Matrix4().copy((fiberWrapper as THREE.Object3D).matrixWorld).invert();
      const localHit = worldHit.clone().applyMatrix4(wrapperInv);

      if (drag.kind === "anchor") {
        const node = nodes[drag.nodeIndex];
        const oldAnchorLocal = labMmToLocalThree(node.posMm[0], node.posMm[1], node.posMm[2]);
        const delta = localHit.clone().sub(oldAnchorLocal);
        // Update anchor position
        const newPosLab = localThreeToLabMm(localHit);
        node.posMm = [newPosLab[0], newPosLab[1], newPosLab[2]];
        // Move the anchor mesh
        const anchorRef = anchorRefs.find((a) => a.nodeIndex === drag!.nodeIndex);
        if (anchorRef) anchorRef.mesh.position.copy(localHit);
        // Move BOTH handle tips with the anchor (handles store offsets).
        for (const h of handleRefs) {
          if (h.nodeIndex !== drag.nodeIndex) continue;
          h.mesh.position.add(delta);
          refreshHandleLine(h);
        }
        rebuildTube();
        return;
      }

      // Handle tip drag — adjust the offset on this side only.
      const node = nodes[drag.nodeIndex];
      const anchorLocal = labMmToLocalThree(node.posMm[0], node.posMm[1], node.posMm[2]);
      const offsetLocal = localHit.clone().sub(anchorLocal);
      const offsetMm = offsetLocalThreeToLabMm(offsetLocal);
      if (drag.side === "in") {
        node.handleInMm = offsetMm;
      } else {
        node.handleOutMm = offsetMm;
      }
      const handleRef = handleRefs.find(
        (h) => h.nodeIndex === drag!.nodeIndex && h.side === (drag as { side: "in" | "out" }).side,
      );
      if (handleRef) {
        handleRef.mesh.position.copy(localHit);
        refreshHandleLine(handleRef);
      }
      rebuildTube();
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!drag) return;
      drag = null;
      dragPlane = null;
      if (controls) controls.enabled = true;
      try { renderer.domElement.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
      void updateFiberNodes(
        fiberEditingComponentId,
        nodes.map((n) => ({
          posMm: [n.posMm[0], n.posMm[1], n.posMm[2]],
          handleInMm: n.handleInMm
            ? [n.handleInMm[0], n.handleInMm[1], n.handleInMm[2]]
            : undefined,
          handleOutMm: n.handleOutMm
            ? [n.handleOutMm[0], n.handleOutMm[1], n.handleOutMm[2]]
            : undefined,
        })),
      );
    };

    // Double-click on the tube body inserts a new interior anchor at the
    // click point. The new anchor's handles are tangent-aligned (1/4 of the
    // shorter neighbour segment in the curve direction) so the local shape
    // doesn't pop.
    const onDoubleClick = (event: MouseEvent) => {
      updatePointer({ clientX: event.clientX, clientY: event.clientY });
      const tubeHits = raycaster.intersectObject(tubeMesh as THREE.Mesh, false);
      if (tubeHits.length === 0) return;
      const hitWorld = tubeHits[0].point.clone();
      const wrapperInv = new THREE.Matrix4().copy((fiberWrapper as THREE.Object3D).matrixWorld).invert();
      const localThree = hitWorld.applyMatrix4(wrapperInv);
      const labMm = localThreeToLabMm(localThree);

      // Find the segment closest to the hit and its tangent at that t.
      const path = buildFiberCurvePath(nodes);
      const cumulativeLen: number[] = [0];
      for (const c of path.curves) cumulativeLen.push(cumulativeLen[cumulativeLen.length - 1] + c.getLength());
      // Find which segment got closest in 3D.
      let bestSegment = 0;
      let bestDistSq = Infinity;
      const samples = 24;
      let bestSegT = 0.5;
      path.curves.forEach((c, segIdx) => {
        for (let s = 0; s <= samples; s += 1) {
          const t = s / samples;
          const pt = c.getPointAt(t);
          const d2 = pt.distanceToSquared(localThree);
          if (d2 < bestDistSq) {
            bestDistSq = d2;
            bestSegment = segIdx;
            bestSegT = t;
          }
        }
      });
      const tangentLocal = path.curves[bestSegment].getTangentAt(bestSegT).clone();
      // Tangent in local-three; convert to lab-mm offset of length ~1/4 segment.
      const segLengthThree = path.curves[bestSegment].getLength();
      const segLengthMm = segLengthThree * 100;
      const handleLengthMm = Math.max(20, Math.min(200, segLengthMm * 0.25));
      const tangentLabUnit = offsetLocalThreeToLabMm(tangentLocal);
      const tangentLength = Math.hypot(tangentLabUnit[0], tangentLabUnit[1], tangentLabUnit[2]) || 1;
      const inOffset: [number, number, number] = [
        -tangentLabUnit[0] / tangentLength * handleLengthMm,
        -tangentLabUnit[1] / tangentLength * handleLengthMm,
        -tangentLabUnit[2] / tangentLength * handleLengthMm,
      ];
      const outOffset: [number, number, number] = [
        tangentLabUnit[0] / tangentLength * handleLengthMm,
        tangentLabUnit[1] / tangentLength * handleLengthMm,
        tangentLabUnit[2] / tangentLength * handleLengthMm,
      ];
      event.preventDefault();
      event.stopPropagation();
      void insertFiberNode(fiberEditingComponentId, bestSegment + 1, {
        posMm: [labMm[0], labMm[1], labMm[2]],
        handleInMm: inOffset,
        handleOutMm: outOffset,
      });
    };

    const canvas = renderer.domElement;
    canvas.addEventListener("pointerdown", onPointerDown, true);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("contextmenu", onContextMenu);
    canvas.addEventListener("dblclick", onDoubleClick, true);

    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown, true);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("dblclick", onDoubleClick, true);
      if (controls) controls.enabled = true;
      // Slow-axis + aperture overlay cleanup
      for (const m of specOverlay.meshes) {
        m.parent?.remove(m);
        m.geometry.dispose();
        if (Array.isArray(m.material)) m.material.forEach((mm) => mm.dispose());
        else (m.material as THREE.Material).dispose();
      }
      specOverlay.meshes = [];
      for (const a of anchorRefs) a.mesh.parent?.remove(a.mesh);
      for (const h of handleRefs) {
        h.mesh.parent?.remove(h.mesh);
        h.line.parent?.remove(h.line);
        h.line.geometry.dispose();
      }
      anchorGeometry.dispose();
      handleTipGeometry.dispose();
      anchorEndMat.dispose();
      anchorInteriorMat.dispose();
      handleTipMat.dispose();
      handleLineMat.dispose();
      for (const record of dimmedRecords) {
        (record.material as THREE.Material & { opacity: number; transparent: boolean }).opacity =
          record.prevOpacity;
        (record.material as THREE.Material & { opacity: number; transparent: boolean }).transparent =
          record.prevTransparent;
      }
    };
  }, [
    fiberEditingComponentId,
    sceneData.components,
    componentsBuildVersion,
    insertFiberNode,
    removeFiberNode,
    updateFiberNodes,
  ]);

  // Fiber endpoint markers — show End A / End B as small read-only yellow
  // spheres whenever a fiber object is selected (no edit mode required).
  // Lets the user quickly see where the ports actually sit in the scene,
  // e.g. to debug "no beam found within 25 mm" alignment warnings. Skips
  // the fiber currently in edit mode (its own draggable gizmo already
  // covers the endpoints).
  useEffect(() => {
    const componentGroup = componentGroupRef.current;
    if (!componentGroup) return;

    const ids = new Set<string>();
    for (const id of selectedObjectIds) ids.add(id);
    if (selectedObjectId) ids.add(selectedObjectId);
    if (ids.size === 0) return;

    const labMmToLocalThree = (xMm: number, yMm: number, zMm: number) =>
      new THREE.Vector3(xMm / 100, zMm / 100, -yMm / 100);

    const markerGeometry = new THREE.SphereGeometry(0.045, 16, 12);
    const markerMat = new THREE.MeshBasicMaterial({
      color: 0x3b82f6,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    });

    const created: THREE.Mesh[] = [];
    for (const objectId of ids) {
      const sceneObject = sceneData.objects.find((o) => o.id === objectId);
      if (!sceneObject) continue;
      const component = sceneData.components.find((c) => c.id === sceneObject.componentId);
      if (!component) continue;
      // Prefer per-instance fiberNodes (V2 layer); fall back to component
      // catalog defaults so legacy un-migrated rows still render markers.
      const objProps = (sceneObject.properties ?? {}) as { fiberNodes?: FiberNode[] };
      const compProps = (component.properties ?? {}) as { fiberNodes?: FiberNode[] };
      const nodes =
        (objProps.fiberNodes && objProps.fiberNodes.length >= 2)
          ? objProps.fiberNodes
          : compProps.fiberNodes;
      if (!nodes || nodes.length < 2) continue;
      if (fiberEditingComponentId === component.id) continue;

      let fiberGroup: THREE.Object3D | null = null;
      componentGroup.traverse((node) => {
        if (fiberGroup) return;
        if (
          node.userData?.objectId === objectId
          && node.userData?.fiberComponentId === component.id
        ) {
          fiberGroup = node;
        }
      });
      if (!fiberGroup) continue;

      for (const idx of [0, nodes.length - 1]) {
        const n = nodes[idx];
        const sphere = new THREE.Mesh(markerGeometry, markerMat);
        sphere.position.copy(labMmToLocalThree(n.posMm[0], n.posMm[1], n.posMm[2]));
        sphere.renderOrder = 999;
        sphere.userData.fiberEndpointMarker = true;
        (fiberGroup as THREE.Object3D).add(sphere);
        created.push(sphere);
      }
    }

    return () => {
      for (const mesh of created) {
        mesh.parent?.remove(mesh);
      }
      markerGeometry.dispose();
      markerMat.dispose();
    };
  }, [
    selectedObjectId,
    selectedObjectIds,
    sceneData.objects,
    sceneData.components,
    fiberEditingComponentId,
    componentsBuildVersion,
  ]);

  // Safety net for on-demand rendering: any React commit could have mutated
  // the Three.js scene through one of the many sibling useEffects above
  // (gizmo attach, wireframe outline, fiber overlay, fast-axis indicator,
  // scope probe, hover highlight teardown, etc.). Rather than thread a
  // requestRender call into every one of them, this no-deps effect runs
  // after every commit and schedules a single frame. Cost is one render per
  // React commit — far cheaper than the previous 60 fps continuous loop.
  useEffect(() => {
    requestRenderRef.current?.();
  });

  const ctxObject = ctxMenu ? sceneData.objects.find((o) => o.id === ctxMenu.objectId) : null;
  const ctxObjectName = ctxObject?.name ?? "Object";

  return (
    <div className="viewer-shell">
      <div ref={mountRef} className="viewer-canvas" />
      {/* Marquee selection rectangle. Positioned absolute over the canvas
          and toggled visible by the pointer drag handler in DOM (no React
          re-render churn during a drag). */}
      <div ref={marqueeRef} className="viewer-marquee" />
      <ViewerCursorEditor panelKey={panelKey} />
      <ToolbarHint displayMode={displayMode} gizmoMode={gizmoMode} />
      <div className="viewer-display-modes" role="group" aria-label="Display mode">
        {DISPLAY_MODE_OPTIONS.map(({ mode, title, Icon }) => (
          <button
            key={mode}
            type="button"
            className={`viewer-mode-button${displayMode === mode ? " active" : ""}`}
            data-mode={mode}
            title={title}
            aria-label={title}
            aria-pressed={displayMode === mode}
            onClick={() => onDisplayModeChange(mode)}
          >
            <Icon size={16} />
          </button>
        ))}
      </div>
      <div className="viewer-transform-modes" role="group" aria-label="Transform mode">
        <button
          type="button"
          className={`viewer-mode-button${gizmoMode === "translate" ? " active" : ""}`}
          title="Translate (G)"
          aria-pressed={gizmoMode === "translate"}
          onClick={() => setGizmoMode("translate")}
        >
          <Move size={16} />
        </button>
        <button
          type="button"
          className={`viewer-mode-button${gizmoMode === "rotate" ? " active" : ""}`}
          title="Rotate (R)"
          aria-pressed={gizmoMode === "rotate"}
          onClick={() => setGizmoMode("rotate")}
        >
          <RotateCw size={16} />
        </button>
      </div>
      {displayMode === "wireframe" && (
        <ToolsPie
          activeTool={activeTool}
          faceTouchOp={faceTouchOp}
          faceTouchDirection={faceTouchDirection}
          setFaceTouchOp={(op) => {
            setFaceTouchOp(op);
            setActiveTool("face-touch");
          }}
          setActiveTool={setActiveTool}
          setFaceTouchDirection={setFaceTouchDirection}
        />
      )}
      {ctxMenu && (
        <div
          className="viewer-context-menu"
          style={{ position: "fixed", left: ctxMenu.x, top: ctxMenu.y }}
          onMouseLeave={() => setCtxMenu(null)}
        >
          <div className="context-header">{ctxObjectName}</div>
          <button
            onClick={() => {
              toggleSessionHiddenObject(ctxMenu.objectId);
              setCtxMenu(null);
            }}
          >
            Hide (session) <kbd>H</kbd>
          </button>
          <button
            onClick={() => {
              void updateSceneObject(ctxMenu.objectId, { visible: false });
              setCtxMenu(null);
            }}
          >
            Hide (permanent) <kbd>⇧H</kbd>
          </button>
          <button
            onClick={() => {
              toggleSoloObject(ctxMenu.objectId);
              setCtxMenu(null);
            }}
          >
            Solo / Toggle <kbd>S</kbd>
          </button>
          <div className="context-divider" />
          <button
            onClick={() => {
              showAllHidden();
              setCtxMenu(null);
            }}
          >
            Show all hidden <kbd>Esc</kbd>
          </button>
          {(() => {
            // Delete acts on the union of selectedObjectIds and the right-
            // clicked object (Blender-style: right-click on something not in
            // your selection still deletes it). Confirms with the user since
            // DELETE /api/objects/{id} is a hard-delete and the row can't be
            // restored without re-creating from scratch.
            //
            // Locked objects are filtered out — store.deleteObject silently
            // no-ops on locked, but pre-filtering here lets the confirm
            // dialog show the actual count and disables the button entirely
            // when every candidate is locked.
            const candidateIds = Array.from(new Set([...selectedObjectIds, ctxMenu.objectId]));
            const objsById = new Map(sceneData.objects.map((o) => [o.id, o]));
            const deletableIds = candidateIds.filter((id) => !objsById.get(id)?.locked);
            const lockedCount = candidateIds.length - deletableIds.length;
            const allLocked = deletableIds.length === 0;
            const label = allLocked
              ? `Locked (${candidateIds.length})`
              : deletableIds.length > 1
                ? `Delete selected (${deletableIds.length})${lockedCount > 0 ? ` · skip ${lockedCount} locked` : ""}`
                : "Delete";
            return (
              <button
                className="context-danger"
                disabled={allLocked}
                onClick={() => {
                  setCtxMenu(null);
                  if (allLocked) return;
                  const msg = deletableIds.length > 1
                    ? `Permanently delete ${deletableIds.length} objects${lockedCount > 0 ? ` (${lockedCount} locked will be skipped)` : ""}? This cannot be undone.`
                    : `Permanently delete "${ctxObjectName}"? This cannot be undone.`;
                  if (!window.confirm(msg)) return;
                  void Promise.all(deletableIds.map((id) => deleteSceneObject(id)));
                }}
              >
                {label} <kbd>Del</kbd>
              </button>
            );
          })()}
        </div>
      )}
    </div>
  );
}
