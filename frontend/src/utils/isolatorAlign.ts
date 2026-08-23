/**
 * Pure geometry for "Align isolator to beam".
 *
 * Split out of IsolatorAdjustControls so the frame-sensitive maths is
 * unit-testable without React. The isolator's align spec lives at the
 * Component / binding-tree layer: the two reference points are the
 * resolved centres of the front and back polariser sub-bindings
 * (role_label front_* / back_*). The action rotates + translates the
 * whole isolator SceneObject so the front→back axis is parallel to the
 * beam and the front centre lands on the beam line — which puts the back
 * centre on it too (axis ∥ beam).
 *
 * All maths is in the raw Z-up lab frame, matching TA / AOM align:
 * `labDirToThreeLocal` is identity, so `setFromUnitVectors` /
 * `sceneObjectEulerFromQuaternion` yield a plain Z-up pose, and CAD →
 * lab goes through `rotateLabDir` (the SceneObject pose rotation).
 */
import * as THREE from "three";

import type { SceneObject } from "../types/digitalTwin";
import {
  labDirToThreeLocal,
  rotateLabDir,
  sceneObjectEulerFromQuaternion,
} from "../optical/frames";
import type { ResolvedBindingNode } from "./componentBindings";

export type Vec3 = { x: number; y: number; z: number };
export type RoleCentre = { role: string; isSub: boolean; posMm: THREE.Vector3 };
export type AlignPose = {
  xMm: number;
  yMm: number;
  zMm: number;
  rxDeg: number;
  ryDeg: number;
  rzDeg: number;
};

/** Walk the resolved binding tree, accumulating every role-labelled
 *  node's ORIGIN in the Component CAD frame (mm). The parent→child
 *  composition mirrors `bindingTreeObject.applyBindingLocalTransform`
 *  (raw XYZ Euler, parent CAD frame, no lab↔three swap) so these points
 *  coincide with the rendered sub-part positions. */
export function collectRoleCentres(
  nodes: readonly ResolvedBindingNode[],
  parentPos: THREE.Vector3,
  parentQuat: THREE.Quaternion,
  out: RoleCentre[],
): void {
  for (const node of nodes) {
    const t = node.localTransform;
    const localPos = new THREE.Vector3(t.xMm, t.yMm, t.zMm);
    const localQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(t.rxDeg),
        THREE.MathUtils.degToRad(t.ryDeg),
        THREE.MathUtils.degToRad(t.rzDeg),
        "XYZ",
      ),
    );
    const worldPos = localPos.clone().applyQuaternion(parentQuat).add(parentPos);
    const worldQuat = parentQuat.clone().multiply(localQuat);
    // Role lives in properties.role_label (migration-seeded TORNOS/HP) OR
    // the binding's own `role` field (e.g. IO-3-850-HP authored "front" /
    // "back" / "io_3_850_hp_front_piece" directly in `role`). Read both.
    const roleLabel = (node.binding.properties as { role_label?: unknown } | null)?.role_label;
    const role = (typeof roleLabel === "string" && roleLabel) || node.binding.role || "";
    if (role) {
      out.push({ role, isSub: node.target.kind === "subcomponent", posMm: worldPos });
    }
    if (node.children.length > 0) {
      collectRoleCentres(node.children, worldPos, worldQuat, out);
    }
  }
}

/** Front / back polariser centre. Match by `role_label` substring, then
 *  pick the actual POLARISER, never the housing. Isolator binding trees
 *  vary by model:
 *    - exact role "front" / "back"            (IO-3-850-HP flattened)
 *    - "front_pbs" / "back_pbs"               (TORNOS)
 *    - "front_glan_laser" / "back_glan_laser" (HP via mounts)
 *  and ALSO carry housing pieces ("io_3_850_hp_front_piece", at the body
 *  origin) whose role also contains "front"/"back". Preference order:
 *    1. exact role === side                   (the bare polariser binding)
 *    2. a polariser-ish role that isn't a housing "piece" (glan/pbs/sub)
 *    3. any sub-component node
 *    4. any non-"piece" match, else the first match. */
export function pickPolariserCentre(
  centres: RoleCentre[],
  side: "front" | "back",
): THREE.Vector3 | null {
  const matches = centres.filter((c) => c.role.toLowerCase().includes(side));
  if (matches.length === 0) return null;
  const isPiece = (c: RoleCentre) => c.role.toLowerCase().includes("piece");
  const exact = matches.find((c) => c.role.toLowerCase() === side);
  if (exact) return exact.posMm;
  const polariser = matches.find(
    (c) => !isPiece(c) && (c.isSub || /glan|pbs|polari/.test(c.role.toLowerCase())),
  );
  if (polariser) return polariser.posMm;
  const sub = matches.find((c) => c.isSub);
  if (sub) return sub.posMm;
  return (matches.find((c) => !isPiece(c)) ?? matches[0]).posMm;
}

/** Convert a Component CAD-frame point (mm) to lab mm under a
 *  SceneObject pose. Same path TA / AOM align use. */
export function cadToLab(cad: Vec3, sceneObject: SceneObject): Vec3 {
  const r = rotateLabDir(cad, sceneObject);
  return { x: sceneObject.xMm + r.x, y: sceneObject.yMm + r.y, z: sceneObject.zMm + r.z };
}

/** Solve the isolator pose so the front→back bore axis is parallel to
 *  `beamDir` (front upstream) and the front centre lands on the beam.
 *  `beamRef` is any point on the beam line (lab mm). Returns null when
 *  the front / back centres coincide (degenerate axis).
 *
 *  Frame: `frontCadMm` / `backCadMm` are in the Component CAD frame;
 *  `sceneObject` supplies the CURRENT pose (used only to project the
 *  current front position onto the beam for the translation foot). */
export function computeIsolatorAlignPose(args: {
  frontCadMm: Vec3;
  backCadMm: Vec3;
  sceneObject: SceneObject;
  beamDir: Vec3;
  beamRef: Vec3;
  reverse?: boolean;
  rollDeg?: number;
}): AlignPose | null {
  const { frontCadMm, backCadMm, sceneObject, beamDir, beamRef, reverse, rollDeg } = args;
  // Isolator = the inline (point + direction) case: point = front centre,
  // direction = front→back bore axis.
  return computePointDirAlignPose({
    pointCadMm: frontCadMm,
    dirCadMm: {
      x: backCadMm.x - frontCadMm.x,
      y: backCadMm.y - frontCadMm.y,
      z: backCadMm.z - frontCadMm.z,
    },
    sceneObject,
    beamDir,
    beamRef,
    reverse,
    rollDeg,
  });
}

/** Universal pass-through align: rotate the body so `dirCadMm` becomes
 *  PARALLEL to the beam (forward = +beam, or `reverse` = −beam), optionally
 *  rolled about that axis, then translate so `pointCadMm` lands on the beam
 *  line. Returns null when `dirCadMm` is degenerate.
 *
 *  Per-object (Object panel):
 *    - `reverse`: false → direction points along +beam (forward); true →
 *      along −beam. Lets the user flip which face points upstream.
 *    - `rollDeg`: clockwise rotation (looking ALONG the chosen direction)
 *      about the beam axis — matches the waveplate convention (+Δ about the
 *      +axis, right-hand). Sets the element's roll orientation on the beam.
 *    - `extraTilt`: an OFF-beam tilt applied last, about a body/CAD-frame
 *      axis (carried through the base rotation). Used by the AOM Bragg
 *      align, whose stage 2 tilts the cell by ±θ_B about D3 — every other
 *      kind leaves this undefined and stays exactly parallel to the beam.
 *      `pointCadMm` is the tilt pivot (it is placed on the beam AFTER the
 *      tilt), so for the AOM it should be the interaction centre.
 *
 *  All maths in raw Z-up (labDirToThreeLocal identity), matching TA / AOM
 *  align, so the decomposed Euler is a plain Z-up pose. */
export function computePointDirAlignPose(args: {
  pointCadMm: Vec3;
  dirCadMm: Vec3;
  sceneObject: SceneObject;
  beamDir: Vec3;
  beamRef: Vec3;
  reverse?: boolean;
  rollDeg?: number;
  extraTilt?: { axisCadMm: Vec3; angleRad: number };
}): AlignPose | null {
  const {
    pointCadMm, dirCadMm, sceneObject, beamDir, beamRef, reverse, rollDeg, extraTilt,
  } = args;

  const dir = new THREE.Vector3(dirCadMm.x, dirCadMm.y, dirCadMm.z);
  if (dir.length() < 1e-6) return null;
  const dirUnit = dir.clone().normalize();
  const beamUnit = new THREE.Vector3(beamDir.x, beamDir.y, beamDir.z).normalize();

  // Direction aligns parallel to the beam — forward (+beam) or reverse (−beam).
  const targetDir = reverse ? beamUnit.clone().negate() : beamUnit.clone();

  // Base rotation maps the body direction onto the chosen beam direction,
  // then roll about that axis (clockwise looking along it).
  const base = new THREE.Quaternion().setFromUnitVectors(
    labDirToThreeLocal({ x: dirUnit.x, y: dirUnit.y, z: dirUnit.z }).normalize(),
    labDirToThreeLocal({ x: targetDir.x, y: targetDir.y, z: targetDir.z }).normalize(),
  );
  const roll = typeof rollDeg === "number" ? THREE.MathUtils.degToRad(rollDeg) : 0;
  let quat = base;
  if (Math.abs(roll) > 1e-9) {
    const axis = labDirToThreeLocal({ x: targetDir.x, y: targetDir.y, z: targetDir.z }).normalize();
    quat = new THREE.Quaternion().setFromAxisAngle(axis, roll).multiply(base);
  }
  // Off-beam tilt, last: the CAD-frame axis is carried through the rotation
  // so far, then the body turns about it (the point stays the pivot).
  if (extraTilt && Math.abs(extraTilt.angleRad) > 1e-12) {
    const tiltAxis = labDirToThreeLocal(extraTilt.axisCadMm).normalize().applyQuaternion(quat);
    if (tiltAxis.lengthSq() > 1e-18) {
      quat = new THREE.Quaternion()
        .setFromAxisAngle(tiltAxis, extraTilt.angleRad)
        .multiply(quat);
    }
  }

  // Translate so the rotated point lands on the beam: foot of the current
  // point projected onto the beam, minus the rotated point offset. Axis ∥
  // beam ⇒ any other point on the axis lands on the beam too.
  const pointLab = cadToLab(pointCadMm, sceneObject);
  const t =
    (pointLab.x - beamRef.x) * beamUnit.x +
    (pointLab.y - beamRef.y) * beamUnit.y +
    (pointLab.z - beamRef.z) * beamUnit.z;
  const foot = {
    x: beamRef.x + beamUnit.x * t,
    y: beamRef.y + beamUnit.y * t,
    z: beamRef.z + beamUnit.z * t,
  };
  const rotatedPoint = labDirToThreeLocal(pointCadMm).applyQuaternion(quat);
  const { rxDeg, ryDeg, rzDeg } = sceneObjectEulerFromQuaternion(quat);

  return {
    xMm: foot.x - rotatedPoint.x,
    yMm: foot.y - rotatedPoint.y,
    zMm: foot.z - rotatedPoint.z,
    rxDeg,
    ryDeg,
    rzDeg,
  };
}

/** Reflective / fixed-angle align: keep the current rotation, translate
 *  so `pointCadMm` lands on the beam line. (point on beam; the reflection
 *  / design angle stays the user's manual choice.) */
export function computeTranslateOnlyPose(args: {
  pointCadMm: Vec3;
  sceneObject: SceneObject;
  beamDir: Vec3;
  beamRef: Vec3;
}): AlignPose {
  const { pointCadMm, sceneObject, beamDir, beamRef } = args;
  const beamUnit = new THREE.Vector3(beamDir.x, beamDir.y, beamDir.z).normalize();
  const pointLab = cadToLab(pointCadMm, sceneObject);
  const t =
    (pointLab.x - beamRef.x) * beamUnit.x +
    (pointLab.y - beamRef.y) * beamUnit.y +
    (pointLab.z - beamRef.z) * beamUnit.z;
  const foot = {
    x: beamRef.x + beamUnit.x * t,
    y: beamRef.y + beamUnit.y * t,
    z: beamRef.z + beamUnit.z * t,
  };
  return {
    xMm: sceneObject.xMm + (foot.x - pointLab.x),
    yMm: sceneObject.yMm + (foot.y - pointLab.y),
    zMm: sceneObject.zMm + (foot.z - pointLab.z),
    rxDeg: sceneObject.rxDeg,
    ryDeg: sceneObject.ryDeg,
    rzDeg: sceneObject.rzDeg,
  };
}

/** Optical ElementKinds that align to a beam — drives where the unified
 *  "Align to beam" control (Object panel) and the alignSpec editor (PHY
 *  Editor → Component) appear. Mirrors the per-kind `alignVariant !== "none"`
 *  set. Isolators (kindId "none") are detected separately via their
 *  binding-tree front/back composite roles. Fiber is excluded — it aligns
 *  per-end (Align A/B), which the single (point, direction) model doesn't
 *  fit. So is `eom`: a fibre-pigtailed modulator aligns per port connector
 *  (`PigtailEndAlignControls`) for the same reason. */
export const OPTICAL_ALIGN_KINDS = new Set<string>([
  "mirror", "dichroic_mirror", "beam_splitter",
  "lens_biconvex", "lens_plano_convex", "lens_cylindrical",
  "fiber_coupler", "polarizer", "glan_polarizer", "waveplate",
  "beam_dump", "detector", "camera", "spectrometer", "wavemeter",
  "saturable_absorber", "nonlinear_crystal", "aom", "tapered_amplifier",
]);
