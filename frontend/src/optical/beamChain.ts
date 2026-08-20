/** Shared "optical link" beam-chain geometry.
 *
 *  Builds the rich beam visualisation the `optical-link` viewer display mode
 *  draws INSIDE the main scene (DigitalTwinViewer): one elliptical Gaussian
 *  tube per trace segment plus the per-segment polarization marker, and the
 *  translucent optic-surface faces that mark where each optic actually acts
 *  on the beam.
 *
 *  This code used to live in `components/optical/OpticalLinkViewerPanel.tsx`,
 *  which rendered it into its OWN mini scene stacked over the main canvas —
 *  so the orientation gizmo drove the (hidden) main camera and only the optics
 *  the beam touched were drawn. It now runs in the main viewer's `beamGroup`
 *  under `labRoot`, i.e. raw lab Z-up coordinates scaled by `mmToThree`, which
 *  is exactly the frame the adapted trace segments (`startThree`/`endThree`,
 *  see `three/v3TraceAdapter.ts`) already live in.
 *
 *  Invariants:
 *   - callers add the returned group to a parent whose local frame is lab Z-up
 *     (`labRoot` in the main viewer); nothing here applies the world swap S.
 *   - every tube carries `userData.beamSegment` so the viewer's `pickBeam`
 *     raycast can resolve the clicked segment (the markers deliberately don't).
 */
import * as THREE from "three";

import { beamWidthsUmAtPathMm, type SegmentBeamMode } from "../components/optical/BeamScopePanel";
import { beamColorForSource } from "../three/opticalBeams";
import type { Asset3D, SceneObject } from "../types/digitalTwin";
import { anchorObjectLocalAxisX, anchorObjectLocalPos } from "../utils/anchorAccess";
import { mmToThree } from "./frames";
import { buildPolarizationMarkers } from "./polarizationMarker";

/** Loose subset of `V3TraceSegment` the beam chain reads. */
export type LinkTraceSegment = {
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
  // Y-axis (qy) widths for the astigmatic elliptical tube; equal to X for a
  // circular beam.
  waistAtStartUmY: number;
  waistAtEndUmY: number;
  // Per-axis q-parameter Gaussian snapshot. Lets the tube sample the true
  // analytic width along the segment (intra-segment focus) — same math as the
  // scope plot. Optional: legacy payloads without it fall back to endpoint lerp.
  beamMode?: SegmentBeamMode;
  powerFactorAtStart: number;
  nominalPowerMwAtSource?: number;
  polarizationAtStart: [number, number, number, number];
};

const VISUAL_BOOST = 4; // amplify the Gaussian waist for visibility
const VISUAL_FLOOR_UM = 30; // never draw a tube thinner than this in µm
/** Jones intensity below which a segment is treated as dark — no polarization
 *  marker (a Glan's rejected branch would otherwise draw a full-strength mark
 *  on light that carries no power). */
const DARK_POWER_FACTOR = 0.01;

/** The anchors an optic-surface marker may sit on, in preference order. Mirror
 *  of the backend's `anchor_tracer.PRIMARY_ANCHOR_IDS` (the only anchors the
 *  tracer hit-tests) plus the legacy `optical_anchor` alias — a marker claims
 *  "this is the surface the beam is acted on", so it must not appear anywhere
 *  the tracer would never intercept. */
const PRIMARY_OPTICAL_ANCHOR_IDS = [
  "optical_center", "optical_anchor", "intercept_face",
  "interaction_center", "intercept_in", "intercept_out",
];

/** Diagonal of the box enclosing every segment endpoint (three units), floored
 *  so an empty / degenerate chain still yields a usable marker scale. */
export function beamChainSpan(segments: readonly LinkTraceSegment[]): number {
  const bbox = new THREE.Box3();
  for (const seg of segments) {
    bbox.expandByPoint(new THREE.Vector3(seg.startThree.x, seg.startThree.y, seg.startThree.z));
    bbox.expandByPoint(new THREE.Vector3(seg.endThree.x, seg.endThree.y, seg.endThree.z));
  }
  return bbox.isEmpty() ? 1 : Math.max(bbox.getSize(new THREE.Vector3()).length(), 1e-3);
}

/** Build one segment's tapered tube. Local frame: +Y = beam axis, +X/+Z = the
 *  transverse ellipse axes, so an astigmatic beam renders elliptical and a
 *  round one degenerates to the old circular cone. */
function buildBeamTube(seg: LinkTraceSegment, colour: THREE.Color | string): THREE.Mesh | null {
  const start = new THREE.Vector3(seg.startThree.x, seg.startThree.y, seg.startThree.z);
  const end = new THREE.Vector3(seg.endThree.x, seg.endThree.y, seg.endThree.z);
  const direction = new THREE.Vector3().subVectors(end, start);
  const length = direction.length();
  if (length < 1e-9) return null;
  direction.normalize();

  // µm → mm → three units (1 unit = 100 mm) × the visual boost. Each axis is
  // floored independently so a micron waist stays visible.
  const toScene = (um: number) => mmToThree(Math.max(um, VISUAL_FLOOR_UM) / 1000) * VISUAL_BOOST;
  // Half-widths at axial fraction t ∈ [0,1]. With a beamMode we sample the
  // TRUE analytic Gaussian (same q-parameter math as the scope plot) so a
  // focus INSIDE the segment — e.g. just past a lens — renders as a real pinch
  // instead of the straight start→end cone a 2-ring taper draws. Legacy
  // payloads (no beamMode) fall back to endpoint interpolation.
  const mode = seg.beamMode;
  const widthsAt = (t: number): { rx: number; ry: number } => {
    if (mode) {
      const pathMm = seg.pathLengthFromSourceMmAtStart + seg.lengthMm * t;
      const { wxUm, wyUm } = beamWidthsUmAtPathMm(mode, pathMm);
      return { rx: toScene(wxUm), ry: toScene(wyUm) };
    }
    const lerp = (a: number, b: number) => a + (b - a) * t;
    return {
      rx: toScene(lerp(seg.waistAtStartUm, seg.waistAtEndUm)),
      ry: toScene(lerp(seg.waistAtStartUmY, seg.waistAtEndUmY)),
    };
  };

  // Transverse basis. The backend expresses the beam's transverse state in
  // jones.beam_local_sp's frame: +s = the world UP direction projected
  // perpendicular to the propagation axis, +p = d x s. rx comes from qx and
  // therefore belongs on +s, ry from qy on +p.
  //
  // `sHat` below is built as d x up, i.e. PERPENDICULAR to up — that is the
  // backend's +p, not its +s. Mapping rx onto it rendered every astigmatic
  // beam's ellipse rotated by 90 degrees. `upHat` is the one lying in the
  // (d, up) plane, so it is the backend's +s and is what rx must follow.
  const yAxis = new THREE.Vector3(0, 1, 0);   // scene is Y-up; lab is Z-up
  const sHat = new THREE.Vector3().crossVectors(direction, yAxis);
  if (sHat.lengthSq() < 1e-9) {
    sHat.crossVectors(direction, new THREE.Vector3(1, 0, 0));
  }
  sHat.normalize();
  const upHat = new THREE.Vector3().crossVectors(sHat, direction).normalize();
  // upHat x direction = -sHat, so the third column is negated to keep the
  // basis right-handed — a reflection here would invert the tube's normals.
  const minusSHat = sHat.clone().negate();

  const RING = 24;
  // Axial slices: one ring per slice so the hyperbolic taper / focus pinch is
  // resolved smoothly. 24 is cheap (beam tubes are few) yet smooth.
  const SLICES = 24;
  const ringStride = RING + 1;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= SLICES; j++) {
    const t = j / SLICES;
    const { rx, ry } = widthsAt(t);
    const y = -length / 2 + t * length;
    for (let i = 0; i <= RING; i++) {
      const a = (i / RING) * Math.PI * 2;
      pos.push(rx * Math.cos(a), y, ry * Math.sin(a));
    }
  }
  for (let j = 0; j < SLICES; j++) {
    for (let i = 0; i < RING; i++) {
      const a0 = j * ringStride + i, a1 = a0 + 1;
      const b0 = (j + 1) * ringStride + i, b1 = b0 + 1;
      idx.push(a0, b0, a1, a1, b0, b1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geometry.setIndex(idx);
  geometry.computeVertexNormals();
  const tube = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color: colour,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.55,
    }),
  );
  tube.position.copy(start).addScaledVector(direction, length / 2);
  tube.quaternion.setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(upHat, direction, minusSHat),
  );
  // Skinny centreline so a near-focus pinch is still visible.
  const centreline = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, -length / 2, 0),
      new THREE.Vector3(0, length / 2, 0),
    ]),
    new THREE.LineBasicMaterial({ color: colour }),
  );
  tube.add(centreline);
  return tube;
}

/** Build the whole chain: one Gaussian tube per segment + a polarization mark
 *  at each segment midpoint. `objectById` resolves the emitter so a per-source
 *  colour override (`properties.emissionVisuals`) paints its entire chain. */
export function buildBeamChainGroup(
  segments: readonly LinkTraceSegment[],
  objectById: ReadonlyMap<string, SceneObject>,
): THREE.Group {
  const group = new THREE.Group();
  group.name = "beam-chain";
  const span = beamChainSpan(segments);
  for (const seg of segments) {
    // Key on the EMITTER (the laser/TA that originated the beam), which is
    // stable down the whole chain; sourceObjectId is the per-segment source
    // optic and would only colour the first hop.
    const colour = beamColorForSource(objectById.get(seg.emitterObjectId), seg.wavelengthNm);
    const tube = buildBeamTube(seg, colour);
    if (!tube) continue;
    tube.userData.beamSegment = seg;
    group.add(tube);

    if (seg.powerFactorAtStart > DARK_POWER_FACTOR) {
      const start = new THREE.Vector3(seg.startThree.x, seg.startThree.y, seg.startThree.z);
      const end = new THREE.Vector3(seg.endThree.x, seg.endThree.y, seg.endThree.z);
      const direction = new THREE.Vector3().subVectors(end, start);
      const mid = start.clone().addScaledVector(direction, 0.5);
      for (const mark of buildPolarizationMarkers(
        seg.polarizationAtStart,
        direction.clone().normalize(),
        mid,
        span * 0.0025,
        // Lab scale: 1 three-unit = 100 mm, so the helper's default 0.05
        // shaft-radius floor would be 5 mm — thicker than the arrow is long.
        // Scale the floor with the bench instead.
        { minRadius: span * 0.00015 },
      )) {
        group.add(mark);
      }
    }
  }
  return group;
}

/** Translucent fill + edge outline of one shared geometry (disk or rect),
 *  added to `group` in whatever frame the caller set up. */
function addTranslucentFace(
  group: THREE.Group,
  geom: THREE.BufferGeometry,
  fillHex: number,
  lineHex: number,
  opacity: number,
): void {
  const fill = new THREE.Mesh(
    geom,
    new THREE.MeshBasicMaterial({
      color: fillHex, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false,
    }),
  );
  fill.renderOrder = 20;
  group.add(fill);
  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(geom),
    new THREE.LineBasicMaterial({ color: lineHex, transparent: true, opacity: 0.9 }),
  );
  outline.renderOrder = 21;
  group.add(outline);
}

/** Build ONE optic-surface marker in the asset's body/mm frame, then bake
 *  `mw` (the owning mesh's matrix relative to the wrapper) so the marker
 *  tracks the drawn mesh exactly, regardless of per-builder axis swaps/scale:
 *   - beam_splitter (PBS cube, IO-3/IO-5 glan) → translucent PINK reflective-
 *     coating quad at intercept_face (axisX = coating normal).
 *   - faraday_rotator → translucent AMBER disk at optical_center, ⊥ to the
 *     optical axis (the polarisation-rotation plane).
 *   - any other optic → translucent SLATE disk/rect at its primary optical
 *     anchor (optical_center / optical_anchor / intercept_face /
 *     interaction_center / intercept_in / intercept_out), ⊥ to the optical axis.
 *  Returns null only when the asset has no such optical anchor. */
function buildOpticSurfaceMarker(asset: Asset3D, mw: THREE.Matrix4): THREE.Group | null {
  const kind = asset.kindId;
  const hasAnc = (id: string) => (asset.anchors ?? []).some((a) => a.id === id);
  let ancId: string | null = null;
  let style: "pbs" | "faraday" | "generic" = "generic";
  if (kind === "beam_splitter" && hasAnc("intercept_face")) {
    ancId = "intercept_face";
    style = "pbs";
  } else if (kind === "faraday_rotator" && hasAnc("optical_center")) {
    ancId = "optical_center";
    style = "faraday";
  } else {
    // ONLY an anchor the tracer actually hit-tests earns a face — the same set
    // as the backend's `anchor_tracer.PRIMARY_ANCHOR_IDS`. There is deliberately
    // no "else use the asset's first anchor" fallback: connectors would then
    // draw a face on `connect_out`, and RF parts one on `rf_in`/`rf_out`, i.e.
    // big pale discs floating where no light is ever intercepted.
    ancId = PRIMARY_OPTICAL_ANCHOR_IDS.find(hasAnc) ?? null;
    style = "generic";
  }
  if (!ancId) return null;
  // axisX is the coating normal (beam_splitter) / optical axis (faraday &
  // generic); read through anchorAccess so any R_body is applied, landing the
  // marker in the same body frame the geometry lives in.
  const anc = (asset.anchors ?? []).find((a) => a.id === ancId);
  if (!anc) return null;
  const axisX = anchorObjectLocalAxisX(anc, asset);
  if (!axisX) return null;
  const normal = new THREE.Vector3(axisX.x, axisX.y, axisX.z);
  if (normal.lengthSq() < 1e-9) return null;
  normal.normalize();
  const p = anchorObjectLocalPos(anc, asset);

  const group = new THREE.Group();
  group.name = `optic-surface-${ancId}`;
  group.position.set(p.x, p.y, p.z); // body-frame mm
  // Plane/disk face normal is +Z; rotate it onto the surface normal.
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);

  const addFace = (geom: THREE.BufferGeometry, fillHex: number, lineHex: number, opacity: number) =>
    addTranslucentFace(group, geom, fillHex, lineHex, opacity);

  if (style === "pbs") {
    // Aperture extent is a frame-invariant scalar (mm): explicit B1 coating
    // face (36 × 25.4 mm for the PBS252 cube) → anchor aperture → 1" default.
    const faces = (asset.faces ?? []) as Array<Record<string, unknown>>;
    const b1 = faces.find((f) => f.id === "B1");
    const wMm = Number(b1?.apertureWidthMm) || anc.apertureMm || 25.4;
    const hMm = Number(b1?.apertureHeightMm) || anc.apertureMm || 25.4;
    addFace(new THREE.PlaneGeometry(wMm, hMm), 0xf472b6, 0xf9a8d4, 0.22);
  } else if (style === "faraday") {
    // faraday_rotator — amber disk marking the polarisation-rotation plane.
    const rMm = anc.apertureMm && anc.apertureMm > 0 ? anc.apertureMm : 5;
    addFace(new THREE.CircleGeometry(rMm, 40), 0xfbbf24, 0xfcd34d, 0.2);
  } else {
    // Generic optic face — neutral slate disk (or rect) at the anchor aperture.
    const wMm = anc.apertureWidthMm;
    const hMm = anc.apertureHeightMm;
    const geom = (typeof wMm === "number" && wMm > 0 && typeof hMm === "number" && hMm > 0)
      ? new THREE.PlaneGeometry(wMm, hMm)
      : new THREE.CircleGeometry(anc.apertureMm && anc.apertureMm > 0 ? anc.apertureMm : 6.35, 40);
    addFace(geom, 0xcbd5e1, 0xe2e8f0, 0.16);
  }

  // Place via the owning mesh's translation + rotation, but force the
  // body-mm → three scale to mmToThree (1/100). The mesh matrix's own scale
  // differs by asset: STL geometry is authored in mm so its matrix carries the
  // 1/100 unit scale, but procedural prisms (IO-3 glans / Faraday rod) author
  // geometry already in three units so their scale is 1. Reusing that raw
  // scale on a mm-built marker blew the glan / faraday markers up ~100×;
  // substituting the canonical mm→three scale sizes every marker correctly
  // regardless of how its mesh was built.
  // Use the asset/binding ROOT transform. Descendant meshes can include
  // renderer-internal correction rotations (for example the IO-3 Glan prism's
  // visible diagonal is rotated onto its physics plane); applying those again
  // would turn this body-local anchor marker 90° away from the real surface.
  const mPos = new THREE.Vector3();
  const mQuat = new THREE.Quaternion();
  const mScale = new THREE.Vector3();
  mw.decompose(mPos, mQuat, mScale);
  const unit = mmToThree(1);
  group.applyMatrix4(new THREE.Matrix4().compose(mPos, mQuat, new THREE.Vector3(unit, unit, unit)));
  return group;
}

/** Walk a loaded asset tree and build optic-surface markers for every optic
 *  asset unit inside it. Resolves each unit's asset — single-asset =
 *  `singleAsset`; binding tree = `__bindingId` userData → ComponentBinding →
 *  Asset3D — and bakes the marker with that unit's matrix RELATIVE TO `parent`
 *  so composite optics (the IO-3 glan coatings + Faraday rod) get markers too,
 *  not just the root asset. The returned group is meant to be added to
 *  `parent` so it follows the object as it moves (no rebuild on drag).
 *
 *  `assetRoot` is the loaded asset object itself — the node whose transform
 *  (frame airlock + geometry offset) positions a SINGLE-asset component's
 *  marker; for a binding tree each unit brings its own node.
 *
 *  `bindings` is the whole scene's ComponentBinding list (a composite's tree
 *  carries `__bindingId`s from its sub-components, so the lookup needs all of
 *  them); `ownBindings` is only this component's rows and is what the
 *  last-resort branch may enumerate.
 *
 *  The returned group carries `userData.isOpticSurfaceMarker` so the viewer's
 *  `stripDynamicDecorations` can clean it off a cached wrapper.
 *  Returns null when no markers apply. */
export function buildOpticSurfaceMarkers(
  parent: THREE.Object3D,
  assetRoot: THREE.Object3D,
  singleAsset: Asset3D | undefined,
  bindings: ReadonlyArray<{ id: string; asset3dId?: string | null }>,
  ownBindings: ReadonlyArray<{ id: string; asset3dId?: string | null }>,
  assetById: ReadonlyMap<string, Asset3D>,
): THREE.Group | null {
  parent.updateMatrixWorld(true);
  const parentInverse = parent.matrixWorld.clone().invert();
  const relative = (node: THREE.Object3D) =>
    parentInverse.clone().multiply(node.matrixWorld);

  const bindingById = new Map(bindings.map((b) => [b.id, b]));
  const units = new Map<string, { asset: Asset3D; mw: THREE.Matrix4 }>();
  assetRoot.traverse((node) => {
    const bid = (node.userData as { __bindingId?: string } | undefined)?.__bindingId;
    if (typeof bid !== "string" || units.has(bid)) return;
    const b = bindingById.get(bid);
    const asset = b?.asset3dId ? assetById.get(b.asset3dId) : undefined;
    if (asset) units.set(bid, { asset, mw: relative(node) });
  });
  if (singleAsset && !units.has("__root__")) {
    units.set("__root__", { asset: singleAsset, mw: relative(assetRoot) });
  }
  // Binding-based components (created via "+ New Component": asset3dId is null
  // so singleAsset is undefined, and a flat single binding isn't
  // __bindingId-tagged) still need their anchor shown. Resolve the bound
  // assets straight from the bindings and bake at the asset root.
  //
  // `ownBindings` MUST be this component's own rows, not the whole scene's:
  // the full list is needed above to resolve a `__bindingId` inside a
  // composite's tree, but reusing it here made an untagged component (the
  // fiber) sprout a marker for EVERY bound asset in the scene — ~35 discs
  // stacked at the fiber's origin, sized after other components' optics.
  if (units.size === 0) {
    for (const b of ownBindings) {
      if (!b.asset3dId || units.has(b.id)) continue;
      const a = assetById.get(b.asset3dId);
      if (a) units.set(b.id, { asset: a, mw: relative(assetRoot) });
    }
  }
  const out = new THREE.Group();
  out.name = "optic-surface-markers";
  out.userData.isOpticSurfaceMarker = true;
  for (const { asset, mw } of units.values()) {
    const marker = buildOpticSurfaceMarker(asset, mw);
    if (marker) out.add(marker);
  }
  return out.children.length ? out : null;
}

/** A fiber end's pose + spec, as stored on the fiber PhysicsElement's
 *  `kindParams.endA` / `endB` (fiber BODY-local mm). */
type FiberEndParams = {
  posMm?: number[] | null;
  tensionHandleMm?: number[] | null;
  apertureDiameterMm?: number | null;
};

function vec3From(value: number[] | null | undefined): THREE.Vector3 | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  if (!value.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  return new THREE.Vector3(value[0], value[1], value[2]);
}

/** Optical-face offset + hit aperture of one fiber end, read off the bound
 *  `fiber_connector` asset's `connect_in` anchor. Mirror of the backend's
 *  `db_scene_loader._connector_tip_and_aperture` — the ASSET is the single
 *  definition of both, so editing `connect_in` in the ASSET3D editor moves the
 *  coupling face here exactly as it moves the traced waist. */
function connectorTipAndAperture(
  connector: Asset3D | undefined,
  fallbackTipMm: number,
  fallbackApertureMm: number,
): { tipMm: number; apertureMm: number } {
  let tipMm = fallbackTipMm;
  let apertureMm = fallbackApertureMm;
  if (!connector) return { tipMm, apertureMm };
  const cIn = (connector.anchors ?? []).find((a) => a.id === "connect_in");
  const cOut = (connector.anchors ?? []).find((a) => a.id === "connect_out");
  if (!cIn) return { tipMm, apertureMm };
  if (typeof cIn.apertureMm === "number" && cIn.apertureMm > 0) apertureMm = cIn.apertureMm;
  if (cOut) {
    const pIn = anchorObjectLocalPos(cIn, connector);
    const pOut = anchorObjectLocalPos(cOut, connector);
    const d = new THREE.Vector3(pIn.x - pOut.x, pIn.y - pOut.y, pIn.z - pOut.z).length();
    if (d > 1e-6) tipMm = d;
  }
  return { tipMm, apertureMm };
}

/** Coupling-face markers for a FIBER, which has no optical anchor of its own.
 *
 *  A connector-component fiber binds two passthrough `fiber_connector` assets
 *  (`connect_*` are not primary anchors), so the backend SYNTHESIZES the
 *  optical slot instead: `db_scene_loader._synth_fiber_slot` builds
 *  intercept_in (end A) / intercept_out (end B) from the fiber
 *  PhysicsElement's `kindParams.endA/endB` — the per-instance pose Align
 *  writes — offset to the ferrule face by the connector's `connect_in`. This
 *  mirrors that construction so the drawn face is the one the tracer couples
 *  through; keep the two in lockstep (see docs/introduce/fiber.md).
 *
 *  Returns a group in the fiber wrapper's local frame (body mm × mmToThree),
 *  or null when the ends lack the pose the slot needs — the same condition
 *  under which the backend declines to synthesize a slot at all. */
export function buildFiberCouplingMarkers(
  ends: { A: FiberEndParams | null | undefined; B: FiberEndParams | null | undefined },
  connectors: { A?: Asset3D; B?: Asset3D },
  fallbackTipMm: number,
): THREE.Group | null {
  const out = new THREE.Group();
  out.name = "optic-surface-markers";
  out.userData.isOpticSurfaceMarker = true;
  const unit = mmToThree(1);
  for (const end of ["A", "B"] as const) {
    const params = ends[end];
    if (!params) continue;
    const pos = vec3From(params.posMm);
    const tension = vec3From(params.tensionHandleMm);
    if (!pos || !tension || tension.lengthSq() < 1e-18) continue;
    // The ferrule faces AWAY from the wire: outward = −unit(tensionHandle),
    // and the optical face sits `tipMm` along it from the junction (posMm).
    const outward = tension.clone().normalize().multiplyScalar(-1);
    const { tipMm, apertureMm } = connectorTipAndAperture(
      connectors[end],
      fallbackTipMm,
      typeof params.apertureDiameterMm === "number" ? params.apertureDiameterMm : 0.125,
    );
    const group = new THREE.Group();
    group.name = `optic-surface-${end === "A" ? "intercept_in" : "intercept_out"}`;
    group.position.copy(pos).addScaledVector(outward, tipMm); // body-frame mm
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), outward);
    addTranslucentFace(group, new THREE.CircleGeometry(apertureMm, 40), 0xcbd5e1, 0xe2e8f0, 0.16);
    group.applyMatrix4(
      new THREE.Matrix4().compose(
        new THREE.Vector3(),
        new THREE.Quaternion(),
        new THREE.Vector3(unit, unit, unit),
      ),
    );
    out.add(group);
  }
  return out.children.length ? out : null;
}
