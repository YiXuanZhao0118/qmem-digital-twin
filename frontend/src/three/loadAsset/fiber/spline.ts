import * as THREE from "three";

import type { ComponentItem } from "../../../types/digitalTwin";
import {
  applyEulerXYZQuat,
  applyFiberConnectorTransform,
  applyFiberFerruleOrientation,
  buildFiberCurvePath,
} from "./curve";
import { buildFcConnectorMesh } from "./thorlabs_30126a9_fc_connector";
import type { FiberEndPlacement, FiberNode, FiberType, Polish } from "./types";

// Jacket colours follow the Thorlabs colour-coding convention used in the
// product photos: yellow for SM single-mode, blue for PM polarization-
// maintaining, orange for MM multi-mode. This is also the boot colour used
// on PC ends (APC ends are always green by industry convention).
const FIBER_JACKET_COLOR: Record<FiberType, string> = {
  single_mode: "#facc15",            // yellow (Thorlabs SM PVC / Hytrel jacket)
  polarization_maintaining: "#1d4ed8", // deep blue (Thorlabs PM jacket)
  multi_mode: "#fb923c",             // orange (typical OM-series MM cable)
};

const APC_BOOT_COLOR = "#16a34a";    // bright green — industry standard for APC

function pickFiberType(component: ComponentItem): FiberType {
  const props = component.properties as
    | { fiberKindParamsOverride?: { fiberType?: string } }
    | undefined;
  const t = props?.fiberKindParamsOverride?.fiberType;
  if (t === "single_mode" || t === "multi_mode" || t === "polarization_maintaining") {
    return t;
  }
  // Default in DEFAULT_KIND_PARAMS["fiber"] is PM, mirror that here.
  return "polarization_maintaining";
}

function pickEndPolish(component: ComponentItem, endpoint: "A" | "B"): Polish {
  const props = component.properties as
    | {
        fiberKindParamsOverride?: {
          endA?: { polish?: string };
          endB?: { polish?: string };
        };
      }
    | undefined;
  const raw =
    endpoint === "A"
      ? props?.fiberKindParamsOverride?.endA?.polish
      : props?.fiberKindParamsOverride?.endB?.polish;
  if (raw === "PC" || raw === "UPC" || raw === "APC" || raw === "AR") return raw;
  return "PC";
}

/** Refresh a previously-built fiber wrapper's procedural geometry to
 *  match a new node array / jacket radius, without rebuilding the
 *  whole wrapper. Walks the wrapper tree, finds the tube mesh + the two
 *  FC connector groups (tagged by `userData.fiberRole` and
 *  `userData.fiberConnectorEndpoint`), and:
 *    - rebuilds the TubeGeometry from the new Bezier path / radius,
 *    - re-applies `applyFiberConnectorTransform` for each connector.
 *  The old tube geometry is disposed so the GPU buffer doesn't leak.
 *
 *  Called from DigitalTwinViewer's cache-hit branch when the fiber's
 *  per-instance `SceneObject.properties.fiberNodes` / `.radiusMm`
 *  changed but the wrapper itself is being reused. Without this the
 *  procedural fiber would visually freeze on its initial pose while
 *  the underlying spline/anchor data evolves. Returns true if a tube
 *  mesh was found and updated; false when the wrapper doesn't contain
 *  a fiber sub-tree (caller can fall through to wrapper-rebuild). */
export function refreshFiberWrapperGeometry(
  wrapper: THREE.Object3D,
  nodes: FiberNode[],
  radiusMm: number,
  /** alembic 0056: when provided, ferrules are re-placed at the body-
   *  local poses from fiber PE.kindParams.endA / endB instead of being
   *  derived from spline tangent. Pass null for the legacy fallback
   *  (catalog preview, very old data). */
  endA?: FiberEndPlacement | null,
  endB?: FiberEndPlacement | null,
): boolean {
  if (!nodes || nodes.length < 2) return false;
  let tubeMesh: THREE.Mesh | null = null;
  const connectors: { conn: THREE.Object3D; endpoint: "A" | "B" }[] = [];
  wrapper.traverse((node) => {
    if (!tubeMesh && (node as THREE.Mesh).isMesh && node.userData?.fiberRole === "tube") {
      tubeMesh = node as THREE.Mesh;
    }
    const ep = node.userData?.fiberConnectorEndpoint;
    if (ep === "A" || ep === "B") connectors.push({ conn: node, endpoint: ep });
  });
  if (!tubeMesh) return false;

  const path = buildFiberCurvePath(nodes);
  const tubularSegments = Math.max(64, (nodes.length - 1) * 32);
  const newGeom = new THREE.TubeGeometry(
    path,
    tubularSegments,
    Math.max(radiusMm, 0.01) / 100,
    12,
    false,
  );
  const old = (tubeMesh as THREE.Mesh).geometry;
  (tubeMesh as THREE.Mesh).geometry = newGeom;
  old.dispose();

  for (const { conn, endpoint } of connectors) {
    const placement = endpoint === "A" ? endA : endB;
    if (placement) {
      // posMm = BACK of connector (mesh origin). STL extends to tip
      // along its local +Y, which applyFiberFerruleOrientation rotates
      // to -unit(tension). Visible tip ends up at posMm + outward * 36.
      conn.position.set(
        placement.posMm[0] / 100,
        placement.posMm[2] / 100,
        -placement.posMm[1] / 100,
      );
      const mag = Math.hypot(
        placement.tensionHandleMm[0],
        placement.tensionHandleMm[1],
        placement.tensionHandleMm[2],
      );
      if (mag < 1e-9) {
        applyEulerXYZQuat(conn, placement.rotDeg);
      } else {
        applyFiberFerruleOrientation(conn, placement.tensionHandleMm, placement.rotDeg);
      }
    } else {
      applyFiberConnectorTransform(conn, nodes, endpoint);
    }
  }
  return true;
}

export function createFiberSplineObject(
  component: ComponentItem,
  /** Per-instance overrides — preferred over the component's catalog
   *  defaults when present. fiberNodes (the spline) and radiusMm (the
   *  jacket thickness) are both per-instance per V2: each fiber cable
   *  in the scene should have its own spline shape. */
  objectFiberNodes?: FiberNode[],
  objectRadiusMm?: number,
  /** alembic 0056 (2026-05-17): End A / End B pose from the fiber PE
   *  kindParams (body-local frame). When provided, the ferrules are
   *  placed AT these poses directly (decoupled from spline tangent).
   *  When omitted (catalog preview, very old data), the renderer
   *  reverts to applyFiberConnectorTransform deriving ferrule pose
   *  from the spline tangent at each end. */
  endA?: FiberEndPlacement | null,
  endB?: FiberEndPlacement | null,
): THREE.Object3D {
  const compProps = (component.properties as { fiberNodes?: FiberNode[]; radiusMm?: number } | undefined) ?? {};
  const resolvedNodes: FiberNode[] | undefined =
    (objectFiberNodes && objectFiberNodes.length >= 2)
      ? objectFiberNodes
      : (compProps.fiberNodes && compProps.fiberNodes.length >= 2)
        ? compProps.fiberNodes
        : undefined;
  const nodes: FiberNode[] = resolvedNodes ?? [
    { posMm: [0, 0, 50], handleOutMm: [100, 0, 0] },
    { posMm: [300, 0, 50], handleInMm: [-100, 0, 0] },
  ];
  const radiusMm =
    typeof objectRadiusMm === "number" && objectRadiusMm > 0
      ? objectRadiusMm
      : typeof compProps.radiusMm === "number" && compProps.radiusMm > 0
        ? compProps.radiusMm
        : 1.0;

  const fiberType = pickFiberType(component);
  const jacketColor = FIBER_JACKET_COLOR[fiberType];
  const polishA = endA?.polish ?? pickEndPolish(component, "A");
  const polishB = endB?.polish ?? pickEndPolish(component, "B");
  const bootColorA = polishA === "APC" ? APC_BOOT_COLOR : jacketColor;
  const bootColorB = polishB === "APC" ? APC_BOOT_COLOR : jacketColor;

  const path = buildFiberCurvePath(nodes);
  const tubularSegments = Math.max(64, (nodes.length - 1) * 32);
  const geometry = new THREE.TubeGeometry(path, tubularSegments, radiusMm / 100, 12, false);

  const jacket = new THREE.MeshStandardMaterial({
    color: jacketColor,
    metalness: 0.05,
    roughness: 0.55,
  });
  const tube = new THREE.Mesh(geometry, jacket);
  tube.castShadow = true;
  tube.receiveShadow = true;
  tube.name = `${component.name}__tube`;
  tube.userData.fiberRole = "tube";

  const group = new THREE.Group();
  group.name = component.name;
  group.userData.fiberComponentId = component.id;
  group.userData.fiberType = fiberType;
  group.add(tube);

  // Place each ferrule. Contract (2026-05-17, clarified):
  //   kindParams.endA/B.posMm = BACK of connector (= junction with wire
  //   = mesh origin). Mesh extends from its local origin (cable end at
  //   y=0) along +Y for FIBER_FERRULE_TIP_MM to its tip (= optical
  //   port). applyFiberFerruleOrientation rotates local +Y to point
  //   along -unit(tension) (= outward, away from the wire), so the
  //   visible tip lands at `posMm + outward · FIBER_FERRULE_TIP_MM` —
  //   which is exactly where the anchor/BEAM also lands.
  const placeFerruleAtJunction = (
    conn: THREE.Object3D,
    placement: FiberEndPlacement,
  ) => {
    conn.position.set(
      placement.posMm[0] / 100,
      placement.posMm[2] / 100,
      -placement.posMm[1] / 100,
    );
    const tau = placement.tensionHandleMm;
    const mag = Math.hypot(tau[0], tau[1], tau[2]);
    if (mag < 1e-9) {
      applyEulerXYZQuat(conn, placement.rotDeg);
    } else {
      applyFiberFerruleOrientation(conn, tau, placement.rotDeg);
    }
  };

  const connA = buildFcConnectorMesh({ polish: polishA, bootColor: bootColorA });
  connA.userData.fiberConnectorEndpoint = "A";
  if (endA) placeFerruleAtJunction(connA, endA);
  else applyFiberConnectorTransform(connA, nodes, "A");
  group.add(connA);
  const connB = buildFcConnectorMesh({ polish: polishB, bootColor: bootColorB });
  connB.userData.fiberConnectorEndpoint = "B";
  if (endB) placeFerruleAtJunction(connB, endB);
  else applyFiberConnectorTransform(connB, nodes, "B");
  group.add(connB);

  return group;
}
