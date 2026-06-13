import * as THREE from "three";

import type { ComponentItem, DeviceState } from "../../../types/digitalTwin";
import { getNumericProperty, mmToThree } from "../../transformUtils";
import { ddsCableTanMat } from "../materials";
import {
  buildFiberCurvePath,
  fiberEndpointOutwardThree,
  labMmToFiberThree,
  type FiberNode,
} from "../fiber";
import {
  buildRfConnectorGroup,
  normalizeRfConnectorKind,
  type RfConnectorKind,
} from "./connectorModels";
import { readCableAppearance } from "../cableAppearance";

/** Resolve which connector to draw at each cable end. Reads
 *  `properties.endAConnector` / `properties.endBConnector` (preferred), then
 *  falls back to `properties.connectorType` for the legacy single-typed
 *  catalog rows (e.g. the original Thorlabs CA2906 SMA-SMA jumper). The
 *  stored tokens are still family-only ("sma" / "bnc"); they normalise to
 *  the male plug until per-end gender lands with the connector-asset binding
 *  refactor (0116). */
function rfCableEndConnectors(
  component: ComponentItem,
): { a: RfConnectorKind; b: RfConnectorKind } {
  const props = (component.properties ?? {}) as Record<string, unknown>;
  const read = (key: string): RfConnectorKind | null => {
    const v = props[key];
    return typeof v === "string" ? normalizeRfConnectorKind(v) : null;
  };
  const fallback = read("connectorType") ?? "sma_male";
  return {
    a: read("endAConnector") ?? fallback,
    b: read("endBConnector") ?? fallback,
  };
}

function buildRfCableConnector(kind: RfConnectorKind): THREE.Group {
  // Prefer the real catalog model (data-driven, cached); fall back to the
  // procedural connector (gender-aware) while the model loads or if no asset
  // is mapped.
  return buildRfConnectorGroup(kind);
}

/** Bezier-spline RF cable renderer — used when the SceneObject carries
 *  per-instance `properties.rfCableNodes`. Parallels `createFiberSplineObject`:
 *  TubeGeometry follows the curve, the two endpoint connectors are placed
 *  with their +X axes aligned to the outward tangents so the connector
 *  orientation tracks node drag in real time. Per-end connector type is
 *  resolved from `component.properties.endAConnector` / `endBConnector` so
 *  the same renderer covers the SMA-SMA, SMA-BNC and BNC-BNC catalog rows. */
function createSmaCableSpline(
  component: ComponentItem,
  nodes: FiberNode[],
): THREE.Object3D {
  const group = new THREE.Group();
  // Tag the wrapper so the node-edit mode's traversal can recognise this
  // as an rf_cable instance. The outer wrapper (assigned by
  // DigitalTwinViewer at load time) carries the per-instance `objectId`;
  // tube + wrapper here only need to be discoverable by role.
  group.userData.rfCableRole = "wrapper";
  group.userData.rfCableComponentId = component.id;

  // RG-316 reddish-brown jacket — TubeGeometry sweeps the jacket radius
  // circle along the Bezier path. cableAppearance overrides the default
  // colour (#c4a884) / radius (1.6 mm); 64 longitudinal × 14 radial segments.
  const appearance = readCableAppearance(component.properties);
  const radiusMm = appearance.radiusMm ?? 1.6;
  const jacketMat = appearance.jacketColorHex
    ? new THREE.MeshStandardMaterial({ color: appearance.jacketColorHex, metalness: 0.1, roughness: 0.6 })
    : ddsCableTanMat;
  const path = buildFiberCurvePath(nodes);
  const jacket = new THREE.Mesh(
    new THREE.TubeGeometry(path, 64, mmToThree(radiusMm), 14, false),
    jacketMat,
  );
  jacket.userData.rfCableRole = "tube";
  group.add(jacket);

  const ends = rfCableEndConnectors(component);
  const xAxis = new THREE.Vector3(1, 0, 0);
  for (const end of ["A", "B"] as const) {
    const idx = end === "A" ? 0 : nodes.length - 1;
    const connector = buildRfCableConnector(end === "A" ? ends.a : ends.b);
    const nodePos = labMmToFiberThree(nodes[idx].posMm);
    const outward = fiberEndpointOutwardThree(nodes, end);
    connector.quaternion.setFromUnitVectors(xAxis, outward);
    connector.position.copy(nodePos);
    // Tag so the node-edit re-render can find each endpoint connector and
    // re-orient it after the spline changes.
    connector.userData.rfCableConnectorEndpoint = end;
    group.add(connector);
  }

  return group;
}

/** Reapply position + quaternion for one rf_cable SMA-male connector
 *  after the underlying spline has been edited. Called by the node-edit
 *  pointer handlers in `DigitalTwinViewer` so connectors track endpoint
 *  drags without rebuilding the whole spline. */
export function applyRfCableConnectorTransform(
  connector: THREE.Object3D,
  nodes: FiberNode[],
  endpoint: "A" | "B",
): void {
  if (nodes.length < 2) return;
  const idx = endpoint === "A" ? 0 : nodes.length - 1;
  const nodePos = labMmToFiberThree(nodes[idx].posMm);
  const outward = fiberEndpointOutwardThree(nodes, endpoint);
  connector.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), outward);
  connector.position.copy(nodePos);
}

export function createSmaShortCable(
  component: ComponentItem,
  _state?: DeviceState,
  /** Per-instance Bezier nodes. When absent or < 2 nodes, a straight
   *  2-node default spline is auto-generated from `component.properties
   *  .lengthMm` so every rf_cable instance is ready for node-drag editing
   *  without needing a catalog template or backend bootstrap. */
  rfCableNodes?: FiberNode[],
): THREE.Object3D {
  let nodes = rfCableNodes;
  if (!nodes || nodes.length < 2) {
    // Default 2-node straight spline centred on the object origin so a
    // freshly-spawned cable renders symmetrically (matches the old
    // straight-cylinder convention where the jacket was centred at
    // `cable.position = 0`).
    const lengthMm = getNumericProperty(component.properties, "lengthMm", 150);
    nodes = [
      { posMm: [-lengthMm / 2, 0, 0] },
      { posMm: [lengthMm / 2, 0, 0] },
    ];
  }
  return createSmaCableSpline(component, nodes);
}

/** Re-apply rf_cable Bezier tube + SMA-male connector transforms in
 *  place against an existing wrapper. Used in the DigitalTwinViewer
 *  cache-hit path so the cable's geometry tracks per-instance spline
 *  edits (node drag in node-edit mode) AND linked endpoint movement
 *  (Align-RF target SceneObject pose changes) without rebuilding the
 *  whole wrapper. Mirrors `refreshFiberWrapperGeometry`. */
export function refreshRfCableWrapperGeometry(
  wrapper: THREE.Object3D,
  nodes: FiberNode[],
): boolean {
  if (!nodes || nodes.length < 2) return false;
  let tubeMesh: THREE.Mesh | null = null;
  const connectors: { conn: THREE.Object3D; endpoint: "A" | "B" }[] = [];
  wrapper.traverse((node) => {
    if (!tubeMesh && (node as THREE.Mesh).isMesh && node.userData?.rfCableRole === "tube") {
      tubeMesh = node as THREE.Mesh;
    }
    const ep = node.userData?.rfCableConnectorEndpoint;
    if (ep === "A" || ep === "B") connectors.push({ conn: node, endpoint: ep });
  });
  if (!tubeMesh) return false;

  const path = buildFiberCurvePath(nodes);
  const tubularSegments = Math.max(64, (nodes.length - 1) * 32);
  const newGeom = new THREE.TubeGeometry(path, tubularSegments, mmToThree(1.6), 14, false);
  const old = (tubeMesh as THREE.Mesh).geometry;
  (tubeMesh as THREE.Mesh).geometry = newGeom;
  old.dispose();

  for (const { conn, endpoint } of connectors) {
    applyRfCableConnectorTransform(conn, nodes, endpoint);
  }
  return true;
}
