// Auto-snap an object's lab-frame position onto the centerline of a nearby
// OpticalLink. Used when the user types/drags a position close to an existing
// beam path so the element clicks onto the line.
//
// Lab frame: { x, y, z } in mm.

import type { OpticalLink, SceneObject } from "../types/digitalTwin";

export type LabPoint = { x: number; y: number; z: number };

export type BeamSnapResult = {
  snappedPoint: LabPoint;
  linkId: string;
  distanceMm: number;
};

function sub(a: LabPoint, b: LabPoint): LabPoint {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function add(a: LabPoint, b: LabPoint): LabPoint {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scale(v: LabPoint, s: number): LabPoint {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function dot(a: LabPoint, b: LabPoint): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function length(v: LabPoint): number {
  return Math.hypot(v.x, v.y, v.z);
}

// Closest point on the SEGMENT (not the infinite line) [a, b] to point p.
function closestPointOnSegment(p: LabPoint, a: LabPoint, b: LabPoint): { point: LabPoint; t: number } {
  const ab = sub(b, a);
  const lenSq = dot(ab, ab);
  if (lenSq < 1e-9) {
    return { point: a, t: 0 };
  }
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / lenSq));
  return { point: add(a, scale(ab, t)), t };
}

/**
 * Find the nearest OpticalLink centerline within `thresholdMm` of `point`,
 * and return the projected point + link ID + distance. Returns null when no
 * link is close enough.
 *
 * `excludeComponentId` skips any link that touches this component (we don't
 * want a moving element to snap onto its own outgoing/incoming line).
 */
export function snapToBeamCenterline(
  point: LabPoint,
  links: OpticalLink[],
  objects: SceneObject[],
  options: {
    thresholdMm?: number;
    excludeComponentId?: string;
  } = {},
): BeamSnapResult | null {
  const threshold = options.thresholdMm ?? 25;
  const exclude = options.excludeComponentId ?? null;

  let best: BeamSnapResult | null = null;
  const objectByComponentId = new Map<string, SceneObject>();
  for (const obj of objects) {
    if (!objectByComponentId.has(obj.componentId)) {
      objectByComponentId.set(obj.componentId, obj);
    }
  }

  for (const link of links) {
    if (exclude && (link.fromObjectId === exclude || link.toObjectId === exclude)) {
      continue;
    }
    const fromObj = objectByComponentId.get(link.fromObjectId);
    const toObj = objectByComponentId.get(link.toObjectId);
    if (!fromObj || !toObj) continue;
    const a = { x: fromObj.xMm, y: fromObj.yMm, z: fromObj.zMm };
    const b = { x: toObj.xMm, y: toObj.yMm, z: toObj.zMm };
    if (length(sub(b, a)) < 1e-3) continue;

    const { point: projected } = closestPointOnSegment(point, a, b);
    const distance = length(sub(point, projected));
    if (distance <= threshold && (!best || distance < best.distanceMm)) {
      best = {
        snappedPoint: projected,
        linkId: link.id,
        distanceMm: distance,
      };
    }
  }

  return best;
}
