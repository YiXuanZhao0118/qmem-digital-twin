// Fiber port anchor resolver.
//
// Fiber port anchors (intercept_in / intercept_out) can opt into being
// "derived" from the live fiber spline endpoints via the
// `Anchor.derivedFromFiberEndpoint` field. When set, the anchor's
// effective body-local position and direction are computed from the
// current `SceneObject.properties.fiberNodes` (or the legacy catalog
// fallback) at read time, so dragging a fiber endpoint in solid view
// automatically moves the port marker, ray-trace intercept, and beam
// coupling site without the user having to re-edit the anchor.
//
// When the spline is missing (un-instantiated catalog template, or
// `fiberNodes` undefined) the helper falls back to the anchor's stored
// `positionMmBodyLocal` / `directionBodyLocal` — same behaviour as
// before this fix.
//
// All consumers that read anchor positions for fiber ports should funnel
// through `resolveAnchorPosition` / `resolveAnchorDirection` so the
// renderer, ray-tracer, and solver agree on where the port physically is.

import type { Anchor } from "../types/digitalTwin";

export type FiberNodePersistent = {
  posMm: [number, number, number];
  handleInMm?: [number, number, number];
  handleOutMm?: [number, number, number];
};

/** Length in mm from the cable-side end of the FC connector (= the
 *  Bezier spline endpoint) to the ferrule tip (= the optical port face).
 *  Matches the cached 30126A9 STL housing length in
 *  `loadAsset.FC_HOUSING_LENGTH_MM` and the inline `TIP` in
 *  `rayTrace.ts`. Anywhere we map between spline endpoint and optical
 *  port lives off this single constant. */
export const FIBER_FERRULE_TIP_MM = 36.28;

function ferruleTipOffsetMm(): number {
  return FIBER_FERRULE_TIP_MM;
}

function endpointIndex(end: "A" | "B", nodes: FiberNodePersistent[]): number {
  return end === "A" ? 0 : nodes.length - 1;
}

/** Outward unit vector at one end of the spline (body-local mm space).
 *  For end A this is `-handleOut`, i.e. the direction the connector
 *  ferrule points (away from the curve body). For end B it's `-handleIn`.
 *  Falls back to the segment direction toward the neighbour if the
 *  handle is missing or zero-length. */
function endpointOutwardBodyLocal(
  nodes: FiberNodePersistent[],
  end: "A" | "B",
): { x: number; y: number; z: number } {
  const idx = endpointIndex(end, nodes);
  const neighbourIdx = end === "A" ? 1 : nodes.length - 2;
  const node = nodes[idx];
  const neighbour = nodes[neighbourIdx];
  const handle = end === "A" ? node.handleOutMm : node.handleInMm;
  if (handle && handle[0] ** 2 + handle[1] ** 2 + handle[2] ** 2 > 1e-9) {
    const mag = Math.hypot(handle[0], handle[1], handle[2]);
    return { x: -handle[0] / mag, y: -handle[1] / mag, z: -handle[2] / mag };
  }
  const dx = node.posMm[0] - neighbour.posMm[0];
  const dy = node.posMm[1] - neighbour.posMm[1];
  const dz = node.posMm[2] - neighbour.posMm[2];
  const mag = Math.hypot(dx, dy, dz);
  if (mag < 1e-9) return { x: 0, y: 1, z: 0 };
  return { x: dx / mag, y: dy / mag, z: dz / mag };
}

/** Effective body-local position of an anchor — derived from the fiber
 *  spline endpoint + ferrule-tip offset when `derivedFromFiberEndpoint`
 *  is set and the spline is available; otherwise the stored
 *  `positionMmBodyLocal` (same as the pre-fix behaviour). */
export function resolveAnchorPosition(
  anchor: Anchor,
  fiberNodes: FiberNodePersistent[] | undefined,
): { x: number; y: number; z: number } {
  const end = anchor.derivedFromFiberEndpoint;
  if (!end || !fiberNodes || fiberNodes.length < 2) {
    return anchor.positionMmBodyLocal;
  }
  const idx = endpointIndex(end, fiberNodes);
  const base = fiberNodes[idx].posMm;
  const outward = endpointOutwardBodyLocal(fiberNodes, end);
  const tipMm = ferruleTipOffsetMm();
  return {
    x: base[0] + outward.x * tipMm,
    y: base[1] + outward.y * tipMm,
    z: base[2] + outward.z * tipMm,
  };
}

/** Effective body-local direction of an anchor. For derived fiber ports
 *  this is the spline tangent at the endpoint, oriented outward (away
 *  from the cable body). Falls back to `directionBodyLocal` (or +Y when
 *  that's missing). */
export function resolveAnchorDirection(
  anchor: Anchor,
  fiberNodes: FiberNodePersistent[] | undefined,
): { x: number; y: number; z: number } {
  const end = anchor.derivedFromFiberEndpoint;
  if (!end || !fiberNodes || fiberNodes.length < 2) {
    return anchor.directionBodyLocal ?? { x: 0, y: 1, z: 0 };
  }
  return endpointOutwardBodyLocal(fiberNodes, end);
}

/** Convenience: pulls the resolved fiberNodes off a SceneObject's
 *  properties, falling back to the Component catalog template for
 *  legacy data. Mirrors the same precedence used by the writers in
 *  `sceneStore.updateFiberNodes` and the readers in DigitalTwinViewer /
 *  ComponentPanel. Pass the result to `resolveAnchorPosition` /
 *  `resolveAnchorDirection`. */
export function resolveFiberNodes(
  objectProperties: unknown,
  componentProperties: unknown,
): FiberNodePersistent[] | undefined {
  const objNodes = (objectProperties as { fiberNodes?: FiberNodePersistent[] } | null | undefined)
    ?.fiberNodes;
  if (Array.isArray(objNodes) && objNodes.length >= 2) return objNodes;
  const compNodes = (componentProperties as { fiberNodes?: FiberNodePersistent[] } | null | undefined)
    ?.fiberNodes;
  if (Array.isArray(compNodes) && compNodes.length >= 2) return compNodes;
  return undefined;
}
