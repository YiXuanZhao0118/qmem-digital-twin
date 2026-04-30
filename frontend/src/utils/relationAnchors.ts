import type { Anchor, Asset3D, AssemblyRelation, ComponentItem, GeometrySelector, SceneObject } from "../types/digitalTwin";

export type VecObject = { x: number; y: number; z: number };

export type AnchorOption = {
  label: string;
  selector: GeometrySelector;
};

export const anchorOptions: AnchorOption[] = [
  { label: "Center", selector: { kind: "point", name: "Center", anchorId: "center" } },
  { label: "+X face", selector: { kind: "face", name: "+X", anchorId: "+x", normal: [1, 0, 0], localDirection: { x: 1, y: 0, z: 0 } } },
  { label: "-X face", selector: { kind: "face", name: "-X", anchorId: "-x", normal: [-1, 0, 0], localDirection: { x: -1, y: 0, z: 0 } } },
  { label: "+Y face", selector: { kind: "face", name: "+Y", anchorId: "+y", normal: [0, 1, 0], localDirection: { x: 0, y: 1, z: 0 } } },
  { label: "-Y face", selector: { kind: "face", name: "-Y", anchorId: "-y", normal: [0, -1, 0], localDirection: { x: 0, y: -1, z: 0 } } },
  { label: "+Z face", selector: { kind: "face", name: "+Z", anchorId: "+z", normal: [0, 0, 1], localDirection: { x: 0, y: 0, z: 1 } } },
  { label: "-Z face", selector: { kind: "face", name: "-Z", anchorId: "-z", normal: [0, 0, -1], localDirection: { x: 0, y: 0, z: -1 } } },
];

export function normalizeAnchorId(anchorId: string | undefined | null): string {
  if (!anchorId) return "center";

  const value = String(anchorId).trim().toLowerCase();

  const aliases: Record<string, string> = {
    center: "center",
    centre: "center",

    "+x": "+x",
    "x+": "+x",
    "+x face": "+x",
    "+xface": "+x",
    "positive x": "+x",
    right: "+x",

    "-x": "-x",
    "x-": "-x",
    "-x face": "-x",
    "-xface": "-x",
    "negative x": "-x",
    left: "-x",

    "+y": "+y",
    "y+": "+y",
    "+y face": "+y",
    "+yface": "+y",
    "positive y": "+y",
    top: "+y",

    "-y": "-y",
    "y-": "-y",
    "-y face": "-y",
    "-yface": "-y",
    "negative y": "-y",
    bottom: "-y",

    "+z": "+z",
    "z+": "+z",
    "+z face": "+z",
    "+zface": "+z",
    "positive z": "+z",
    front: "+z",

    "-z": "-z",
    "z-": "-z",
    "-z face": "-z",
    "-zface": "-z",
    "negative z": "-z",
    back: "-z",
  };

  return aliases[value] ?? value;
}

export function selectorByAnchor(anchorId: string): GeometrySelector {
  const normalized = normalizeAnchorId(anchorId);
  return anchorOptions.find((option) => option.selector.anchorId === normalized)?.selector ?? anchorOptions[0].selector;
}

export function selectorOffset(selector: GeometrySelector, distance: number): VecObject {
  const direction = selector.localDirection;
  if (direction) {
    return {
      x: direction.x * distance,
      y: direction.y * distance,
      z: direction.z * distance,
    };
  }
  return { x: 0, y: distance, z: 0 };
}

function vec(value: unknown, fallback: VecObject = { x: 0, y: 0, z: 0 }): VecObject {
  if (Array.isArray(value) && value.length === 3) {
    return { x: Number(value[0]) || 0, y: Number(value[1]) || 0, z: Number(value[2]) || 0 };
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return {
      x: Number(source.x) || fallback.x,
      y: Number(source.y) || fallback.y,
      z: Number(source.z) || fallback.z,
    };
  }
  return fallback;
}

export function relationTarget(
  relation: AssemblyRelation,
  side: "a" | "b",
): { objectId: string; anchorId: string } {
  const properties = relation.properties ?? {};
  const target = properties[side];
  if (target && typeof target === "object") {
    const source = target as Record<string, unknown>;
    return {
      objectId: String(source.objectId ?? (side === "a" ? relation.objectAId : relation.objectBId)),
      anchorId: normalizeAnchorId(String(source.anchorId ?? source.anchor_id ?? source.name ?? "center")),
    };
  }
  const selector = side === "a" ? relation.selectorA : relation.selectorB;
  return {
    objectId: side === "a" ? relation.objectAId : relation.objectBId,
    anchorId: normalizeAnchorId(String(selector.anchorId ?? selector.name ?? "center")),
  };
}

export function relationPriority(relation: AssemblyRelation): number {
  const value = relation.properties?.priority;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function relationOffset(relation: AssemblyRelation): VecObject {
  const params = relation.properties?.params;
  if (params && typeof params === "object") {
    const offset = (params as Record<string, unknown>).offset;
    return vec(offset);
  }
  return { x: 0, y: 0, z: 0 };
}

export function relationDistance(relation: AssemblyRelation): number {
  const params = relation.properties?.params;
  if (params && typeof params === "object") {
    const value = (params as Record<string, unknown>).distance;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return typeof relation.offsetMm === "number" ? relation.offsetMm : 0;
}

function objectSize(object: SceneObject, component?: ComponentItem): VecObject {
  const explicit = vec(object.properties?.size, { x: 0, y: 0, z: 0 });
  if (explicit.x || explicit.y || explicit.z) return explicit;
  const dimensions = component?.properties?.dimensionsMm;
  return vec(dimensions, { x: 100, y: 100, z: 100 });
}

function rotateVec(v: VecObject, rxDeg: number, ryDeg: number, rzDeg: number): VecObject {
  // Lab-frame rotation: R = Rz(rz) · Rx(rx) · Ry(ry). Mirrors the YXZ-intrinsic
  // Euler order applied by the Three.js renderer (transformUtils.ts).
  const rx = (rxDeg * Math.PI) / 180;
  const ry = (ryDeg * Math.PI) / 180;
  const rz = (rzDeg * Math.PI) / 180;

  const cy = Math.cos(ry), sy = Math.sin(ry);
  const x1 = v.x * cy + v.z * sy;
  const y1 = v.y;
  const z1 = -v.x * sy + v.z * cy;

  const cx = Math.cos(rx), sx = Math.sin(rx);
  const x2 = x1;
  const y2 = y1 * cx - z1 * sx;
  const z2 = y1 * sx + z1 * cx;

  const cz = Math.cos(rz), sz = Math.sin(rz);
  return {
    x: x2 * cz - y2 * sz,
    y: x2 * sz + y2 * cz,
    z: z2,
  };
}

export function localAnchor(anchorId: string, size: VecObject): { position: VecObject; direction?: VecObject } {
  const half = { x: size.x / 2, y: size.y / 2, z: size.z / 2 };
  switch (normalizeAnchorId(anchorId)) {
    case "+x":
      return { position: { x: half.x, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } };
    case "-x":
      return { position: { x: -half.x, y: 0, z: 0 }, direction: { x: -1, y: 0, z: 0 } };
    case "+y":
      return { position: { x: 0, y: half.y, z: 0 }, direction: { x: 0, y: 1, z: 0 } };
    case "-y":
      return { position: { x: 0, y: -half.y, z: 0 }, direction: { x: 0, y: -1, z: 0 } };
    case "+z":
      return { position: { x: 0, y: 0, z: half.z }, direction: { x: 0, y: 0, z: 1 } };
    case "-z":
      return { position: { x: 0, y: 0, z: -half.z }, direction: { x: 0, y: 0, z: -1 } };
    default:
      return { position: { x: 0, y: 0, z: 0 } };
  }
}

function findCustomAnchor(anchors: unknown, anchorId: string): Anchor | null {
  if (!Array.isArray(anchors)) return null;
  const target = normalizeAnchorId(anchorId);
  for (const candidate of anchors) {
    if (candidate && typeof candidate === "object") {
      const id = (candidate as { id?: unknown }).id;
      if (typeof id === "string" && normalizeAnchorId(id) === target) {
        return candidate as Anchor;
      }
    }
  }
  return null;
}

export function worldAnchor(
  object: SceneObject,
  component: ComponentItem | undefined,
  anchorId: string,
  asset?: Asset3D | null,
): { position: VecObject; direction?: VecObject } {
  // Resolution: placement override → asset default → standard box anchor.
  const placementAnchor = findCustomAnchor(object.properties?.anchors, anchorId);
  const assetAnchor = placementAnchor ? null : findCustomAnchor(asset?.anchors, anchorId);
  const standard = !placementAnchor && !assetAnchor ? localAnchor(anchorId, objectSize(object, component)) : null;

  const localPosition = placementAnchor?.localPosition ?? assetAnchor?.localPosition ?? standard!.position;
  const localDirection = placementAnchor?.localDirection ?? assetAnchor?.localDirection ?? standard?.direction;

  const rotatedPosition = rotateVec(localPosition, object.rxDeg, object.ryDeg, object.rzDeg);
  const rotatedDirection = localDirection
    ? rotateVec(localDirection, object.rxDeg, object.ryDeg, object.rzDeg)
    : undefined;
  return {
    position: {
      x: object.xMm + rotatedPosition.x,
      y: object.yMm + rotatedPosition.y,
      z: object.zMm + rotatedPosition.z,
    },
    direction: rotatedDirection,
  };
}
