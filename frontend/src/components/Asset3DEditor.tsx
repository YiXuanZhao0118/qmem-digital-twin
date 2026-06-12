/**
 * Asset3D v3 Catalog Editor.
 *
 * Edits the v3 optical metadata that drives face hit detection and
 * transition dispatch:
 *   - faces: body-local position, normal, aperture size/shape
 *   - transitions: face-in -> face-out op calls plus params/matrices
 *   - defaultParams: kind-level optical constants used by PhysicsOps
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  ICON_BUTTON,
  INPUT,
  INPUT_DISABLED,
  SECTION_LABEL,
  TABLE,
  TD,
  TEXTAREA,
  TH,
} from "./phyEditorTheme";
import { Eye, EyeOff, Lock, RefreshCw, Save, Trash2, Unlock, X } from "lucide-react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

import { resolveAssetUrl } from "../api/client";
import { useKindsStore } from "../store/kindsStore";
import { useSceneStore } from "../store/sceneStore";
import {
  type V3Asset,
  type V3AssetUpdate,
  type V3AssetUsage,
  type V3Face,
  type V3FaceDomain,
  type V3Transition,
  type V3Vec3,
  useV3Catalog,
} from "../store/catalogStore";
import { createZhl12wPlusAmplifier } from "../kinds/rf_amplifier/renderer";
import { createRfSwitch } from "../kinds/rf_switch/renderer";
import { createSmaShortCable } from "../three/loadAsset/rf_cable";
import { createNewportOpticalTable } from "../three/photoRoom";
import { VIEWER_BG_LIGHT, VIEWER_GRID_BLACK, VIEWER_GROUND_FILL } from "../three/viewerTheme";
import { createFiberSplineObject } from "../three/loadAsset/fiber/spline";
import type { FiberNode } from "../three/loadAsset/fiber";
import { applyDeletionFilter, applyIncludeOnlyFilter, applyViewerHintsToGeometry, centroidKey, findCoplanarCluster } from "../three/loadAsset/viewerHints";
import type { AssetViewerHints, ComponentItem } from "../types/digitalTwin";
import { domainForElementKind } from "../utils/elementDefaults";
import type { ElementKind } from "../types/digitalTwin";
import { isPhysicsPlugin, resolvePortDomain } from "../kinds/_plugin";
import { pluginForKind } from "../kinds/_plugins";
import { isEditableValue } from "../utils/paramLeaves";
import { cleanNumber } from "../utils/numberFormat";

const stlLoader = new STLLoader();
const gltfLoader = new GLTFLoader();
const objLoader = new OBJLoader();

/** Draft row in the PHY Editor's Anchors table (Phase 9.8 ??replaces
 *  the old Faces table). Each anchor has a position + two body-local
 *  axes the user edits directly:
 *    - axisX (nx/ny/nz): propagation / face normal
 *    - axisY (yx/yy/yz): transverse reference (slow axis for PM fiber,
 *                        fast axis for waveplate, transmission axis
 *                        for polarizer, acoustic axis for AOM, etc.)
 *  axisZ is derived as X ? Y on save (after Gram-Schmidt orthogonalizing
 *  Y against X), so we don't store it in the draft. */
type DraftAnchor = {
  id: string;
  px: string;
  py: string;
  pz: string;
  nx: string;
  ny: string;
  nz: string;
  yx: string;
  yy: string;
  yz: string;
  apertureMm: string;
  apertureShape: "rectangle" | "ellipse" | "circle";
  apertureWidthMm: string;
  apertureHeightMm: string;
  /** Coax connector on RF / TTL ports. Empty string = none (optical
   *  anchors). Only edited when the anchor's domain is rf / ttl / trigger
   *  (see the anchor table's per-row gating). */
  connectorType: string;
  /** Display name for anchors sharing an id (rf_switch RF1/RF2, AD9959
   *  CH0..CH3). Empty string = no name (falls back to id on save). The
   *  RF Link panel + solver key throws/channels by this. */
  name: string;
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
  name: string;
  kindId: string;
  wavelengthMinNm: string;
  wavelengthMaxNm: string;
  properties: Record<string, unknown>;
  anchors: DraftAnchor[];
  transitions: DraftTransition[];
  defaultParamsText: string;
  /** Top-level defaultParams keys marked tunable per-instance (alembic 0113). */
  tunableParams: string[];
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
  const props = (asset.properties ?? {}) as Record<string, unknown>;
  // wavelengthRangeNm belongs in the top-level column (edited via the
  // lambda min/max fields), never in the defaultParams JSON. Legacy/seeded
  // assets stranded a copy in defaultParams (older seeding dumped the whole
  // kind template, including wavelengthRangeNm, into the JSON). Hoist it
  // into the lambda fields when the column is empty, and strip it from the
  // JSON so the two views stay in sync and Save doesn't drop it.
  const { wavelengthRangeNm: strayWavelength, ...defaultParamsRest } =
    (asset.defaultParams ?? {}) as Record<string, unknown>;
  const columnRange = asset.wavelengthRangeNm;
  const fallbackRange =
    !columnRange && Array.isArray(strayWavelength) ? strayWavelength : null;
  const minNm = columnRange?.[0] ?? (fallbackRange?.[0] as number | undefined);
  const maxNm = columnRange?.[1] ?? (fallbackRange?.[1] as number | undefined);
  return {
    name: asset.name ?? "",
    kindId: asset.kindId ?? "unclassified",
    wavelengthMinNm: n(minNm),
    wavelengthMaxNm: n(maxNm),
    properties: props,
    anchors: (asset.anchors ?? []).map((rawAnchor) => {
      // The anchors[] JSONB column has historical schema drift: clean
      // Phase 9.1 rows use camelCase (`positionMmBodyLocal`,
      // `axisXBodyLocal`), but older backfills wrote snake_case
      // (`position_mm_body_local`, `direction_body_local`) plus extra
      // `name` / `type` fields. Read both shapes, project down to the
      // editor's draft form (position + axisX as the "normal").
      const a = rawAnchor as Record<string, unknown>;
      const pos = (a.positionMmBodyLocal ?? a.position_mm_body_local ?? {}) as {
        x?: number; y?: number; z?: number;
      };
      const axisX = (a.axisXBodyLocal ?? a.direction_body_local ?? {}) as {
        x?: number; y?: number; z?: number;
      };
      const axisY = (a.axisYBodyLocal ?? {}) as {
        x?: number; y?: number; z?: number;
      };
      const apertureMm = (a.apertureMm ?? a.aperture_mm) as number | undefined;
      const apertureShape = (a.apertureShape ?? a.aperture_shape) as
        | DraftAnchor["apertureShape"]
        | undefined;
      const apertureWidthMm = (a.apertureWidthMm ?? a.aperture_width_mm) as
        | number
        | undefined;
      const apertureHeightMm = (a.apertureHeightMm ?? a.aperture_height_mm) as
        | number
        | undefined;
      const connectorType = (a.connectorType ?? a.connector_type) as
        | string
        | undefined;
      const anchorName = a.name as string | undefined;
      // axisY default = world +Y when unset. The serializer will
      // Gram-Schmidt-orthogonalize it against axisX, so as long as Y
      // isn't parallel to X the result is well-defined.
      return {
        id: String(a.id ?? ""),
        px: n(pos.x),
        py: n(pos.y),
        pz: n(pos.z),
        nx: n(axisX.x),
        ny: n(axisX.y),
        nz: n(axisX.z),
        yx: n(axisY.x ?? 0),
        yy: n(axisY.y ?? 1),
        yz: n(axisY.z ?? 0),
        apertureMm: n(apertureMm),
        apertureShape: apertureShape ?? "circle",
        apertureWidthMm: n(apertureWidthMm),
        apertureHeightMm: n(apertureHeightMm),
        connectorType: connectorType ?? "",
        name: anchorName ?? "",
      };
    }),
    transitions: (asset.transitions ?? []).map((transition) => ({
      in: transition.in,
      viaText: (transition.via ?? []).join(", "),
      outText: Array.isArray(transition.out) ? transition.out.join(", ") : transition.out,
      op: transition.op,
      paramsText: jsonText(transition.params),
      matrix5x5Text: jsonText(transition.matrix5x5),
      abcdText: jsonText(transition.abcd),
    })),
    defaultParamsText: jsonText(defaultParamsRest),
    tunableParams: [...(asset.tunableParams ?? [])],
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

function facePosition(anchor: DraftAnchor): THREE.Vector3 | null {
  const x = readDraftNumber(anchor.px);
  const y = readDraftNumber(anchor.py);
  const z = readDraftNumber(anchor.pz);
  if (x === null || y === null || z === null) return null;
  return new THREE.Vector3(x, y, z);
}

function faceNormal(anchor: DraftAnchor): THREE.Vector3 {
  const x = readDraftNumber(anchor.nx) ?? 0;
  const y = readDraftNumber(anchor.ny) ?? 0;
  const z = readDraftNumber(anchor.nz) ?? 1;
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

function inferProceduralKind(asset: V3Asset): string | null {
  if (asset.kindId) return asset.kindId;
  if (asset.catalogId === "minicircuits_zhl_1_2w_plus") return "rf_amplifier";
  if (asset.catalogId === "minicircuits_zyswa_2_50dr") return "rf_switch";
  if (
    asset.catalogId === "thorlabs_ca2906"
    || asset.catalogId === "generic_rf_cable_sma_to_bnc"
    || asset.catalogId === "generic_rf_cable_bnc_to_bnc"
    || asset.filePath === "primitive://sma_short_cable"
  ) {
    return "rf_cable";
  }
  return null;
}

function proceduralPreviewProperties(asset: V3Asset, kindId: string): Record<string, unknown> {
  const props: Record<string, unknown> = {
    ...(asset.defaultParams ?? {}),
    ...(asset.properties ?? {}),
  };
  if (kindId === "fiber") {
    // Fiber asset specs live in `defaultParams` as `fiberType` ("SM"/
    // "PM"/"MM") + `endAPolish`/`endBPolish` ("PC"/"APC"). The renderer
    // (`createFiberSplineObject`) instead reads a nested
    // `fiberKindParamsOverride` with the long enum names. Bridge the two
    // so each catalog fiber paints its true jacket colour (SM=yellow,
    // PM=blue) and APC ends get the green boot ??without this every
    // fiber falls back to the PM-blue + PC default and they all look
    // identical. The Component preview already works because the fiber
    // *Component* row carries a proper fiberKindParamsOverride.
    const ftRaw = String(props.fiberType ?? "").toUpperCase();
    const fiberType =
      ftRaw === "PM" || ftRaw === "POLARIZATION_MAINTAINING"
        ? "polarization_maintaining"
        : ftRaw === "MM" || ftRaw === "MULTI_MODE"
          ? "multi_mode"
          : "single_mode";
    const normPolish = (v: unknown): "PC" | "UPC" | "APC" | "AR" => {
      const s = String(v ?? "PC").toUpperCase();
      return s === "APC" || s === "UPC" || s === "AR" ? (s as "APC" | "UPC" | "AR") : "PC";
    };
    return {
      ...props,
      fiberKindParamsOverride: {
        fiberType,
        endA: { polish: normPolish(props.endAPolish) },
        endB: { polish: normPolish(props.endBPolish) },
      },
    };
  }
  if (kindId === "rf_cable") {
    if (asset.catalogId === "thorlabs_ca2906") {
      return {
        lengthMm: 152.4,
        cableType: "RG-316",
        connectorType: "sma",
        endAConnector: "sma",
        endBConnector: "sma",
        jacketColor: "#c4a884",
        ...props,
      };
    }
    if (asset.catalogId === "generic_rf_cable_sma_to_bnc") {
      return {
        lengthMm: 300,
        cableType: "RG-316",
        connectorType: "sma",
        endAConnector: "sma",
        endBConnector: "bnc",
        jacketColor: "#c4a884",
        ...props,
      };
    }
    if (asset.catalogId === "generic_rf_cable_bnc_to_bnc") {
      return {
        lengthMm: 300,
        cableType: "RG-58",
        connectorType: "bnc",
        endAConnector: "bnc",
        endBConnector: "bnc",
        jacketColor: "#1f2937",
        ...props,
      };
    }
  }
  return props;
}

function proceduralPreviewModel(asset: V3Asset): string | null {
  if (asset.catalogId === "minicircuits_zhl_1_2w_plus") return "ZHL-1-2W+";
  if (asset.catalogId === "minicircuits_zyswa_2_50dr") return "ZYSWA-2-50DR";
  if (asset.catalogId === "thorlabs_ca2906") return "CA2906";
  if (asset.catalogId === "generic_rf_cable_sma_to_bnc") return "SMA to BNC cable";
  if (asset.catalogId === "generic_rf_cable_bnc_to_bnc") return "BNC cable";
  return null;
}

/** Walks a procedural tube/jacket wrapper, finds the mesh tagged
 *  `userData[roleKey] === "tube"`, and swaps its TubeGeometry for a
 *  CylinderGeometry of equivalent length + radius (Y-axis cylinder
 *  rotated to lie along X). TubeGeometry's Frenet-frame fallback
 *  twists the cross-section by 360簞 on a perfectly-straight curve ??
 *  invisible on smooth uniform-colour cylinders but it shows up on
 *  fibers as a spiral artefact. The replacement is rotationally
 *  symmetric so it can't twist regardless of view angle. */
function replaceSpiralTubeWithCylinder(
  root: THREE.Object3D,
  roleKey: "fiberRole" | "rfCableRole",
): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    if (node.userData?.[roleKey] !== "tube") return;
    const bbox = new THREE.Box3().setFromBufferAttribute(
      node.geometry.attributes.position as THREE.BufferAttribute,
    );
    const size = bbox.getSize(new THREE.Vector3());
    const center = bbox.getCenter(new THREE.Vector3());
    // The procedural tube lies along its longest axis. Use that as the
    // cylinder height; the smaller two extents average to the diameter.
    const axes: Array<["x" | "y" | "z", number]> = [
      ["x", size.x], ["y", size.y], ["z", size.z],
    ];
    axes.sort((a, b) => b[1] - a[1]);
    const heightAxis = axes[0][0];
    const length = axes[0][1];
    const radius = (axes[1][1] + axes[2][1]) / 4; // avg / 2
    const cyl = new THREE.CylinderGeometry(radius, radius, length, 18);
    // CylinderGeometry's default axis is +Y. Re-orient so the cylinder
    // axis matches whichever world axis the tube ran along.
    if (heightAxis === "x") cyl.rotateZ(Math.PI / 2);
    else if (heightAxis === "z") cyl.rotateX(Math.PI / 2);
    cyl.translate(center.x, center.y, center.z);
    node.geometry.dispose();
    node.geometry = cyl;
  });
}

function buildProceduralFaceLocatorModel(asset: V3Asset): THREE.Object3D | null {
  const isProceduralPath =
    asset.assetType === "primitive"
    || asset.filePath.startsWith("primitive://")
    || asset.filePath.startsWith("procedural:");
  if (!isProceduralPath) return null;
  const kindId = inferProceduralKind(asset);
  if (!kindId) return null;
  const component: ComponentItem = {
    id: `face-locator-${asset.id}`,
    name: asset.name,
    kindId,
    brand: asset.catalogId.startsWith("minicircuits_")
      ? "Mini-Circuits"
      : asset.catalogId.startsWith("thorlabs_")
        ? "Thorlabs"
        : "Generic",
    model: proceduralPreviewModel(asset),
    asset3dId: asset.id,
    catalogId: asset.catalogId,
    properties: proceduralPreviewProperties(asset, kindId),
    physicsCapabilities: ["rf"],
  };

  let model: THREE.Object3D | null = null;
  if (kindId === "rf_cable") model = createSmaShortCable(component);
  if (kindId === "rf_amplifier") model = createZhl12wPlusAmplifier(component);
  if (kindId === "rf_switch") model = createRfSwitch(component);
  if (kindId === "fiber") {
    // Fiber preview = same Bezier spline + 2 FC ferrules the lab scene
    // viewer renders. Object Sense paints freshly-spawned fibers as a
    // straight line between two anchor nodes (no curve handles), so we
    // pass an explicit 2-node straight spline here ??overrides the
    // builder's curved default and matches what the user sees in the
    // lab viewer. Centred at origin so it sits inside the body-axes
    // gizmo cluster instead of being offset 50 mm in +Z.
    const straightNodes: FiberNode[] = [
      { posMm: [-150, 0, 0] },
      { posMm: [150, 0, 0] },
    ];
    model = createFiberSplineObject(component, straightNodes);
    // three.js TubeGeometry's Frenet-frame computation twists the
    // cross-section vertices 360簞 around the curve when fed a
    // perfectly-straight CubicBezier (a known artefact ??see e.g.
    // mrdoob/three.js#16040). On the thin yellow / blue / orange
    // fiber jacket that twist shows up as a visible spiral pattern,
    // even though the surface is rotationally symmetric. The thicker
    // RF-cable jacket hides it, which is why the user sees "fiber
    // spirals, rf cable straight". Replace the spiraling tube with a
    // plain CylinderGeometry (no Frenet frame ??no twist).
    replaceSpiralTubeWithCylinder(model, "fiberRole");
  }
  if (!model) return null;

  // Procedural scene renderers are authored in the main viewer's three.js
  // frame (Y-up, units = mm / 100). The face locator uses body-local mm
  // directly, same as STL vertices and anchor coordinates.
  const bodyMm = new THREE.Group();
  bodyMm.add(model);
  bodyMm.scale.setScalar(100);
  bodyMm.rotation.x = Math.PI / 2;
  return bodyMm;
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

/** Build an orthonormal body-local basis from user-provided axisX +
 *  axisY. axisX is normalized; axisY is Gram-Schmidt orthogonalized
 *  against axisX (any component along X is projected out) then
 *  normalized; axisZ = axisX ? axisY. The user-facing axisY *direction*
 *  is preserved as much as possible ??this is the semantic axis (slow
 *  / fast / transmission / acoustic). If axisY is parallel to axisX
 *  (degenerate), fall back to world +Y or +Z whichever is less
 *  parallel to X. */
function deriveOrthonormalBasis(
  ax: { x: number; y: number; z: number },
  ay: { x: number; y: number; z: number },
): {
  axisX: { x: number; y: number; z: number };
  axisY: { x: number; y: number; z: number };
  axisZ: { x: number; y: number; z: number };
} {
  const xLen = Math.hypot(ax.x, ax.y, ax.z);
  if (xLen < 1e-9) {
    throw new Error("axisX direction must be non-zero (set nx/ny/nz)");
  }
  const X = { x: ax.x / xLen, y: ax.y / xLen, z: ax.z / xLen };

  // Pick the user's axisY; fall back to a world axis if degenerate.
  let Yseed = ay;
  if (Math.hypot(ay.x, ay.y, ay.z) < 1e-9) {
    Yseed = Math.abs(X.y) > 0.95 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
  }
  // Gram-Schmidt: Y' = Yseed ??(Yseed繚X) X
  let dotYX = Yseed.x * X.x + Yseed.y * X.y + Yseed.z * X.z;
  let Yp = {
    x: Yseed.x - dotYX * X.x,
    y: Yseed.y - dotYX * X.y,
    z: Yseed.z - dotYX * X.z,
  };
  let yLen = Math.hypot(Yp.x, Yp.y, Yp.z);
  if (yLen < 1e-9) {
    // axisY collapsed onto axisX ??Yseed was parallel to X. Pick a
    // world fallback that's not parallel to X.
    Yseed = Math.abs(X.y) > 0.95 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
    dotYX = Yseed.x * X.x + Yseed.y * X.y + Yseed.z * X.z;
    Yp = {
      x: Yseed.x - dotYX * X.x,
      y: Yseed.y - dotYX * X.y,
      z: Yseed.z - dotYX * X.z,
    };
    yLen = Math.hypot(Yp.x, Yp.y, Yp.z);
  }
  const Y = { x: Yp.x / yLen, y: Yp.y / yLen, z: Yp.z / yLen };
  const Z = {
    x: X.y * Y.z - X.z * Y.y,
    y: X.z * Y.x - X.x * Y.z,
    z: X.x * Y.y - X.y * Y.x,
  };
  return { axisX: X, axisY: Y, axisZ: Z };
}

function draftToPatch(draft: AssetDraft): V3AssetUpdate {
  // Phase 9.8 cutover: editor writes anchors[] only. faces[] and
  // transitions[] are no longer authored here (tracer reads anchors[]).
  const anchors = draft.anchors.map((a, index) => {
    const id = a.id.trim();
    if (!id) throw new Error(`anchor ${index + 1} id is required`);
    const width = readOptionalNumber(a.apertureWidthMm, `${id}.apertureWidthMm`);
    const height = readOptionalNumber(a.apertureHeightMm, `${id}.apertureHeightMm`);
    const { axisX, axisY, axisZ } = deriveOrthonormalBasis(
      {
        x: readNumber(a.nx, `${id}.axisX.x`),
        y: readNumber(a.ny, `${id}.axisX.y`),
        z: readNumber(a.nz, `${id}.axisX.z`),
      },
      {
        x: readNumber(a.yx, `${id}.axisY.x`),
        y: readNumber(a.yy, `${id}.axisY.y`),
        z: readNumber(a.yz, `${id}.axisY.z`),
      },
    );
    return {
      id,
      positionMmBodyLocal: {
        x: readNumber(a.px, `${id}.position.x`),
        y: readNumber(a.py, `${id}.position.y`),
        z: readNumber(a.pz, `${id}.position.z`),
      },
      axisXBodyLocal: axisX,
      axisYBodyLocal: axisY,
      axisZBodyLocal: axisZ,
      apertureMm: readNumber(a.apertureMm, `${id}.apertureMm`),
      apertureShape: a.apertureShape,
      ...(width !== null ? { apertureWidthMm: width } : {}),
      ...(height !== null ? { apertureHeightMm: height } : {}),
      // Only RF / TTL anchors carry a connector; optical anchors leave
      // it empty and the field is omitted (stays null in the JSONB).
      ...(a.connectorType.trim() ? { connectorType: a.connectorType.trim() } : {}),
      // Preserve the per-anchor name (RF1/RF2/TTL, CH0..CH3). Omitted when
      // empty so single-port anchors stay nameless and fall back to id.
      ...(a.name.trim() ? { name: a.name.trim() } : {}),
    };
  });

  const wavelengthMin = readOptionalNumber(draft.wavelengthMinNm, "wavelength min");
  const wavelengthMax = readOptionalNumber(draft.wavelengthMaxNm, "wavelength max");
  const wavelengthRangeNm =
    wavelengthMin === null && wavelengthMax === null
      ? null
      : [wavelengthMin ?? 0, wavelengthMax ?? 0] as [number, number];

  const nameValue = draft.name.trim();
  if (!nameValue) throw new Error("name is required");

  // kind_id is NOT NULL (alembic 0111) — an empty draft falls back to the
  // "unclassified" placeholder rather than clearing the asset's kind.
  const kindIdValue = draft.kindId.trim() || "unclassified";
  // Strict: an asset may only carry defaultParams the kind declares. For
  // kinds with a scalar schema (lens, mirror, …) keys the kind never defined
  // are dropped here so the free-form textarea / legacy rows can't smuggle in
  // typo'd or stale keys (the focalMm / transmission / wavelengthRangeNm drift).
  const defaultParams = strictDefaultParamsForKind(
    kindIdValue,
    readJsonObject(draft.defaultParamsText, "defaultParams"),
  );
  // Keep only tunable flags that still point at a live top-level param, so a
  // flag left over from a removed/renamed param doesn't persist.
  const tunableParams = draft.tunableParams.filter((k) => k in defaultParams);
  return {
    name: nameValue,
    kindId: kindIdValue,
    wavelengthRangeNm,
    anchors,
    defaultParams,
    tunableParams,
    properties: draft.properties,
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

type AssetParamValue = number | boolean | string | number[];

/** The kind's opt-in params (NOT in defaultParams), keyed to their suggested
 *  default. Rendered as BLANK fields whose absence is meaningful — e.g.
 *  plano-convex thick-lens R/n/d: blank → thin-lens, filled → thick-lens. */
function kindOptionalParams(kindId: string): Record<string, AssetParamValue> {
  return (pluginForKind(kindId)?.physics.optionalParams ?? {}) as Record<string, AssetParamValue>;
}

/** The kind's editable scalar/tuple param keys — required `defaultParams` plus
 *  opt-in `optionalParams` — minus the column-owned `wavelengthRangeNm` (edited
 *  via the lambda min/max fields). Empty when the kind has no plugin or only
 *  nested/no params — the caller then keeps the free-form JSON textarea (we
 *  can't constrain a schema we don't have). */
function kindScalarParamKeys(kindId: string): string[] {
  const defaults = (pluginForKind(kindId)?.physics.defaultParams ?? {}) as Record<string, unknown>;
  const required = Object.keys(defaults).filter(
    (k) => k !== "wavelengthRangeNm" && isEditableValue(defaults[k]),
  );
  const optional = Object.keys(kindOptionalParams(kindId)).filter((k) => k !== "wavelengthRangeNm");
  return [...required, ...optional];
}

/** Every param key the kind declares (defaultParams scalar + nested, plus
 *  optional), minus the column-owned `wavelengthRangeNm`. The strict save
 *  filter keeps only these keys on the asset — nested kind keys (e.g. fiber
 *  endA/endB, edited via their dedicated panels) and opt-in keys the user
 *  actually filled survive; keys the kind never declared are dropped. */
function kindAllParamKeys(kindId: string): string[] {
  const defaults = (pluginForKind(kindId)?.physics.defaultParams ?? {}) as Record<string, unknown>;
  return [
    ...Object.keys(defaults).filter((k) => k !== "wavelengthRangeNm"),
    ...Object.keys(kindOptionalParams(kindId)).filter((k) => k !== "wavelengthRangeNm"),
  ];
}

/** Strict filter: drop any defaultParams key the kind doesn't declare. Only
 *  applied when the kind exposes an editable scalar schema (lens, mirror,
 *  polarizer …); kinds with no/empty or nested-only schema (laser_source,
 *  fiber, isolator) are left untouched so nothing is silently wiped. */
function strictDefaultParamsForKind(
  kindId: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (kindScalarParamKeys(kindId).length === 0) return params;
  const keep = new Set(kindAllParamKeys(kindId));
  return Object.fromEntries(Object.entries(params).filter(([k]) => keep.has(k)));
}

/** One kind-param input, styled like the editor's other fields. Mirrors the
 *  Object panel's CoefficientField (跟 object 一樣) minus the override/reset
 *  chrome — the asset editor sets absolute defaults, not per-instance deltas.
 *
 *  `optional` fields render BLANK when unset and emit `undefined` when cleared
 *  (the caller then omits the key). `suggested` is shown as the placeholder so
 *  the user knows the recommended value without it being seeded. */
function AssetParamField({
  name,
  base,
  value,
  optional = false,
  suggested,
  onChange,
}: {
  name: string;
  base: unknown;
  value: unknown;
  optional?: boolean;
  suggested?: AssetParamValue;
  onChange: (v: AssetParamValue | undefined) => void;
}) {
  const labelStyle = { fontSize: 11, color: "#6b7280" } as const;

  // Optional scalar: blank when unset, placeholder = suggested, clear → omit.
  if (optional) {
    const isEmpty = value === undefined || value === null || value === "";
    return (
      <label style={labelStyle}>
        {name}
        <input
          type="number"
          value={isEmpty ? "" : cleanNumber(Number(value))}
          placeholder={suggested !== undefined ? String(suggested) : undefined}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") {
              onChange(undefined);
              return;
            }
            const next = Number(raw);
            if (Number.isFinite(next)) onChange(next);
          }}
          style={INPUT}
        />
      </label>
    );
  }

  if (Array.isArray(base)) {
    const arr = (Array.isArray(value) ? value : base) as number[];
    return (
      <label style={labelStyle}>
        {name}
        <div style={{ display: "flex", gap: 4 }}>
          {arr.map((num, i) => (
            <input
              // eslint-disable-next-line react/no-array-index-key
              key={i}
              type="number"
              value={cleanNumber(num)}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (!Number.isFinite(next)) return;
                const out = [...arr];
                out[i] = next;
                onChange(out);
              }}
              style={INPUT}
            />
          ))}
        </div>
      </label>
    );
  }

  if (typeof base === "boolean") {
    return (
      <label style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 6 }}>
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        {name}
      </label>
    );
  }

  if (typeof base === "string") {
    return (
      <label style={labelStyle}>
        {name}
        <input
          type="text"
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          style={INPUT}
        />
      </label>
    );
  }

  return (
    <label style={labelStyle}>
      {name}
      <input
        type="number"
        value={cleanNumber(Number(value ?? 0))}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        style={INPUT}
      />
    </label>
  );
}

/** Deep-set a leaf value at `path` in a strict, kind-keys-only clone of the
 *  current params (missing required keys seeded from the kind default so one
 *  edit also completes the asset), then return the new bag. Non-kind top-level
 *  keys are dropped; nested structure within a kind key is preserved. */
function setLeafInParams(
  current: Record<string, unknown>,
  kindKeys: string[],
  requiredKeys: string[],
  kindDefaults: Record<string, unknown>,
  path: (string | number)[],
  value: AssetParamValue,
): Record<string, unknown> {
  const clone = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const next: Record<string, unknown> = {};
  for (const k of kindKeys) if (k in current) next[k] = clone(current[k]);
  for (const k of requiredKeys) if (!(k in next) && k in kindDefaults) next[k] = clone(kindDefaults[k]);
  let node = next as Record<string | number, unknown>;
  for (let i = 0; i < path.length - 1; i += 1) {
    const seg = path[i];
    if (node[seg] == null || typeof node[seg] !== "object") {
      node[seg] = typeof path[i + 1] === "number" ? [] : {};
    }
    node = node[seg] as Record<string | number, unknown>;
  }
  node[path[path.length - 1]] = value;
  return next;
}

/** Recursive editor for one kind param: scalars render an input; objects and
 *  arrays recurse so EVERY leaf (number/string/bool) is shown and editable,
 *  labelled by its dotted path (spatialModeX.waistUm, spectrum.components.0.
 *  fwhmMhz). Numeric tuples ([x,y,z]) render as one compact row. No structural
 *  add/remove — leaf values only. */
function ParamTree({
  label,
  value,
  path,
  onLeaf,
}: {
  label: string;
  value: unknown;
  path: (string | number)[];
  onLeaf: (path: (string | number)[], v: AssetParamValue) => void;
}) {
  const labelStyle = { fontSize: 11, color: "#6b7280" } as const;

  if (Array.isArray(value) && value.length > 0 && value.every((x) => typeof x === "number")) {
    const arr = value as number[];
    return (
      <label style={labelStyle}>
        {label}
        <div style={{ display: "flex", gap: 4 }}>
          {arr.map((num, i) => (
            <input
              // eslint-disable-next-line react/no-array-index-key
              key={i}
              type="number"
              value={cleanNumber(num)}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) onLeaf([...path, i], n);
              }}
              style={INPUT}
            />
          ))}
        </div>
      </label>
    );
  }
  if (Array.isArray(value)) {
    return (
      <>
        {value.map((v, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <ParamTree key={i} label={`${label}.${i}`} value={v} path={[...path, i]} onLeaf={onLeaf} />
        ))}
      </>
    );
  }
  if (value && typeof value === "object") {
    return (
      <>
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <ParamTree key={k} label={`${label}.${k}`} value={v} path={[...path, k]} onLeaf={onLeaf} />
        ))}
      </>
    );
  }
  if (typeof value === "boolean") {
    return (
      <label style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 6 }}>
        <input type="checkbox" checked={value} onChange={(e) => onLeaf(path, e.target.checked)} />
        {label}
      </label>
    );
  }
  if (typeof value === "string") {
    return (
      <label style={labelStyle}>
        {label}
        <input type="text" value={value} onChange={(e) => onLeaf(path, e.target.value)} style={INPUT} />
      </label>
    );
  }
  return (
    <label style={labelStyle}>
      {label}
      <input
        type="number"
        value={cleanNumber(Number(value ?? 0))}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onLeaf(path, n);
        }}
        style={INPUT}
      />
    </label>
  );
}

/** Structured, kind-constrained defaultParams editor. Renders EVERY required
 *  kind param — scalars and nested objects/arrays alike (recursing to each
 *  leaf, 跟 object 一樣) — so the asset shows the kind's full param set, plus
 *  any opt-in optionalParams as blank scalar fields. Every write rebuilds the
 *  bag from the kind's keys alone (unknown top-level keys dropped, nested
 *  structure preserved). Shown only when the kind exposes a scalar schema;
 *  otherwise the caller falls back to the raw JSON textarea. */
function DefaultParamsKindFields({
  kindId,
  defaultParamsText,
  onChangeText,
  tunableParams,
  onToggleTunable,
}: {
  kindId: string;
  defaultParamsText: string;
  onChangeText: (text: string) => void;
  /** Top-level keys currently marked tunable per-instance. */
  tunableParams: string[];
  onToggleTunable: (key: string, on: boolean) => void;
}) {
  const kindDefaults = (pluginForKind(kindId)?.physics.defaultParams ?? {}) as Record<string, unknown>;
  const optionalParams = kindOptionalParams(kindId);
  const kindKeys = kindAllParamKeys(kindId);

  // Required = ALL defaultParams keys (scalar + nested); rendered recursively.
  // Optional = opt-in scalar keys rendered blank (omitted unless filled).
  const requiredKeys = Object.keys(kindDefaults).filter((k) => k !== "wavelengthRangeNm");
  const optionalKeys = Object.keys(optionalParams).filter((k) => k !== "wavelengthRangeNm");

  let current: Record<string, unknown> = {};
  try {
    current = readJsonObject(defaultParamsText, "defaultParams");
  } catch {
    current = {};
  }

  const onLeaf = (path: (string | number)[], value: AssetParamValue) => {
    onChangeText(jsonText(setLeafInParams(current, kindKeys, requiredKeys, kindDefaults, path, value)));
  };

  // Optional scalar write: keep current kind keys, set/omit the one optional key.
  const writeOptional = (key: string, value: AssetParamValue | undefined) => {
    const next: Record<string, unknown> = {};
    for (const k of kindKeys) {
      if (k === key) continue;
      const v = k in current ? current[k] : kindDefaults[k];
      if (v !== undefined) next[k] = v;
    }
    if (value !== undefined) next[key] = value;
    onChangeText(jsonText(next));
  };

  const tunableSet = new Set(tunableParams);

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontSize: 10, color: "#9ca3af" }}>
        ✓ tunable = adjustable per-instance (laser power, RF freq…); unchecked
        params are fixed by this asset.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
        {requiredKeys.map((key) => (
          <div key={key} style={{ display: "grid", gap: 2 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "#9ca3af" }}>
              <input
                type="checkbox"
                checked={tunableSet.has(key)}
                onChange={(e) => onToggleTunable(key, e.target.checked)}
              />
              tunable
            </label>
            <ParamTree
              label={key}
              value={key in current ? current[key] : kindDefaults[key]}
              path={[key]}
              onLeaf={onLeaf}
            />
          </div>
        ))}
      </div>
      {optionalKeys.length > 0 && (
        <>
          <div style={{ fontSize: 10, color: "#9ca3af" }}>optional — leave blank to omit</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
            {optionalKeys.map((key) => (
              <AssetParamField
                key={key}
                name={key}
                base={optionalParams[key]}
                value={current[key]}
                optional
                suggested={optionalParams[key]}
                onChange={(v) => writeOptional(key, v)}
              />
            ))}
          </div>
        </>
      )}
    </div>
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

function FaceLocator3D({
  asset,
  draft,
  selectedAnchorIndex,
  onSelectFace,
  onMoveFace,
  onAutoPlaceFace,
  readOnlyGeometry = false,
  onDeleteCluster,
  lockedCentroids,
  onToggleLockCluster,
  onAddLockCluster,
  showLocks = true,
}: {
  asset: V3Asset;
  draft: AssetDraft;
  selectedAnchorIndex: number | null;
  onSelectFace: (index: number) => void;
  onMoveFace: (index: number, position: THREE.Vector3) => void;
  onAutoPlaceFace: (index: number, position: THREE.Vector3, normal: THREE.Vector3) => void;
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
  const selectedAnchorIndexRef = useRef(selectedAnchorIndex);
  const [modelStatus, setModelStatus] = useState<"loading" | "loaded" | "proxy">("loading");
  const [autoPick, setAutoPick] = useState(false);
  const autoPickRef = useRef(autoPick);
  // Picked-face wireframe overlay survives useEffect remounts (which fire on
  // every draft.anchors edit, including the one auto-pick itself triggers).
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
  selectedAnchorIndexRef.current = selectedAnchorIndex;
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
    scene.background = new THREE.Color(VIEWER_BG_LIGHT);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    scene.add(new THREE.HemisphereLight("#dbeafe", VIEWER_GROUND_FILL, 2.4));
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

    const facePositions = draft.anchors
      .map(facePosition)
      .filter((position): position is THREE.Vector3 => position !== null);
    const faceBox = new THREE.Box3();
    for (const position of facePositions) faceBox.expandByPoint(position);
    if (faceBox.isEmpty()) {
      faceBox.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(20, 20, 20));
    }
    const faceSize = faceBox.getSize(new THREE.Vector3());
    const sceneScale = Math.max(faceSize.x, faceSize.y, faceSize.z, 10);
    // Anchor sphere + normal arrow sizing. Shrunk another 5? from the
    // earlier halving (original was sceneScale * 0.08, then 0.04, now
    // 0.008) so the markers stay readable on thin fiber / rf_cable
    // assets without dwarfing the geometry. Arrow LENGTH unchanged
    // (normalLength); only sphere + arrowhead THICKNESS shrink.
    const markerRadius = Math.max(sceneScale * 0.008, 0.5);
    const normalLength = Math.max(sceneScale * 0.6, 12);

    const grid = new THREE.GridHelper(sceneScale * 1.6, 12, VIEWER_GRID_BLACK, VIEWER_GRID_BLACK);
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
      // Thickness shrunk 5? from the earlier halving ??current values:
      //   shaft rad 0.018 ??0.009 ??0.0018
      //   head  rad 0.05  ??0.025 ??0.005
      //   head  len 0.15  ??0.10  ??0.02
      // Length axis (shaftLen) unchanged so the triad still reaches as
      // far as before; only the cylinder/cone thickness shrinks.
      const shaftLen = bodyArmLen * 0.85;
      const shaftRad = bodyArmLen * 0.0018;
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(shaftRad, shaftRad, shaftLen, 12),
        new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false }),
      );
      // Cylinder's local axis is +Y; rotate so it aligns with `dir`.
      shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      shaft.position.copy(dir.clone().multiplyScalar(shaftLen / 2));
      shaft.renderOrder = 50;
      bodyAxesGroup.add(shaft);

      const headLen = bodyArmLen * 0.02;
      const headRad = bodyArmLen * 0.005;
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

    // Model geometry is shown in native Asset/CAD coordinates; anchors are edited in the same frame.
    const modelGroup = new THREE.Group();
    root.add(modelGroup);

    const selectable: THREE.Object3D[] = [];
    const modelMeshes: THREE.Mesh[] = [];
    const markerGroups: THREE.Group[] = [];
    const markerMaterial = new THREE.MeshStandardMaterial({ color: "#22d3ee", emissive: "#0e7490" });
    const selectedMaterial = new THREE.MeshStandardMaterial({ color: "#fbbf24", emissive: "#b45309" });
    markerMaterial.depthTest = false;
    selectedMaterial.depthTest = false;

    draft.anchors.forEach((anchor, index) => {
      const position = facePosition(anchor);
      if (!position) return;
      const normal = faceNormal(anchor);
      const group = new THREE.Group();
      group.position.copy(position);
      group.userData.faceIndex = index;

      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(markerRadius, 20, 14),
        index === selectedAnchorIndex ? selectedMaterial : markerMaterial,
      );
      sphere.renderOrder = 30;
      sphere.userData.faceIndex = index;
      group.add(sphere);
      selectable.push(sphere);

      const aperture = readDraftNumber(anchor.apertureMm) ?? markerRadius * 3;
      // Per-anchor width/height: if user filled them, use them; otherwise
      // default to aperture ? 2 (square / circle inscribed in apertureMm
      // half-extent). Clamped to markerRadius so tiny apertures stay
      // visible.
      const wMm = readDraftNumber(anchor.apertureWidthMm) ?? aperture * 2;
      const hMm = readDraftNumber(anchor.apertureHeightMm) ?? aperture * 2;
      const drawW = Math.max(wMm, markerRadius * 2.8);
      const drawH = Math.max(hMm, markerRadius * 2.8);
      const thickness = Math.max(Math.max(drawW, drawH) * 0.04, markerRadius * 0.2);
      const isInternalFace = /^B\d+/.test(anchor.id);  // B1, B2, ... = internal reflective interface
      const ring = new THREE.Mesh(
        _makeApertureOutlineGeometry(anchor.apertureShape, drawW, drawH, thickness),
        new THREE.MeshBasicMaterial({
          color: index === selectedAnchorIndex ? "#fbbf24" : (isInternalFace ? "#f472b6" : "#38bdf8"),
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
          _makeApertureFillGeometry(anchor.apertureShape, drawW, drawH),
          new THREE.MeshBasicMaterial({
            color: index === selectedAnchorIndex ? "#fbbf24" : "#f472b6",
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

      // Anchor normal arrow. Head length / width shrunk 5? from the
      // earlier halving (0.22 ??0.12 ??0.024 head len; 0.10 ??0.05 ??
      // 0.01 head width) so the arrow reads as a slim line + tiny
      // indicator tip, not a fat cone covering the aperture ring.
      const arrow = new THREE.ArrowHelper(
        normal,
        new THREE.Vector3(),
        normalLength,
        index === selectedAnchorIndex ? "#fbbf24" : "#a78bfa",
        normalLength * 0.024,
        normalLength * 0.01,
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

      const label = makeFaceLabel(anchor.id, index === selectedAnchorIndex ? "#fbbf24" : "#22d3ee");
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
      const firstFaceShape = draft.anchors[0]?.apertureShape;
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
        modelGroup.add(mesh);
      }
      setModelStatus("proxy");
      fitCameraToObject();
    }

    async function loadModel() {
      const path = asset.filePath;
      if (!path) {
        addProxyBox();
        return;
      }
      // Optical table — render the real Newport breadboard the lab viewer
      // draws instead of the generic proxy box. Handled BEFORE
      // buildProceduralFaceLocatorModel because that helper dereferences
      // asset.catalogId (null for the primitive_table asset) and would throw.
      // createNewportOpticalTable authors geometry in the main-viewer ÷100
      // frame; this editor renders body-local raw mm, so scale ×100. No
      // rotation, so it sits Y-up like the lab.
      if (asset.kindId === "optical_table" || path === "primitive://table") {
        const tableMm = new THREE.Group();
        tableMm.add(createNewportOpticalTable());
        tableMm.scale.setScalar(100);
        modelGroup.add(tableMm);
        tableMm.updateMatrixWorld(true);
        tableMm.traverse((child) => {
          if (child instanceof THREE.Mesh) modelMeshes.push(child);
        });
        setModelStatus("loaded");
        fitCameraToObject();
        return;
      }
      const proceduralModel = buildProceduralFaceLocatorModel(asset);
      if (proceduralModel) {
        modelGroup.add(proceduralModel);
        proceduralModel.updateMatrixWorld(true);
        proceduralModel.traverse((child) => {
          if (child instanceof THREE.Mesh) modelMeshes.push(child);
        });
        setModelStatus("loaded");
        fitCameraToObject();
        return;
      }
      if (path.startsWith("primitive://") || path.startsWith("procedural:") || asset.assetType === "primitive") {
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
              modelGroup.add(lockMesh);
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
        modelGroup.add(object);
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
      if (!data || data.faceIndex !== selectedAnchorIndexRef.current) return;
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
        const selectedIdx = selectedAnchorIndexRef.current;
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
  }, [asset.filePath, viewerHintsKey, lockedCentroidsKey, showLocks, draft.anchors, selectedAnchorIndex]);

  const selected = selectedAnchorIndex !== null ? draft.anchors[selectedAnchorIndex] : null;
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

  const autoPickDisabled = selectedAnchorIndex === null || modelStatus !== "loaded";

  return (
    <div style={{ border: "1px solid #38bdf8", background: "#fbfbf8", marginBottom: 10 }}>
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
                  : selectedAnchorIndex === null
                    ? "Select a face marker first"
                    : "Click a triangle or closed loop on the model to auto-center the selected anchor"
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
              title="Ctrl+middle = delete 繚 Shift+middle = lock (keep). Click for one cluster; drag for a screen rectangle. Plain left/right buttons still orbit/pan the camera."
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
  kinds: Array<{ name: string; displayName: string; domains: string[] }>;
  parentDomain: "all" | "optical" | "rf" | "mechanical";
  onChange: (v: string) => void;
}) {
  const scoped = useMemo(() => {
    // "all" filter lists every kind. Otherwise narrow to kinds that
    // include this domain (multi-domain kinds like AOM appear under each
    // of their domains). Empty result falls back to the full list so a
    // mechanical asset can still pick something.
    const filtered =
      parentDomain === "all"
        ? kinds
        : kinds.filter((k) => k.domains.includes(parentDomain));
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
  selectedAnchorIndex,
  setSelectedAnchorIndex,
  parentDomain,
  mode,
  inUse,
}: {
  asset: V3Asset;
  draft: AssetDraft;
  setDraft: (draft: AssetDraft) => void;
  selectedAnchorIndex: number | null;
  setSelectedAnchorIndex: (index: number | null) => void;
  parentDomain: "all" | "optical" | "rf" | "mechanical";
  mode: Asset3DEditorMode;
  /** Asset is placed in a scene — lock connector_type to avoid
   *  retroactively breaking those instances. */
  inUse: boolean;
}) {
  const isBindingDev = mode === "binding-dev";
  const kinds = useKindsStore((s) => s.kinds);

  // face_id is a kind-level contract: kinds.face_template lists which
  // face ids are `required` + `optional` for this kind. Build a closed
  // set from the asset's kind so the face_id picker can offer only
  // those ??typing a freeform id would silently desync the asset from
  // the kind contract and break tracer lookups.
  const faceIdTemplate = useMemo(() => {
    const template = kinds.find((k) => k.name === draft.kindId)?.anchorTemplate as
      | { required?: string[]; optional?: string[] }
      | undefined;
    const required = Array.isArray(template?.required) ? template!.required! : [];
    const optional = Array.isArray(template?.optional) ? template!.optional! : [];
    return { required, optional, all: [...required, ...optional] };
  }, [kinds, draft.kindId]);

  // Per-anchor field relevance, driven entirely by the kind plugin
  // (kinds/<kind>/index.ts → physics.anchors + portDomains):
  //   - domain      → portDomains (rf / ttl / trigger vs optical)
  //   - axisY        → needsFastAxis (slow / fast / transmit transverse axis)
  //   - aperture/... → needsAperture
  //   - connector    → rf / ttl / trigger domain
  // Anything an anchor doesn't use is rendered disabled + blank so the
  // editor only shows the numbers that actually matter for that kind.
  const anchorFieldsOf = useMemo(() => {
    const plugin = pluginForKind(draft.kindId);
    const phys = plugin && isPhysicsPlugin(plugin) ? plugin.physics : null;
    const fastAxis = new Set<string>(phys?.anchors.needsFastAxis ?? []);
    const aperture = new Set<string>(phys?.anchors.needsAperture ?? []);
    return (anchorId: string) => {
      const domain = phys ? resolvePortDomain(plugin!, anchorId) : null;
      const isRf = domain === "rf" || domain === "ttl" || domain === "trigger";
      return {
        domain,
        isRf,
        // RF ports have no transverse/aperture geometry; optical ports
        // gate axisY and aperture on the kind's declared needs.
        showAxisY: !isRf && fastAxis.has(anchorId),
        showAperture: !isRf && aperture.has(anchorId),
        showConnector: isRf,
      };
    };
  }, [draft.kindId]);

  // Anchors are a kind-level contract: the editable anchor list is
  // derived from the selected kind's anchorTemplate, not hand-authored.
  // When a kind is chosen, auto-seed a blank row for every template
  // anchor id (required + optional) the asset is missing, so a freshly
  // imported asset — the backend creates STEP/GLB builds with
  // anchors=[] (v3_catalog.create_asset3d) — shows the kind's anchors
  // instead of an empty table; the user then positions them.
  //
  // Additive only: never drops anchors. Synthesized ids that live
  // outside the template (interaction_center for aom, optical_center for
  // faraday/slab) must survive, and an already-seeded asset
  // (thorlabs_bb1_e03) is left untouched once its template ids exist —
  // so this converges in one pass and never fights the user.
  useEffect(() => {
    const kind = kinds.find((k) => k.name === draft.kindId);
    if (!kind) return;
    const present = new Set(draft.anchors.map((a) => a.id));
    const missing = faceIdTemplate.all.filter((id) => !present.has(id));
    if (missing.length === 0) return;

    // Seed the kind's defaultParams alongside the anchors, but only while
    // the asset still has none. Gating on `missing` means we touch
    // defaultParams exactly once (this first seed pass), so the user can
    // clear them afterwards without the effect re-seeding.
    //
    // wavelengthRangeNm is special: it has a dedicated top-level Asset
    // column (V3Asset.wavelengthRangeNm) edited via the lambda min/max
    // fields below, and on Save the column — not the defaultParams JSON —
    // is authoritative (see toAssetUpdate). So strip it out of the JSON
    // seed and route it to the lambda fields instead; otherwise it lands
    // in defaultParams as a duplicate the lambda fields never reflect and
    // the save silently drops.
    const { wavelengthRangeNm: seedWavelength, ...kindParams } =
      (kind.defaultParams ?? {}) as Record<string, unknown>;
    const seedParams =
      (draft.defaultParamsText.trim() === "" || draft.defaultParamsText.trim() === "{}")
      && Object.keys(kindParams).length > 0;
    const seedWavelengthFields =
      Array.isArray(seedWavelength)
      && draft.wavelengthMinNm.trim() === ""
      && draft.wavelengthMaxNm.trim() === "";
    // Seed the tunable set from the kind's declared state params (∩ the params
    // actually seeded) the first time params land, so a new laser/RF asset is
    // born with sensible per-instance knobs. Only when nothing tunable yet.
    const stateKeys = (pluginForKind(draft.kindId)?.physics.stateParamKeys ?? []) as string[];
    const seedTunable =
      seedParams && draft.tunableParams.length === 0
      && stateKeys.some((k) => k in kindParams);

    setDraft({
      ...draft,
      anchors: [
        ...draft.anchors,
        ...missing.map((id): DraftAnchor => ({
          id,
          px: "0", py: "0", pz: "0",
          nx: "0", ny: "0", nz: "1",
          yx: "0", yy: "1", yz: "0",
          apertureMm: "1",
          apertureShape: "circle",
          apertureWidthMm: "",
          apertureHeightMm: "",
          connectorType: "",
          name: "",
        })),
      ],
      ...(seedParams ? { defaultParamsText: jsonText(kindParams) } : {}),
      ...(seedTunable ? { tunableParams: stateKeys.filter((k) => k in kindParams) } : {}),
      ...(seedWavelengthFields
        ? {
            wavelengthMinNm: n(seedWavelength[0] as number),
            wavelengthMaxNm: n(seedWavelength[1] as number),
          }
        : {}),
    });
  }, [draft, kinds, faceIdTemplate]);

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

  const updateAnchor = (index: number, patch: Partial<DraftAnchor>) => {
    const next = [...draft.anchors];
    next[index] = { ...next[index], ...patch };
    setDraft({ ...draft, anchors: next });
  };

  // Enforce axisY ??axisX on blur: project user's axisY onto the plane
  // perpendicular to axisX (Gram-Schmidt), normalize, write back into
  // the draft. Skips when axisX is degenerate (length ??0) so the user
  // can fix axisX without the helper fighting them. Falls back to the
  // current displayed value if the projection collapses (axisY parallel
  // to axisX) ??leaves the data alone, lets the user choose how to fix.
  const orthogonalizeAnchorY = (index: number) => {
    const a = draft.anchors[index];
    if (!a) return;
    const xv = { x: readDraftNumber(a.nx), y: readDraftNumber(a.ny), z: readDraftNumber(a.nz) };
    const yv = { x: readDraftNumber(a.yx), y: readDraftNumber(a.yy), z: readDraftNumber(a.yz) };
    if (xv.x === null || xv.y === null || xv.z === null) return;
    if (yv.x === null || yv.y === null || yv.z === null) return;
    const xLen = Math.hypot(xv.x, xv.y, xv.z);
    if (xLen < 1e-9) return;
    const Xh = { x: xv.x / xLen, y: xv.y / xLen, z: xv.z / xLen };
    const dot = yv.x * Xh.x + yv.y * Xh.y + yv.z * Xh.z;
    const Yp = {
      x: yv.x - dot * Xh.x,
      y: yv.y - dot * Xh.y,
      z: yv.z - dot * Xh.z,
    };
    const yLen = Math.hypot(Yp.x, Yp.y, Yp.z);
    if (yLen < 1e-9) return;
    updateAnchor(index, {
      yx: mmText(Yp.x / yLen),
      yy: mmText(Yp.y / yLen),
      yz: mmText(Yp.z / yLen),
    });
  };
  const moveFace = (index: number, position: THREE.Vector3) => {
    updateAnchor(index, {
      px: mmText(position.x),
      py: mmText(position.y),
      pz: mmText(position.z),
    });
  };
  const autoPlaceFace = (index: number, position: THREE.Vector3, normal: THREE.Vector3) => {
    updateAnchor(index, {
      px: mmText(position.x),
      py: mmText(position.y),
      pz: mmText(position.z),
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
        selectedAnchorIndex={selectedAnchorIndex}
        onSelectFace={setSelectedAnchorIndex}
        onMoveFace={moveFace}
        onAutoPlaceFace={autoPlaceFace}
        readOnlyGeometry={false}
        onDeleteCluster={handleDeleteCluster}
        lockedCentroids={lockedCentroids}
        onToggleLockCluster={handleToggleLockCluster}
        onAddLockCluster={handleAddLockCluster}
        showLocks={showLocks}
      />

      {/* Identity ??physics_kind is catalog identity, wavelength range
          is physics tuning. Both editable here. */}
      <div style={SECTION_LABEL}>Identity</div>
      <label style={{ display: "block", fontSize: 11, color: "#6b7280", marginBottom: 8 }}>
        name
        <input
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          style={INPUT}
          type="text"
        />
      </label>
      <div style={{ display: "grid", gridTemplateColumns: parentDomain === "rf" ? "minmax(0, 1fr)" : "minmax(0, 1fr) 120px 120px", gap: 8 }}>
        <label style={{ fontSize: 11, color: "#6b7280" }}>
          kind_id
          <KindSelectInline
            value={draft.kindId}
            kinds={kinds}
            parentDomain={parentDomain}
            onChange={(v) => setDraft({ ...draft, kindId: v })}
          />
        </label>
        {parentDomain !== "rf" && (
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

      {/* Anchors are defined by the kind's anchorTemplate and auto-seeded
          above — no manual add/remove. To change which anchors a kind
          has, edit the kind in the Kinds editor. */}
      <div style={SECTION_LABEL}>Anchors ({draft.anchors.length})</div>

      <table style={TABLE}>
        <thead>
          <tr>
            <th style={{ ...TH, width: 110 }}>anchor_id</th>
            <th style={TH}>position x/y/z</th>
            <th style={TH}>axisX (propagation) x/y/z</th>
            <th style={TH}>axisY (slow / fast / transmit) x/y/z</th>
            <th style={{ ...TH, width: 88 }}>aperture</th>
            <th style={{ ...TH, width: 105 }}>shape</th>
            <th style={TH}>width/height</th>
            <th style={{ ...TH, width: 110 }}>connector_type</th>
          </tr>
        </thead>
        <tbody>
          {draft.anchors.map((anchor, index) => {
            const ff = anchorFieldsOf(anchor.id);
            return (
            <tr
              key={`${anchor.id}-${index}`}
              onClick={() => setSelectedAnchorIndex(index)}
              style={{ background: index === selectedAnchorIndex ? "#f3f4f1" : "transparent" }}
            >
              {/* anchor_id is fixed by the kind's anchor template
                  (kinds.face_template) ??Phase 9.8 enforces a 1:1
                  match between asset.anchors[].id and the template's
                  required list, so the editor displays the id as a
                  read-only label. axisY / axisZ are derived from
                  axisX on save (deriveOrthonormalBasis). */}
              <td style={TD}>
                <span style={{ fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>{anchor.id}</span>
              </td>
              {/* Per-anchor `name` (rf_switch RF1/RF2, AD9959 CH0..CH3) is
                  no longer editable here — it's a kind-level RF detail, not
                  a per-asset field. The value still round-trips untouched
                  via draftFromAsset → draftToPatch, so saving an RF asset
                  preserves its channel/throw names; the column is just
                  hidden (optical anchors never use it). */}
              <td style={TD}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
                  <input value={anchor.px} onChange={(event) => updateAnchor(index, { px: event.target.value })} style={INPUT} type="number" step="0.01" />
                  <input value={anchor.py} onChange={(event) => updateAnchor(index, { py: event.target.value })} style={INPUT} type="number" step="0.01" />
                  <input value={anchor.pz} onChange={(event) => updateAnchor(index, { pz: event.target.value })} style={INPUT} type="number" step="0.01" />
                </div>
              </td>
              <td style={TD}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
                  <input value={anchor.nx} onChange={(event) => updateAnchor(index, { nx: event.target.value })} onBlur={() => orthogonalizeAnchorY(index)} style={INPUT} type="number" step="0.01" />
                  <input value={anchor.ny} onChange={(event) => updateAnchor(index, { ny: event.target.value })} onBlur={() => orthogonalizeAnchorY(index)} style={INPUT} type="number" step="0.01" />
                  <input value={anchor.nz} onChange={(event) => updateAnchor(index, { nz: event.target.value })} onBlur={() => orthogonalizeAnchorY(index)} style={INPUT} type="number" step="0.01" />
                </div>
              </td>
              <td style={TD}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
                  <input value={ff.showAxisY ? anchor.yx : ""} disabled={!ff.showAxisY} onChange={(event) => updateAnchor(index, { yx: event.target.value })} onBlur={() => orthogonalizeAnchorY(index)} style={ff.showAxisY ? INPUT : INPUT_DISABLED} type="number" step="0.01" />
                  <input value={ff.showAxisY ? anchor.yy : ""} disabled={!ff.showAxisY} onChange={(event) => updateAnchor(index, { yy: event.target.value })} onBlur={() => orthogonalizeAnchorY(index)} style={ff.showAxisY ? INPUT : INPUT_DISABLED} type="number" step="0.01" />
                  <input value={ff.showAxisY ? anchor.yz : ""} disabled={!ff.showAxisY} onChange={(event) => updateAnchor(index, { yz: event.target.value })} onBlur={() => orthogonalizeAnchorY(index)} style={ff.showAxisY ? INPUT : INPUT_DISABLED} type="number" step="0.01" />
                </div>
              </td>
              <td style={TD}>
                <input value={ff.showAperture ? anchor.apertureMm : ""} disabled={!ff.showAperture} onChange={(event) => updateAnchor(index, { apertureMm: event.target.value })} style={ff.showAperture ? INPUT : INPUT_DISABLED} type="number" step="0.01" />
              </td>
              <td style={TD}>
                <select
                  value={anchor.apertureShape}
                  disabled={!ff.showAperture}
                  onChange={(event) => updateAnchor(index, { apertureShape: event.target.value as V3Face["apertureShape"] })}
                  style={ff.showAperture ? INPUT : INPUT_DISABLED}
                >
                  <option value="circle">circle</option>
                  <option value="ellipse">ellipse</option>
                  <option value="rectangle">rectangle</option>
                </select>
              </td>
              <td style={TD}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                  <input value={ff.showAperture ? anchor.apertureWidthMm : ""} disabled={!ff.showAperture} onChange={(event) => updateAnchor(index, { apertureWidthMm: event.target.value })} style={ff.showAperture ? INPUT : INPUT_DISABLED} type="number" step="0.01" placeholder="w" />
                  <input value={ff.showAperture ? anchor.apertureHeightMm : ""} disabled={!ff.showAperture} onChange={(event) => updateAnchor(index, { apertureHeightMm: event.target.value })} style={ff.showAperture ? INPUT : INPUT_DISABLED} type="number" step="0.01" placeholder="h" />
                </div>
              </td>
              <td style={TD}>
                <select
                  value={ff.showConnector ? anchor.connectorType : ""}
                  disabled={!ff.showConnector || inUse}
                  onChange={(event) => updateAnchor(index, { connectorType: event.target.value })}
                  style={ff.showConnector && !inUse ? INPUT : INPUT_DISABLED}
                >
                  <option value="">—</option>
                  <option value="sma_male">sma_male</option>
                  <option value="sma_female">sma_female</option>
                  <option value="bnc_male">bnc_male</option>
                  <option value="bnc_female">bnc_female</option>
                </select>
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>

      {/* defaultParams are catalog-level (used by the kind's ABCD formula)
          ??Binding dev only. Kinds with a scalar param schema get a
          structured, kind-constrained editor (跟 object 一樣 — you can only
          set params the kind defines); schema-less / nested-only kinds fall
          back to the raw JSON textarea. */}
      {isBindingDev && (
        <>
          <div style={SECTION_LABEL}>defaultParams</div>
          {kindScalarParamKeys(draft.kindId).length > 0 ? (
            <DefaultParamsKindFields
              kindId={draft.kindId}
              defaultParamsText={draft.defaultParamsText}
              onChangeText={(text) => setDraft({ ...draft, defaultParamsText: text })}
              tunableParams={draft.tunableParams}
              onToggleTunable={(key, on) =>
                setDraft({
                  ...draft,
                  tunableParams: on
                    ? [...draft.tunableParams.filter((k) => k !== key), key]
                    : draft.tunableParams.filter((k) => k !== key),
                })
              }
            />
          ) : (
            <textarea
              value={draft.defaultParamsText}
              onChange={(event) => setDraft({ ...draft, defaultParamsText: event.target.value })}
              style={{ ...TEXTAREA, minHeight: 180 }}
            />
          )}
        </>
      )}
    </>
  );
}

export type V3EditorDomain = "optical" | "rf" | "mechanical";

/** Editor mode ??controls which fields are editable.
 *  - "binding-dev": catalog editor. Picks kind, edits asset name +
 *    defaultParams (catalog-level params used by the ABCD formula).
 *    New assets are created in the BUILD tab (import CAD -> coloured
 *    GLB); this editor only edits existing rows. Face geometry inputs
 *    are HIDDEN; faces table only shows id + domain.
 *  - "phy-editor": physics-tuning editor. Adjusts body frame origin
 *    (offset + rotation), per-face position/normal/aperture/shape/
 *    width-height, wavelength min/max, display name. Kind picker and
 *    catalog-level defaultParams are HIDDEN.
 *  Both modes share the 3D face locator visualization; face dragging
 *  is active only in phy-editor mode (binding-dev shows positions
 *  read-only).
 */
export type Asset3DEditorMode = "binding-dev" | "phy-editor";

export function Asset3DEditor({
  domain = "all",
  mode = "binding-dev",
}: { domain?: "all" | V3EditorDomain; mode?: Asset3DEditorMode } = {}) {
  const isBindingDev = mode === "binding-dev";
  const assets = useV3Catalog((state) => state.assets);
  const status = useV3Catalog((state) => state.status);
  const error = useV3Catalog((state) => state.error);
  const fetchAll = useV3Catalog((state) => state.fetchAll);
  const refresh = useV3Catalog((state) => state.refresh);
  const updateAsset = useV3Catalog((state) => state.updateAsset);
  const deleteAsset = useV3Catalog((state) => state.deleteAsset);
  const fetchAssetUsage = useV3Catalog((state) => state.fetchAssetUsage);
  // Reference counts for the selected asset. objectCount > 0 ⇒ placed in a
  // scene, so connector_type editing + Delete are locked (a catalog-level
  // change would retroactively break those instances). null = not loaded.
  const [usage, setUsage] = useState<V3AssetUsage | null>(null);

  const [kindFilter, setKindFilter] = useState<string>("all");
  const [search, setSearch] = useState<string>("");
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AssetDraft | null>(null);
  const [selectedAnchorIndex, setSelectedAnchorIndex] = useState<number | null>(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Per-row lock toggle in-flight tracking (asset id -> busy).
  const [lockBusy, setLockBusy] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (status === "idle") void fetchAll();
  }, [status, fetchAll]);

  // Bootstrap the Kind registry so the kind_id <select> below is
  // populated. Shares state with ComponentsEditor via kindsStore.
  const kinds = useKindsStore((s) => s.kinds);
  const kindsStatus = useKindsStore((s) => s.status);
  const fetchKinds = useKindsStore((s) => s.fetchAll);
  useEffect(() => {
    if (kindsStatus === "idle") void fetchKinds();
  }, [kindsStatus, fetchKinds]);

  // Domain-scoped asset pool. Domain is KIND-AUTHORITATIVE ONLY: an asset
  // appears under exactly its kind's registry domains (`kind.domains`).
  // There is no per-asset properties.domains override and no faces[].domain
  // expansion — to change an asset's domain, edit its kind. (Category is a
  // separate axis that lives on the Component.) Hybrids need no special
  // case: kind=aom already carries domains=["optical","rf"], so it lands in
  // both rails straight from the kind.
  const domainAssets = useMemo(() => {
    return assets.filter((asset) => {
      // "all" filter: every asset, regardless of domain.
      if (domain === "all") return true;
      const rawKind = asset.kindId;
      if (rawKind && rawKind !== "none") {
        const registryKind = kinds.find((k) => k.name === rawKind);
        if (registryKind) return registryKind.domains.includes(domain);
        // Legacy kind not in the DB registry: fall back to the static map.
        return domainForElementKind(rawKind as ElementKind) === domain;
      }
      // No kind / "none" placeholder ⇒ mechanical bucket.
      return domain === "mechanical";
    });
  }, [assets, domain, kinds]);

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

  // Pull reference counts whenever the selected asset changes (keyed on the
  // resolved slug/UUID so a save that only mutates fields doesn't refetch).
  const selectedKey = selected?.catalogId ?? selected?.id ?? null;
  useEffect(() => {
    if (!selectedKey) {
      setUsage(null);
      return;
    }
    let cancelled = false;
    setUsage(null);
    void fetchAssetUsage(selectedKey)
      .then((u) => { if (!cancelled) setUsage(u); })
      .catch(() => { if (!cancelled) setUsage(null); });
    return () => { cancelled = true; };
  }, [selectedKey, fetchAssetUsage]);
  const inUse = (usage?.objectCount ?? 0) > 0;

  useEffect(() => {
    if (!selectedAssetId && filtered.length > 0) {
      setSelectedAssetId(filtered[0].id);
    }
  }, [filtered, selectedAssetId]);

  useEffect(() => {
    if (selected) {
      setDraft(draftFromAsset(selected));
      setSelectedAnchorIndex((selected.anchors?.length ?? 0) > 0 ? 0 : null);
    } else {
      setDraft(null);
      setSelectedAnchorIndex(null);
    }
    setSaveError(null);
  }, [selected?.id]);

  const save = async () => {
    if (!selected || !draft) return;
    // Guardrail: an optical/RF physics asset whose primary anchor is still
    // at the body origin (the auto-seed default) won't interact with beams
    // until it's positioned on the real surface — exactly the trap behind a
    // "mirror that doesn't reflect". Warn (non-blocking) before saving.
    const savedKind = kinds.find((k) => k.name === draft.kindId);
    const isPhysicsKind =
      !!savedKind && savedKind.domains.some((d) => d === "optical" || d === "rf");
    if (isPhysicsKind) {
      const atOrigin = draft.anchors.find(
        (a) => Number(a.px) === 0 && Number(a.py) === 0 && Number(a.pz) === 0,
      );
      if (
        atOrigin &&
        !window.confirm(
          `Anchor "${atOrigin.id}" is at the body origin (0,0,0). If the optical ` +
            `surface isn't there, position it (3D face locator → "auto-pick face ` +
            `center") so beams interact with it. Save anyway?`,
        )
      ) {
        return;
      }
    }
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
      // The Asset3D editor writes to the V3 catalog store (useV3Catalog),
      // but every OTHER consumer of asset data ??the lab viewer, the
      // Optical Link panel, and the PHY editor's Component preview
      // (ComponentsEditor reads useSceneStore.scene.assets) ??reads
      // from the scene store. Without this refresh those views keep
      // rendering the pre-edit asset (e.g. a Component that references
      // io_3_850_hp_back_piece won't pick up anchor / body-frame / mesh
      // edits). loadScene re-fetches the scene and preserves the user's
      // current selection, so the edit propagates everywhere at once.
      void useSceneStore.getState().loadScene();
      const nextAnchorCount = updated.anchors?.length ?? 0;
      setSelectedAnchorIndex((prev) => {
        if (nextAnchorCount === 0) return null;
        if (prev === null || prev >= nextAnchorCount) return 0;
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
      setSelectedAssetId(null);
      setDraft(null);
      // deleteAsset also drops ComponentBinding rows that referenced
      // this asset ??refresh the scene store so the Component preview /
      // lab viewer stop rendering the now-deleted asset + its bindings.
      void useSceneStore.getState().loadScene();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  // Toggle an asset's locked flag. Locked = human-confirmed complete: the
  // backend rejects every write but this toggle, and the editor renders the
  // form read-only. PATCHing only `locked` is the exception the API allows
  // in both directions, so unlock-then-edit is always possible.
  const toggleAssetLock = async (asset: V3Asset) => {
    const key = asset.catalogId ?? asset.id;
    setLockBusy((prev) => ({ ...prev, [asset.id]: true }));
    try {
      await updateAsset(key, { locked: !asset.locked });
    } catch (err) {
      window.alert(`Lock toggle failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLockBusy((prev) => {
        const next = { ...prev };
        delete next[asset.id];
        return next;
      });
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
            <div key={asset.id} style={{ position: "relative" }}>
              <button
                type="button"
                onClick={() => setSelectedAssetId(asset.id)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "6px 30px 6px 8px",
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
              {/* Per-row lock toggle. Locked = human-confirmed complete:
                  read-only form + the API rejects all edits but unlocking. */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void toggleAssetLock(asset);
                }}
                disabled={lockBusy[asset.id]}
                title={
                  asset.locked
                    ? "Locked — confirmed complete. Click to unlock for editing."
                    : "Unlocked. Click to lock (freeze as confirmed complete)."
                }
                style={{
                  position: "absolute",
                  top: 6,
                  right: 6,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 22,
                  height: 22,
                  padding: 0,
                  border: "none",
                  background: "transparent",
                  cursor: lockBusy[asset.id] ? "default" : "pointer",
                  color: asset.locked ? "#b45309" : "#9ca3af",
                }}
              >
                {asset.locked ? <Lock size={13} /> : <Unlock size={13} />}
              </button>
            </div>
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
            {selected && draft && (
              <>
                <IconButton
                  title={selected.locked ? "Locked — unlock to save" : "Save changes"}
                  onClick={() => void save()}
                  disabled={saving || selected.locked}
                >
                  <Save size={14} />
                </IconButton>
                <IconButton
                  title="Revert unsaved changes"
                  onClick={() => {
                    setDraft(draftFromAsset(selected));
                    setSelectedAnchorIndex((selected.anchors?.length ?? 0) > 0 ? 0 : null);
                    setSaveError(null);
                  }}
                  disabled={saving}
                >
                  <X size={15} />
                </IconButton>
                {isBindingDev && (
                  <IconButton
                    title={
                      selected.locked
                        ? "Locked — unlock to delete"
                        : inUse
                          ? `In use by ${usage?.objectCount} placed object(s) — remove them before deleting`
                          : "Delete asset (removes DB row + bindings; catalog JSON untouched)"
                    }
                    onClick={() => void deleteCurrent()}
                    disabled={deleting || inUse || selected.locked}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                )}
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
          {selected && inUse && (
            <div style={{ marginBottom: 10, color: "#fde68a", background: "#78350f", padding: 8, fontSize: 12, borderRadius: 4 }}>
              In use by {usage?.objectCount} placed scene object(s)
              {usage?.componentCount ? ` (${usage.componentCount} component ref(s))` : ""}.
              connector_type editing + Delete are locked — a catalog-level
              change would retroactively break those instances.
            </div>
          )}
          {selected && selected.locked && (
            <div style={{ marginBottom: 10, color: "#fde68a", background: "#78350f", padding: 8, fontSize: 12, borderRadius: 4 }}>
              🔒 Locked — confirmed complete. The form is read-only and saves
              are rejected. Click the lock icon on this asset in the list to
              unlock before editing.
            </div>
          )}
          {selected && draft && (
            // Locked → read-only: pointerEvents:none disables every field at
            // once (no per-input prop threading) and the backend rejects any
            // write anyway. Unlock via the list-row lock button.
            <div
              style={
                selected.locked
                  ? { pointerEvents: "none", opacity: 0.6 }
                  : undefined
              }
            >
              <AssetEditForm
                asset={selected}
                draft={draft}
                setDraft={setDraft}
                selectedAnchorIndex={selectedAnchorIndex}
                setSelectedAnchorIndex={setSelectedAnchorIndex}
                parentDomain={domain}
                mode={mode}
                inUse={inUse}
              />
            </div>
          )}
          {saveError && (
            <div style={{ marginTop: 10, color: "#fecaca", background: "#7f1d1d", padding: 8, fontSize: 12 }}>
              {saveError}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
