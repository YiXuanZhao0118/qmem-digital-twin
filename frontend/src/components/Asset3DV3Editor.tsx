/**
 * Asset3D v3 Catalog Editor.
 *
 * Edits the v3 optical metadata that drives face hit detection and
 * transition dispatch:
 *   - faces: body-local position, normal, aperture size/shape
 *   - transitions: face-in -> face-out op calls plus params/matrices
 *   - defaultParams: kind-level optical constants used by PhysicsOps
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Edit3, Eye, EyeOff, Plus, RefreshCw, Save, Trash2, Upload, X } from "lucide-react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

import { resolveAssetUrl } from "../api/client";
import { useKindsStore } from "../store/kindsStore";
import {
  type V3Asset,
  type V3AssetUpdate,
  type V3Face,
  type V3FaceDomain,
  type V3Transition,
  type V3Vec3,
  useV3Catalog,
} from "../store/v3CatalogStore";
import { applyDeletionFilter, applyIncludeOnlyFilter, applyViewerHintsToGeometry, centroidKey, findCoplanarCluster } from "../three/loadAsset/viewerHints";
import type { AssetViewerHints } from "../types/digitalTwin";
import {
  domainForElementKind,
  type ElementDomain,
} from "../utils/elementDefaults";
import type { ElementKind } from "../types/digitalTwin";

const stlLoader = new STLLoader();
const gltfLoader = new GLTFLoader();
const objLoader = new OBJLoader();

type DraftFace = {
  id: string;
  px: string;
  py: string;
  pz: string;
  hasNormal: boolean;
  nx: string;
  ny: string;
  nz: string;
  apertureMm: string;
  apertureShape: V3Face["apertureShape"];
  apertureWidthMm: string;
  apertureHeightMm: string;
  domain: V3FaceDomain;                 // "optical" | "rf" | "ttl"; rows written
                                        // before this field defaulted to "optical"
                                        // via draftFromAsset()
};

type DraftTransition = {
  in: string;
  /** Internal face chain for multi-hop reflective ops (B1, B2, ...).
   *  Stored as comma-separated text in the UI; round-tripped to string[]
   *  via JSON in draftFromAsset / draftToPatch. Empty = 2-port slab. */
  viaText: string;
  outText: string;
  op: string;
  paramsText: string;
  matrix5x5Text: string;
  abcdText: string;
};

type AssetDraft = {
  kindId: string;
  wavelengthMinNm: string;
  wavelengthMaxNm: string;
  // bodyFrameRotation is locked to null at Asset3D level (Phase 9.10) ??  // body frame +Z is the optical axis, X/Y are the polarization basis,
  // and orientation is fixed. The field stays in the draft so existing
  // rows round-trip cleanly to null on save.
  bodyFrameRotation: { x: number; y: number; z: number; w: number } | null;
  // Body frame origin in CAD-frame coordinates (mm). Empty strings ??  // no offset (CAD origin == body origin). Persisted via
  // properties.bodyFramePositionMm so no DB schema change is required.
  bodyFramePositionMmX: string;
  bodyFramePositionMmY: string;
  bodyFramePositionMmZ: string;
  // Snapshot of asset.properties so we can merge our bodyFramePositionMm
  // edit back without clobbering other keys.
  properties: Record<string, unknown>;
  faces: DraftFace[];
  transitions: DraftTransition[];
  defaultParamsText: string;
};

type NewAssetModalState = {
  open: boolean;
  sourceCatalogId: string;
  catalogId: string;
  name: string;
  file: File | null;
  precisionPreset: "preview" | "standard" | "high";
  preserveColors: boolean;
  unit: "mm" | "m";
  scaleFactor: string;
};

type KindGuide = {
  kind: string;
  faces: string;
  transitions: string;
  params: string[];
  matrix: string;
};

const KIND_GUIDES: KindGuide[] = [
  {
    kind: "laser_source",
    faces: "Use one output face named out. Its normalBodyLocal is the emitted beam direction; body +z is the default optical axis.",
    transitions: "out -> out, op=emit_laser_source. This marks the asset as a scene emitter rather than a passive surface.",
    params: ["centerWavelengthNm", "spectrum.centerWavelengthNm", "nominalPowerMw", "spatialModeX/Y.waistUm", "spatialModeX/Y.waistZOffsetMm", "polarization"],
    matrix: "Creates the initial BeamRay: origin=out face, direction=out normal, q from waist params, Jones from polarization.",
  },
  {
    kind: "lens",
    faces: "A/B on the two optical surfaces. Move z to match half thickness; apertureMm is the clear radius/half-width used by hit checks.",
    transitions: "A -> B and B -> A, op=abcd_thin_lens.",
    params: ["focalLengthMm", "refractiveIndex", "arResidualR"],
    matrix: "Thin lens: q_out = q/(1 - q/f); chief ray uses the 5x5 lens matrix when decenter/tilt is present.",
  },
  {
    kind: "mirror",
    faces: "Usually one front face A. normalBodyLocal is the reflective surface normal.",
    transitions: "A -> A, op=reflect_specular.",
    params: ["reflectivity", "coating", "radiusMm or focalLengthMm for curved mirrors when used"],
    matrix: "Flat mirror leaves q unchanged in unfolded frame; curved mirror uses f=R/2.",
  },
  {
    kind: "pbs",
    faces: "Cube faces: back/front/left/right. Face normals point outward from the cube.",
    transitions: "Each input face normally has two transitions: p-transmit and s-reflect.",
    params: ["cubeSizeMm", "refractiveIndex", "extinctionRatioPpDb", "extinctionRatioSpDb", "plateAlphaXRad/YRad", "coatingAlphaXRad/YRad", "reflectionFraction"],
    matrix: "Reflect arm uses advanced splitter mode: glass pre-path -> coating mirror -> glass post-path; q_out=q+L/n.",
  },
  {
    kind: "dichroic_mirror",
    faces: "A input, Bt transmitted output, Br reflected output. For real mounts, split Br onto the reflected physical face.",
    transitions: "A -> Bt op=dichroic_transmit and A -> Br op=dichroic_reflect.",
    params: ["cutoffWavelengthNm", "isShortPass", "transitionWidthNm", "substrateThicknessMm", "refractiveIndex", "plateAlphaXRad/YRad", "coatingAlphaXRad/YRad"],
    matrix: "Transmit is slab; reflect should use the same advanced splitter convention as PBS reflect.",
  },
  {
    kind: "aom",
    faces: "Use physical optical faces A/B. RF is not a face; it is rfPropagationDirectionBodyLocal.",
    transitions: "A -> B and B -> A, op=diffract_aom. Put order/side/frequency behavior in transition params and dynamic RF sources.",
    params: ["centerFreqMhz", "acousticVelocityMps", "refractiveIndex", "crystalLengthMm", "baseEfficiency", "modulationBandwidthMhz", "rfPropagationDirectionBodyLocal", "requiresRfDrive"],
    matrix: "Slab q propagation plus RF-direction Bragg angle kick. rfPropagationDirectionBodyLocal must be perpendicular to A->B.",
  },
  {
    kind: "waveplate",
    faces: "Use physical optical faces A/B.",
    transitions: "A -> B and B -> A, op=jones_waveplate. The Jones matrix is reciprocal, so both directions use the same op.",
    params: [
      "designWavelengthNm",
      "wavelengthRangeNm",
      "retardanceLambda",
      "retardanceDeg",
      "fastAxisDegBeamLocal",
      "lengthMm",
      "thicknessMm",
      "refractiveIndex",
      "clearApertureMm",
      "transmission",
      "material",
    ],
    matrix: "Spatially a slab: q_out=q+L/n. Jones retardance is separate from ABCD.",
  },
  {
    kind: "polarizer",
    faces: "Use physical optical faces A/B for two-port polarizers; add extra physical faces only for real rejected-beam ports.",
    transitions: "A -> B and B -> A with jones_polarizer or jones_glan_laser_calcite. Extra branches are explicit transitions to extra physical faces.",
    params: ["transmissionAxisDegBodyLocal", "extinctionRatioPpDb", "extinctionRatioSpDb", "lengthMm", "B_x_mm", "B_y_mm"],
    matrix: "Film polarizer can be Jones-only; thick prism polarizers should carry slab or astigmatic 5x5 Bx/By.",
  },
  {
    kind: "faraday_rotator",
    faces: "Use physical optical faces A/B.",
    transitions: "A -> B and B -> A both use op=faraday_rotate; reverse does not undo rotation because the op is non-reciprocal.",
    params: ["rotationDeg", "reciprocal", "lengthMm", "refractiveIndex", "VerdetConstantRadPerTeslaMm", "material"],
    matrix: "Spatially a slab: q_out=q+L/n. Jones rotation stays non-reciprocal.",
  },
  {
    kind: "fiber",
    faces: "Not seeded in v3 yet. Define input/output connector faces at the ferrules or fiber endpoints.",
    transitions: "Use a future fiber coupling/propagation op; for now keep it explicit in transitions when added.",
    params: ["modeFieldDiameterUm", "na", "lengthMm", "coreIndex", "claddingIndex", "couplingEfficiency"],
    matrix: "Gaussian mode matching is not just ABCD; keep mode/coupling params in defaultParams.",
  },
  {
    kind: "fiber_coupler",
    faces: "Define free-space input face plus fiber output face; normal directions should match launch/exit directions.",
    transitions: "Use coupling transitions once registered; keep A -> fiber_out naming stable.",
    params: ["focalLengthMm", "modeFieldDiameterUm", "workingDistanceMm", "na", "couplingEfficiency"],
    matrix: "Lens-like focusing plus mode overlap; q handling needs both ABCD and fiber mode overlap.",
  },
  // ????????????????????????????????????????????????????????????????????????
  // RF kinds (asset-physics-model.md §8.7-§8.12). Faces carry domain="rf"
  // or domain="ttl"; the RF tracer (§7.5) walks a port-adjacency graph
  // instead of doing ray-plane intersection, so apertureMm is unused.
  // ????????????????????????????????????????????????????????????????????????
  {
    kind: "rf_source",
    faces: "One rf_out per channel (AD9959: CH0..CH3). domain=\"rf\". normalBodyLocal = SMA connector outward direction. apertureMm = 0.",
    transitions: "rf_out -> rf_out, op=emit_rf_source. Reads dynamicSources.channels[anchorName] for per-channel frequency + amplitudeScale.",
    params: ["referenceClockMhz", "sysClockMhz", "pllMultiplier", "pllBypass", "serialInterface", "syncRole", "serialPortMode"],
    matrix: "Emitter ??no ABCD. RfSignalState seeded from dynamicSources (Vpp = amplitudeScale ? AD9959_VPP_FULL_SCALE).",
  },
  {
    kind: "rf_amplifier",
    faces: "rf_in (inward SMA) and rf_out (outward SMA), both domain=\"rf\". apertureMm = 0.",
    transitions: "rf_in -> rf_out, op=rf_amplify. Single-direction passthrough.",
    params: ["gainDb", "frequencyRangeMhz", "outputPowerP1dbDbm", "outputPowerMaxDbm", "inputPowerMaxDbm", "noiseFigureDb", "supplyVoltageV", "connectorType"],
    matrix: "RF op: vpp_out = vpp_in ? 10^(gainDb/20), clamped at outputPowerMaxDbm (sets saturated flag). Power gate -> null (signal terminates).",
  },
  {
    kind: "rf_cable",
    faces: "rf_in (end A) and rf_out (end B), both domain=\"rf\". endAConnector / endBConnector may differ (adapter cables).",
    transitions: "rf_in -> rf_out AND rf_out -> rf_in, both op=rf_pass. Bidirectional; current op is identity.",
    params: ["lengthMm", "impedanceOhm", "maxFrequencyGhz", "connectorType", "endAConnector", "endBConnector", "cableType", "jacketColor"],
    matrix: "No matrix. Future: vpp ? 10^(-lossDbPerM ? lengthMm / 1000 / 20). Endpoints stored in SceneObject.properties.rfCableEndpoints, NOT in rf_links.",
  },
  {
    kind: "rf_switch",
    faces: "rf_in (RFIN common, domain=\"rf\"), N x rf_out throws (RF1, RF2, ... ??share id, different anchor.name), ttl_in (domain=\"ttl\").",
    transitions: "rf_in -> [rf_out:RF1, rf_out:RF2, ...], op=rf_switch_route. Only one throw active per call; TTL state pre-resolved from PPG peer.",
    params: ["switchType", "throwCount", "frequencyMinGhz", "frequencyMaxGhz", "insertionLossDb", "isolationDb", "ttlActiveHighThrow", "ttlState"],
    matrix: "Active path: vpp ? 10^(-insertionLossDb/20). LOW state on SP4T+ returns [] (no active path). Power gate -> null.",
  },
  {
    kind: "programmable_pulse_generator",
    faces: "One rf_out face with domain=\"ttl\" (NOT \"rf\" ??face id is historical; the line carries TTL/Trigger digital).",
    transitions: "rf_out -> rf_out, op=emit_ttl_steady. Reads TimingProgram.rest_state for steady-state HIGH/LOW level.",
    params: ["connectorType", "timingProgramId", "outputDomain", "highVoltageV"],
    matrix: "Emitter ??no ABCD. Solver only sees steady-state idle level; pulse train timeline is scrub-UI only.",
  },
  {
    kind: "horn_antenna",
    faces: "Optional aperture face with domain=\"rf\". Position = lobe origin, normalBodyLocal = main-beam axis.",
    transitions: "No transitions ??horn is an RF sink. signalAtPort[(horn, aperture)] is the terminating signal (UI can display received power).",
    params: ["frequencyGhz", "gainDbi", "beamwidth3dbDeg", "polarAxisBodyLocal", "cosineExponent"],
    matrix: "No matrix. Phase RF.7 will add cos^n lobe visualization and optional Palace farfield S-parameter import.",
  },
];

const SECTION_LABEL: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "#6b7280",
  marginTop: 12,
  marginBottom: 6,
};

const TABLE: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontFamily: "ui-monospace, monospace",
  fontSize: 11,
};

const TH: CSSProperties = {
  textAlign: "left",
  padding: "4px 6px",
  borderBottom: "1px solid #d8ded8",
  color: "#6b7280",
  fontWeight: 600,
};

const TD: CSSProperties = {
  padding: "4px 6px",
  borderBottom: "1px solid #e9ece9",
  fontFamily: "ui-monospace, monospace",
  fontSize: 11,
  color: "#1f2937",
  verticalAlign: "top",
};

const INPUT: CSSProperties = {
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  background: "#ffffff",
  color: "#1f2937",
  border: "1px solid #d8ded8",
  padding: "4px 5px",
  fontFamily: "ui-monospace, monospace",
  fontSize: 11,
};

const TEXTAREA: CSSProperties = {
  ...INPUT,
  resize: "vertical",
  minHeight: 54,
  lineHeight: 1.35,
};

const ICON_BUTTON: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  border: "1px solid #d8ded8",
  background: "#ffffff",
  color: "#1f2937",
  cursor: "pointer",
};

function n(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

function vec3Str(v?: V3Vec3 | null): string {
  if (!v) return "-";
  return `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
}

function jsonText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

function slugFromFilename(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "");
  const slug = stem
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "uploaded_asset";
}

function displayNameFromFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Uploaded Asset3D";
}

function draftFromAsset(asset: V3Asset): AssetDraft {
  const props = (asset.properties ?? {}) as Record<string, unknown>;
  const pos = (props.bodyFramePositionMm ?? null) as
    | { x?: number; y?: number; z?: number }
    | null;
  return {
    kindId: asset.kindId ?? "",
    wavelengthMinNm: n(asset.wavelengthRangeNm?.[0]),
    wavelengthMaxNm: n(asset.wavelengthRangeNm?.[1]),
    bodyFrameRotation: asset.bodyFrameRotation ?? null,
    bodyFramePositionMmX: n(pos?.x),
    bodyFramePositionMmY: n(pos?.y),
    bodyFramePositionMmZ: n(pos?.z),
    properties: props,
    faces: (asset.faces ?? []).map((face) => ({
      id: face.id,
      px: n(face.positionMmBodyLocal.x),
      py: n(face.positionMmBodyLocal.y),
      pz: n(face.positionMmBodyLocal.z),
      hasNormal: !!face.normalBodyLocal,
      nx: n(face.normalBodyLocal?.x),
      ny: n(face.normalBodyLocal?.y),
      nz: n(face.normalBodyLocal?.z),
      apertureMm: n(face.apertureMm),
      apertureShape: face.apertureShape,
      apertureWidthMm: n(face.apertureWidthMm),
      apertureHeightMm: n(face.apertureHeightMm),
      domain: (face.domain ?? "optical") as V3FaceDomain,
    })),
    transitions: (asset.transitions ?? []).map((transition) => ({
      in: transition.in,
      viaText: (transition.via ?? []).join(", "),
      outText: Array.isArray(transition.out) ? transition.out.join(", ") : transition.out,
      op: transition.op,
      paramsText: jsonText(transition.params),
      matrix5x5Text: jsonText(transition.matrix5x5),
      abcdText: jsonText(transition.abcd),
    })),
    defaultParamsText: jsonText(asset.defaultParams ?? {}),
  };
}

function readNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a finite number`);
  }
  return parsed;
}

function readOptionalNumber(value: string, label: string): number | null {
  if (value.trim() === "") return null;
  return readNumber(value, label);
}

function readJsonObject(text: string, label: string): Record<string, unknown> {
  const parsed = text.trim() ? JSON.parse(text) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function readOptionalJson<T>(text: string, label: string): T | undefined {
  if (text.trim() === "") return undefined;
  const parsed = JSON.parse(text) as T | null;
  if (parsed === null) return undefined;
  if (label === "matrix5x5" && !Array.isArray(parsed)) {
    throw new Error("matrix5x5 must be a JSON array");
  }
  if (label === "abcd" && !Array.isArray(parsed)) {
    throw new Error("abcd must be a JSON array");
  }
  return parsed;
}

function readDraftNumber(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Outline (ring/border) for an aperture. Half-extents (w/2, h/2) define
 *  the outer edge; `thickness` is the visible border width. */
function _makeApertureOutlineGeometry(
  shape: "circle" | "ellipse" | "rectangle",
  w: number,
  h: number,
  thickness: number,
): THREE.ShapeGeometry {
  const halfW = Math.max(w / 2, 1e-6);
  const halfH = Math.max(h / 2, 1e-6);
  const innerHalfW = Math.max(halfW - thickness, 0);
  const innerHalfH = Math.max(halfH - thickness, 0);
  const outline = new THREE.Shape();
  if (shape === "rectangle") {
    outline.moveTo(-halfW, -halfH);
    outline.lineTo(halfW, -halfH);
    outline.lineTo(halfW, halfH);
    outline.lineTo(-halfW, halfH);
    outline.lineTo(-halfW, -halfH);
    if (innerHalfW > 0 && innerHalfH > 0) {
      const hole = new THREE.Path();
      hole.moveTo(-innerHalfW, -innerHalfH);
      hole.lineTo(innerHalfW, -innerHalfH);
      hole.lineTo(innerHalfW, innerHalfH);
      hole.lineTo(-innerHalfW, innerHalfH);
      hole.lineTo(-innerHalfW, -innerHalfH);
      outline.holes.push(hole);
    }
  } else {
    // ellipse and circle both use parametric ellipse; circle = halfW == halfH.
    outline.ellipse(0, 0, halfW, halfH, 0, Math.PI * 2, false, 0);
    if (innerHalfW > 0 && innerHalfH > 0) {
      const hole = new THREE.Path();
      hole.ellipse(0, 0, innerHalfW, innerHalfH, 0, Math.PI * 2, true, 0);
      outline.holes.push(hole);
    }
  }
  return new THREE.ShapeGeometry(outline, 48);
}

/** Filled aperture surface (used for the translucent disk inside internal
 *  B* faces). */
function _makeApertureFillGeometry(
  shape: "circle" | "ellipse" | "rectangle",
  w: number,
  h: number,
): THREE.BufferGeometry {
  if (shape === "rectangle") return new THREE.PlaneGeometry(w, h);
  const geo = new THREE.CircleGeometry(0.5, 48);
  geo.scale(w, h, 1);
  return geo;
}

function facePosition(face: DraftFace): THREE.Vector3 | null {
  const x = readDraftNumber(face.px);
  const y = readDraftNumber(face.py);
  const z = readDraftNumber(face.pz);
  if (x === null || y === null || z === null) return null;
  return new THREE.Vector3(x, y, z);
}

function faceNormal(face: DraftFace): THREE.Vector3 {
  if (!face.hasNormal) return new THREE.Vector3(0, 0, 1);
  const x = readDraftNumber(face.nx) ?? 0;
  const y = readDraftNumber(face.ny) ?? 0;
  const z = readDraftNumber(face.nz) ?? 1;
  const normal = new THREE.Vector3(x, y, z);
  return normal.lengthSq() > 1e-12 ? normal.normalize() : new THREE.Vector3(0, 0, 1);
}

function mmText(value: number): string {
  return Number(value.toFixed(3)).toString();
}

/**
 * Flood-fill connected coplanar triangles starting from a raycaster hit, then
 * return the boundary-loop centroid + averaged normal of that region.
 *
 * Boundary-loop centroid: for flat patches this is the geometric centre; for
 * curved patches bounded by a closed edge loop (e.g. a lens dome rim) this is
 * the centre of that rim ??exactly what "click face -> position to centre"
 * should mean for both flat and round optical surfaces.
 */
function detectFaceCenterFromHit(
  hit: THREE.Intersection,
  options: { angleToleranceDeg?: number; vertexEpsilon?: number } = {},
): { center: THREE.Vector3; normal: THREE.Vector3; regionVertices: Float32Array } | null {
  const mesh = hit.object as THREE.Mesh;
  if (!(mesh.geometry instanceof THREE.BufferGeometry)) return null;
  if (!hit.face) return null;
  const positionAttr = mesh.geometry.getAttribute("position");
  if (!positionAttr) return null;

  const indexAttr = mesh.geometry.index;
  const triCount = indexAttr ? indexAttr.count / 3 : positionAttr.count / 3;
  if (triCount === 0) return null;

  const startTri =
    typeof hit.faceIndex === "number"
      ? hit.faceIndex
      : Math.floor((hit.face.a ?? 0) / 3);

  const angleTol = (options.angleToleranceDeg ?? 4) * (Math.PI / 180);
  const cosTol = Math.cos(angleTol);

  const matrixWorld = mesh.matrixWorld;

  // Triangle vertex indices in the geometry buffer.
  const vi = (tri: number, corner: 0 | 1 | 2): number =>
    indexAttr ? indexAttr.getX(tri * 3 + corner) : tri * 3 + corner;

  // World-space vertex fetch into a scratch vector.
  const readVertex = (target: THREE.Vector3, vertIdx: number): void => {
    target.fromBufferAttribute(positionAttr, vertIdx);
    target.applyMatrix4(matrixWorld);
  };

  // Quantise positions so triangles that share a vertex (but differ at FP
  // noise level) still register as connected. Epsilon defaults to 1e-4 of the
  // bounding box max dimension or 1e-4 absolute, whichever is larger.
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  const bboxSize = mesh.geometry.boundingBox!.getSize(new THREE.Vector3());
  const scale = Math.max(bboxSize.x, bboxSize.y, bboxSize.z, 1);
  const eps = options.vertexEpsilon ?? scale * 1e-4;
  const quantize = (v: number) => Math.round(v / eps);
  const vertexKey = (v: THREE.Vector3) =>
    `${quantize(v.x)},${quantize(v.y)},${quantize(v.z)}`;

  // Build per-vertex-key -> triangle list (adjacency via shared corner).
  const vertexToTris = new Map<string, number[]>();
  const triVertKeys: [string, string, string][] = new Array(triCount);
  const triNormals: THREE.Vector3[] = new Array(triCount);
  const triCentroids: THREE.Vector3[] = new Array(triCount);
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    readVertex(v0, vi(t, 0));
    readVertex(v1, vi(t, 1));
    readVertex(v2, vi(t, 2));
    edge1.subVectors(v1, v0);
    edge2.subVectors(v2, v0);
    const n = new THREE.Vector3().crossVectors(edge1, edge2);
    if (n.lengthSq() < 1e-20) {
      triNormals[t] = new THREE.Vector3(0, 0, 1);
      triCentroids[t] = new THREE.Vector3();
      triVertKeys[t] = ["", "", ""];
      continue;
    }
    triNormals[t] = n.normalize();
    triCentroids[t] = new THREE.Vector3(
      (v0.x + v1.x + v2.x) / 3,
      (v0.y + v1.y + v2.y) / 3,
      (v0.z + v1.z + v2.z) / 3,
    );
    const k0 = vertexKey(v0);
    const k1 = vertexKey(v1);
    const k2 = vertexKey(v2);
    triVertKeys[t] = [k0, k1, k2];
    for (const k of [k0, k1, k2]) {
      const list = vertexToTris.get(k);
      if (list) list.push(t);
      else vertexToTris.set(k, [t]);
    }
  }

  // Flood fill from startTri through neighbours whose normal is close enough.
  const seedNormal = triNormals[startTri];
  if (!seedNormal) return null;
  const inRegion = new Uint8Array(triCount);
  const queue: number[] = [startTri];
  inRegion[startTri] = 1;
  while (queue.length > 0) {
    const t = queue.pop()!;
    const keys = triVertKeys[t];
    for (const k of keys) {
      const neighbours = vertexToTris.get(k);
      if (!neighbours) continue;
      for (const n of neighbours) {
        if (inRegion[n]) continue;
        if (triNormals[n].dot(seedNormal) < cosTol) continue;
        inRegion[n] = 1;
        queue.push(n);
      }
    }
  }

  // Compute the boundary loop: edges of region triangles that aren't shared by
  // another region triangle. Boundary vertices are the unique endpoints of
  // those edges, deduplicated by quantised key.
  const edgeCount = new Map<string, number>();
  const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (let t = 0; t < triCount; t++) {
    if (!inRegion[t]) continue;
    const [ka, kb, kc] = triVertKeys[t];
    for (const [a, b] of [[ka, kb], [kb, kc], [kc, ka]] as const) {
      const key = edgeKey(a, b);
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
    }
  }
  const boundaryVerts = new Map<string, THREE.Vector3>();
  for (let t = 0; t < triCount; t++) {
    if (!inRegion[t]) continue;
    const [ka, kb, kc] = triVertKeys[t];
    const edges: [string, string, 0 | 1 | 2, 0 | 1 | 2][] = [
      [ka, kb, 0, 1],
      [kb, kc, 1, 2],
      [kc, ka, 2, 0],
    ];
    for (const [a, b, ai, bi] of edges) {
      const key = edgeKey(a, b);
      if ((edgeCount.get(key) ?? 0) === 1) {
        if (!boundaryVerts.has(a)) {
          const target = new THREE.Vector3();
          readVertex(target, vi(t, ai));
          boundaryVerts.set(a, target);
        }
        if (!boundaryVerts.has(b)) {
          const target = new THREE.Vector3();
          readVertex(target, vi(t, bi));
          boundaryVerts.set(b, target);
        }
      }
    }
  }

  const center = new THREE.Vector3();
  if (boundaryVerts.size > 0) {
    for (const p of boundaryVerts.values()) center.add(p);
    center.divideScalar(boundaryVerts.size);
  } else {
    // Fully closed region (e.g. whole sphere) ??fall back to centroid average.
    let count = 0;
    for (let t = 0; t < triCount; t++) {
      if (!inRegion[t]) continue;
      center.add(triCentroids[t]);
      count++;
    }
    if (count === 0) return null;
    center.divideScalar(count);
  }

  // Averaged outward normal across the region (already direction-coherent
  // because we only added triangles with positive dot to the seed).
  const normal = new THREE.Vector3();
  let regionCount = 0;
  for (let t = 0; t < triCount; t++) {
    if (!inRegion[t]) continue;
    normal.add(triNormals[t]);
    regionCount++;
  }
  if (regionCount === 0 || normal.lengthSq() < 1e-20) {
    normal.copy(seedNormal);
  } else {
    normal.normalize();
  }

  // Collect all region triangle vertices in world space for wireframe overlay.
  const regionVertices = new Float32Array(regionCount * 9);
  let offset = 0;
  for (let t = 0; t < triCount; t++) {
    if (!inRegion[t]) continue;
    readVertex(v0, vi(t, 0));
    readVertex(v1, vi(t, 1));
    readVertex(v2, vi(t, 2));
    regionVertices[offset + 0] = v0.x;
    regionVertices[offset + 1] = v0.y;
    regionVertices[offset + 2] = v0.z;
    regionVertices[offset + 3] = v1.x;
    regionVertices[offset + 4] = v1.y;
    regionVertices[offset + 5] = v1.z;
    regionVertices[offset + 6] = v2.x;
    regionVertices[offset + 7] = v2.y;
    regionVertices[offset + 8] = v2.z;
    offset += 9;
  }

  return { center, normal, regionVertices };
}

function maxBoxDimension(object: THREE.Object3D): number {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return 0;
  return Math.max(...box.getSize(new THREE.Vector3()).toArray());
}

function normalizeLoadedModelUnits(object: THREE.Object3D, sceneScaleMm: number): void {
  const maxDim = maxBoxDimension(object);
  if (maxDim > 0 && maxDim < Math.max(sceneScaleMm * 0.2, 2)) {
    object.scale.multiplyScalar(1000);
  }
}

function makeFaceLabel(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(2, 6, 23, 0.82)";
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.roundRect(12, 18, 232, 56, 12);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 34px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 128, 47);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  }));
  sprite.scale.set(4.2, 1.6, 1);
  return sprite;
}

function draftToPatch(draft: AssetDraft): V3AssetUpdate {
  const faces: V3Face[] = draft.faces.map((face, index) => {
    const id = face.id.trim();
    if (!id) throw new Error(`face ${index + 1} id is required`);
    const width = readOptionalNumber(face.apertureWidthMm, `${id}.apertureWidthMm`);
    const height = readOptionalNumber(face.apertureHeightMm, `${id}.apertureHeightMm`);
    return {
      id,
      positionMmBodyLocal: {
        x: readNumber(face.px, `${id}.position.x`),
        y: readNumber(face.py, `${id}.position.y`),
        z: readNumber(face.pz, `${id}.position.z`),
      },
      normalBodyLocal: face.hasNormal
        ? {
            x: readNumber(face.nx, `${id}.normal.x`),
            y: readNumber(face.ny, `${id}.normal.y`),
            z: readNumber(face.nz, `${id}.normal.z`),
          }
        : null,
      apertureMm: readNumber(face.apertureMm, `${id}.apertureMm`),
      apertureShape: face.apertureShape,
      ...(width !== null ? { apertureWidthMm: width } : {}),
      ...(height !== null ? { apertureHeightMm: height } : {}),
      // Persist domain only when non-optical to avoid noisy diffs on
      // legacy optical assets that never carried the field.
      ...(face.domain && face.domain !== "optical" ? { domain: face.domain } : {}),
    };
  });

  const transitions: V3Transition[] = draft.transitions.map((transition, index) => {
    const inFace = transition.in.trim();
    const outRaw = transition.outText.trim();
    const op = transition.op.trim();
    if (!inFace) throw new Error(`transition ${index + 1} in face is required`);
    if (!outRaw) throw new Error(`transition ${index + 1} out face is required`);
    if (!op) throw new Error(`transition ${index + 1} op is required`);

    const params = readOptionalJson<Record<string, unknown>>(transition.paramsText, "params");
    const matrix5x5 = readOptionalJson<number[][]>(transition.matrix5x5Text, "matrix5x5");
    const abcd = readOptionalJson<number[][]>(transition.abcdText, "abcd");
    const out = outRaw.includes(",")
      ? outRaw.split(",").map((part) => part.trim()).filter(Boolean)
      : outRaw;
    const viaRaw = transition.viaText.trim();
    const via = viaRaw === ""
      ? null
      : viaRaw.split(",").map((part) => part.trim()).filter(Boolean);

    return {
      in: inFace,
      out,
      op,
      ...(via && via.length > 0 ? { via } : {}),
      ...(params !== undefined ? { params } : {}),
      ...(matrix5x5 !== undefined ? { matrix5x5 } : {}),
      ...(abcd !== undefined ? { abcd } : {}),
    };
  });

  const wavelengthMin = readOptionalNumber(draft.wavelengthMinNm, "wavelength min");
  const wavelengthMax = readOptionalNumber(draft.wavelengthMaxNm, "wavelength max");
  const wavelengthRangeNm =
    wavelengthMin === null && wavelengthMax === null
      ? null
      : [wavelengthMin ?? 0, wavelengthMax ?? 0] as [number, number];

  // Build properties patch: keep all other keys, overwrite (or remove)
  // bodyFramePositionMm based on the draft inputs. All three components
  // empty ??no offset, drop the key.
  const posX = readOptionalNumber(draft.bodyFramePositionMmX, "bodyFramePosition.x");
  const posY = readOptionalNumber(draft.bodyFramePositionMmY, "bodyFramePosition.y");
  const posZ = readOptionalNumber(draft.bodyFramePositionMmZ, "bodyFramePosition.z");
  const nextProps: Record<string, unknown> = { ...draft.properties };
  if (posX === null && posY === null && posZ === null) {
    delete nextProps.bodyFramePositionMm;
  } else {
    nextProps.bodyFramePositionMm = {
      x: posX ?? 0,
      y: posY ?? 0,
      z: posZ ?? 0,
    };
  }

  const kindIdValue = draft.kindId.trim() || null;
  return {
    kindId: kindIdValue,
    wavelengthRangeNm,
    // body_frame_rotation now stores the CAD-to-body rotation (the
    // body-frame origin's orientation relative to the CAD STL). User
    // edits via Euler rx/ry/rz, persisted as a quaternion.
    bodyFrameRotation: draft.bodyFrameRotation,
    faces,
    transitions,
    defaultParams: readJsonObject(draft.defaultParamsText, "defaultParams"),
    properties: nextProps,
  };
}

function IconButton({
  title,
  onClick,
  children,
  disabled = false,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
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

const DOMAIN_BADGE: Record<V3FaceDomain, { color: string; bg: string }> = {
  optical: { color: "#7dd3fc", bg: "#082f49" },
  rf:      { color: "#fbbf24", bg: "#3f2a06" },
  ttl:     { color: "#a78bfa", bg: "#2e1065" },
};

function FacesReadOnly({ faces }: { faces: V3Face[] | null }) {
  if (!faces || faces.length === 0) return <em style={{ color: "#4b5563" }}>(no faces)</em>;
  return (
    <table style={TABLE}>
      <thead>
        <tr>
          <th style={TH}>face_id</th>
          <th style={TH}>domain</th>
          <th style={TH}>position mm</th>
          <th style={TH}>normal</th>
          <th style={TH}>aper</th>
          <th style={TH}>shape</th>
        </tr>
      </thead>
      <tbody>
        {faces.map((face) => {
          const dom = (face.domain ?? "optical") as V3FaceDomain;
          const badge = DOMAIN_BADGE[dom];
          return (
            <tr key={face.id}>
              <td style={{ ...TD, fontWeight: 700 }}>{face.id}</td>
              <td style={TD}>
                <span style={{
                  display: "inline-block", padding: "1px 6px", fontSize: 10,
                  background: badge.bg, color: badge.color,
                  borderRadius: 3, fontWeight: 600,
                }}>{dom}</span>
              </td>
              <td style={TD}>{vec3Str(face.positionMmBodyLocal)}</td>
              <td style={TD}>{vec3Str(face.normalBodyLocal)}</td>
              <td style={TD}>{face.apertureMm}</td>
              <td style={TD}>{face.apertureShape}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function DefaultParamsReadOnly({ params }: { params: Record<string, unknown> | null }) {
  if (!params || Object.keys(params).length === 0) {
    return <em style={{ color: "#4b5563" }}>(none)</em>;
  }
  return (
    <table style={TABLE}>
      <tbody>
        {Object.entries(params).map(([key, value]) => (
          <tr key={key}>
            <td style={{ ...TD, color: "#6b7280", width: "32%" }}>{key}</td>
            <td style={TD}>{typeof value === "object" ? JSON.stringify(value) : String(value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function KindGuidePanel({ selectedKind }: { selectedKind: string | null }) {
  // When an asset is selected, only show that asset's kind ??listing
  // every kind below an unrelated asset is noise. With nothing
  // selected (idle state), still show the full registry so the user can
  // browse what's available.
  const sorted = useMemo(() => {
    if (!selectedKind) return KIND_GUIDES;
    return KIND_GUIDES.filter((guide) => guide.kind === selectedKind);
  }, [selectedKind]);

  if (selectedKind && sorted.length === 0) {
    // Asset references a kind not in KIND_GUIDES (custom variant / new
    // kind without a guide entry yet). Suppress the panel rather than
    // showing the full unrelated list.
    return null;
  }

  return (
    <div>
      <div style={SECTION_LABEL}>Kind definitions</div>
      <div style={{ display: "grid", gap: 8 }}>
        {sorted.map((guide) => (
          <details
            key={guide.kind}
            open={guide.kind === selectedKind}
            style={{
              border: "1px solid #e9ece9",
              background: "#ffffff",
              padding: 8,
            }}
          >
            <summary style={{ cursor: "pointer", color: "#7dd3fc", fontWeight: 700 }}>
              {guide.kind}
            </summary>
            <div style={{ marginTop: 6, display: "grid", gap: 5, fontSize: 11, color: "#374151" }}>
              <div><strong style={{ color: "#6b7280" }}>faces:</strong> {guide.faces}</div>
              <div><strong style={{ color: "#6b7280" }}>transitions:</strong> {guide.transitions}</div>
              <div><strong style={{ color: "#6b7280" }}>defaultParams:</strong> {guide.params.join(", ")}</div>
              <div><strong style={{ color: "#6b7280" }}>ABCD/q:</strong> {guide.matrix}</div>
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

function FaceLocator3D({
  asset,
  draft,
  selectedFaceIndex,
  onSelectFace,
  onMoveFace,
  onAutoPlaceFace,
  bodyFramePositionMm,
  bodyFrameRotation,
  readOnlyGeometry = false,
  onDeleteCluster,
  lockedCentroids,
  onToggleLockCluster,
  onAddLockCluster,
  showLocks = true,
}: {
  asset: V3Asset;
  draft: AssetDraft;
  selectedFaceIndex: number | null;
  onSelectFace: (index: number) => void;
  onMoveFace: (index: number, position: THREE.Vector3) => void;
  onAutoPlaceFace: (index: number, position: THREE.Vector3, normal: THREE.Vector3) => void;
  bodyFramePositionMm: { x: number; y: number; z: number };
  bodyFrameRotation: { x: number; y: number; z: number; w: number } | null;
  /** When true, face markers can be selected but not dragged or
   *  auto-placed; positions are owned by another editor (PHY Editor). */
  readOnlyGeometry?: boolean;
  /** Ctrl+middle-click / Ctrl+middle-drag: flat-face cluster or
   *  screen-rectangle delete. Receives centroid keys (0.5 mm grid, same
   *  format as viewerHints.deletedCentroids). Only wired up in Binding
   *  dev ??undefined here disables the handler entirely. */
  onDeleteCluster?: (centroidKeys: string[]) => void;
  /** UI-only "keep" markers. Shift+middle-click toggles a single
   *  cluster's lock state; Shift+middle-drag adds every cluster in the
   *  rectangle. Locked centroids are protected from Ctrl-drag box
   *  delete and rendered with a green overlay. Not persisted to the
   *  asset; resets when the user exits Edit Asset. */
  lockedCentroids?: ReadonlySet<string>;
  onToggleLockCluster?: (centroidKeys: string[]) => void;
  onAddLockCluster?: (centroidKeys: string[]) => void;
  /** When false, the green lock overlay mesh is hidden. Defaults to
   *  true so existing callers (e.g. PHY Editor) see the overlay
   *  whenever locks are present. */
  showLocks?: boolean;
}) {
  const readOnlyGeometryRef = useRef(readOnlyGeometry);
  readOnlyGeometryRef.current = readOnlyGeometry;
  const onDeleteClusterRef = useRef(onDeleteCluster);
  onDeleteClusterRef.current = onDeleteCluster;
  const onToggleLockClusterRef = useRef(onToggleLockCluster);
  onToggleLockClusterRef.current = onToggleLockCluster;
  const onAddLockClusterRef = useRef(onAddLockCluster);
  onAddLockClusterRef.current = onAddLockCluster;
  const lockedCentroidsRef = useRef<ReadonlySet<string>>(lockedCentroids ?? new Set());
  lockedCentroidsRef.current = lockedCentroids ?? new Set();
  const mountRef = useRef<HTMLDivElement | null>(null);
  const callbacksRef = useRef({ onSelectFace, onMoveFace, onAutoPlaceFace });
  const selectedFaceIndexRef = useRef(selectedFaceIndex);
  const [modelStatus, setModelStatus] = useState<"loading" | "loaded" | "proxy">("loading");
  const [autoPick, setAutoPick] = useState(false);
  const autoPickRef = useRef(autoPick);
  // Body-frame position + rotation: the STL is wrapped in two nested
  // groups so its CAD frame ends up displayed in body-frame orientation
  // with the body origin at the scene origin. Outer group rotates by
  // R_body; inner group translates by -body_origin. Refs let the
  // long-lived scene useEffect read latest values; separate effects
  // update the groups live as the user types.
  const bodyFramePositionRef = useRef(bodyFramePositionMm);
  const bodyFrameRotationRef = useRef(bodyFrameRotation);
  const modelGroupRef = useRef<THREE.Group | null>(null);          // outer: rotation
  const modelInnerGroupRef = useRef<THREE.Group | null>(null);     // inner: translation
  bodyFramePositionRef.current = bodyFramePositionMm;
  bodyFrameRotationRef.current = bodyFrameRotation;
  // Picked-face wireframe overlay survives useEffect remounts (which fire on
  // every draft.faces edit, including the one auto-pick itself triggers).
  const pickedFaceWireframeRef = useRef<{
    vertices: Float32Array;
    faceIndex: number;
    forFilePath: string;
  } | null>(null);
  // Camera pose survives useEffect remounts so saves / auto-pick / face edits
  // do not reset the view the user has orbited to.
  const cameraStateRef = useRef<{
    position: THREE.Vector3;
    target: THREE.Vector3;
    forFilePath: string;
  } | null>(null);

  callbacksRef.current = { onSelectFace, onMoveFace, onAutoPlaceFace };
  selectedFaceIndexRef.current = selectedFaceIndex;
  autoPickRef.current = autoPick;

  // Read viewer hints from the *draft* so mid-click cluster deletions
  // (which now stage in draft.properties.viewerHints instead of writing
  // through to the DB) preview live and revert cleanly when the user
  // cancels Edit Asset without saving.
  const viewerHintsKey = useMemo(
    () => JSON.stringify((draft.properties as { viewerHints?: AssetViewerHints } | undefined)?.viewerHints ?? null),
    [draft.properties],
  );
  // Stable key over the locked-centroid set: rebuilds the lock overlay
  // when the user shift-mid-clicks new clusters.
  const lockedCentroidsKey = useMemo(() => {
    if (!lockedCentroids || lockedCentroids.size === 0) return "";
    return [...lockedCentroids].sort().join("|");
  }, [lockedCentroids]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;

    let cancelled = false;
    let animationFrame = 0;
    setModelStatus("loading");
    const width = Math.max(420, mount.clientWidth || 760);
    const height = 420;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#07111f");

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    scene.add(new THREE.HemisphereLight("#dbeafe", "#1a2435", 2.4));
    scene.add(new THREE.AmbientLight("#ffffff", 0.5));
    const key = new THREE.DirectionalLight("#ffffff", 2.4);
    key.position.set(30, 40, 60);
    scene.add(key);
    const fill = new THREE.DirectionalLight("#ffe7c4", 1.2);
    fill.position.set(-40, 20, -30);
    scene.add(fill);
    const rim = new THREE.DirectionalLight("#bfdbfe", 0.9);
    rim.position.set(0, -50, 30);
    scene.add(rim);

    const root = new THREE.Group();
    scene.add(root);

    const facePositions = draft.faces
      .map(facePosition)
      .filter((position): position is THREE.Vector3 => position !== null);
    const faceBox = new THREE.Box3();
    for (const position of facePositions) faceBox.expandByPoint(position);
    if (faceBox.isEmpty()) {
      faceBox.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(20, 20, 20));
    }
    const faceSize = faceBox.getSize(new THREE.Vector3());
    const sceneScale = Math.max(faceSize.x, faceSize.y, faceSize.z, 10);
    const markerRadius = Math.max(sceneScale * 0.08, 2.2);
    const normalLength = Math.max(sceneScale * 0.6, 12);

    const grid = new THREE.GridHelper(sceneScale * 1.6, 12, "#d8ded8", "#ffffff");
    grid.rotation.x = Math.PI / 2;
    root.add(grid);
    // Faint lab/CAD axes (grey) for reference.
    const labAxes = new THREE.AxesHelper(sceneScale * 0.45);
    (labAxes.material as THREE.Material).transparent = true;
    (labAxes.material as THREE.Material).opacity = 0.22;
    (labAxes.material as THREE.LineBasicMaterial).depthTest = false;
    root.add(labAxes);

    // Body-frame triad (X red, Y green, Z blue) at the scene origin ??    // Phase 9.10: orientation is *locked* (no rotation). Body +Z is the
    // optical axis, body +X/+Y are the polarization basis. Per-instance
    // tilt lives in the Component 3D preview, not here. Sized big
    // enough to poke out of the CAD proxy / loaded STL.
    const bodyArmLen = Math.max(sceneScale * 1.2, 30);
    const bodyAxesGroup = new THREE.Group();
    const bodyAxisColors: Array<[THREE.Vector3, string]> = [
      [new THREE.Vector3(1, 0, 0), "#ef4444"],
      [new THREE.Vector3(0, 1, 0), "#22c55e"],
      [new THREE.Vector3(0, 0, 1), "#3b82f6"],
    ];
    for (const [dir, color] of bodyAxisColors) {
      // Shaft = thin cylinder along axis, depthTest false so it pokes through
      // the proxy cube; renderOrder ensures it draws after transparent CAD.
      const shaftLen = bodyArmLen * 0.85;
      const shaftRad = bodyArmLen * 0.018;
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(shaftRad, shaftRad, shaftLen, 12),
        new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false }),
      );
      // Cylinder's local axis is +Y; rotate so it aligns with `dir`.
      shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      shaft.position.copy(dir.clone().multiplyScalar(shaftLen / 2));
      shaft.renderOrder = 50;
      bodyAxesGroup.add(shaft);

      const headLen = bodyArmLen * 0.15;
      const headRad = bodyArmLen * 0.05;
      const head = new THREE.Mesh(
        new THREE.ConeGeometry(headRad, headLen, 16),
        new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false }),
      );
      head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      head.position.copy(dir.clone().multiplyScalar(shaftLen + headLen / 2));
      head.renderOrder = 50;
      bodyAxesGroup.add(head);
    }
    root.add(bodyAxesGroup);

    // Wrap the loaded STL/proxy in two nested groups so the user can
    // adjust position + rotation live. Outer group's quaternion = R_body
    // (rotates STL into body-aligned orientation), inner group's
    // position = -body_origin (slides body origin onto world zero).
    // Net transform: world_point = R_body * (cad_point - body_origin).
    const modelGroup = new THREE.Group();
    const modelInnerGroup = new THREE.Group();
    {
      const p = bodyFramePositionRef.current;
      const q = bodyFrameRotationRef.current;
      modelInnerGroup.position.set(-p.x, -p.y, -p.z);
      if (q) modelGroup.quaternion.set(q.x, q.y, q.z, q.w).invert();
    }
    modelGroup.add(modelInnerGroup);
    root.add(modelGroup);
    modelGroupRef.current = modelGroup;
    modelInnerGroupRef.current = modelInnerGroup;

    const selectable: THREE.Object3D[] = [];
    const modelMeshes: THREE.Mesh[] = [];
    const markerGroups: THREE.Group[] = [];
    const markerMaterial = new THREE.MeshStandardMaterial({ color: "#22d3ee", emissive: "#0e7490" });
    const selectedMaterial = new THREE.MeshStandardMaterial({ color: "#fbbf24", emissive: "#b45309" });
    markerMaterial.depthTest = false;
    selectedMaterial.depthTest = false;

    draft.faces.forEach((face, index) => {
      const position = facePosition(face);
      if (!position) return;
      const normal = faceNormal(face);
      const group = new THREE.Group();
      group.position.copy(position);
      group.userData.faceIndex = index;

      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(markerRadius, 20, 14),
        index === selectedFaceIndex ? selectedMaterial : markerMaterial,
      );
      sphere.renderOrder = 30;
      sphere.userData.faceIndex = index;
      group.add(sphere);
      selectable.push(sphere);

      const aperture = readDraftNumber(face.apertureMm) ?? markerRadius * 3;
      // Per-face width/height: if user filled them, use them; otherwise
      // default to aperture ? 2 (square / circle inscribed in apertureMm
      // half-extent). Clamped to markerRadius so tiny apertures stay
      // visible.
      const wMm = readDraftNumber(face.apertureWidthMm) ?? aperture * 2;
      const hMm = readDraftNumber(face.apertureHeightMm) ?? aperture * 2;
      const drawW = Math.max(wMm, markerRadius * 2.8);
      const drawH = Math.max(hMm, markerRadius * 2.8);
      const thickness = Math.max(Math.max(drawW, drawH) * 0.04, markerRadius * 0.2);
      const isInternalFace = /^B\d+/.test(face.id);  // B1, B2, ... = internal reflective interface
      const ring = new THREE.Mesh(
        _makeApertureOutlineGeometry(face.apertureShape, drawW, drawH, thickness),
        new THREE.MeshBasicMaterial({
          color: index === selectedFaceIndex ? "#fbbf24" : (isInternalFace ? "#f472b6" : "#38bdf8"),
          transparent: true,
          opacity: 0.7,
          side: THREE.DoubleSide,
          depthWrite: false,
          depthTest: false,
        }),
      );
      ring.renderOrder = 29;
      ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
      group.add(ring);

      // For internal B* faces, also render a filled translucent disk to
      // visualize the slanted gap / Brewster plate inside the body. Helps
      // distinguish Glan-Laser (B1/B2 tilted) from a plain box.
      if (isInternalFace) {
        const disk = new THREE.Mesh(
          _makeApertureFillGeometry(face.apertureShape, drawW, drawH),
          new THREE.MeshBasicMaterial({
            color: index === selectedFaceIndex ? "#fbbf24" : "#f472b6",
            transparent: true,
            opacity: 0.18,
            side: THREE.DoubleSide,
            depthWrite: false,
          }),
        );
        disk.renderOrder = 25;
        disk.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
        group.add(disk);
      }

      const arrow = new THREE.ArrowHelper(
        normal,
        new THREE.Vector3(),
        normalLength,
        index === selectedFaceIndex ? "#fbbf24" : "#a78bfa",
        normalLength * 0.22,
        normalLength * 0.1,
      );
      arrow.renderOrder = 30;
      arrow.traverse((child) => {
        const mesh = child as THREE.Mesh | THREE.Line;
        const material = mesh.material;
        const materials = Array.isArray(material) ? material : material ? [material] : [];
        for (const mat of materials) {
          mat.depthTest = false;
          mat.depthWrite = false;
        }
      });
      group.add(arrow);

      const label = makeFaceLabel(face.id, index === selectedFaceIndex ? "#fbbf24" : "#22d3ee");
      label.position.copy(normal.clone().multiplyScalar(normalLength * 1.12));
      label.renderOrder = 31;
      group.add(label);

      markerGroups[index] = group;
      root.add(group);
    });

    function saveCameraState() {
      if (!cameraStateRef.current) {
        cameraStateRef.current = {
          position: new THREE.Vector3(),
          target: new THREE.Vector3(),
          forFilePath: asset.filePath,
        };
      }
      cameraStateRef.current.position.copy(camera.position);
      cameraStateRef.current.target.copy(controls.target);
      cameraStateRef.current.forFilePath = asset.filePath;
    }

    function fitCameraToObject() {
      const saved = cameraStateRef.current;
      if (saved && saved.forFilePath === asset.filePath) {
        // Restore the pose the user last orbited to. Skip the auto-fit so
        // edits / saves / auto-pick don't yank the camera away.
        camera.position.copy(saved.position);
        controls.target.copy(saved.target);
        const dist = camera.position.distanceTo(saved.target);
        camera.near = Math.max(dist / 1200, 0.01);
        camera.far = Math.max(dist * 120, camera.far);
        camera.updateProjectionMatrix();
        controls.update();
        return;
      }
      const bbox = new THREE.Box3().setFromObject(root);
      if (bbox.isEmpty()) bbox.copy(faceBox);
      bbox.expandByScalar(Math.max(sceneScale * 0.35, 2));
      const center = bbox.getCenter(new THREE.Vector3());
      const size = Math.max(...bbox.getSize(new THREE.Vector3()).toArray(), 8);
      camera.position.set(center.x + size * 0.9, center.y - size * 1.2, center.z + size * 0.75);
      camera.near = Math.max(size / 1200, 0.01);
      camera.far = size * 120;
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.update();
      saveCameraState();
    }
    controls.addEventListener("change", saveCameraState);

    function addProxyBox() {
      // Prefer asset.properties.physicalDimensionsMm + face aperture shape
      // to pick a realistic primitive. Fall back to wireframe box around
      // the face cluster only when nothing useful is declared.
      const dims = ((asset.properties ?? {}) as Record<string, unknown>).physicalDimensionsMm as
        | Record<string, number> | undefined;
      const firstFaceShape = draft.faces[0]?.apertureShape;
      const center = faceBox.getCenter(new THREE.Vector3());
      const material = new THREE.MeshStandardMaterial({
        color: "#6b7280",
        roughness: 0.55,
        metalness: 0.05,
        transparent: true,
        opacity: 0.18,    // low so internal B* face disks show through
        side: THREE.DoubleSide,
        depthWrite: false,
      });

      let mesh: THREE.Mesh | null = null;

      if (dims && typeof dims.diameterMm === "number") {
        // Cylindrical optic (lens / mirror / waveplate). Axis = body +z.
        const r = dims.diameterMm / 2;
        const h = (dims.L as number | undefined) ?? (dims.thicknessMm as number | undefined) ?? 1;
        const cyl = new THREE.CylinderGeometry(r, r, h, 48);
        cyl.rotateX(Math.PI / 2);
        mesh = new THREE.Mesh(cyl, material);
      } else if (
        dims && typeof dims.claddingDiameterUm === "number"
        && typeof dims.lengthMm === "number"
      ) {
        // Fiber: thin cylinder along z. Cladding um -> mm.
        const r = (dims.claddingDiameterUm as number) / 2 / 1000;
        const h = dims.lengthMm;
        const cyl = new THREE.CylinderGeometry(r, r, h, 16);
        cyl.rotateX(Math.PI / 2);
        mesh = new THREE.Mesh(cyl, material);
      } else if (
        dims
        && typeof dims.L === "number"
        && typeof dims.W === "number"
        && typeof dims.H === "number"
      ) {
        // Rectangular slab: AOM crystal, EOM, TA, dichroic plate in mount.
        // L along optical axis (z), W along x, H along y.
        const box = new THREE.BoxGeometry(dims.W, dims.H, dims.L);
        mesh = new THREE.Mesh(box, material);
      } else if (firstFaceShape === "circle") {
        // Face-shape hint when dimensions absent: cylinder sized from faces.
        const proxyBox = faceBox.clone();
        proxyBox.expandByScalar(sceneScale * 0.12);
        const size = proxyBox.getSize(new THREE.Vector3());
        const r = Math.max(size.x, size.y) / 2;
        const cyl = new THREE.CylinderGeometry(r, r, Math.max(size.z, 1), 32);
        cyl.rotateX(Math.PI / 2);
        mesh = new THREE.Mesh(cyl, material);
      } else {
        // Last-resort wireframe box around the face cluster.
        const proxyBox = faceBox.clone();
        proxyBox.expandByScalar(sceneScale * 0.12);
        const size = proxyBox.getSize(new THREE.Vector3());
        mesh = new THREE.Mesh(
          new THREE.BoxGeometry(size.x, size.y, size.z),
          new THREE.MeshBasicMaterial({
            color: "#475569",
            wireframe: true,
            transparent: true,
            opacity: 0.55,
          }),
        );
      }

      if (mesh) {
        mesh.position.copy(center);
        modelInnerGroup.add(mesh);
      }
      setModelStatus("proxy");
      fitCameraToObject();
    }

    async function loadModel() {
      const path = asset.filePath;
      if (!path || path.startsWith("primitive://")) {
        addProxyBox();
        return;
      }
      const extension = path.split("?")[0].split(".").pop()?.toLowerCase();
      if (extension !== "stl" && extension !== "glb" && extension !== "gltf" && extension !== "obj") {
        addProxyBox();
        return;
      }
      try {
        const url = resolveAssetUrl(path);
        let object: THREE.Object3D;
        if (extension === "stl") {
          const rawGeometry = await stlLoader.loadAsync(url);
          const hints = (draft.properties as { viewerHints?: AssetViewerHints } | undefined)?.viewerHints;
          let geometry = applyViewerHintsToGeometry(rawGeometry, hints);
          // When the toolbar's "Hide locks" is engaged, treat the
          // locked centroids as if they were deleted ??this previews
          // the mesh as it would look if those patches went away too,
          // which is the comparison the user actually wants
          // ("show me without these"). The committed deletion set on
          // disk is unaffected; this filter is render-only.
          if (!showLocks && lockedCentroidsRef.current.size > 0) {
            geometry = applyDeletionFilter(geometry, [...lockedCentroidsRef.current]);
          }
          geometry.computeVertexNormals();
          object = new THREE.Mesh(
            geometry,
            new THREE.MeshStandardMaterial({
              color: "#cbd5e1",
              roughness: 0.55,
              metalness: 0.05,
              transparent: true,
              opacity: 0.42,
              side: THREE.DoubleSide,
            }),
          );
          // Lock overlay ??green-tinted copy of just the locked
          // triangles, drawn on top so the user can see what they've
          // marked as "keep" while reviewing what to delete. Only
          // built when showLocks is on; the off state hides both the
          // overlay AND the underlying patches (see filter above).
          if (showLocks && lockedCentroidsRef.current.size > 0) {
            const lockGeom = applyIncludeOnlyFilter(rawGeometry, [...lockedCentroidsRef.current]);
            if (lockGeom.attributes.position && lockGeom.attributes.position.count > 0) {
              const lockMesh = new THREE.Mesh(
                lockGeom,
                new THREE.MeshBasicMaterial({
                  color: "#22c55e",
                  transparent: true,
                  opacity: 0.45,
                  side: THREE.DoubleSide,
                  depthWrite: false,
                }),
              );
              lockMesh.renderOrder = 20;
              modelInnerGroup.add(lockMesh);
            }
          }
        } else if (extension === "obj") {
          object = await objLoader.loadAsync(url);
          object.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.material = new THREE.MeshStandardMaterial({
                color: "#cbd5e1",
                roughness: 0.55,
                metalness: 0.05,
                transparent: true,
                opacity: 0.42,
                side: THREE.DoubleSide,
              });
            }
          });
        } else {
          object = (await gltfLoader.loadAsync(url)).scene;
          object.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              const materials = Array.isArray(child.material) ? child.material : [child.material];
              const cloned = materials.map((material) => {
                const next = material.clone();
                next.side = THREE.DoubleSide;
                return next;
              });
              child.material = Array.isArray(child.material) ? cloned : cloned[0];
            }
          });
        }
        if (cancelled) return;
        normalizeLoadedModelUnits(object, sceneScale);
        modelInnerGroup.add(object);
        object.updateMatrixWorld(true);
        object.traverse((child) => {
          if (child instanceof THREE.Mesh) modelMeshes.push(child);
        });
        setModelStatus("loaded");
        fitCameraToObject();
      } catch {
        if (!cancelled) addProxyBox();
      }
    }

    let pickedFaceOverlay: THREE.LineSegments | null = null;
    function applyPickedFaceOverlay() {
      if (pickedFaceOverlay) {
        scene.remove(pickedFaceOverlay);
        pickedFaceOverlay.geometry.dispose();
        (pickedFaceOverlay.material as THREE.Material).dispose();
        pickedFaceOverlay = null;
      }
      const data = pickedFaceWireframeRef.current;
      if (!data || data.faceIndex !== selectedFaceIndexRef.current) return;
      if (data.forFilePath !== asset.filePath) {
        pickedFaceWireframeRef.current = null;
        return;
      }
      const tris = new THREE.BufferGeometry();
      tris.setAttribute("position", new THREE.Float32BufferAttribute(data.vertices, 3));
      const edges = new THREE.EdgesGeometry(tris, 4);
      tris.dispose();
      pickedFaceOverlay = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: 0xfbbf24, depthTest: false, transparent: true }),
      );
      pickedFaceOverlay.renderOrder = 999;
      scene.add(pickedFaceOverlay);
    }

    void loadModel().then(() => {
      if (!cancelled) applyPickedFaceOverlay();
    });

    fitCameraToObject();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const drag = {
      active: false,
      faceIndex: -1,
      plane: new THREE.Plane(),
    };
    // All geometry-edit gestures route through the middle mouse button
    // so the left button (orbit) and right button (pan) stay free for
    // OrbitControls. Ctrl+mid = delete, Shift+mid = lock; click vs drag
    // is decided in onPointerUp by the cumulative cursor displacement.
    const middleAction = {
      active: false,
      mode: null as null | "delete" | "lock",
      pointerId: -1,
      startX: 0,
      startY: 0,
      currentX: 0,
      currentY: 0,
      dragged: false,
      overlay: null as HTMLDivElement | null,
    };
    const DRAG_THRESHOLD_PX = 5;

    function setPointer(event: PointerEvent | MouseEvent) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
    }

    function ensureMiddleActionOverlay() {
      if (middleAction.overlay) return;
      const overlay = document.createElement("div");
      overlay.style.position = "absolute";
      const isLock = middleAction.mode === "lock";
      overlay.style.border = `1px solid ${isLock ? "#22c55e" : "#fbbf24"}`;
      overlay.style.background = isLock
        ? "rgba(34, 197, 94, 0.16)"
        : "rgba(251, 191, 36, 0.16)";
      overlay.style.pointerEvents = "none";
      overlay.style.zIndex = "2";
      middleAction.overlay = overlay;
      mount!.appendChild(overlay);
    }

    function updateMiddleActionOverlay() {
      if (!middleAction.overlay) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const left = Math.min(middleAction.startX, middleAction.currentX) - rect.left;
      const top = Math.min(middleAction.startY, middleAction.currentY) - rect.top;
      const widthPx = Math.abs(middleAction.currentX - middleAction.startX);
      const heightPx = Math.abs(middleAction.currentY - middleAction.startY);
      middleAction.overlay.style.left = `${left}px`;
      middleAction.overlay.style.top = `${top}px`;
      middleAction.overlay.style.width = `${widthPx}px`;
      middleAction.overlay.style.height = `${heightPx}px`;
    }

    /** Triangle centroid keys whose projection lies inside the
     *  middle-button drag rectangle. Does NOT filter locks ??the caller
     *  decides what to do with them (delete mode strips them out; lock
     *  mode includes them so an already-locked cluster stays locked). */
    function centroidKeysInsideMiddleActionBox(): string[] {
      const rect = renderer.domElement.getBoundingClientRect();
      const minX = Math.min(middleAction.startX, middleAction.currentX);
      const maxX = Math.max(middleAction.startX, middleAction.currentX);
      const minY = Math.min(middleAction.startY, middleAction.currentY);
      const maxY = Math.max(middleAction.startY, middleAction.currentY);
      const keys = new Set<string>();
      const centroid = new THREE.Vector3();
      const world = new THREE.Vector3();
      for (const mesh of modelMeshes) {
        const geo = mesh.geometry as THREE.BufferGeometry | undefined;
        const positions = geo?.attributes.position?.array as Float32Array | undefined;
        if (!positions) continue;
        const triangleCount = Math.floor(positions.length / 9);
        mesh.updateMatrixWorld(true);
        for (let t = 0; t < triangleCount; t += 1) {
          const o = t * 9;
          centroid.set(
            (positions[o + 0] + positions[o + 3] + positions[o + 6]) / 3,
            (positions[o + 1] + positions[o + 4] + positions[o + 7]) / 3,
            (positions[o + 2] + positions[o + 5] + positions[o + 8]) / 3,
          );
          world.copy(centroid).applyMatrix4(mesh.matrixWorld).project(camera);
          if (world.z < -1 || world.z > 1) continue;
          const sx = rect.left + ((world.x + 1) / 2) * rect.width;
          const sy = rect.top + ((-world.y + 1) / 2) * rect.height;
          if (sx < minX || sx > maxX || sy < minY || sy > maxY) continue;
          keys.add(centroidKey(centroid.x, centroid.y, centroid.z));
        }
      }
      return [...keys];
    }

    function clusterKeysAtPointer(): string[] | null {
      const hit = raycaster.intersectObjects(modelMeshes, true)[0];
      if (!hit) return null;
      const meshObj = hit.object as THREE.Mesh;
      const geo = meshObj.geometry as THREE.BufferGeometry | undefined;
      if (!geo || typeof hit.faceIndex !== "number") return null;
      const positions = geo.attributes.position.array as Float32Array;
      const cluster = findCoplanarCluster(positions, hit.faceIndex);
      if (cluster.size === 0) return null;
      const keys: string[] = [];
      for (const t of cluster) {
        const o = t * 9;
        const cx = (positions[o + 0] + positions[o + 3] + positions[o + 6]) / 3;
        const cy = (positions[o + 1] + positions[o + 4] + positions[o + 7]) / 3;
        const cz = (positions[o + 2] + positions[o + 5] + positions[o + 8]) / 3;
        keys.push(centroidKey(cx, cy, cz));
      }
      return keys;
    }

    function onPointerDown(event: PointerEvent) {
      // Middle button + Ctrl/Shift = geometry edit gesture.
      // - Ctrl+mid     ??delete mode (yellow rectangle on drag)
      // - Shift+mid    ??lock mode   (green rectangle on drag)
      // Click vs drag is decided later in onPointerUp by total cursor
      // travel; this just captures the pointer and locks out
      // OrbitControls so the wheel-button dolly doesn't kick in.
      if (
        event.button === 1
        && (event.ctrlKey || event.shiftKey)
        && modelMeshes.length > 0
      ) {
        const mode: "delete" | "lock" = event.ctrlKey ? "delete" : "lock";
        const handlerAvailable = mode === "delete"
          ? Boolean(onDeleteClusterRef.current)
          : Boolean(onToggleLockClusterRef.current);
        if (!handlerAvailable) return;
        event.preventDefault();
        middleAction.active = true;
        middleAction.mode = mode;
        middleAction.pointerId = event.pointerId;
        middleAction.startX = event.clientX;
        middleAction.startY = event.clientY;
        middleAction.currentX = event.clientX;
        middleAction.currentY = event.clientY;
        middleAction.dragged = false;
        controls.enabled = false;
        renderer.domElement.setPointerCapture(event.pointerId);
        return;
      }

      setPointer(event);

      // Auto-pick mode: clicking the loaded model snaps the selected face
      // marker to the centroid of the clicked face region and aligns its
      // normal. Markers stay clickable so the user can re-select a face
      // without leaving the mode.
      if (autoPickRef.current && event.button === 0) {
        const markerHit = raycaster.intersectObjects(selectable, false)[0];
        if (markerHit) {
          const faceIndex = markerHit.object.userData.faceIndex as number;
          callbacksRef.current.onSelectFace(faceIndex);
          return;
        }
        const selectedIdx = selectedFaceIndexRef.current;
        if (selectedIdx === null || modelMeshes.length === 0) return;
        const meshHit = raycaster.intersectObjects(modelMeshes, true)[0];
        if (!meshHit) return;
        const result = detectFaceCenterFromHit(meshHit);
        if (!result) return;
        pickedFaceWireframeRef.current = {
          vertices: result.regionVertices,
          faceIndex: selectedIdx,
          forFilePath: asset.filePath,
        };
        applyPickedFaceOverlay();
        callbacksRef.current.onAutoPlaceFace(selectedIdx, result.center, result.normal);
        return;
      }

      const hit = raycaster.intersectObjects(selectable, false)[0];
      if (!hit) return;
      const faceIndex = hit.object.userData.faceIndex as number;
      callbacksRef.current.onSelectFace(faceIndex);
      // Marker drag commits a new face position ??only allowed when
      // geometry is editable (PHY Editor). Binding dev still lets the
      // user click to select but not move.
      if (readOnlyGeometryRef.current) return;
      const group = markerGroups[faceIndex];
      if (!group) return;
      renderer.domElement.setPointerCapture(event.pointerId);
      const viewNormal = new THREE.Vector3();
      camera.getWorldDirection(viewNormal);
      drag.plane.setFromNormalAndCoplanarPoint(viewNormal, group.position);
      drag.faceIndex = faceIndex;
      drag.active = true;
      controls.enabled = false;
    }

    function onPointerMove(event: PointerEvent) {
      if (middleAction.active) {
        middleAction.currentX = event.clientX;
        middleAction.currentY = event.clientY;
        const moved = Math.hypot(
          middleAction.currentX - middleAction.startX,
          middleAction.currentY - middleAction.startY,
        );
        if (moved >= DRAG_THRESHOLD_PX) {
          // First time we cross the threshold ??show the rectangle.
          if (!middleAction.dragged) {
            middleAction.dragged = true;
            ensureMiddleActionOverlay();
          }
          updateMiddleActionOverlay();
        }
        return;
      }
      if (!drag.active) return;
      setPointer(event);
      const next = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(drag.plane, next)) return;
      markerGroups[drag.faceIndex]?.position.copy(next);
    }

    function onPointerUp(event: PointerEvent) {
      if (middleAction.active) {
        middleAction.currentX = event.clientX;
        middleAction.currentY = event.clientY;
        const mode = middleAction.mode;
        const wasDrag = middleAction.dragged;
        middleAction.overlay?.remove();
        middleAction.overlay = null;
        middleAction.active = false;
        middleAction.mode = null;
        middleAction.dragged = false;
        middleAction.pointerId = -1;
        controls.enabled = true;
        try {
          renderer.domElement.releasePointerCapture(event.pointerId);
        } catch {
          // Pointer capture may already be released if the browser cancelled it.
        }
        if (!mode) return;
        if (wasDrag) {
          const allKeys = centroidKeysInsideMiddleActionBox();
          if (allKeys.length === 0) return;
          if (mode === "delete") {
            const locked = lockedCentroidsRef.current;
            const targetKeys = locked.size > 0
              ? allKeys.filter((k) => !locked.has(k))
              : allKeys;
            if (targetKeys.length > 0) onDeleteClusterRef.current?.(targetKeys);
          } else {
            onAddLockClusterRef.current?.(allKeys);
          }
        } else {
          // Click without movement ??single cluster pick.
          setPointer(event);
          const keys = clusterKeysAtPointer();
          if (!keys || keys.length === 0) return;
          if (mode === "delete") onDeleteClusterRef.current?.(keys);
          else onToggleLockClusterRef.current?.(keys);
        }
        return;
      }
      if (!drag.active) return;
      const group = markerGroups[drag.faceIndex];
      if (group) callbacksRef.current.onMoveFace(drag.faceIndex, group.position.clone());
      drag.active = false;
      drag.faceIndex = -1;
      controls.enabled = true;
      try {
        renderer.domElement.releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture may already be released if the browser cancelled it.
      }
    }

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointerleave", onPointerUp);
    // Suppress the default middle-button autoscroll cursor on
    // mousedown. Middle-button interactions now flow through the
    // pointerdown handler above when Ctrl or Shift is held; without
    // a modifier we let OrbitControls' default dolly behaviour run,
    // so we only swallow the autoscroll fallback.
    const onMouseDownNoMid = (e: MouseEvent) => { if (e.button === 1) e.preventDefault(); };
    renderer.domElement.addEventListener("mousedown", onMouseDownNoMid);

    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      animationFrame = window.requestAnimationFrame(animate);
    };
    animate();

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(animationFrame);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointerleave", onPointerUp);
      renderer.domElement.removeEventListener("mousedown", onMouseDownNoMid);
      controls.dispose();
      renderer.dispose();
      middleAction.overlay?.remove();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) {
          material.forEach((m) => m.dispose());
        } else {
          material?.dispose?.();
        }
      });
      mount.removeChild(renderer.domElement);
    };
  }, [asset.filePath, viewerHintsKey, lockedCentroidsKey, showLocks, draft.faces, selectedFaceIndex]);

  // Reflect external body-frame origin position edits live into the
  // inner translation group, and rotation edits into the outer rotation
  // group, so the user sees the STL shift / spin as they type.
  useEffect(() => {
    const inner = modelInnerGroupRef.current;
    if (inner) {
      inner.position.set(
        -bodyFramePositionMm.x,
        -bodyFramePositionMm.y,
        -bodyFramePositionMm.z,
      );
    }
  }, [bodyFramePositionMm.x, bodyFramePositionMm.y, bodyFramePositionMm.z]);

  useEffect(() => {
    const outer = modelGroupRef.current;
    if (!outer) return;
    if (bodyFrameRotation) {
      outer.quaternion
        .set(bodyFrameRotation.x, bodyFrameRotation.y, bodyFrameRotation.z, bodyFrameRotation.w)
        .invert();
    } else {
      outer.quaternion.identity();
    }
  }, [bodyFrameRotation]);

  const selected = selectedFaceIndex !== null ? draft.faces[selectedFaceIndex] : null;
  const canDeleteGeometry = Boolean(onDeleteCluster);
  const fileExtension = asset.filePath.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  const isCadSourceFile = ["step", "stp", "sldprt", "dxf"].includes(fileExtension);
  const modelStatusText = modelStatus === "loaded"
    ? "model loaded"
    : isCadSourceFile
      ? `CAD source only (.${fileExtension}) - convert to GLB/STL to view geometry`
      : modelStatus === "proxy"
        ? "proxy view"
        : "loading model";

  const autoPickDisabled = selectedFaceIndex === null || modelStatus !== "loaded";

  return (
    <div style={{ border: "1px solid #38bdf8", background: "#020617", marginBottom: 10 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
          padding: "6px 8px",
          borderBottom: "1px solid #e9ece9",
          fontSize: 11,
          color: "#6b7280",
        }}
      >
        <span style={{ color: "#7dd3fc", fontWeight: 700 }}>3D face locator</span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span>
            {modelStatusText} -{" "}
            {selected
              ? `selected: ${selected.id}${autoPick ? " - auto-pick on" : ""}`
              : autoPick
                ? "select a face first"
                : readOnlyGeometry
                  ? "click a marker to select (positions editable in PHY Editor)"
                  : "click a marker; drag it to move position"}
          </span>
          <span style={{ display: "none" }}>
            {modelStatus === "loaded" ? "model loaded" : modelStatus === "proxy" ? "proxy view" : "loading model"} |{" "}
            {selected
              ? `selected: ${selected.id}${autoPick ? " | auto-pick on" : ""}`
              : autoPick
                ? "select a face first"
                : readOnlyGeometry
                  ? "click a marker to select (positions editable in PHY Editor)"
                  : "click a marker; drag it to move position"}
          </span>
          {!readOnlyGeometry && (
            <button
              type="button"
              onClick={() => setAutoPick((v) => !v)}
              disabled={autoPickDisabled}
              title={
                modelStatus !== "loaded"
                  ? isCadSourceFile
                    ? "STEP/STP/SLDPRT/DXF must be converted to GLB/STL/OBJ before auto-pick can inspect geometry."
                    : "Load a model (STL/GLB/GLTF/OBJ) to enable auto-pick"
                  : selectedFaceIndex === null
                    ? "Select a face marker first"
                    : "Click a face or closed loop on the model to auto-center"
              }
              style={{
                padding: "3px 8px",
                fontSize: 11,
                fontWeight: 700,
                border: `1px solid ${autoPick ? "#fbbf24" : "#d8ded8"}`,
                background: autoPick ? "#78350f" : "#fbfbf8",
                color: autoPick ? "#fde68a" : "#374151",
                cursor: autoPickDisabled ? "not-allowed" : "pointer",
                opacity: autoPickDisabled ? 0.5 : 1,
                borderRadius: 4,
              }}
            >
              {autoPick ? "auto-pick: ON" : "auto-pick face center"}
            </button>
          )}
          {canDeleteGeometry && (
            <span
              title="Ctrl+middle = delete · Shift+middle = lock (keep). Click for one cluster; drag for a screen rectangle. Plain left/right buttons still orbit/pan the camera."
              style={{
                padding: "3px 8px",
                fontSize: 10,
                color: "#94a3b8",
                border: "1px solid transparent",
              }}
            >
              Ctrl+mid = delete | Shift+mid = lock | (click or drag)
            </span>
          )}
        </div>
      </div>
      <div
        ref={mountRef}
        style={{
          height: 420,
          width: "100%",
          position: "relative",
          cursor: autoPick && !autoPickDisabled ? "crosshair" : "default",
        }}
      />
    </div>
  );
}

function AssetReadOnly({ asset }: { asset: V3Asset }) {
  const conversionStatus = (asset.properties as { conversionStatus?: string } | undefined)?.conversionStatus;
  const colorImportStatus = (asset.properties as { colorImportStatus?: string } | undefined)?.colorImportStatus;
  return (
    <>
      <div style={SECTION_LABEL}>Identity</div>
      <table style={TABLE}>
        <tbody>
          <tr>
            <td style={{ ...TD, color: "#6b7280", width: "30%" }}>catalog_id</td>
            <td style={{ ...TD, fontWeight: 700 }}>{asset.catalogId}</td>
          </tr>
          <tr>
            <td style={{ ...TD, color: "#6b7280" }}>name</td>
            <td style={TD}>{asset.name}</td>
          </tr>
          <tr>
            <td style={{ ...TD, color: "#6b7280" }}>kind_id</td>
            <td style={{ ...TD, color: asset.kindId ? "#4ec9b0" : "#6b7280" }}>
              {asset.kindId ?? "(mechanical / no physics)"}
            </td>
          </tr>
          <tr>
            <td style={{ ...TD, color: "#6b7280" }}>geometry</td>
            <td style={TD}>{asset.filePath || "-"}</td>
          </tr>
          {(conversionStatus || colorImportStatus) && (
            <tr>
              <td style={{ ...TD, color: "#6b7280" }}>import status</td>
              <td style={TD}>
                {conversionStatus ?? "-"}
                {colorImportStatus ? ` / color: ${colorImportStatus}` : ""}
              </td>
            </tr>
          )}
          {asset.wavelengthRangeNm && (
            <tr>
              <td style={{ ...TD, color: "#6b7280" }}>lambda range nm</td>
              <td style={TD}>{asset.wavelengthRangeNm[0]} - {asset.wavelengthRangeNm[1]}</td>
            </tr>
          )}
        </tbody>
      </table>

      <div style={SECTION_LABEL}>Faces ({asset.faces?.length ?? 0})</div>
      <FacesReadOnly faces={asset.faces} />

      <div style={SECTION_LABEL}>defaultParams</div>
      <DefaultParamsReadOnly params={asset.defaultParams} />
    </>
  );
}

/**
 * Body frame origin editor (Phase 9.10). Defines where the body frame
 * sits inside the imported CAD STL, with two parts:
 *   - position offset (x/y/z mm) ??body origin in CAD-frame coordinates
 *   - rotation (rx/ry/rz deg, XYZ Euler) ??CAD axes relative to body axes
 *
 * Coordinate formula:
 *   world_face = lab_sense ??( body_frame_origin + R_body * face_position )
 * where face_position is stored in body frame. The face locator translates
 * + rotates the STL by the inverse so body axes display aligned with the
 * scene axes, and faces (in body frame) sit at their natural positions.
 *
 * Component-instance pose (placing devices in a scene) lives at the
 * Component 3D preview as binding.localXYZ + localRxRyRz, not here.
 */
function _eulerDegFromQuat(
  q: { x: number; y: number; z: number; w: number } | null,
): [number, number, number] {
  if (!q) return [0, 0, 0];
  const e = new THREE.Euler().setFromQuaternion(
    new THREE.Quaternion(q.x, q.y, q.z, q.w),
    "XYZ",
  );
  const r2d = 180 / Math.PI;
  return [e.x * r2d, e.y * r2d, e.z * r2d];
}

function _quatFromEulerDeg(
  rx: number, ry: number, rz: number,
): { x: number; y: number; z: number; w: number } | null {
  if (rx === 0 && ry === 0 && rz === 0) return null;
  const d2r = Math.PI / 180;
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(rx * d2r, ry * d2r, rz * d2r, "XYZ"),
  );
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

function BodyFrameOriginEditor({
  x, y, z, rotation,
  onPositionChange,
  onRotationChange,
}: {
  x: string;
  y: string;
  z: string;
  rotation: { x: number; y: number; z: number; w: number } | null;
  onPositionChange: (axis: "x" | "y" | "z", value: string) => void;
  onRotationChange: (next: { x: number; y: number; z: number; w: number } | null) => void;
}) {
  const inputStyle = {
    width: 78,
    padding: "2px 4px",
    fontSize: 11,
    border: "1px solid #d8ded8",
    borderRadius: 3,
    fontFamily: "ui-monospace, monospace",
  } as const;

  const [rxDeg, ryDeg, rzDeg] = _eulerDegFromQuat(rotation);
  const setEuler = (rx: number, ry: number, rz: number) => {
    onRotationChange(_quatFromEulerDeg(rx, ry, rz));
  };

  return (
    <>
      <div style={{ ...SECTION_LABEL, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>Body frame origin (CAD-frame offset, mm + rotation, deg)</span>
        <span style={{ fontSize: 10, color: "#4b5563", textTransform: "none" }}>
          body +Z = optical axis | +X/+Y = polarization basis
        </span>
      </div>

      <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
        <label style={{ fontSize: 10, color: "#ef4444", fontWeight: 600 }}>
          x mm
          <input
            type="number"
            step={0.01}
            value={x}
            placeholder="0"
            onChange={(e) => onPositionChange("x", e.target.value)}
            style={{ ...inputStyle, marginLeft: 4 }}
          />
        </label>
        <label style={{ fontSize: 10, color: "#22c55e", fontWeight: 600 }}>
          y mm
          <input
            type="number"
            step={0.01}
            value={y}
            placeholder="0"
            onChange={(e) => onPositionChange("y", e.target.value)}
            style={{ ...inputStyle, marginLeft: 4 }}
          />
        </label>
        <label style={{ fontSize: 10, color: "#3b82f6", fontWeight: 600 }}>
          z mm
          <input
            type="number"
            step={0.01}
            value={z}
            placeholder="0"
            onChange={(e) => onPositionChange("z", e.target.value)}
            style={{ ...inputStyle, marginLeft: 4 }}
          />
        </label>
      </div>

      <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
        <label style={{ fontSize: 10, color: "#ef4444", fontWeight: 600 }}>
          rx°
          <input
            type="number"
            step={1}
            value={rxDeg.toFixed(2)}
            onChange={(e) => setEuler(Number(e.target.value) || 0, ryDeg, rzDeg)}
            style={{ ...inputStyle, marginLeft: 4 }}
          />
        </label>
        <label style={{ fontSize: 10, color: "#22c55e", fontWeight: 600 }}>
          ry°
          <input
            type="number"
            step={1}
            value={ryDeg.toFixed(2)}
            onChange={(e) => setEuler(rxDeg, Number(e.target.value) || 0, rzDeg)}
            style={{ ...inputStyle, marginLeft: 4 }}
          />
        </label>
        <label style={{ fontSize: 10, color: "#3b82f6", fontWeight: 600 }}>
          rz°
          <input
            type="number"
            step={1}
            value={rzDeg.toFixed(2)}
            onChange={(e) => setEuler(rxDeg, ryDeg, Number(e.target.value) || 0)}
            style={{ ...inputStyle, marginLeft: 4 }}
          />
        </label>
        <button
          type="button"
          onClick={() => {
            onPositionChange("x", "");
            onPositionChange("y", "");
            onPositionChange("z", "");
            onRotationChange(null);
          }}
          style={{
            marginLeft: "auto", fontSize: 10, padding: "2px 8px",
            border: "1px solid #d8ded8", background: "#fff", cursor: "pointer",
          }}
          title="Clear offset + rotation (body frame = CAD frame)"
        >
          ??clear
        </button>
      </div>

      <div style={{ fontSize: 10, color: "#4b5563", marginTop: 6, lineHeight: 1.45 }}>
        Defines the body frame inside the imported CAD STL: position
        offset = where the body origin sits in CAD-frame coordinates,
        rotation = how CAD axes are oriented relative to body axes (XYZ
        Euler order). The face locator transforms the STL by the inverse
        so body axes display aligned with the scene axes and faces
        (stored in body frame) sit at their natural positions. Per-instance
        lab pose (placing devices into a scene) lives in the Component
        3D preview, not here.
      </div>
    </>
  );
}

/** Multi-select domain chip row for Asset3D's properties.domains. An
 *  asset can belong to several composer rails (e.g. AOM = optical + rf;
 *  isolator-housing = optical + mechanical). Empty list = fall back to
 *  the kind-derived classification. */
function DomainChips({
  value,
  onChange,
}: {
  value: ReadonlyArray<string>;
  onChange: (next: string[]) => void;
}) {
  const set = new Set(value);
  const toggle = (cap: string) => {
    const next = new Set(set);
    if (next.has(cap)) next.delete(cap);
    else next.add(cap);
    onChange([...next]);
  };
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 3 }}>
        domains (multi-select; empty = inferred from kind_id)
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {(["optical", "rf", "mechanical"] as const).map((cap) => {
          const on = set.has(cap);
          return (
            <button
              key={cap}
              type="button"
              onClick={() => toggle(cap)}
              style={{
                fontSize: 11,
                padding: "3px 10px",
                background: on ? "#0f766e" : "transparent",
                color: on ? "#ffffff" : "#242726",
                border: `1px solid ${on ? "#115e59" : "#d8ded8"}`,
                borderRadius: 4,
                cursor: "pointer",
                fontFamily: "'Menlo', 'Consolas', monospace",
              }}
            >
              {cap}
            </button>
          );
        })}
        {value.length === 0 && (
          <span style={{ fontSize: 10, color: "#9ca3af" }}>
            (inferred)
          </span>
        )}
      </div>
    </div>
  );
}

/** Drop-down picker for Asset3D's `kind_id`, scoped to the rail's
 *  domain so a mechanical asset doesn't accidentally get an optical
 *  kind. Legacy values that don't appear in the Kind registry (e.g.
 *  ``pbs``, ``isolator``, ``faraday_rotator``, ``lens``, ``none``) are
 *  kept selectable via a "(legacy)" suffix so existing data isn't
 *  silently rewritten. */
function KindSelectInline({
  value,
  kinds,
  parentDomain,
  onChange,
}: {
  value: string;
  kinds: Array<{ name: string; displayName: string; domain: string }>;
  parentDomain: ElementDomain;
  onChange: (v: string) => void;
}) {
  const scoped = useMemo(() => {
    // Mechanical rail: rail is parentDomain "optical" (forced by editor —
    // see Asset3DV3Editor below where parentDomain is computed), so we
    // fall back to listing every kind to let mechanical assets pick
    // anything. Optical/RF rails narrow to their domain.
    const filtered = kinds.filter((k) => k.domain === parentDomain);
    return filtered.length > 0 ? filtered : kinds;
  }, [kinds, parentDomain]);
  const valueInRegistry = scoped.some((k) => k.name === value);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={INPUT}
    >
      {!valueInRegistry && (
        <option value={value}>{value || "(unset)"}{value ? " (legacy)" : ""}</option>
      )}
      {scoped
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((k) => (
          <option key={k.name} value={k.name}>
            {k.name}
          </option>
        ))}
    </select>
  );
}

function AssetEditForm({
  asset,
  draft,
  setDraft,
  selectedFaceIndex,
  setSelectedFaceIndex,
  parentDomain,
  mode,
}: {
  asset: V3Asset;
  draft: AssetDraft;
  setDraft: (draft: AssetDraft) => void;
  selectedFaceIndex: number | null;
  setSelectedFaceIndex: (index: number | null) => void;
  parentDomain: ElementDomain;
  mode: Asset3DV3EditorMode;
}) {
  const isBindingDev = mode === "binding-dev";
  const isPhyEditor = mode === "phy-editor";
  const kinds = useKindsStore((s) => s.kinds);

  // Geometry edits (mid-click cluster delete + "Revert geometry") stage
  // in draft.properties.viewerHints and only commit on Save Changes.
  // Previously they wrote through to the DB immediately, which created
  // two bugs: deletions persisted even when the user dismissed Edit
  // Asset, and Save Changes then stomped the just-written viewerHints
  // with the pre-deletion draft.properties snapshot, reverting them.
  const currentDeleted = useMemo<readonly string[]>(() => {
    const hints = (draft.properties as { viewerHints?: { deletedCentroids?: string[] } } | undefined)?.viewerHints;
    return Array.isArray(hints?.deletedCentroids) ? hints!.deletedCentroids! : [];
  }, [draft.properties]);

  // UI-only "keep" markers paired with the delete flow. Shift+mid-click
  // toggles locks; locks block Shift+drag box delete and render a green
  // overlay. Per the spec ("save only commits the delete portion") locks are
  // not persisted -- saving only commits deletedCentroids. State resets
  // automatically when the user switches asset because AssetEditForm
  // unmounts at edit-mode exit / asset switch.
  const [lockedCentroids, setLockedCentroids] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Toolbar toggle: when false the green lock overlay mesh is hidden
  // so the user can preview the geometry as it would appear post-save.
  // Persists across lock additions/removals (default visible).
  const [showLocks, setShowLocks] = useState(true);

  const stageViewerHintsDeleted = (nextDeleted: string[]) => {
    const existingHints = (draft.properties.viewerHints ?? {}) as Record<string, unknown>;
    const nextHints: Record<string, unknown> = { ...existingHints };
    if (nextDeleted.length > 0) {
      nextHints.deletedCentroids = nextDeleted;
    } else {
      delete (nextHints as { deletedCentroids?: unknown }).deletedCentroids;
    }
    setDraft({ ...draft, properties: { ...draft.properties, viewerHints: nextHints } });
  };

  const handleDeleteCluster = isBindingDev
    ? (keys: string[]) => {
        const set = new Set(currentDeleted);
        for (const k of keys) set.add(k);
        if (set.size === currentDeleted.length) return;
        stageViewerHintsDeleted([...set]);
      }
    : undefined;

  const handleToggleLockCluster = isBindingDev
    ? (keys: string[]) => {
        setLockedCentroids((prev) => {
          const next = new Set(prev);
          // Toggle semantics for the single-click case: if every key
          // is already locked, unlock the whole cluster; otherwise
          // lock any that aren't yet. Lets a second shift+mid-click on
          // the same patch undo a mistake without reaching for "Clear
          // locks".
          const allIn = keys.every((k) => next.has(k));
          if (allIn) {
            for (const k of keys) next.delete(k);
          } else {
            for (const k of keys) next.add(k);
          }
          return next;
        });
      }
    : undefined;

  // Box variant: Shift+middle-drag sweeps a region into the lock set.
  // Adds only (never toggles) so dragging across already-locked patches
  // doesn't accidentally unlock them mid-sweep.
  const handleAddLockCluster = isBindingDev
    ? (keys: string[]) => {
        if (keys.length === 0) return;
        setLockedCentroids((prev) => {
          let changed = false;
          const next = new Set(prev);
          for (const k of keys) {
            if (!next.has(k)) { next.add(k); changed = true; }
          }
          return changed ? next : prev;
        });
      }
    : undefined;

  const handleRevertGeometry = () => {
    if (currentDeleted.length === 0) return;
    if (!window.confirm(
      `Revert ${currentDeleted.length} staged triangle cluster${currentDeleted.length === 1 ? "" : "s"} on this asset? (only affects unsaved deletions)`,
    )) return;
    stageViewerHintsDeleted([]);
  };

  const handleClearLocks = () => setLockedCentroids(new Set());

  const updateFace = (index: number, patch: Partial<DraftFace>) => {
    const next = [...draft.faces];
    next[index] = { ...next[index], ...patch };
    setDraft({ ...draft, faces: next });
  };
  const moveFace = (index: number, position: THREE.Vector3) => {
    updateFace(index, {
      px: mmText(position.x),
      py: mmText(position.y),
      pz: mmText(position.z),
    });
  };
  const autoPlaceFace = (index: number, position: THREE.Vector3, normal: THREE.Vector3) => {
    updateFace(index, {
      px: mmText(position.x),
      py: mmText(position.y),
      pz: mmText(position.z),
      hasNormal: true,
      nx: mmText(normal.x),
      ny: mmText(normal.y),
      nz: mmText(normal.z),
    });
  };

  return (
    <>
      {/* Binding dev only ??geometry edit toolbar.
          - Revert: drop staged mid-click deletions (only the unsaved
            ones; committed deletions live in asset.properties).
          - Clear locks: drop UI-only "keep" marks. Locks never persist
            ??Save Changes only commits deletedCentroids.
          - Show/Hide locks: toggle the green overlay so the user can
            sanity-check what the geometry looks like once the locked
            patches are committed back into the visible mesh.
          - In-canvas gestures (all on the middle mouse button so the
            left button stays free for OrbitControls orbit):
              Ctrl+mid-click  = stage cluster for deletion (draft only,
                                committed on Save Changes)
              Ctrl+mid-drag   = stage every visible patch in the
                                rectangle for deletion; locked patches
                                are skipped
              Shift+mid-click = toggle cluster lock (UI-only "keep"
                                mark that survives Ctrl+mid-drag)
              Shift+mid-drag  = add every visible patch in the
                                rectangle to the lock set */}
      {isBindingDev && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
          <button
            type="button"
            onClick={handleRevertGeometry}
            disabled={currentDeleted.length === 0}
            style={{
              fontSize: 11,
              padding: "4px 10px",
              border: "1px solid #d8ded8",
              background: currentDeleted.length === 0 ? "#f3f4f1" : "#fef3c7",
              cursor: currentDeleted.length === 0 ? "not-allowed" : "pointer",
              opacity: currentDeleted.length === 0 ? 0.55 : 1,
            }}
            title="Restore all triangle clusters previously removed via middle-click."
          >
            Revert geometry{currentDeleted.length > 0 ? ` (${currentDeleted.length} deleted)` : ""}
          </button>
          <button
            type="button"
            onClick={handleClearLocks}
            disabled={lockedCentroids.size === 0}
            style={{
              fontSize: 11,
              padding: "4px 10px",
              border: "1px solid #d8ded8",
              background: lockedCentroids.size === 0 ? "#f3f4f1" : "#dcfce7",
              cursor: lockedCentroids.size === 0 ? "not-allowed" : "pointer",
              opacity: lockedCentroids.size === 0 ? 0.55 : 1,
            }}
            title="Clear all UI 'keep' marks. Locks are UI-only ??Save Changes only commits deletions."
          >
            Clear locks{lockedCentroids.size > 0 ? ` (${lockedCentroids.size} locked)` : ""}
          </button>
          <button
            type="button"
            onClick={() => setShowLocks((v) => !v)}
            disabled={lockedCentroids.size === 0}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11,
              padding: "4px 10px",
              border: "1px solid #d8ded8",
              background: lockedCentroids.size === 0
                ? "#f3f4f1"
                : showLocks ? "#dcfce7" : "#fbfbf8",
              cursor: lockedCentroids.size === 0 ? "not-allowed" : "pointer",
              opacity: lockedCentroids.size === 0 ? 0.55 : 1,
            }}
            title={
              lockedCentroids.size === 0
                ? "No locked patches to show or hide."
                : showLocks
                  ? "Hide the locked patches (render as if they were deleted) so you can preview the mesh without them."
                  : "Show the locked patches again with a green overlay."
            }
          >
            {showLocks ? <Eye size={13} /> : <EyeOff size={13} />}
            {showLocks ? "Hide locks" : "Show locks"}
          </button>
          <span style={{ fontSize: 10, color: "#6b7280" }}>
            Ctrl+mid-click = delete cluster | Ctrl+mid-drag = box delete | Shift+mid-click = lock (keep) | Shift+mid-drag = box lock.
            Locks aren't saved; Save only commits deletions.
          </span>
        </div>
      )}

      <FaceLocator3D
        asset={asset}
        draft={draft}
        selectedFaceIndex={selectedFaceIndex}
        onSelectFace={setSelectedFaceIndex}
        onMoveFace={moveFace}
        onAutoPlaceFace={autoPlaceFace}
        bodyFramePositionMm={{
          x: Number(draft.bodyFramePositionMmX) || 0,
          y: Number(draft.bodyFramePositionMmY) || 0,
          z: Number(draft.bodyFramePositionMmZ) || 0,
        }}
        bodyFrameRotation={draft.bodyFrameRotation}
        readOnlyGeometry={isBindingDev}
        onDeleteCluster={handleDeleteCluster}
        lockedCentroids={lockedCentroids}
        onToggleLockCluster={handleToggleLockCluster}
        onAddLockCluster={handleAddLockCluster}
        showLocks={showLocks}
      />

      {/* Identity ??physics_kind is catalog-level (Binding dev only),
          wavelength range is physics tuning (PHY Editor only). */}
      <div style={SECTION_LABEL}>Identity</div>
      <div style={{ display: "grid", gridTemplateColumns: parentDomain === "rf" || isBindingDev ? "minmax(0, 1fr)" : "minmax(0, 1fr) 120px 120px", gap: 8 }}>
        {isBindingDev && (
          <label style={{ fontSize: 11, color: "#6b7280" }}>
            kind_id
            <KindSelectInline
              value={draft.kindId}
              kinds={kinds}
              parentDomain={parentDomain}
              onChange={(v) => setDraft({ ...draft, kindId: v })}
            />
            <DomainChips
              value={(draft.properties as { domains?: string[] } | undefined)?.domains ?? []}
              onChange={(next) => {
                const nextProps = { ...draft.properties };
                if (next.length > 0) nextProps.domains = next;
                else delete (nextProps as { domains?: unknown }).domains;
                setDraft({ ...draft, properties: nextProps });
              }}
            />
          </label>
        )}
        {isPhyEditor && parentDomain !== "rf" && (
          <>
            <label style={{ fontSize: 11, color: "#6b7280" }}>
              lambda min
              <input
                value={draft.wavelengthMinNm}
                onChange={(event) => setDraft({ ...draft, wavelengthMinNm: event.target.value })}
                style={INPUT}
                type="number"
              />
            </label>
            <label style={{ fontSize: 11, color: "#6b7280" }}>
              lambda max
              <input
                value={draft.wavelengthMaxNm}
                onChange={(event) => setDraft({ ...draft, wavelengthMaxNm: event.target.value })}
                style={INPUT}
                type="number"
              />
            </label>
          </>
        )}
      </div>

      {/* Body frame origin is PHY-Editor-only (per the surface split:
          Binding dev establishes the initial offset on STL upload and
          PHY Editor fine-tunes it). */}
      {isPhyEditor && (
        <BodyFrameOriginEditor
          x={draft.bodyFramePositionMmX}
          y={draft.bodyFramePositionMmY}
          z={draft.bodyFramePositionMmZ}
          rotation={draft.bodyFrameRotation}
          onPositionChange={(axis, value) =>
            setDraft({
              ...draft,
              ...(axis === "x" ? { bodyFramePositionMmX: value } : {}),
              ...(axis === "y" ? { bodyFramePositionMmY: value } : {}),
              ...(axis === "z" ? { bodyFramePositionMmZ: value } : {}),
            })
          }
          onRotationChange={(next) => setDraft({ ...draft, bodyFrameRotation: next })}
        />
      )}

      <div style={{ ...SECTION_LABEL, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>Faces ({draft.faces.length})</span>
        {isBindingDev && (
          <IconButton
            title="Add face"
            onClick={() => {
              const nextIndex = draft.faces.length;
              // RF/TTL faces don't participate in ray-plane intersection,
              // so apertureMm defaults to 0; optical faces keep a sensible
              // 1mm half-radius default.
              const isRfParent = parentDomain === "rf";
              setDraft({
                ...draft,
                faces: [
                  ...draft.faces,
                  {
                    id: isRfParent ? `rf_out` : `F${draft.faces.length + 1}`,
                    px: "0",
                    py: "0",
                    pz: "0",
                    hasNormal: true,
                    nx: "0",
                    ny: "0",
                    nz: "1",
                    apertureMm: isRfParent ? "0" : "1",
                    apertureShape: "circle",
                    apertureWidthMm: "",
                    apertureHeightMm: "",
                    domain: isRfParent ? "rf" : "optical",
                  },
                ],
              });
              setSelectedFaceIndex(nextIndex);
            }}
          >
            <Plus size={15} />
          </IconButton>
        )}
      </div>

      <table style={TABLE}>
        <thead>
          <tr>
            <th style={{ ...TH, width: 80 }}>face_id</th>
            <th style={{ ...TH, width: 84 }}>domain</th>
            {isPhyEditor && (
              <>
                <th style={TH}>position x/y/z</th>
                <th style={TH}>normal x/y/z</th>
                <th style={{ ...TH, width: 88 }}>aperture</th>
                <th style={{ ...TH, width: 105 }}>shape</th>
                <th style={TH}>width/height</th>
              </>
            )}
            {isBindingDev && <th style={{ ...TH, width: 34 }} />}
          </tr>
        </thead>
        <tbody>
          {draft.faces.map((face, index) => (
            <tr
              key={`${face.id}-${index}`}
              onClick={() => setSelectedFaceIndex(index)}
              style={{ background: index === selectedFaceIndex ? "#f3f4f1" : "transparent" }}
            >
              {/* face id (name) and domain are catalog identity ??editable
                  in Binding dev, read-only label in PHY Editor (kind
                  declares the required face set). */}
              <td style={TD}>
                {isBindingDev ? (
                  <input value={face.id} onChange={(event) => updateFace(index, { id: event.target.value })} style={INPUT} />
                ) : (
                  <span style={{ fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>{face.id}</span>
                )}
              </td>
              <td style={TD}>
                {isBindingDev ? (
                  <select
                    value={face.domain}
                    onChange={(event) => updateFace(index, { domain: event.target.value as V3FaceDomain })}
                    style={INPUT}
                    title="optical: ray tracer; rf/ttl: §7.5 RF tracer"
                  >
                    <option value="optical">optical</option>
                    <option value="rf">rf</option>
                    <option value="ttl">ttl</option>
                  </select>
                ) : (
                  <span style={{ fontSize: 11, color: "#4b5563" }}>{face.domain}</span>
                )}
              </td>
              {isPhyEditor && (
                <>
                  <td style={TD}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
                      <input value={face.px} onChange={(event) => updateFace(index, { px: event.target.value })} style={INPUT} type="number" step="0.01" />
                      <input value={face.py} onChange={(event) => updateFace(index, { py: event.target.value })} style={INPUT} type="number" step="0.01" />
                      <input value={face.pz} onChange={(event) => updateFace(index, { pz: event.target.value })} style={INPUT} type="number" step="0.01" />
                    </div>
                  </td>
                  <td style={TD}>
                    <label style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4, color: "#6b7280" }}>
                      <input
                        type="checkbox"
                        checked={face.hasNormal}
                        onChange={(event) => updateFace(index, { hasNormal: event.target.checked })}
                      />
                      normal
                    </label>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
                      <input value={face.nx} onChange={(event) => updateFace(index, { nx: event.target.value })} style={INPUT} type="number" step="0.01" disabled={!face.hasNormal} />
                      <input value={face.ny} onChange={(event) => updateFace(index, { ny: event.target.value })} style={INPUT} type="number" step="0.01" disabled={!face.hasNormal} />
                      <input value={face.nz} onChange={(event) => updateFace(index, { nz: event.target.value })} style={INPUT} type="number" step="0.01" disabled={!face.hasNormal} />
                    </div>
                  </td>
                  <td style={TD}>
                    <input value={face.apertureMm} onChange={(event) => updateFace(index, { apertureMm: event.target.value })} style={INPUT} type="number" step="0.01" />
                  </td>
                  <td style={TD}>
                    <select
                      value={face.apertureShape}
                      onChange={(event) => updateFace(index, { apertureShape: event.target.value as V3Face["apertureShape"] })}
                      style={INPUT}
                    >
                      <option value="circle">circle</option>
                      <option value="ellipse">ellipse</option>
                      <option value="rectangle">rectangle</option>
                    </select>
                  </td>
                  <td style={TD}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                      <input value={face.apertureWidthMm} onChange={(event) => updateFace(index, { apertureWidthMm: event.target.value })} style={INPUT} type="number" step="0.01" placeholder="w" />
                      <input value={face.apertureHeightMm} onChange={(event) => updateFace(index, { apertureHeightMm: event.target.value })} style={INPUT} type="number" step="0.01" placeholder="h" />
                    </div>
                  </td>
                </>
              )}
              {isBindingDev && (
                <td style={TD}>
                  <IconButton
                    title="Remove face"
                    onClick={() => {
                      setDraft({ ...draft, faces: draft.faces.filter((_, i) => i !== index) });
                      setSelectedFaceIndex(null);
                    }}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {/* defaultParams are catalog-level (used by the kind's ABCD formula)
          ??Binding dev only. */}
      {isBindingDev && (
        <>
          <div style={SECTION_LABEL}>defaultParams</div>
          <textarea
            value={draft.defaultParamsText}
            onChange={(event) => setDraft({ ...draft, defaultParamsText: event.target.value })}
            style={{ ...TEXTAREA, minHeight: 180 }}
          />
        </>
      )}
    </>
  );
}

export type V3EditorDomain = "optical" | "rf" | "mechanical";

/** Editor mode ??controls which fields are editable.
 *  - "binding-dev": catalog editor. Picks kind, edits asset name +
 *    defaultParams (catalog-level params used by the ABCD formula),
 *    creates new assets via STL upload, live-tweak fork. Face geometry
 *    inputs are HIDDEN; faces table only shows id + domain.
 *  - "phy-editor": physics-tuning editor. Adjusts body frame origin
 *    (offset + rotation), per-face position/normal/aperture/shape/
 *    width-height, wavelength min/max, display name. Kind picker and
 *    catalog-level defaultParams are HIDDEN.
 *  Both modes share the 3D face locator visualization; face dragging
 *  is active only in phy-editor mode (binding-dev shows positions
 *  read-only).
 */
export type Asset3DV3EditorMode = "binding-dev" | "phy-editor";

export function Asset3DV3Editor({
  domain = "optical",
  mode = "binding-dev",
}: { domain?: V3EditorDomain; mode?: Asset3DV3EditorMode } = {}) {
  const isBindingDev = mode === "binding-dev";
  const isPhyEditor = mode === "phy-editor";
  const assets = useV3Catalog((state) => state.assets);
  const status = useV3Catalog((state) => state.status);
  const error = useV3Catalog((state) => state.error);
  const fetchAll = useV3Catalog((state) => state.fetchAll);
  const refresh = useV3Catalog((state) => state.refresh);
  const updateAsset = useV3Catalog((state) => state.updateAsset);
  const deleteAsset = useV3Catalog((state) => state.deleteAsset);
  const createAsset = useV3Catalog((state) => state.createAsset);
  const uploadAsset = useV3Catalog((state) => state.uploadAsset);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const [kindFilter, setKindFilter] = useState<string>("all");
  const [search, setSearch] = useState<string>("");
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<AssetDraft | null>(null);
  const [selectedFaceIndex, setSelectedFaceIndex] = useState<number | null>(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // "+ New Asset3D" modal ??Binding dev only. Lets the user fork an
  // existing asset (or start blank) into a new catalog row.
  const [newAssetModal, setNewAssetModal] = useState<NewAssetModalState | null>(null);
  const [newAssetError, setNewAssetError] = useState<string | null>(null);
  const [uploadingNewAsset, setUploadingNewAsset] = useState(false);

  useEffect(() => {
    if (status === "idle") void fetchAll();
  }, [status, fetchAll]);

  // Bootstrap the Kind registry so the kind_id <select> below is
  // populated. Shares state with ComponentsV2Editor via kindsStore.
  const kinds = useKindsStore((s) => s.kinds);
  const kindsStatus = useKindsStore((s) => s.status);
  const fetchKinds = useKindsStore((s) => s.fetchAll);
  useEffect(() => {
    if (kindsStatus === "idle") void fetchKinds();
  }, [kindsStatus, fetchKinds]);

  // Domain-scoped asset pool. Three categories:
  //   - "mechanical": asset.physicsKind is null/empty (raw mounts, posts,
  //                chassis, annotations). No face-domain expansion --
  //                mechanical assets have no rf/ttl faces by definition.
  //   - "rf": asset.physicsKind maps to rf via domainForElementKind
  //                (includes coarse kinds not in KIND_LABELS -- fallback
  //                returns "optical" for unknown, so this matches only
  //                explicit RF_DOMAIN_KINDS members), OR any face.domain
  //                in {"rf","ttl"} (covers hybrids like AOM whose rf_in
  //                face is an RF tracer sink -- §1 & §14). The TTL
  //                pre-pass (§7.5) is part of the RF tracer.
  //   - "optical": everything else with a non-empty physicsKind.
  //
  // AOM is the canonical hybrid: kind=aom (optical) so it appears under
  // Optical AND under RF (via its rf_in face). It does NOT appear under
  // Mechanical because its kind is non-empty.
  const domainAssets = useMemo(() => {
    return assets.filter((asset) => {
      // Multi-domain support: properties.domains[] is a user-set list of
      // composer rails this asset belongs to. When any entry matches the
      // current rail, include the asset ??same semantics as Component's
      // physicsCapabilities. Falls back to kind-derived bucketing when
      // properties.domains is absent.
      const domains = (asset.properties as { domains?: string[] } | undefined)?.domains;
      if (Array.isArray(domains) && domains.length > 0) {
        if (domains.includes(domain)) return true;
        // explicit list set and current rail not in it ??exclude
        return false;
      }
      const rawKind = asset.kindId;
      // Phase 9.12: all rows now have a physics_kind ("none" for the
      // passive mechanical bucket), so the old "null ??mechanical"
      // fallback collapses into the regular kind-domain check below.
      if (!rawKind) return domain === "mechanical";
      // "none" is the mechanical placeholder kind.
      if (rawKind === "none") return domain === "mechanical";
      const kind = rawKind as ElementKind;
      const kindDomain = domainForElementKind(kind);
      if (kindDomain === domain) return true;
      const faceDomains = (asset.faces ?? []).map(
        (f) => (f.domain ?? "optical"),
      );
      if (domain !== "mechanical" && faceDomains.includes(domain)) return true;
      if (domain === "rf" && faceDomains.includes("ttl")) return true;
      return false;
    });
  }, [assets, domain]);

  const kindOptions = useMemo(() => {
    const set = new Set<string>();
    for (const asset of domainAssets) set.add(asset.kindId ?? "(mechanical)");
    return ["all", ...Array.from(set).sort()];
  }, [domainAssets]);

  // Reset kindFilter when domain switches so a stale RF kind doesn't
  // hide every optical asset (or vice versa).
  useEffect(() => {
    setKindFilter("all");
    setSelectedAssetId(null);
  }, [domain]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return domainAssets
      .filter((asset) => {
        const kind = asset.kindId ?? "(mechanical)";
        if (kindFilter !== "all" && kind !== kindFilter) return false;
        const label = asset.catalogId ?? asset.name;
        if (needle && !label.toLowerCase().includes(needle)) return false;
        return true;
      })
      .sort((a, b) => {
        const al = (a.catalogId ?? a.name).toLowerCase();
        const bl = (b.catalogId ?? b.name).toLowerCase();
        return al.localeCompare(bl);
      });
  }, [domainAssets, kindFilter, search]);

  // Selection keyed by DB id (UUID) ??catalogId can be null for legacy
  // mechanical Asset3Ds that were ingested before the v3 catalog flow,
  // so comparing on catalogId would collapse all of them into one
  // "selected" pseudo-row.
  const selected = useMemo(
    () => assets.find((asset) => asset.id === selectedAssetId) ?? null,
    [assets, selectedAssetId],
  );

  const openNewAssetModal = (sourceCatalogId = selected?.catalogId ?? "") => {
    setNewAssetError(null);
    setNewAssetModal({
      open: true,
      sourceCatalogId,
      catalogId: "",
      name: "",
      file: null,
      precisionPreset: "standard",
      preserveColors: true,
      unit: "mm",
      scaleFactor: "1",
    });
  };

  useEffect(() => {
    if (!selectedAssetId && filtered.length > 0) {
      setSelectedAssetId(filtered[0].id);
    }
  }, [filtered, selectedAssetId]);

  useEffect(() => {
    if (selected) {
      setDraft(draftFromAsset(selected));
      setSelectedFaceIndex((selected.faces?.length ?? 0) > 0 ? 0 : null);
    } else {
      setDraft(null);
      setSelectedFaceIndex(null);
    }
    setEditMode(false);
    setSaveError(null);
  }, [selected?.id]);

  const save = async () => {
    if (!selected || !draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      const patch = draftToPatch(draft);
      const updated = await updateAsset(selected.catalogId ?? selected.id, patch);
      // Refresh the draft from the server response (drops stomped
      // fields like reformatted JSON, picks up server-side defaults)
      // but stay in edit mode ??the user often saves mid-edit to
      // checkpoint progress and expects to keep working. Cancel /
      // close still exit edit mode normally.
      setDraft(draftFromAsset(updated));
      const nextFaceCount = updated.faces?.length ?? 0;
      setSelectedFaceIndex((prev) => {
        if (nextFaceCount === 0) return null;
        if (prev === null || prev >= nextFaceCount) return 0;
        return prev;
      });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const deleteCurrent = async () => {
    if (!selected || deleting) return;
    const ok = window.confirm(
      `Delete Asset3D "${selected.catalogId ?? selected.name}"?\n\n`
      + `This removes the DB row + any ComponentBinding rows that reference it.\n`
      + `The catalog JSON file is NOT touched ??running seed_v3_assets.py will recreate this row.`,
    );
    if (!ok) return;
    setDeleting(true);
    setSaveError(null);
    try {
      await deleteAsset(selected.catalogId ?? selected.id);
      setEditMode(false);
      setSelectedAssetId(null);
      setDraft(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  if (status === "loading") {
    return <div style={{ padding: 16, color: "#6b7280" }}>Loading v3 catalog...</div>;
  }
  if (status === "error") {
    return <div style={{ padding: 16, color: "#f87171" }}>Failed to load v3 catalog: {error}</div>;
  }

  return (
    <div
      data-testid="asset3d-v3-editor"
      style={{
        display: "grid",
        gridTemplateColumns: "280px minmax(0, 1fr)",
        height: "100%",
        background: "#fbfbf8",
        color: "#1f2937",
      }}
    >
      <aside style={{ borderRight: "1px solid #e9ece9", padding: 8, overflowY: "auto" }}>
        {isBindingDev && (
          <button
            type="button"
            onClick={() => openNewAssetModal()}
            style={{
              width: "100%", marginBottom: 6,
              padding: "4px 8px", fontSize: 11,
              border: "1px solid #ca8a04", background: "#fde68a",
              cursor: "pointer", fontWeight: 600,
            }}
            title="Create a new Asset3D row, optionally forked from an existing one."
          >
            + New Asset3D
          </button>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 30px", gap: 6, marginBottom: 8 }}>
          <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value)} style={INPUT}>
            {kindOptions.map((kind) => (
              <option key={kind} value={kind}>{kind}</option>
            ))}
          </select>
          <IconButton title="Refresh catalog" onClick={() => void refresh()}>
            <RefreshCw size={14} />
          </IconButton>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="filter by id"
            style={{ ...INPUT, gridColumn: "1 / span 2" }}
          />
        </div>
        <div style={{ fontSize: 10, color: "#4b5563", marginBottom: 6 }}>
          {filtered.length} of {assets.length} assets
        </div>
        {filtered.length === 0 && (
          <em style={{ color: "#4b5563", fontSize: 11 }}>
            {assets.length === 0
              ? "No v3 catalog rows. Run backend/scripts/seed_v3_assets.py."
              : "No assets match the filter."}
          </em>
        )}
        {filtered.map((asset) => {
          const isSelected = asset.id === selectedAssetId;
          return (
            <button
              key={asset.id}
              type="button"
              onClick={() => setSelectedAssetId(asset.id)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "6px 8px",
                marginBottom: 3,
                background: isSelected ? "#f3f4f1" : "transparent",
                color: "#1f2937",
                border: isSelected ? "1px solid #4ec9b0" : "1px solid transparent",
                cursor: "pointer",
                fontFamily: "ui-monospace, monospace",
                fontSize: 11,
              }}
            >
              <div style={{ fontWeight: 700 }}>{asset.catalogId ?? asset.name}</div>
              <div style={{ fontSize: 10, color: "#6b7280" }}>kind: {asset.kindId ?? "(mech)"}</div>
            </button>
          );
        })}
      </aside>

      <main style={{ overflow: "hidden", display: "grid", gridTemplateRows: "auto minmax(0, 1fr)" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: "8px 12px",
            borderBottom: "1px solid #e9ece9",
            background: "#ffffff",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {selected?.name ?? "Select an Asset3D"}
            </div>
            <div style={{ fontSize: 11, color: "#6b7280" }}>
              {selected?.catalogId ?? selected?.name ?? "faces + transitions + defaultParams"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {!editMode && selected && (
              <>
                <IconButton title="Edit asset" onClick={() => setEditMode(true)}>
                  <Edit3 size={14} />
                </IconButton>
                {isBindingDev && (
                  <IconButton
                    title="Delete asset (removes DB row + bindings; catalog JSON untouched)"
                    onClick={() => void deleteCurrent()}
                    disabled={deleting}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                )}
              </>
            )}
            {editMode && (
              <>
                <IconButton title="Save changes" onClick={() => void save()} disabled={saving}>
                  <Save size={14} />
                </IconButton>
                <IconButton
                  title="Cancel editing"
                  onClick={() => {
                    if (selected) setDraft(draftFromAsset(selected));
                    setSelectedFaceIndex((selected?.faces?.length ?? 0) > 0 ? 0 : null);
                    setEditMode(false);
                    setSaveError(null);
                  }}
                  disabled={saving}
                >
                  <X size={15} />
                </IconButton>
              </>
            )}
          </div>
        </div>

        <div style={{ overflowY: "auto", padding: 12 }}>
          {!selected && (
            <div style={{ color: "#4b5563" }}>
              Select an asset from the list to inspect or edit its v3 {domain} definition.
            </div>
          )}
          {selected && !editMode && <AssetReadOnly asset={selected} />}
          {selected && editMode && draft && (
            <AssetEditForm
              asset={selected}
              draft={draft}
              setDraft={setDraft}
              selectedFaceIndex={selectedFaceIndex}
              setSelectedFaceIndex={setSelectedFaceIndex}
              parentDomain={domain === "mechanical" ? "optical" : domain}
              mode={mode}
            />
          )}
          {saveError && (
            <div style={{ marginTop: 10, color: "#fecaca", background: "#7f1d1d", padding: 8, fontSize: 12 }}>
              {saveError}
            </div>
          )}
          <KindGuidePanel selectedKind={editMode ? draft?.kindId || selected?.kindId || null : selected?.kindId ?? null} />
        </div>
      </main>
      {isBindingDev && newAssetModal?.open && (
        <div
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 100,
          }}
          onClick={() => setNewAssetModal(null)}
        >
          <div
            style={{
              background: "#fff", color: "#1f2937",
              minWidth: 420, maxWidth: 520,
              border: "1px solid #d8ded8", borderRadius: 6,
              padding: 16, display: "grid", gap: 8,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: 0, fontSize: 14 }}>+ New Asset3D</h3>
            <p style={{ margin: 0, fontSize: 11, color: "#4b5563" }}>
              Three creation modes: pick an existing asset under "source"
              to fork, pick blank to start empty, or upload GLB/GLTF/OBJ/STL/STEP/STP/SLDPRT/DXF.
              CAD files are stored as source geometry until a CAD-to-GLB converter is configured.
              catalog_id must match {" "}<code>^[a-z0-9_]+$</code> and be unique.
            </p>
            <input
              ref={uploadInputRef}
              type="file"
              accept=".glb,.gltf,.obj,.stl,.step,.stp,.sldprt,.dxf"
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0] ?? null;
                if (!file || !newAssetModal) return;
                setNewAssetModal({
                  ...newAssetModal,
                  file,
                  sourceCatalogId: "",
                  catalogId: newAssetModal.catalogId || slugFromFilename(file.name),
                  name: newAssetModal.name || displayNameFromFilename(file.name),
                });
                setNewAssetError(null);
                event.currentTarget.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => uploadInputRef.current?.click()}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 12px",
                fontSize: 12,
                fontWeight: 600,
                border: "1px solid #2563eb",
                background: "#dbeafe",
                color: "#1e3a8a",
                cursor: "pointer",
                borderRadius: 4,
                width: "fit-content",
              }}
            >
              <Upload size={14} />
              Upload 3D file...
            </button>
            {newAssetModal.file && (
              <>
                <div style={{ fontSize: 11, color: "#1f2937" }}>
                  Selected: <code>{newAssetModal.file.name}</code>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <label style={{ fontSize: 11, color: "#6b7280" }}>
                    CAD precision
                    <select
                      value={newAssetModal.precisionPreset}
                      onChange={(e) => setNewAssetModal({
                        ...newAssetModal,
                        precisionPreset: e.target.value as NewAssetModalState["precisionPreset"],
                      })}
                      style={INPUT}
                    >
                      <option value="preview">preview</option>
                      <option value="standard">standard</option>
                      <option value="high">high</option>
                    </select>
                  </label>
                  <label style={{ fontSize: 11, color: "#6b7280" }}>
                    unit
                    <select
                      value={newAssetModal.unit}
                      onChange={(e) => setNewAssetModal({
                        ...newAssetModal,
                        unit: e.target.value as NewAssetModalState["unit"],
                      })}
                      style={INPUT}
                    >
                      <option value="mm">mm</option>
                      <option value="m">m</option>
                    </select>
                  </label>
                </div>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11, color: "#6b7280" }}>
                  <input
                    type="checkbox"
                    checked={newAssetModal.preserveColors}
                    onChange={(e) => setNewAssetModal({ ...newAssetModal, preserveColors: e.target.checked })}
                  />
                  preserve CAD colors when converted to GLB
                </label>
              </>
            )}
            <div style={{ fontSize: 10, color: "#9ca3af", marginTop: -2 }}>
              or
            </div>
            <label style={{ fontSize: 11, color: "#6b7280" }}>
              source (fork from)
              <select
                value={newAssetModal.sourceCatalogId}
                onChange={(e) => setNewAssetModal({ ...newAssetModal, sourceCatalogId: e.target.value })}
                style={INPUT}
                disabled={!!newAssetModal.file}
              >
                <option value="">(blank, no source)</option>
                {assets
                  .filter((a) => !!a.catalogId)
                  .map((a) => (
                    <option key={a.catalogId} value={a.catalogId!}>
                      {a.catalogId} - {a.name}
                    </option>
                  ))}
              </select>
            </label>
            <label style={{ fontSize: 11, color: "#6b7280" }}>
              catalog_id (slug, snake_case)
              <input
                value={newAssetModal.catalogId}
                onChange={(e) => setNewAssetModal({ ...newAssetModal, catalogId: e.target.value })}
                placeholder={newAssetModal.sourceCatalogId
                  ? `${newAssetModal.sourceCatalogId}_v2`
                  : "my_new_asset"}
                style={INPUT}
              />
            </label>
            <label style={{ fontSize: 11, color: "#6b7280" }}>
              name (display)
              <input
                value={newAssetModal.name}
                onChange={(e) => setNewAssetModal({ ...newAssetModal, name: e.target.value })}
                placeholder="Free-form display label"
                style={INPUT}
              />
            </label>
            {newAssetError && (
              <div style={{ color: "#dc2626", fontSize: 11 }}>{newAssetError}</div>
            )}
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 4 }}>
              <button
                type="button"
                onClick={() => setNewAssetModal(null)}
                style={{ padding: "4px 10px", fontSize: 11, border: "1px solid #d8ded8", background: "#fbfbf8", cursor: "pointer" }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (!newAssetModal) return;
                  const slugRe = /^[a-z0-9_]+$/;
                  if (!slugRe.test(newAssetModal.catalogId)) {
                    setNewAssetError("catalog_id must be lower-snake-case ([a-z0-9_]+)");
                    return;
                  }
                  if (!newAssetModal.name.trim()) {
                    setNewAssetError("name is required");
                    return;
                  }
                  const scaleFactor = Number(newAssetModal.scaleFactor);
                  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
                    setNewAssetError("scale factor must be a positive number");
                    return;
                  }
                  setUploadingNewAsset(true);
                  try {
                    const created = newAssetModal.file
                      ? await uploadAsset({
                        file: newAssetModal.file,
                        catalogId: newAssetModal.catalogId,
                        name: newAssetModal.name.trim(),
                        domain,
                        unit: newAssetModal.unit,
                        scaleFactor,
                        precisionPreset: newAssetModal.precisionPreset,
                        preserveColors: newAssetModal.preserveColors,
                      })
                      : await createAsset({
                        catalogId: newAssetModal.catalogId,
                        name: newAssetModal.name.trim(),
                        sourceCatalogId: newAssetModal.sourceCatalogId || undefined,
                        kindId: domain === "mechanical" ? "none" : undefined,
                      });
                    setNewAssetModal(null);
                    setNewAssetError(null);
                    setSelectedAssetId(created.id);
                    setEditMode(true);
                  } catch (err) {
                    setNewAssetError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setUploadingNewAsset(false);
                  }
                }}
                disabled={uploadingNewAsset}
                style={{ padding: "4px 10px", fontSize: 11, border: "1px solid #ca8a04", background: uploadingNewAsset ? "#f3f4f1" : "#fde68a", cursor: uploadingNewAsset ? "not-allowed" : "pointer", fontWeight: 600 }}
              >
                {uploadingNewAsset ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
