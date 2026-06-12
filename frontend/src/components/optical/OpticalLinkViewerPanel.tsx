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
import { beamColorForSource } from "../../three/opticalBeams";
import { gaussianWaistAtZ, type BeamState } from "../../three/rayTrace";
import { loadAssetObject } from "../../three/loadAsset";
import {
  buildSceneObjectFromBindings,
  shouldRenderViaBindings,
} from "../../three/bindingRendererGate";
import { applyObjectTransformWorld } from "../../three/transformUtils";
import { anchorObjectLocalAxisX, anchorObjectLocalPos } from "../../utils/anchorAccess";
import { mmToThree, labRootSwapInverseQuaternion, labRootSwapQuaternion } from "../../optical/frames";
import { polEllipseFromJones } from "../../optical/polarizationMarker";
import { VIEWER_BG_LIGHT, VIEWER_GRID_LINE, VIEWER_GRID_CENTER } from "../../three/viewerTheme";
import { domainForElementKind, kindIdToElementKind } from "../../utils/elementDefaults";
import { BeamScopeContents, beamWidthsUmAtPathMm, type SegmentBeamMode } from "./BeamScopePanel";
import { OpticalSettingPanel } from "../physics/OpticalSettingPanel";

const EMITTER_KINDS: ReadonlySet<string> = new Set([
  "laser_source",
  "tapered_amplifier",
]);

// Inline beam-scope panel sizing. The panel is collapsible and its expanded
// height is user-draggable (top grip); the chosen height persists per browser.
// Min is 0 so the grip can be dragged all the way down to fully retract the
// body (leaving just the grip + header), not only down to a fixed floor.
const SCOPE_MIN_H = 0;
const SCOPE_DEFAULT_H = 300;
const SCOPE_H_KEY = "qmem-beam-scope-h";
function loadScopeHeight(): number {
  try {
    const raw = window.localStorage.getItem(SCOPE_H_KEY);
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n) && n >= SCOPE_MIN_H) return n;
  } catch {
    // ignore
  }
  return SCOPE_DEFAULT_H;
}
function saveScopeHeight(h: number): void {
  try {
    window.localStorage.setItem(SCOPE_H_KEY, String(Math.round(h)));
  } catch {
    // ignore
  }
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
/** Build ONE optic-surface marker in the asset's body/mm frame, then bake
 *  `mw` (the owning mesh's matrixWorld — the SAME transform the wireframe
 *  edges are baked with) so the marker tracks the wireframe exactly,
 *  regardless of per-builder axis swaps or scale:
 *   - beam_splitter (PBS cube, IO-3/IO-5 glan) → translucent PINK
 *     reflective-coating quad at intercept_face (axisX = coating normal).
 *   - faraday_rotator → translucent AMBER disk at optical_center,
 *     perpendicular to the optical axis (the polarisation-rotation plane).
 *   - any other optic → translucent SLATE disk/rect at its primary optical
 *     anchor (optical_center / optical_anchor / intercept_face /
 *     interaction_center / intercept_in / intercept_out), ⊥ to the optical axis.
 *  Returns null only when the asset has no such optical anchor. */
function buildOpticSurfaceMarker(asset: Asset3D, mw: THREE.Matrix4): THREE.Group | null {
  const kind = asset.kindId;
  // beam_splitter / faraday_rotator keep their bespoke face; EVERY other optic
  // gets a generic translucent face at its primary optical anchor. Non-optical
  // kinds (no such anchor) fall through to null and draw nothing.
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
    // Prefer a known primary anchor id; otherwise fall back to the asset's
    // FIRST anchor so ANY anchor-bearing asset still gets a surface marker.
    // Requirement: a defined anchor must always be shown in the overlay.
    const order = [
      "optical_center", "optical_anchor", "intercept_face",
      "interaction_center", "intercept_in", "intercept_out",
    ];
    ancId = order.find(hasAnc) ?? (asset.anchors ?? [])[0]?.id ?? null;
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

  // Translucent fill + edge outline of a shared geometry (disk or rect).
  const addFace = (geom: THREE.BufferGeometry, fillHex: number, lineHex: number, opacity: number) => {
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
  };

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

  // Place via the owning mesh's WORLD translation + rotation, but force the
  // body-mm → three scale to mmToThree (1/100). The wireframe bakes the RAW
  // mesh.matrixWorld, whose scale differs by asset: STL geometry is authored
  // in mm so its matrixWorld carries the 1/100 unit scale, but procedural
  // prisms (IO-3 glans / Faraday rod) author geometry already in three units
  // so their matrixWorld scale is 1. Reusing that raw scale on a mm-built
  // marker blew the glan / faraday markers up ~100×; substituting the
  // canonical mm→three scale sizes every marker correctly regardless of how
  // its mesh was built.
  // Use the asset/binding root transform. Descendant meshes can include
  // renderer-internal correction rotations (for example the IO-3 Glan prism's
  // visible diagonal is rotated onto its physics plane); applying those again
  // would turn this body-local anchor marker 90deg away from the real surface.
  const mPos = new THREE.Vector3();
  const mQuat = new THREE.Quaternion();
  const mScale = new THREE.Vector3();
  mw.decompose(mPos, mQuat, mScale);
  const unit = mmToThree(1);
  group.applyMatrix4(new THREE.Matrix4().compose(mPos, mQuat, new THREE.Vector3(unit, unit, unit)));
  return group;
}

/** Walk a loaded wireframe-source tree and build optic-surface markers for
 *  every optic asset unit inside it. Resolves each
 *  mesh's owning asset — single-asset = `singleAsset`; binding tree =
 *  nearest `__bindingId` ancestor → ComponentBinding → Asset3D — and bakes
 *  the marker with that mesh's matrixWorld so composite optics (the IO-3
 *  glan coatings + Faraday rod) get markers too, not just the root asset.
 *  Returns null when no markers apply. */
function buildOpticSurfaceMarkers(
  loaded: THREE.Object3D,
  singleAsset: Asset3D | undefined,
  bindings: ReadonlyArray<{ id: string; asset3dId?: string | null }>,
  assetById: Map<string, Asset3D>,
): THREE.Group | null {
  const bindingById = new Map(bindings.map((b) => [b.id, b]));
  const units = new Map<string, { asset: Asset3D; mw: THREE.Matrix4 }>();
  loaded.traverse((node) => {
    const bid = (node.userData as { __bindingId?: string } | undefined)?.__bindingId;
    if (typeof bid !== "string" || units.has(bid)) return;
    const b = bindingById.get(bid);
    const asset = b?.asset3dId ? assetById.get(b.asset3dId) : undefined;
    if (asset) units.set(bid, { asset, mw: node.matrixWorld.clone() });
  });
  if (singleAsset && !units.has("__root__")) {
    units.set("__root__", { asset: singleAsset, mw: loaded.matrixWorld.clone() });
  }
  // Binding-based components (created via "+ New Component": asset3dId is
  // null so singleAsset is undefined, and a flat single binding isn't
  // __bindingId-tagged) still need their anchor shown. Resolve the bound
  // assets straight from the bindings and bake at the loaded root so the
  // marker appears regardless of how the mesh was loaded.
  if (units.size === 0) {
    for (const b of bindings) {
      if (!b.asset3dId || units.has(b.id)) continue;
      const a = assetById.get(b.asset3dId);
      if (a) units.set(b.id, { asset: a, mw: loaded.matrixWorld.clone() });
    }
  }
  const out = new THREE.Group();
  out.name = "optic-surface-markers";
  for (const { asset, mw } of units.values()) {
    const marker = buildOpticSurfaceMarker(asset, mw);
    if (marker) out.add(marker);
  }
  return out.children.length ? out : null;
}

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
  // Y-axis (qy) widths for the astigmatic elliptical tube; equal to X for a
  // circular beam.
  waistAtStartUmY: number;
  waistAtEndUmY: number;
  // Per-axis q-parameter Gaussian snapshot. Lets the 3D tube sample the true
  // analytic width along the segment (intra-segment focus) — same math as the
  // scope plot. Optional: legacy payloads without it fall back to endpoint lerp.
  beamMode?: SegmentBeamMode;
  powerFactorAtStart: number;
  nominalPowerMwAtSource?: number;
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

// Polarization helpers (beamLocalSPThree, polEllipseFromJones) live in the
// shared optical/polarizationMarker util so the Lab optical link and the PHY
// Editor COMPONENT preview interpret Jones identically. Imported at the top.

/** Camera state shared with the main viewer so the optical-link mode adopts
 *  the SAME view (position / orbit target / fov / up) instead of re-fitting to
 *  a default — switching into it no longer jerks the camera, and on the way out
 *  the (possibly orbited) view is handed back so the other modes continue from
 *  it. The optical-link scene draws beams in the same mmToThree(lab) world the
 *  main viewer uses, so the camera transfers 1:1. */
export type MainViewState = {
  position: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
  up: THREE.Vector3;
};

export function OpticalLinkViewerContent({
  active = true,
  getMainView,
  setMainView,
}: {
  active?: boolean;
  getMainView?: () => MainViewState | null;
  setMainView?: (position: THREE.Vector3, target: THREE.Vector3) => void;
} = {}) {
  // Rendered as the "optical-link" viewer display mode overlay
  // (DigitalTwinViewer). The mount DIV exists as soon as this component
  // mounts, so the Three.js setup effect creates the renderer immediately;
  // `active` (true while the mode is selected) drives the same re-fire
  // dependency the effect already had.
  const panelVisible = active;
  // Latest get/set held in refs so the [panelVisible] setup effect reads them
  // fresh without listing them as deps (which would re-create the renderer).
  const getMainViewRef = useRef(getMainView);
  getMainViewRef.current = getMainView;
  const setMainViewRef = useRef(setMainView);
  setMainViewRef.current = setMainView;
  const objects = useSceneStore((s) => s.scene.objects);
  const physicsElements = useSceneStore((s) => s.scene.physicsElements);
  const opticalLinks = useSceneStore((s) => s.scene.opticalLinks);
  const components = useSceneStore((s) => s.scene.components);
  const assets = useSceneStore((s) => s.scene.assets);
  const componentBindings = useSceneStore((s) => s.scene.componentBindings);
  const objectBindings = useSceneStore((s) => s.scene.objectBindings);
  const scopeProbe = useSceneStore((s) => s.scopeProbe);
  const setScopeProbe = useSceneStore((s) => s.setScopeProbe);

  // Right-sidebar object inspector: every OPTICAL scene object, selectable via
  // a dropdown → renders its PhysicsElementPanel inline (so the object physics
  // panel lives in the optical-link view, not just the component inspector).
  const opticalObjects = useMemo(() => {
    const compById = new Map(components.map((c) => [c.id, c]));
    const ekByObjectId = new Map(physicsElements.map((e) => [e.objectId, e.elementKind]));
    return objects
      .filter((o) => {
        // Element kind is authoritative on the PhysicsElement; fall back to the
        // component's kindId only for objects with no physics row. Keying off
        // the component alone dropped LASER_SOURCE0 — its component is typed
        // `none`, so its real `laser_source` kind lives only on the PE.
        const comp = compById.get(o.componentId);
        const ek = ekByObjectId.get(o.id) || kindIdToElementKind(comp?.kindId);
        if (ek) return domainForElementKind(ek) === "optical";
        // Composite optical components (e.g. the IO-3-850-HP isolator) carry
        // kindId="none" and have NO PhysicsElement, so `ek` is null — derive
        // optical-ness from their bound assets' kinds (domain is asset-kind-
        // authoritative, 2026-06-10; physicsCapabilities no longer decides
        // domain). Include them so their settings are reachable in the drawer.
        return (componentBindings ?? []).some((b) => {
          if (b.componentId !== o.componentId || b.targetKind !== "asset" || !b.asset3dId) return false;
          const a = assets.find((x) => x.id === b.asset3dId);
          const aek = a?.kindId ? kindIdToElementKind(a.kindId) : null;
          return aek != null && domainForElementKind(aek) === "optical";
        });
      })
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  }, [objects, components, physicsElements, componentBindings, assets]);
  const [inspectObjectId, setInspectObjectId] = useState<string | null>(null);
  // Inspector is a collapsible LEFT drawer — default collapsed so the 3D view
  // is clear. Clicking an optic in the scene (or the edge tab) opens it.
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Inline beam-scope panel: collapsible (header chevron) + vertically
  // resizable (top grip). Height lives in a ref and is written straight to the
  // body element during a drag so pointermove doesn't churn React at 60 fps —
  // same idiom as useResizablePanes / DualViewerSplit. Persisted per browser.
  const [scopeCollapsed, setScopeCollapsed] = useState(false);
  const scopeBodyRef = useRef<HTMLDivElement | null>(null);
  const scopeHeightRef = useRef<number>(loadScopeHeight());
  const startScopeResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startH = scopeHeightRef.current;
    const onMove = (move: PointerEvent) => {
      // The grip rides the panel's TOP edge; dragging up grows it downward.
      const next = Math.max(
        SCOPE_MIN_H,
        Math.min(startH + (startY - move.clientY), window.innerHeight * 0.8),
      );
      scopeHeightRef.current = next;
      if (scopeBodyRef.current) scopeBodyRef.current.style.height = `${next}px`;
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      saveScopeHeight(scopeHeightRef.current);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };
  // Follow the global scene selection: selecting a different optic anywhere
  // (3D viewer, object list, …) re-points the Optical-setting inspector at it,
  // so its intrinsic spec + tunable coefficients refresh for that object. Only
  // syncs when the selected object IS an optic (non-optical selections leave the
  // last inspected optic in place rather than blanking the drawer).
  const selectedObjectId = useSceneStore((s) => s.selectedObjectId);
  useEffect(() => {
    if (selectedObjectId && opticalObjects.some((o) => o.id === selectedObjectId)) {
      setInspectObjectId(selectedObjectId);
    }
  }, [selectedObjectId, opticalObjects]);

  // Keep the selection valid as the scene changes (default to the first optic).
  const effectiveInspectId =
    inspectObjectId && opticalObjects.some((o) => o.id === inspectObjectId)
      ? inspectObjectId
      : (opticalObjects[0]?.id ?? null);
  const inspectObject = opticalObjects.find((o) => o.id === effectiveInspectId) ?? null;
  const inspectComponent = inspectObject
    ? components.find((c) => c.id === inspectObject.componentId) ?? null
    : null;

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

  // `chainEmitterIds` is tick-maintained = the set of ALL emitters in the
  // scene (no per-emitter selection). The segment filter and the inline-scope
  // visibility check key off it, so it must reflect live trace data.
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
  const componentBindingsRef = useRef(componentBindings);
  const objectBindingsRef = useRef(objectBindings);
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
  componentBindingsRef.current = componentBindings;
  objectBindingsRef.current = objectBindings;
  tasFoldedIntoLaserRef.current = tasFoldedIntoLaser;
  setScopeProbeRef.current = setScopeProbe;
  setChainEmitterIdsRef.current = setChainEmitterIds;
  setTasFoldedIntoLaserRef.current = setTasFoldedIntoLaser;
  scopeProbeRef.current = scopeProbe;
  // Click-in-scene object selection writes the inspected object + opens the
  // drawer; held in refs so the [panelVisible] click handler reads them fresh.
  const setInspectObjectIdRef = useRef(setInspectObjectId);
  setInspectObjectIdRef.current = setInspectObjectId;
  const setDrawerOpenRef = useRef(setDrawerOpen);
  setDrawerOpenRef.current = setDrawerOpen;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(VIEWER_BG_LIGHT);
    // Gentle distance fog so the reference grid's far edges fade into the bg
    // (starts well beyond the bench content, which sits within ~20 units).
    scene.fog = new THREE.Fog(VIEWER_BG_LIGHT, 45, 150);

    const ambient = new THREE.AmbientLight(0xffffff, 0.75);
    scene.add(ambient);
    const dir = new THREE.DirectionalLight(0xffffff, 0.7);
    dir.position.set(5, 10, 7);
    scene.add(dir);

    // Subtle reference grid on the lab X-Y plane (the optical-table surface).
    // The scene is Z-up (lab content is pure-scale Z-up), so a default
    // GridHelper — which lies in the X-Z plane — must be rotated +90° about X
    // to lie flat on X-Y; without this it stands up as a vertical Z-X wall.
    // 1 three-unit = 100 mm; an 80-unit grid with 80 divisions gives 100 mm
    // cells. Muted lines + fog fade so it never fights the beam colours.
    const grid = new THREE.GridHelper(80, 80, VIEWER_GRID_CENTER, VIEWER_GRID_LINE);
    grid.rotation.x = Math.PI / 2;
    const gridMat = grid.material as THREE.LineBasicMaterial;
    gridMat.transparent = true;
    gridMat.opacity = 0.5;
    scene.add(grid);

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

    // Adopt the main viewer's camera so entering optical-link mode does NOT
    // jump to a fitted/default view — it stays exactly where the wireframe /
    // rendered modes left it (same world frame, so this transfers 1:1). When
    // adopted, the auto-fit below is suppressed.
    let cameraFromMain = false;
    const adoptedView = getMainViewRef.current?.();
    if (adoptedView) {
      camera.fov = adoptedView.fov;
      camera.up.copy(adoptedView.up);
      camera.position.copy(adoptedView.position);
      controls.target.copy(adoptedView.target);
      camera.lookAt(controls.target);
      camera.updateProjectionMatrix();
      controls.update();
      cameraFromMain = true;
    }

    const contentGroup = new THREE.Group();
    contentGroup.name = "optical-link-content";
    scene.add(contentGroup);
    // Beam tubes are added to a child group so the click raycaster can hit
    // ONLY them (anchor spheres / aperture rings on the same scene shouldn't
    // intercept a beam-segment probe click).
    const beamGroup = new THREE.Group();
    beamGroup.name = "beam-tubes";
    contentGroup.add(beamGroup);
    // Invisible per-object pick proxies (one box per beam-touched optic) live
    // in their own group so the selection raycaster hits ONLY them — clicking
    // an optic sets the inspected object without intercepting beam-segment
    // probe clicks (those raycast beamGroup, checked first).
    const pickGroup = new THREE.Group();
    pickGroup.name = "object-pick-proxies";
    contentGroup.add(pickGroup);

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
    //
    // `digest` tags each entry with the per-object override state it was
    // built from (objectBindings deltas for composite components). When
    // the live digest changes — eg. the user drags an isolator's front
    // glan-laser rotation slider — the lookup misses and the wireframe
    // is rebuilt with the new pose. Without this the panel would freeze
    // the wireframe at whatever rotations were active on first render.
    const wireframeCache = new Map<string, { digest: string; group: THREE.Group | "pending" }>();
    const wireframeDigest = (objectId: string): string => {
      const obs = objectBindingsRef.current ?? [];
      // Order-stable: a single objectId never has duplicate
      // componentBindingId rows. We hash every per-binding delta the
      // resolver could consume (XYZ translate + RxRyRz rotate +
      // asset override). Match resolveBindingTree's _effectiveTransform
      // — any field NOT covered here can cause stale wireframes.
      const parts: string[] = [];
      for (const ob of obs) {
        if (ob.objectId !== objectId) continue;
        parts.push(
          `${ob.componentBindingId}|` +
            `${ob.localXMmDelta},${ob.localYMmDelta},${ob.localZMmDelta},` +
            `${ob.localRxDegDelta},${ob.localRyDegDelta},${ob.localRzDegDelta}|` +
            `${ob.asset3dIdOverride ?? ""}`,
        );
      }
      return parts.join(";");
    };
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
      if (hits.length === 0) {
        // No beam under the cursor — treat it as an object pick. Among all
        // proxies under the ray, take the SMALLEST (most specific) so a small
        // optic inside a larger neighbour's loose AABB still wins.
        const picks = raycaster.intersectObjects(pickGroup.children, false);
        let picked: string | undefined;
        let bestVol = Infinity;
        for (const h of picks) {
          const ud = h.object.userData as { pickObjectId?: string; pickVolume?: number };
          const vol = ud.pickVolume ?? Infinity;
          if (ud.pickObjectId && vol < bestVol) {
            bestVol = vol;
            picked = ud.pickObjectId;
          }
        }
        if (picked) {
          setInspectObjectIdRef.current(picked);
          setDrawerOpenRef.current(true);
        }
        return;
      }
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

      // No per-emitter selection: show every emitter's beam chain at once.
      const chainIds = allEmitterIds;
      if (!sameSet(chainIds, chainEmitterIdsRef.current)) {
        chainEmitterIdsRef.current = chainIds;
        setChainEmitterIdsRef.current(chainIds);
      }

      // Beams: take EVERY v3 trace segment, exactly like the main viewer's
      // renderRayTraces (no per-emitter / chain filtering). chainIds is still
      // computed above for the folded-TA state + the warnings poll, but it no
      // longer gates what the panel draws.
      const segments = allSegments;

      // Per-instance objectBinding deltas feed into the wireframe
      // pose (Pass 3). Fold a digest of them into the content key so
      // an isolator-rotation edit invalidates `prevContentKey` and the
      // wireframe rebuilds — without this the rebuild short-circuits
      // (segments unchanged because the rotation doesn't bend the beam)
      // and the panel keeps drawing the prior pose.
      const obDigest = (objectBindingsRef.current ?? [])
        .map(
          (ob) =>
            `${ob.objectId}|${ob.componentBindingId}|` +
            `${ob.localXMmDelta},${ob.localYMmDelta},${ob.localZMmDelta},` +
            `${ob.localRxDegDelta},${ob.localRyDegDelta},${ob.localRzDegDelta}|` +
            `${ob.asset3dIdOverride ?? ""}`,
        )
        .join(";");
      // Per-source beam-colour overrides (SceneObject.properties.emissionVisuals)
      // are PURELY visual — they don't move/bend the beam, so the segment fields
      // above never change when the user recolours. Fold a colour digest into
      // the key so a recolour invalidates prevContentKey and the tube repaints
      // (else beamColorForSource's new colour would only show after the next
      // geometry-changing edit). Objects without an override contribute "".
      const colDigest = (objectsRef.current ?? [])
        .map((o) => {
          const ev = (o.properties?.emissionVisuals ?? null) as
            | Record<string, { colorHex?: string | null } | undefined>
            | null;
          if (!ev) return "";
          return `${o.id}:${ev.main?.colorHex ?? ""}/${ev.forward?.colorHex ?? ""}`;
        })
        .filter(Boolean)
        .join(";");
      // Render-logic version: the contentKey short-circuits rebuilds when the
      // segment DATA is unchanged — but it must ALSO bust when the rendering
      // LOGIC changes (e.g. the polarization s/p basis fix), or a hot-patched
      // viewer keeps drawing stale markers. Bump this tag whenever the beam /
      // marker drawing math changes so the next rebuild redraws everything.
      const RENDER_LOGIC_VERSION = "pol-projection-2026-06-12";
      const key = segments.length === 0
        ? `(none)|${obDigest}|col:${colDigest}|rv:${RENDER_LOGIC_VERSION}`
        : segments
            .map(
              (s) =>
                `${s.startThree.x},${s.startThree.y},${s.startThree.z}|` +
                `${s.endThree.x},${s.endThree.y},${s.endThree.z}|` +
                `${s.hitObjectId ?? ""}|${s.wavelengthNm}|` +
                `${s.waistAtStartUm.toFixed(3)}|${s.waistAtEndUm.toFixed(3)}|` +
                `${(s.waistAtStartUmY ?? 0).toFixed(3)}|${(s.waistAtEndUmY ?? 0).toFixed(3)}|` +
                `${(s.nominalPowerMwAtSource ?? 0).toFixed(6)}|` +
                `${s.powerFactorAtStart.toFixed(6)}|` +
                `${s.polarizationAtStart.map((v) => v.toFixed(6)).join(",")}`,
            )
            .join(";") + `|ob:${obDigest}|col:${colDigest}|rv:${RENDER_LOGIC_VERSION}`;
      if (key === prevContentKey) return;
      prevContentKey = key;

      // Wipe the previous content (beams + anchors + rings).
      while (contentGroup.children.length > 0) {
        const child = contentGroup.children.pop()!;
        if (child === beamGroup || child === pickGroup) continue; // keep containers alive
        disposeTree(child);
      }
      clearGroup(beamGroup);
      clearGroup(pickGroup);
      contentGroup.add(beamGroup);
      contentGroup.add(pickGroup);

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

      // Pass 2: build the beam tubes with Gaussian taper.
      for (const seg of segments) {
        const start = new THREE.Vector3(seg.startThree.x, seg.startThree.y, seg.startThree.z);
        const end = new THREE.Vector3(seg.endThree.x, seg.endThree.y, seg.endThree.z);
        const direction = new THREE.Vector3().subVectors(end, start);
        const length = direction.length();
        if (length < 1e-9) continue;
        direction.normalize();

        // Key on the EMITTER (laser/TA that originated the beam), stable down
        // the whole chain — see DigitalTwinViewer note. sourceObjectId is the
        // per-segment source optic and would only colour the first hop.
        const colour = beamColorForSource(
          objectById.get(seg.emitterObjectId),
          seg.wavelengthNm,
        );

        // Elliptical Gaussian taper: independent X (qx) and Y (qy) widths at
        // each end so an astigmatic beam renders an ELLIPTICAL tube (a
        // circular beam degenerates to the old round cylinder). Each axis is
        // floored independently so a micron waist stays visible.
        // µm → mm → Three units (1 unit = 100 mm) × the same VISUAL_BOOST the
        // main scene uses.
        const toScene = (um: number) =>
          mmToThree(Math.max(um, VISUAL_FLOOR_UM) / 1000) * VISUAL_BOOST;
        // Half-widths at axial fraction t ∈ [0,1] along the segment. With a
        // beamMode we sample the TRUE analytic Gaussian (same q-parameter math
        // as the scope plot) so a focus INSIDE the segment — e.g. just past a
        // lens — renders as a real pinch instead of the straight start→end cone
        // a 2-ring linear taper draws. Legacy payloads (no beamMode) fall back
        // to endpoint interpolation.
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
        // Local frame: +Y = beam axis, +X = beam-local s, +Z = beam-local p,
        // so the ellipse axes track the astigmatism axes (spatialModeX ∥ s).
        // (Convention; flip s/p if the major axis points the wrong way.)
        const sHat = new THREE.Vector3().crossVectors(direction, yAxis);
        if (sHat.lengthSq() < 1e-9) {
          sHat.crossVectors(direction, new THREE.Vector3(1, 0, 0));
        }
        sHat.normalize();
        const pHat = new THREE.Vector3().crossVectors(sHat, direction).normalize();
        const RING = 24;
        // Axial slices: one ring per slice so the hyperbolic taper / focus pinch
        // is resolved smoothly. 24 is cheap (beam tubes are few) yet smooth.
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
        const tubeGeom = new THREE.BufferGeometry();
        tubeGeom.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        tubeGeom.setIndex(idx);
        tubeGeom.computeVertexNormals();
        const tubeMat = new THREE.MeshBasicMaterial({
          color: colour,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.55,
        });
        const tube = new THREE.Mesh(tubeGeom, tubeMat);
        tube.position.copy(start).addScaledVector(direction, length / 2);
        // Orient local (X,Y,Z) → (sHat, direction, pHat) so the ellipse axes
        // align with the astigmatism axes (not an arbitrary roll).
        tube.quaternion.setFromRotationMatrix(
          new THREE.Matrix4().makeBasis(sHat, direction, pHat),
        );
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

        // Polarization mark at the segment MIDPOINT, ⊥ to the beam, from the
        // segment's Jones vector: a cyan double-headed arrow for LINEAR light,
        // the polarization ELLIPSE for elliptical, a CIRCLE for circular (plus
        // a small arrowhead showing the rotation sense). Skipped on dark beams.
        if (seg.powerFactorAtStart > 0.01) {
          const { u, v, minorFrac, handed } = polEllipseFromJones(seg.polarizationAtStart, direction);
          const mid = start.clone().addScaledVector(direction, length / 2);
          const polColor = 0x06b6d4; // cyan — matches the PHY editor's pol mark
          const polMat = new THREE.MeshBasicMaterial({
            color: polColor, depthTest: false, transparent: true, opacity: 0.95,
          });
          if (minorFrac < 0.08) {
            // LINEAR → double-headed arrow along the E-field axis (= u).
            const markLen = bboxSpan * 0.005;
            const markRad = Math.max(markLen * 0.05, bboxSpan * 0.00015);
            const headLen = markLen * 0.3;
            const headRad = markRad * 3.0;
            const shaft = new THREE.Mesh(
              new THREE.CylinderGeometry(markRad, markRad, markLen, 8), polMat,
            );
            shaft.quaternion.setFromUnitVectors(yAxis, u);
            shaft.position.copy(mid);
            shaft.renderOrder = 2100;
            contentGroup.add(shaft);
            for (const sign of [1, -1] as const) {
              const head = new THREE.Mesh(new THREE.ConeGeometry(headRad, headLen, 12), polMat);
              head.quaternion.setFromUnitVectors(yAxis, u.clone().multiplyScalar(sign));
              head.position.copy(mid).addScaledVector(u, sign * (markLen / 2 + headLen / 2));
              head.renderOrder = 2100;
              contentGroup.add(head);
            }
          } else {
            // ELLIPTICAL / CIRCULAR → draw the polarization ellipse loop
            // (minorFrac=1 → a circle) + a rotation-sense arrowhead.
            const semiMajor = bboxSpan * 0.0025;
            const semiMinor = semiMajor * minorFrac;
            const pts: THREE.Vector3[] = [];
            const N = 48;
            for (let i = 0; i <= N; i++) {
              const t = (i / N) * Math.PI * 2;
              pts.push(mid.clone()
                .addScaledVector(u, Math.cos(t) * semiMajor)
                .addScaledVector(v, Math.sin(t) * semiMinor * handed));
            }
            const loop = new THREE.Line(
              new THREE.BufferGeometry().setFromPoints(pts),
              new THREE.LineBasicMaterial({ color: polColor, transparent: true, opacity: 0.95, depthTest: false }),
            );
            loop.renderOrder = 2100;
            contentGroup.add(loop);
            const tA = Math.PI / 2;
            const pos = mid.clone()
              .addScaledVector(u, Math.cos(tA) * semiMajor)
              .addScaledVector(v, Math.sin(tA) * semiMinor * handed);
            const tangent = u.clone().multiplyScalar(-Math.sin(tA) * semiMajor)
              .add(v.clone().multiplyScalar(Math.cos(tA) * semiMinor * handed)).normalize();
            const head = new THREE.Mesh(new THREE.ConeGeometry(semiMajor * 0.16, semiMajor * 0.45, 10), polMat);
            head.quaternion.setFromUnitVectors(yAxis, tangent);
            head.position.copy(pos);
            head.renderOrder = 2100;
            contentGroup.add(head);
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
        const currentDigest = wireframeDigest(objectId);
        const cached = wireframeCache.get(objectId);
        if (cached && cached.group === "pending") continue;
        if (cached && cached.digest !== currentDigest) {
          // Stale entry — the user changed an objectBinding override
          // (e.g. rotated the front_glan_laser of an isolator). Drop
          // the cached wireframe so the load path below rebuilds with
          // the current pose.
          if (cached.group !== "pending") disposeTree(cached.group);
          wireframeCache.delete(objectId);
        }
        if (!wireframeCache.has(objectId)) {
          // Kick off an async load; the next tick after resolve will
          // see the cache hit and render. We mark "pending" so we don't
          // dispatch a second load for the same object meanwhile.
          wireframeCache.set(objectId, { digest: currentDigest, group: "pending" });
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
          // Composite components (e.g. IO-3-850-HP / IO-5-850-HP isolators
          // with front_glan_laser / front_piece / back_glan_laser /
          // back_piece children) load through the binding tree — same
          // gate the main scene uses. Routing them through the legacy
          // single-asset loader would only draw the root body and drop
          // every sub-Component / piece child.
          const bindings = componentBindingsRef.current ?? [];
          const useBindingTree = shouldRenderViaBindings(
            comp.kindId ?? "",
            comp.id,
            { componentBindings: bindings },
          );
          void (async () => {
            let loaded: THREE.Object3D;
            try {
              loaded = useBindingTree
                ? await buildSceneObjectFromBindings(comp, obj, {
                    componentBindings: bindings,
                    // Per-instance bindingOverrides (e.g. the user's
                    // front/back rotation adjustments on an isolator)
                    // live on objectBindings. resolveBindingTree reads
                    // them through scene.objectBindings; without this
                    // the wireframe ignores per-instance rotations and
                    // shows the catalog default pose.
                    objectBindings: objectBindingsRef.current ?? [],
                    assets: assetsRef.current,
                    components: componentsRef.current,
                  })
                : await loadAssetObject(
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
            // Frame airlock — mirror DigitalTwinViewer's loader normalization
            // (premultiply S⁻¹). Every loader emits geometry in three's Y-up
            // frame (g = S·b); de-swapping to the canonical Z-up body b here,
            // then composing the pose as S·M at use (below), makes this panel
            // render the SAME S·M·b orientation as Object Sense. Without it the
            // baked wireframe stayed S·b and applyObjectTransformWorld produced
            // the legacy M·S·b, which diverges from Object Sense whenever the
            // object has ry≠0 / rz≠0 (e.g. the IO-3 isolator at rz=90°).
            loaded.quaternion.premultiply(labRootSwapInverseQuaternion());
            loaded.updateMatrixWorld(true);
            const lineMat = new THREE.LineBasicMaterial({
              color: 0x64748b, // slate-500 — muted on the light bg, doesn't fight beam colours
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
            // Optic-surface markers: pink reflective-coating quads on the
            // PBS / IO-3 glan beam_splitters + an amber rotation-plane disk
            // on the Faraday rod. Walk the loaded tree (so composites loaded
            // through the binding tree get a marker per optic, not just the
            // root asset) and bake each marker with the asset/binding root's
            // matrixWorld — the SAME transform applied to the wireframe edges
            // above — so the marker tracks the drawn cube/prism exactly.
            const surfaceMarkers = buildOpticSurfaceMarkers(loaded, asset, bindings, assetById);
            if (surfaceMarkers) group.add(surfaceMarkers);
            disposeTree(loaded);
            if (disposed) {
              disposeTree(group);
              return;
            }
            wireframeCache.set(objectId, { digest: currentDigest, group });
            // Force the next rebuildContent to redraw even though the
            // segment-key is unchanged — the wireframes are now ready.
            prevContentKey = "";
          })();
          continue;
        }
        // Cache hit: shallow-clone so the cached prototype stays
        // untouched and we can apply the scene-object transform to the
        // clone. EdgesGeometry + LineBasicMaterial are shared by clone(true).
        const entry = wireframeCache.get(objectId)!;
        if (entry.group === "pending") continue;
        const wrapper = entry.group.clone(true);
        applyObjectTransformWorld(wrapper, obj);
        // Compose the world swap S OUTSIDE the pose M (→ S·M·b), matching
        // labRoot's order in Object Sense. applyObjectTransformWorld set the
        // quaternion to the bare pose M (the legacy leaf-swap order M·S·b); the
        // airlock above already de-swapped the geometry to b, so pre-multiplying
        // S here lands the model in the same orientation as the main viewer and
        // the beam segments (placed at labMmToThree = S·seg). Position is
        // unchanged (labMmToThree already bakes S).
        wrapper.quaternion.premultiply(labRootSwapQuaternion());
        contentGroup.add(wrapper);

        // Selection pick-proxy: an invisible (opacity 0) box covering the
        // wireframe's world bounds, tagged with the objectId. The selection
        // raycaster hits these so the user can click anywhere on/near an
        // optic to inspect it. Each dimension is floored to a small fraction
        // of the scene span so flat optics (a thin lens / waveplate) still
        // present a clickable thickness.
        wrapper.updateMatrixWorld(true);
        const pbox = new THREE.Box3().setFromObject(wrapper);
        if (!pbox.isEmpty()) {
          const psize = pbox.getSize(new THREE.Vector3());
          const pmin = bboxSpan * 0.01;
          const dx = Math.max(psize.x, pmin);
          const dy = Math.max(psize.y, pmin);
          const dz = Math.max(psize.z, pmin);
          const proxy = new THREE.Mesh(
            new THREE.BoxGeometry(dx, dy, dz),
            new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
          );
          proxy.position.copy(pbox.getCenter(new THREE.Vector3()));
          proxy.userData.pickObjectId = objectId;
          // Box volume — the click handler prefers the SMALLEST hit proxy so a
          // small optic whose loose AABB overlaps a larger neighbour's (e.g. a
          // lens sitting in front of the TA body, viewed end-on) still wins.
          proxy.userData.pickVolume = dx * dy * dz;
          pickGroup.add(proxy);
        }
      }

      lastBboxSpan = bboxSpan;

      // Camera fit — only when the bbox actually changed AND we didn't adopt
      // the main viewer's camera (adopting means "keep the current view").
      if (!cameraFromMain && !bbox.isEmpty()) {
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
      // Hand the (possibly orbited) view back to the main viewer so switching
      // out of optical-link continues from here — but only if we adopted it on
      // the way in (don't clobber the main camera with our auto-fit).
      if (cameraFromMain) {
        setMainViewRef.current?.(camera.position.clone(), controls.target.clone());
      }
      window.clearInterval(intervalId);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      controls.dispose();
      grid.geometry.dispose();
      gridMat.dispose();
      // Wireframe prototypes live outside contentGroup (they get cloned
      // in on each rebuild) so the traverse below misses them.
      for (const entry of wireframeCache.values()) {
        if (entry.group !== "pending") disposeTree(entry.group);
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
    <div style={{ display: "flex", flexDirection: "row", height: "100%", minHeight: 0, gap: 8 }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          gap: 8,
        }}
      >
        <div
          style={{
            flex: probeBelongsToChain ? 1.2 : 1,
            minHeight: 0,
            position: "relative",
            borderRadius: 4,
            overflow: "hidden",
            background: VIEWER_BG_LIGHT,
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
                color: "#6c706b",
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
              borderLeft: "2px solid #f59e0b",
              background: "rgba(250, 204, 21, 0.1)",
              color: "#7c5310",
              fontSize: 11,
            }}
          >
            <div style={{ color: "#b45309", fontWeight: 600, marginBottom: 4 }}>
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
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              marginTop: 2,
              borderRadius: 6,
              border: "1px solid rgba(56, 189, 248, 0.28)",
              borderTop: "2px solid rgba(14, 116, 110, 0.7)",
              background: "rgba(56, 189, 248, 0.08)",
              // BeamScopeContents was built for a light floating panel (dark
              // text); the overlay is now light too, so let it use its native
              // dark-on-light ink.
              color: "#242726",
            }}
          >
            {/* Top grip — drag up/down to resize (hidden while collapsed). */}
            {!scopeCollapsed && (
              <div
                onPointerDown={startScopeResize}
                title="Drag to resize"
                style={{
                  height: 9,
                  flexShrink: 0,
                  cursor: "ns-resize",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  touchAction: "none",
                }}
              >
                <div
                  style={{
                    width: 38,
                    height: 3,
                    borderRadius: 2,
                    background: "rgba(14, 116, 110, 0.55)",
                  }}
                />
              </div>
            )}
            {/* Header — title + collapse/expand toggle. */}
            <div
              onClick={() => setScopeCollapsed((c) => !c)}
              title={scopeCollapsed ? "Expand beam scope" : "Collapse beam scope"}
              style={{
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "2px 10px 4px",
                cursor: "pointer",
                userSelect: "none",
                fontSize: 11,
                fontWeight: 600,
                opacity: 0.85,
              }}
            >
              <span>Beam scope</span>
              <span style={{ fontSize: 12 }}>{scopeCollapsed ? "▸" : "▾"}</span>
            </div>
            {/* Body — drag-controlled height, scrolls internally. */}
            {!scopeCollapsed && (
              <div
                ref={scopeBodyRef}
                style={{
                  height: scopeHeightRef.current,
                  overflow: "auto",
                  padding: "0 10px 8px",
                }}
              >
                <BeamScopeContents />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Optical-setting inspector — collapsible LEFT drawer (order:-1). Default
          collapsed so the 3D view is clear; click an optic in the scene (or the
          edge tab) to open it. The tab rides the drawer's inner edge so it reads
          as a pull-handle. The rail is nudged down (marginTop) so it clears the
          floating .viewer-toolbar at the viewport's top-left rather than tucking
          under it; the top-RIGHT stays free for the orientation gizmo. */}
      <div style={{ order: -1, display: "flex", flexDirection: "row", minHeight: 0, flexShrink: 0, marginTop: 24 }}>
        {drawerOpen && (
          <div
            style={{
              width: 340,
              minHeight: 0,
              overflow: "auto",
              padding: "8px 10px",
              borderRadius: 4,
              background: "#fbfbf8",
              border: "1px solid #d8ded8",
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 6 }}>
              <span style={{ fontSize: 11, opacity: 0.7, color: "#242726" }}>Optical setting</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#242726" }}>
                {inspectObject?.name ?? "—"}
              </span>
            </div>
            {inspectObject && inspectComponent ? (
              <OpticalSettingPanel component={inspectComponent} sceneObject={inspectObject} />
            ) : (
              <p style={{ color: "#6c706b", fontSize: 12 }}>
                Click an optical element in the scene to edit its physics.
              </p>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={() => setDrawerOpen((o) => !o)}
          title={drawerOpen ? "Collapse optical setting" : "Optical setting"}
          style={{
            width: 22,
            flexShrink: 0,
            alignSelf: "stretch",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            border: "1px solid #d8ded8",
            borderRadius: 4,
            background: "#fbfbf8",
            color: "#445",
            cursor: "pointer",
            padding: "8px 0",
          }}
        >
          <span style={{ fontSize: 12 }}>{drawerOpen ? "‹" : "›"}</span>
          {!drawerOpen && (
            <span style={{ writingMode: "vertical-rl", fontSize: 10, opacity: 0.75, letterSpacing: 1 }}>
              Optical setting
            </span>
          )}
        </button>
      </div>
    </div>
  );
}
