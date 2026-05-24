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
import { Edit3, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

import { resolveAssetUrl } from "../api/client";
import {
  type V3Asset,
  type V3AssetUpdate,
  type V3Face,
  type V3FaceDomain,
  type V3Transition,
  type V3Vec3,
  useV3Catalog,
} from "../store/v3CatalogStore";
import {
  domainForElementKind,
  type ElementDomain,
} from "../utils/elementDefaults";
import type { ElementKind } from "../types/digitalTwin";

const stlLoader = new STLLoader();
const gltfLoader = new GLTFLoader();

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
  outText: string;
  op: string;
  paramsText: string;
  matrix5x5Text: string;
  abcdText: string;
};

type AssetDraft = {
  physicsKind: string;
  wavelengthMinNm: string;
  wavelengthMaxNm: string;
  bodyFrameRotation: { x: number; y: number; z: number; w: number } | null;
  faces: DraftFace[];
  transitions: DraftTransition[];
  defaultParamsText: string;
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
  // ────────────────────────────────────────────────────────────────────────
  // RF kinds (asset-physics-model.md §8.7–§8.12). Faces carry domain="rf"
  // or domain="ttl"; the RF tracer (§7.5) walks a port-adjacency graph
  // instead of doing ray-plane intersection, so apertureMm is unused.
  // ────────────────────────────────────────────────────────────────────────
  {
    kind: "rf_source",
    faces: "One rf_out per channel (AD9959: CH0..CH3). domain=\"rf\". normalBodyLocal = SMA connector outward direction. apertureMm = 0.",
    transitions: "rf_out -> rf_out, op=emit_rf_source. Reads dynamicSources.channels[anchorName] for per-channel frequency + amplitudeScale.",
    params: ["referenceClockMhz", "sysClockMhz", "pllMultiplier", "pllBypass", "serialInterface", "syncRole", "serialPortMode"],
    matrix: "Emitter — no ABCD. RfSignalState seeded from dynamicSources (Vpp = amplitudeScale × AD9959_VPP_FULL_SCALE).",
  },
  {
    kind: "rf_amplifier",
    faces: "rf_in (inward SMA) and rf_out (outward SMA), both domain=\"rf\". apertureMm = 0.",
    transitions: "rf_in -> rf_out, op=rf_amplify. Single-direction passthrough.",
    params: ["gainDb", "frequencyRangeMhz", "outputPowerP1dbDbm", "outputPowerMaxDbm", "inputPowerMaxDbm", "noiseFigureDb", "supplyVoltageV", "connectorType"],
    matrix: "RF op: vpp_out = vpp_in × 10^(gainDb/20), clamped at outputPowerMaxDbm (sets saturated flag). Power gate -> null (signal terminates).",
  },
  {
    kind: "rf_cable",
    faces: "rf_in (end A) and rf_out (end B), both domain=\"rf\". endAConnector / endBConnector may differ (adapter cables).",
    transitions: "rf_in -> rf_out AND rf_out -> rf_in, both op=rf_pass. Bidirectional; current op is identity.",
    params: ["lengthMm", "impedanceOhm", "maxFrequencyGhz", "connectorType", "endAConnector", "endBConnector", "cableType", "jacketColor"],
    matrix: "No matrix. Future: vpp × 10^(-lossDbPerM × lengthMm / 1000 / 20). Endpoints stored in SceneObject.properties.rfCableEndpoints, NOT in rf_links.",
  },
  {
    kind: "rf_switch",
    faces: "rf_in (RFIN common, domain=\"rf\"), N x rf_out throws (RF1, RF2, ... — share id, different anchor.name), ttl_in (domain=\"ttl\").",
    transitions: "rf_in -> [rf_out:RF1, rf_out:RF2, ...], op=rf_switch_route. Only one throw active per call; TTL state pre-resolved from PPG peer.",
    params: ["switchType", "throwCount", "frequencyMinGhz", "frequencyMaxGhz", "insertionLossDb", "isolationDb", "ttlActiveHighThrow", "ttlState"],
    matrix: "Active path: vpp × 10^(-insertionLossDb/20). LOW state on SP4T+ returns [] (no active path). Power gate -> null.",
  },
  {
    kind: "programmable_pulse_generator",
    faces: "One rf_out face with domain=\"ttl\" (NOT \"rf\" — face id is historical; the line carries TTL/Trigger digital).",
    transitions: "rf_out -> rf_out, op=emit_ttl_steady. Reads TimingProgram.rest_state for steady-state HIGH/LOW level.",
    params: ["connectorType", "timingProgramId", "outputDomain", "highVoltageV"],
    matrix: "Emitter — no ABCD. Solver only sees steady-state idle level; pulse train timeline is scrub-UI only.",
  },
  {
    kind: "horn_antenna",
    faces: "Optional aperture face with domain=\"rf\". Position = lobe origin, normalBodyLocal = main-beam axis.",
    transitions: "No transitions — horn is an RF sink. signalAtPort[(horn, aperture)] is the terminating signal (UI can display received power).",
    params: ["frequencyGhz", "gainDbi", "beamwidth3dbDeg", "polarAxisBodyLocal", "cosineExponent"],
    matrix: "No matrix. Phase RF.7 will add cos^n lobe visualization and optional Palace farfield S-parameter import.",
  },
];

const SECTION_LABEL: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "#94a3b8",
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
  borderBottom: "1px solid #334155",
  color: "#94a3b8",
  fontWeight: 600,
};

const TD: CSSProperties = {
  padding: "4px 6px",
  borderBottom: "1px solid #1f2937",
  fontFamily: "ui-monospace, monospace",
  fontSize: 11,
  color: "#e2e8f0",
  verticalAlign: "top",
};

const INPUT: CSSProperties = {
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  background: "#111827",
  color: "#e2e8f0",
  border: "1px solid #334155",
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
  border: "1px solid #334155",
  background: "#1e293b",
  color: "#e2e8f0",
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

function draftFromAsset(asset: V3Asset): AssetDraft {
  return {
    physicsKind: asset.physicsKind ?? "",
    wavelengthMinNm: n(asset.wavelengthRangeNm?.[0]),
    wavelengthMaxNm: n(asset.wavelengthRangeNm?.[1]),
    bodyFrameRotation: asset.bodyFrameRotation ?? null,
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
 * the centre of that rim — exactly what "click face -> position to centre"
 * should mean for both flat and round optical surfaces.
 */
function detectFaceCenterFromHit(
  hit: THREE.Intersection,
  options: { angleToleranceDeg?: number; vertexEpsilon?: number } = {},
): { center: THREE.Vector3; normal: THREE.Vector3 } | null {
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
    // Fully closed region (e.g. whole sphere) — fall back to centroid average.
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

  return { center, normal };
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
  ctx.fillStyle = "#f8fafc";
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

function makeBeamAxisLabel(text: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 420;
  canvas.height = 96;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgba(6, 78, 59, 0.88)";
  ctx.strokeStyle = "#34d399";
  ctx.lineWidth = 4;
  ctx.roundRect(12, 18, 396, 56, 12);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#ecfeff";
  ctx.font = "700 28px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 210, 47);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  }));
  sprite.scale.set(9.2, 2.1, 1);
  sprite.renderOrder = 36;
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

    return {
      in: inFace,
      out,
      op,
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

  return {
    physicsKind: draft.physicsKind.trim() || null,
    wavelengthRangeNm,
    bodyFrameRotation: draft.bodyFrameRotation,
    faces,
    transitions,
    defaultParams: readJsonObject(draft.defaultParamsText, "defaultParams"),
  };
}

function matrixLabel(t: V3Transition): string {
  if (t.matrix5x5) return "5x5";
  if (t.abcd) return "2x2";
  return "-";
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
  if (!faces || faces.length === 0) return <em style={{ color: "#64748b" }}>(no faces)</em>;
  return (
    <table style={TABLE}>
      <thead>
        <tr>
          <th style={TH}>id</th>
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

function TransitionsReadOnly({ transitions }: { transitions: V3Transition[] | null }) {
  if (!transitions || transitions.length === 0) {
    return <em style={{ color: "#64748b" }}>(no transitions)</em>;
  }
  return (
    <table style={TABLE}>
      <thead>
        <tr>
          <th style={TH}>in</th>
          <th style={TH}>out</th>
          <th style={TH}>op</th>
          <th style={TH}>matrix</th>
        </tr>
      </thead>
      <tbody>
        {transitions.map((transition, index) => (
          <tr key={`${transition.in}-${String(transition.out)}-${index}`}>
            <td style={{ ...TD, fontWeight: 700 }}>{transition.in}</td>
            <td style={TD}>{Array.isArray(transition.out) ? transition.out.join(", ") : transition.out}</td>
            <td style={TD}>{transition.op}</td>
            <td style={TD}>{matrixLabel(transition)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DefaultParamsReadOnly({ params }: { params: Record<string, unknown> | null }) {
  if (!params || Object.keys(params).length === 0) {
    return <em style={{ color: "#64748b" }}>(none)</em>;
  }
  return (
    <table style={TABLE}>
      <tbody>
        {Object.entries(params).map(([key, value]) => (
          <tr key={key}>
            <td style={{ ...TD, color: "#94a3b8", width: "32%" }}>{key}</td>
            <td style={TD}>{typeof value === "object" ? JSON.stringify(value) : String(value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function KindGuidePanel({ selectedKind }: { selectedKind: string | null }) {
  const sorted = useMemo(() => {
    if (!selectedKind) return KIND_GUIDES;
    const exact = KIND_GUIDES.filter((guide) => guide.kind === selectedKind);
    const rest = KIND_GUIDES.filter((guide) => guide.kind !== selectedKind);
    return [...exact, ...rest];
  }, [selectedKind]);

  return (
    <div>
      <div style={SECTION_LABEL}>Kind definitions</div>
      <div style={{ display: "grid", gap: 8 }}>
        {sorted.map((guide) => (
          <details
            key={guide.kind}
            open={guide.kind === selectedKind}
            style={{
              border: "1px solid #1e293b",
              background: "#111827",
              padding: 8,
            }}
          >
            <summary style={{ cursor: "pointer", color: "#7dd3fc", fontWeight: 700 }}>
              {guide.kind}
            </summary>
            <div style={{ marginTop: 6, display: "grid", gap: 5, fontSize: 11, color: "#cbd5e1" }}>
              <div><strong style={{ color: "#94a3b8" }}>faces:</strong> {guide.faces}</div>
              <div><strong style={{ color: "#94a3b8" }}>transitions:</strong> {guide.transitions}</div>
              <div><strong style={{ color: "#94a3b8" }}>defaultParams:</strong> {guide.params.join(", ")}</div>
              <div><strong style={{ color: "#94a3b8" }}>ABCD/q:</strong> {guide.matrix}</div>
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
}: {
  asset: V3Asset;
  draft: AssetDraft;
  selectedFaceIndex: number | null;
  onSelectFace: (index: number) => void;
  onMoveFace: (index: number, position: THREE.Vector3) => void;
  onAutoPlaceFace: (index: number, position: THREE.Vector3, normal: THREE.Vector3) => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const callbacksRef = useRef({ onSelectFace, onMoveFace, onAutoPlaceFace });
  const selectedFaceIndexRef = useRef(selectedFaceIndex);
  const [modelStatus, setModelStatus] = useState<"loading" | "loaded" | "proxy">("loading");
  const [autoPick, setAutoPick] = useState(false);
  const autoPickRef = useRef(autoPick);

  callbacksRef.current = { onSelectFace, onMoveFace, onAutoPlaceFace };
  selectedFaceIndexRef.current = selectedFaceIndex;
  autoPickRef.current = autoPick;

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

    scene.add(new THREE.HemisphereLight("#dbeafe", "#111827", 1.2));
    const key = new THREE.DirectionalLight("#ffffff", 1.8);
    key.position.set(30, 40, 60);
    scene.add(key);

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

    const grid = new THREE.GridHelper(sceneScale * 1.6, 12, "#334155", "#1e293b");
    grid.rotation.x = Math.PI / 2;
    root.add(grid);
    root.add(new THREE.AxesHelper(sceneScale * 0.45));

    const zMin = Math.min(faceBox.min.z, -sceneScale * 1.6);
    const zMax = Math.max(faceBox.max.z, sceneScale * 1.6);
    const beamLength = Math.max(zMax - zMin, sceneScale * 1.5);
    const beamCenterZ = (zMin + zMax) / 2;
    const beamRadius = Math.max(sceneScale * 0.012, 0.18);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(beamRadius, beamRadius, beamLength, 24),
      new THREE.MeshBasicMaterial({
        color: "#22d3ee",
        transparent: true,
        opacity: 0.85,
        depthTest: false,
        depthWrite: false,
      }),
    );
    beam.rotation.x = Math.PI / 2;
    beam.position.set(0, 0, beamCenterZ);
    beam.renderOrder = 24;
    root.add(beam);

    const beamArrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0, zMax),
      Math.max(sceneScale * 0.35, 5),
      "#22d3ee",
      Math.max(sceneScale * 0.12, 2.4),
      Math.max(sceneScale * 0.055, 1.1),
    );
    beamArrow.renderOrder = 35;
    beamArrow.traverse((child) => {
      const mesh = child as THREE.Mesh | THREE.Line;
      const material = mesh.material;
      const materials = Array.isArray(material) ? material : material ? [material] : [];
      for (const mat of materials) {
        mat.depthTest = false;
        mat.depthWrite = false;
      }
    });
    root.add(beamArrow);

    const beamLabel = makeBeamAxisLabel("+Z beam axis / ABCD");
    beamLabel.position.set(0, Math.max(sceneScale * 0.28, 4), zMax + Math.max(sceneScale * 0.16, 2));
    root.add(beamLabel);

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
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(Math.max(aperture * 0.92, markerRadius), Math.max(aperture, markerRadius * 1.4), 48),
        new THREE.MeshBasicMaterial({
          color: index === selectedFaceIndex ? "#fbbf24" : "#38bdf8",
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

    function fitCameraToObject() {
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
    }

    function addProxyBox() {
      // Prefer asset.properties.physicalDimensionsMm + face aperture shape
      // to pick a realistic primitive. Fall back to wireframe box around
      // the face cluster only when nothing useful is declared.
      const dims = ((asset.properties ?? {}) as Record<string, unknown>).physicalDimensionsMm as
        | Record<string, number> | undefined;
      const firstFaceShape = draft.faces[0]?.apertureShape;
      const center = faceBox.getCenter(new THREE.Vector3());
      const material = new THREE.MeshStandardMaterial({
        color: "#94a3b8",
        roughness: 0.55,
        metalness: 0.05,
        transparent: true,
        opacity: 0.32,
        side: THREE.DoubleSide,
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
        // Fiber: thin cylinder along z. Cladding µm -> mm.
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
        root.add(mesh);
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
      if (extension !== "stl" && extension !== "glb" && extension !== "gltf") {
        addProxyBox();
        return;
      }
      try {
        const url = resolveAssetUrl(path);
        let object: THREE.Object3D;
        if (extension === "stl") {
          const geometry = await stlLoader.loadAsync(url);
          geometry.computeVertexNormals();
          object = new THREE.Mesh(
            geometry,
            new THREE.MeshStandardMaterial({
              color: "#94a3b8",
              roughness: 0.55,
              metalness: 0.05,
              transparent: true,
              opacity: 0.32,
              side: THREE.DoubleSide,
            }),
          );
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
        root.add(object);
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

    void loadModel();

    fitCameraToObject();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const drag = {
      active: false,
      faceIndex: -1,
      plane: new THREE.Plane(),
    };

    function setPointer(event: PointerEvent) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
    }

    function onPointerDown(event: PointerEvent) {
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
        callbacksRef.current.onAutoPlaceFace(selectedIdx, result.center, result.normal);
        return;
      }

      const hit = raycaster.intersectObjects(selectable, false)[0];
      if (!hit) return;
      const faceIndex = hit.object.userData.faceIndex as number;
      callbacksRef.current.onSelectFace(faceIndex);
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
      if (!drag.active) return;
      setPointer(event);
      const next = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(drag.plane, next)) return;
      markerGroups[drag.faceIndex]?.position.copy(next);
    }

    function onPointerUp(event: PointerEvent) {
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
      controls.dispose();
      renderer.dispose();
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
  }, [asset.filePath, draft.faces, selectedFaceIndex]);

  const selected = selectedFaceIndex !== null ? draft.faces[selectedFaceIndex] : null;

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
          borderBottom: "1px solid #1e293b",
          fontSize: 11,
          color: "#94a3b8",
        }}
      >
        <span style={{ color: "#7dd3fc", fontWeight: 700 }}>3D face locator</span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span>
            {modelStatus === "loaded" ? "model loaded" : modelStatus === "proxy" ? "proxy view" : "loading model"} ·{" "}
            {selected
              ? `selected: ${selected.id}${autoPick ? " · auto-pick on" : ""}`
              : autoPick
                ? "select a face first"
                : "click a marker; drag it to move position"}
          </span>
          <button
            type="button"
            onClick={() => setAutoPick((v) => !v)}
            disabled={autoPickDisabled}
            title={
              modelStatus !== "loaded"
                ? "Load a model (STL/GLTF) to enable auto-pick"
                : selectedFaceIndex === null
                  ? "Select a face marker first"
                  : "Click a face or closed loop on the model to auto-center"
            }
            style={{
              padding: "3px 8px",
              fontSize: 11,
              fontWeight: 700,
              border: `1px solid ${autoPick ? "#fbbf24" : "#334155"}`,
              background: autoPick ? "#78350f" : "#0f172a",
              color: autoPick ? "#fde68a" : "#cbd5e1",
              cursor: autoPickDisabled ? "not-allowed" : "pointer",
              opacity: autoPickDisabled ? 0.5 : 1,
              borderRadius: 4,
            }}
          >
            {autoPick ? "auto-pick: ON" : "auto-pick face center"}
          </button>
        </div>
      </div>
      <div
        ref={mountRef}
        style={{
          height: 420,
          width: "100%",
          cursor: autoPick && !autoPickDisabled ? "crosshair" : "default",
        }}
      />
    </div>
  );
}

function AssetReadOnly({ asset }: { asset: V3Asset }) {
  return (
    <>
      <div style={SECTION_LABEL}>Identity</div>
      <table style={TABLE}>
        <tbody>
          <tr>
            <td style={{ ...TD, color: "#94a3b8", width: "30%" }}>catalog_id</td>
            <td style={{ ...TD, fontWeight: 700 }}>{asset.catalogId}</td>
          </tr>
          <tr>
            <td style={{ ...TD, color: "#94a3b8" }}>name</td>
            <td style={TD}>{asset.name}</td>
          </tr>
          <tr>
            <td style={{ ...TD, color: "#94a3b8" }}>physics_kind</td>
            <td style={{ ...TD, color: asset.physicsKind ? "#4ec9b0" : "#94a3b8" }}>
              {asset.physicsKind ?? "(mechanical / no physics)"}
            </td>
          </tr>
          <tr>
            <td style={{ ...TD, color: "#94a3b8" }}>geometry</td>
            <td style={TD}>{asset.filePath || "-"}</td>
          </tr>
          {asset.wavelengthRangeNm && (
            <tr>
              <td style={{ ...TD, color: "#94a3b8" }}>lambda range nm</td>
              <td style={TD}>{asset.wavelengthRangeNm[0]} - {asset.wavelengthRangeNm[1]}</td>
            </tr>
          )}
        </tbody>
      </table>

      <div style={SECTION_LABEL}>Faces ({asset.faces?.length ?? 0})</div>
      <FacesReadOnly faces={asset.faces} />

      <div style={SECTION_LABEL}>Transitions ({asset.transitions?.length ?? 0})</div>
      <TransitionsReadOnly transitions={asset.transitions} />

      <div style={SECTION_LABEL}>defaultParams</div>
      <DefaultParamsReadOnly params={asset.defaultParams} />
    </>
  );
}

/**
 * Body-frame orientation picker — sets bodyFrameRotation so that the
 * specified CAD axis becomes the v3 optical axis (+z). Used when the
 * imported STL/GLB's natural +z does NOT coincide with the beam path
 * A → B. Defaults to "+Z" = no rotation (most common after STL clean-up).
 *
 * The dropdown maps to precomputed quaternions:
 *   +Z (default) → null              (CAD already aligned)
 *   -Z           → (1, 0, 0, 0)      180° about X
 *   +X           → (0, -0.7071, 0, 0.7071)  -90° about Y → CAD +X = optical +Z
 *   -X           → (0,  0.7071, 0, 0.7071)  +90° about Y
 *   +Y           → ( 0.7071, 0, 0, 0.7071)  +90° about X
 *   -Y           → (-0.7071, 0, 0, 0.7071)  -90° about X
 */
const SQRT_HALF = Math.SQRT1_2; // 0.7071067811865476
const AXIS_PRESETS: ReadonlyArray<{
  label: string;
  hint: string;
  quat: { x: number; y: number; z: number; w: number } | null;
}> = [
  { label: "+Z (default)", hint: "CAD already aligned — no rotation", quat: null },
  { label: "-Z",           hint: "Flip optical axis 180° (180° about X)", quat: { x: 1, y: 0, z: 0, w: 0 } },
  { label: "+X",           hint: "CAD +X is optical axis (−90° about Y)", quat: { x: 0, y: -SQRT_HALF, z: 0, w: SQRT_HALF } },
  { label: "-X",           hint: "CAD −X is optical axis (+90° about Y)", quat: { x: 0, y:  SQRT_HALF, z: 0, w: SQRT_HALF } },
  { label: "+Y",           hint: "CAD +Y is optical axis (+90° about X)", quat: { x:  SQRT_HALF, y: 0, z: 0, w: SQRT_HALF } },
  { label: "-Y",           hint: "CAD −Y is optical axis (−90° about X)", quat: { x: -SQRT_HALF, y: 0, z: 0, w: SQRT_HALF } },
];

function quatApproxEqual(
  a: { x: number; y: number; z: number; w: number } | null,
  b: { x: number; y: number; z: number; w: number } | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  const eps = 1e-4;
  return (
    Math.abs(a.x - b.x) < eps &&
    Math.abs(a.y - b.y) < eps &&
    Math.abs(a.z - b.z) < eps &&
    Math.abs(a.w - b.w) < eps
  );
}

function BodyFrameRotationEditor({
  value,
  onChange,
}: {
  value: { x: number; y: number; z: number; w: number } | null;
  onChange: (next: { x: number; y: number; z: number; w: number } | null) => void;
}) {
  const matchedPreset = AXIS_PRESETS.find((p) => quatApproxEqual(p.quat, value));
  const selectedLabel = matchedPreset?.label ?? "(custom)";

  const handleSelect = (label: string) => {
    const preset = AXIS_PRESETS.find((p) => p.label === label);
    if (!preset) return; // "(custom)" option is non-selectable in practice
    onChange(preset.quat);
  };

  return (
    <>
      <div style={{ ...SECTION_LABEL, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>Body frame orientation</span>
        <span style={{ fontSize: 10, color: "#64748b", textTransform: "none" }}>
          which CAD axis is the optical axis (+Z)?
        </span>
      </div>
      <select
        value={selectedLabel}
        onChange={(e) => handleSelect(e.target.value)}
        style={{
          background: "#1e293b", color: "#e2e8f0",
          border: "1px solid #334155",
          padding: "4px 6px", fontSize: 12,
          width: "100%",
        }}
      >
        {AXIS_PRESETS.map((p) => (
          <option key={p.label} value={p.label}>{p.label} — {p.hint}</option>
        ))}
        {!matchedPreset && value !== null && (
          <option value="(custom)">(custom quaternion — preserved)</option>
        )}
      </select>
      <div style={{ fontSize: 10, color: "#64748b", marginTop: 4, fontFamily: "ui-monospace, monospace" }}>
        current quaternion: {value ? `(${value.x.toFixed(4)}, ${value.y.toFixed(4)}, ${value.z.toFixed(4)}, ${value.w.toFixed(4)})` : "null (identity — CAD = body frame)"}
      </div>
      <div style={{ fontSize: 10, color: "#64748b", marginTop: 6, lineHeight: 1.45 }}>
        Body +Z is a convention for matrix authoring, not enforced by tracer.
        For 2-port slabs (lens / waveplate / AOM / Faraday): body +Z = A→B axis.
        For multi-port (PBS / BS / dichroic): body +Z = primary transmit (A→B); side faces (R, L…) carry their own normals.
        Tracer reads face geometry, not body axis. This picker only rotates the CAD STL to match the body frame you defined.
      </div>
    </>
  );
}

function AssetEditForm({
  asset,
  draft,
  setDraft,
  selectedFaceIndex,
  setSelectedFaceIndex,
  parentDomain,
}: {
  asset: V3Asset;
  draft: AssetDraft;
  setDraft: (draft: AssetDraft) => void;
  selectedFaceIndex: number | null;
  setSelectedFaceIndex: (index: number | null) => void;
  parentDomain: ElementDomain;
}) {
  const updateFace = (index: number, patch: Partial<DraftFace>) => {
    const next = [...draft.faces];
    next[index] = { ...next[index], ...patch };
    setDraft({ ...draft, faces: next });
  };
  const updateTransition = (index: number, patch: Partial<DraftTransition>) => {
    const next = [...draft.transitions];
    next[index] = { ...next[index], ...patch };
    setDraft({ ...draft, transitions: next });
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
      <FaceLocator3D
        asset={asset}
        draft={draft}
        selectedFaceIndex={selectedFaceIndex}
        onSelectFace={setSelectedFaceIndex}
        onMoveFace={moveFace}
        onAutoPlaceFace={autoPlaceFace}
      />

      <div style={SECTION_LABEL}>Identity</div>
      <div style={{ display: "grid", gridTemplateColumns: parentDomain === "rf" ? "minmax(0, 1fr)" : "minmax(0, 1fr) 120px 120px", gap: 8 }}>
        <label style={{ fontSize: 11, color: "#94a3b8" }}>
          physics_kind
          <input
            value={draft.physicsKind}
            onChange={(event) => setDraft({ ...draft, physicsKind: event.target.value })}
            style={INPUT}
            placeholder={parentDomain === "rf" ? "rf_source, rf_amplifier, ..." : "lens, pbs, aom..."}
          />
        </label>
        {parentDomain !== "rf" && (
          <>
            <label style={{ fontSize: 11, color: "#94a3b8" }}>
              lambda min
              <input
                value={draft.wavelengthMinNm}
                onChange={(event) => setDraft({ ...draft, wavelengthMinNm: event.target.value })}
                style={INPUT}
                type="number"
              />
            </label>
            <label style={{ fontSize: 11, color: "#94a3b8" }}>
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

      <BodyFrameRotationEditor
        value={draft.bodyFrameRotation}
        onChange={(next) => setDraft({ ...draft, bodyFrameRotation: next })}
      />

      <div style={{ ...SECTION_LABEL, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>Faces ({draft.faces.length})</span>
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
      </div>

      <table style={TABLE}>
        <thead>
          <tr>
            <th style={{ ...TH, width: 80 }}>id</th>
            <th style={{ ...TH, width: 84 }}>domain</th>
            <th style={TH}>position x/y/z</th>
            <th style={TH}>normal x/y/z</th>
            <th style={{ ...TH, width: 88 }}>aperture</th>
            <th style={{ ...TH, width: 105 }}>shape</th>
            <th style={TH}>width/height</th>
            <th style={{ ...TH, width: 34 }} />
          </tr>
        </thead>
        <tbody>
          {draft.faces.map((face, index) => (
            <tr
              key={`${face.id}-${index}`}
              onClick={() => setSelectedFaceIndex(index)}
              style={{ background: index === selectedFaceIndex ? "#1e3a52" : "transparent" }}
            >
              <td style={TD}>
                <input value={face.id} onChange={(event) => updateFace(index, { id: event.target.value })} style={INPUT} />
              </td>
              <td style={TD}>
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
              </td>
              <td style={TD}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
                  <input value={face.px} onChange={(event) => updateFace(index, { px: event.target.value })} style={INPUT} type="number" step="0.01" />
                  <input value={face.py} onChange={(event) => updateFace(index, { py: event.target.value })} style={INPUT} type="number" step="0.01" />
                  <input value={face.pz} onChange={(event) => updateFace(index, { pz: event.target.value })} style={INPUT} type="number" step="0.01" />
                </div>
              </td>
              <td style={TD}>
                <label style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4, color: "#94a3b8" }}>
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
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ ...SECTION_LABEL, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>Transitions ({draft.transitions.length})</span>
        <IconButton
          title="Add transition"
          onClick={() => {
            const firstFace = draft.faces[0]?.id ?? "A";
            const secondFace = draft.faces[1]?.id ?? firstFace;
            setDraft({
              ...draft,
              transitions: [
                ...draft.transitions,
                { in: firstFace, outText: secondFace, op: "abcd_thin_lens", paramsText: "", matrix5x5Text: "", abcdText: "" },
              ],
            });
          }}
        >
          <Plus size={15} />
        </IconButton>
      </div>

      <table style={TABLE}>
        <thead>
          <tr>
            <th style={{ ...TH, width: 90 }}>in</th>
            <th style={{ ...TH, width: 150 }}>out</th>
            <th style={{ ...TH, width: 170 }}>op</th>
            <th style={TH}>params JSON</th>
            <th style={TH}>matrix JSON</th>
            <th style={{ ...TH, width: 34 }} />
          </tr>
        </thead>
        <tbody>
          {draft.transitions.map((transition, index) => (
            <tr key={`${transition.in}-${transition.outText}-${index}`}>
              <td style={TD}>
                <input value={transition.in} onChange={(event) => updateTransition(index, { in: event.target.value })} style={INPUT} />
              </td>
              <td style={TD}>
                <input value={transition.outText} onChange={(event) => updateTransition(index, { outText: event.target.value })} style={INPUT} placeholder="B or rejected" />
              </td>
              <td style={TD}>
                <input value={transition.op} onChange={(event) => updateTransition(index, { op: event.target.value })} style={INPUT} />
              </td>
              <td style={TD}>
                <textarea value={transition.paramsText} onChange={(event) => updateTransition(index, { paramsText: event.target.value })} style={TEXTAREA} placeholder='{"order": 1}' />
              </td>
              <td style={TD}>
                <textarea value={transition.matrix5x5Text} onChange={(event) => updateTransition(index, { matrix5x5Text: event.target.value })} style={TEXTAREA} placeholder="matrix5x5" />
                <textarea value={transition.abcdText} onChange={(event) => updateTransition(index, { abcdText: event.target.value })} style={{ ...TEXTAREA, marginTop: 4 }} placeholder="abcd" />
              </td>
              <td style={TD}>
                <IconButton
                  title="Remove transition"
                  onClick={() => setDraft({ ...draft, transitions: draft.transitions.filter((_, i) => i !== index) })}
                >
                  <Trash2 size={14} />
                </IconButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={SECTION_LABEL}>defaultParams</div>
      <textarea
        value={draft.defaultParamsText}
        onChange={(event) => setDraft({ ...draft, defaultParamsText: event.target.value })}
        style={{ ...TEXTAREA, minHeight: 180 }}
      />
    </>
  );
}

export function Asset3DV3Editor({
  domain = "optical",
}: { domain?: ElementDomain } = {}) {
  const assets = useV3Catalog((state) => state.assets);
  const status = useV3Catalog((state) => state.status);
  const error = useV3Catalog((state) => state.error);
  const fetchAll = useV3Catalog((state) => state.fetchAll);
  const refresh = useV3Catalog((state) => state.refresh);
  const updateAsset = useV3Catalog((state) => state.updateAsset);

  const [kindFilter, setKindFilter] = useState<string>("all");
  const [search, setSearch] = useState<string>("");
  const [selectedCatalogId, setSelectedCatalogId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<AssetDraft | null>(null);
  const [selectedFaceIndex, setSelectedFaceIndex] = useState<number | null>(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (status === "idle") void fetchAll();
  }, [status, fetchAll]);

  // Domain-scoped asset pool: filter the global catalog down to the
  // selected tracer domain. Optical tab hides RF assets so the kind
  // dropdown stays focused; RF tab hides optical assets so the user
  // browsing AD9959 / ZHL-1-2W+ catalogs isn't drowned in lenses.
  // Assets without a physicsKind (raw mechanical mounts) only appear
  // under optical to avoid double-counting.
  const domainAssets = useMemo(() => {
    return assets.filter((asset) => {
      const kind = asset.physicsKind as ElementKind | null;
      const assetDomain = kind ? domainForElementKind(kind) : "optical";
      return assetDomain === domain;
    });
  }, [assets, domain]);

  const kindOptions = useMemo(() => {
    const set = new Set<string>();
    for (const asset of domainAssets) set.add(asset.physicsKind ?? "(mechanical)");
    return ["all", ...Array.from(set).sort()];
  }, [domainAssets]);

  // Reset kindFilter when domain switches so a stale RF kind doesn't
  // hide every optical asset (or vice versa).
  useEffect(() => {
    setKindFilter("all");
    setSelectedCatalogId(null);
  }, [domain]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return domainAssets.filter((asset) => {
      const kind = asset.physicsKind ?? "(mechanical)";
      if (kindFilter !== "all" && kind !== kindFilter) return false;
      if (needle && !asset.catalogId.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [domainAssets, kindFilter, search]);

  const selected = useMemo(
    () => assets.find((asset) => asset.catalogId === selectedCatalogId) ?? null,
    [assets, selectedCatalogId],
  );

  useEffect(() => {
    if (!selectedCatalogId && filtered.length > 0) {
      setSelectedCatalogId(filtered[0].catalogId);
    }
  }, [filtered, selectedCatalogId]);

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
  }, [selected?.catalogId]);

  const save = async () => {
    if (!selected || !draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      const patch = draftToPatch(draft);
      const updated = await updateAsset(selected.catalogId, patch);
      setDraft(draftFromAsset(updated));
      setSelectedFaceIndex((updated.faces?.length ?? 0) > 0 ? 0 : null);
      setEditMode(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (status === "loading") {
    return <div style={{ padding: 16, color: "#94a3b8" }}>Loading v3 catalog...</div>;
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
        background: "#0f172a",
        color: "#e2e8f0",
      }}
    >
      <aside style={{ borderRight: "1px solid #1e293b", padding: 8, overflowY: "auto" }}>
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
        <div style={{ fontSize: 10, color: "#64748b", marginBottom: 6 }}>
          {filtered.length} of {assets.length} assets
        </div>
        {filtered.length === 0 && (
          <em style={{ color: "#64748b", fontSize: 11 }}>
            {assets.length === 0
              ? "No v3 catalog rows. Run backend/scripts/seed_v3_assets.py."
              : "No assets match the filter."}
          </em>
        )}
        {filtered.map((asset) => {
          const isSelected = asset.catalogId === selectedCatalogId;
          return (
            <button
              key={asset.id}
              type="button"
              onClick={() => setSelectedCatalogId(asset.catalogId)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "6px 8px",
                marginBottom: 3,
                background: isSelected ? "#1e3a52" : "transparent",
                color: "#e2e8f0",
                border: isSelected ? "1px solid #4ec9b0" : "1px solid transparent",
                cursor: "pointer",
                fontFamily: "ui-monospace, monospace",
                fontSize: 11,
              }}
            >
              <div style={{ fontWeight: 700 }}>{asset.catalogId}</div>
              <div style={{ fontSize: 10, color: "#94a3b8" }}>kind: {asset.physicsKind ?? "(mech)"}</div>
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
            borderBottom: "1px solid #1e293b",
            background: "#111827",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {selected?.name ?? "Select an Asset3D"}
            </div>
            <div style={{ fontSize: 11, color: "#94a3b8" }}>
              {selected?.catalogId ?? "faces + transitions + defaultParams"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {!editMode && selected && (
              <IconButton title="Edit asset" onClick={() => setEditMode(true)}>
                <Edit3 size={14} />
              </IconButton>
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
            <div style={{ color: "#64748b" }}>
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
              parentDomain={domain}
            />
          )}
          {saveError && (
            <div style={{ marginTop: 10, color: "#fecaca", background: "#7f1d1d", padding: 8, fontSize: 12 }}>
              {saveError}
            </div>
          )}
          <KindGuidePanel selectedKind={editMode ? draft?.physicsKind || selected?.physicsKind || null : selected?.physicsKind ?? null} />
        </div>
      </main>
    </div>
  );
}
