// Gizmo wrapper — manages a single TransformControls instance attached to
// the currently-selected SceneObject. Hooks every drag event through the
// Smart Placement Engine so snapping is automatic.
//
// See PLACEMENT_DESIGN.md §4 (L1).

import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";

import type {
  PlacementInput,
  PlacementResult,
  SceneSnapshot,
  SnapCategory,
  LabPoint,
  LabRotation,
} from "./engine";
import { computePlacement } from "./engine";
import { threeToLabPointMm } from "../../optical/frames";

export type GizmoOrientation = "global" | "local" | "beam";

export type GizmoCallbacks = {
  /** Called continuously during drag with the latest engine result for the
   * primary (active) object — drives the snap overlay/readout. */
  onDragUpdate: (result: PlacementResult) => void;
  /** Called once when the user releases. Primary gets intent metadata;
   * followers carry both position AND rotation (multi-rotate semantics —
   * each follower may have rotated around the centroid AND its own axes
   * during the drag). Followers persist as absolute (no intent metadata). */
  onDragEnd: (args: {
    primary: { objectId: string; result: PlacementResult };
    followers: Array<{ objectId: string; positionLab: LabPoint; rotationLab: LabRotation }>;
  }) => void;
  /** Called when drag starts/ends so the parent can disable OrbitControls. */
  onDraggingChange: (dragging: boolean) => void;
};

export type GizmoConfig = {
  snapEnabled: () => boolean;
  snapCategories: () => SnapCategory[];
  thresholdsMm: () => Partial<Record<string, number>>;
  gridStepMm: () => number;
  cursorMm: () => LabPoint | undefined;
  scene: () => SceneSnapshot;
  componentGroup: () => THREE.Group | null;
};

export class PlacementGizmo {
  private controls: TransformControls;
  private camera: THREE.Camera;
  private domElement: HTMLElement;
  private scene: THREE.Scene;
  private callbacks: GizmoCallbacks;
  private config: GizmoConfig;

  /** Primary SceneObject the gizmo is attached to. */
  private attachedObject: {
    id: string;
    componentId: string;
    group: THREE.Group;
    initialLab: LabPoint;
    initialRot: LabRotation;
  } | null = null;

  /** Other selected objects that should follow the primary by translation
   * delta. Their initial lab position is captured at attach time. */
  private followers: Array<{
    id: string;
    componentId: string;
    group: THREE.Group;
    initialLab: LabPoint;
  }> = [];

  /** Hidden proxy Object3D placed at the pivot point. TransformControls is
   *  always attached to THIS, never directly to a SceneObject's wrapper, so
   *  the gizmo arrows appear at the requested pivot (single object: body
   *  centre; multi-object: collective centroid). The proxy's drag delta is
   *  then applied to every selected wrapper — translation = same delta,
   *  rotation = around the proxy origin (rotates each wrapper's position
   *  AND its own orientation as a rigid group). */
  private proxy: THREE.Object3D = new THREE.Object3D();
  private initialProxyPosThree = new THREE.Vector3();
  private initialProxyQuat = new THREE.Quaternion();
  /** All selected wrappers (primary + followers) with their pre-drag pose
   *  in three-units. Captured at attach() time and used to derive each
   *  object's new pose from the proxy's drag delta. */
  private selectedRigid: Array<{
    id: string;
    componentId: string;
    group: THREE.Group;
    initialPosThree: THREE.Vector3;
    initialQuat: THREE.Quaternion;
  }> = [];

  /** Last engine result during current drag — used to commit on end. */
  private lastResult: PlacementResult | null = null;
  /** When the user presses Tab during drag, cycle through alternatives. */
  private alternativeIndex = 0;

  private orientation: GizmoOrientation = "global";

  constructor(args: {
    camera: THREE.Camera;
    domElement: HTMLElement;
    scene: THREE.Scene;
    callbacks: GizmoCallbacks;
    config: GizmoConfig;
  }) {
    this.camera = args.camera;
    this.domElement = args.domElement;
    this.scene = args.scene;
    this.callbacks = args.callbacks;
    this.config = args.config;

    this.controls = new TransformControls(this.camera, this.domElement);
    this.controls.size = 0.7;
    this.controls.setSpace("world");
    // The TransformControls "root" is the gizmo helper itself. It must be
    // added to the scene via the helper accessor on newer three versions.
    const helper = (this.controls as unknown as { getHelper?: () => THREE.Object3D }).getHelper;
    if (typeof helper === "function") {
      this.scene.add(helper.call(this.controls));
    } else {
      // Fallback for older three versions where TransformControls is itself
      // an Object3D.
      this.scene.add(this.controls as unknown as THREE.Object3D);
    }
    // Hidden proxy that the controls actually target. Placed in the scene
    // so its world matrix is computable, but never has children / mesh.
    this.proxy.name = "placement-gizmo-proxy";
    this.scene.add(this.proxy);

    this.controls.addEventListener("dragging-changed", (event) => {
      const dragging = Boolean((event as { value?: unknown }).value);
      this.callbacks.onDraggingChange(dragging);
      if (!dragging) {
        // Drag end — commit each selected wrapper's CURRENT pose. The
        // primary uses the snap-engine result (which carries intent
        // metadata for "placedRelativeTo" provenance); followers report
        // their just-computed group.position + group.quaternion (already
        // includes the rigid rotation around the proxy pivot). Rotation
        // is now sent for ALL wrappers including followers — multi-rotate
        // would be silently broken otherwise.
        if (this.selectedRigid.length > 0 && this.attachedObject && this.lastResult) {
          const followers = this.selectedRigid.slice(1).map((f) => {
            const e = new THREE.Euler().setFromQuaternion(f.group.quaternion, "YXZ");
            return {
              objectId: f.id,
              positionLab: threeToLabPointMm(f.group.position) as LabPoint,
              rotationLab: {
                rxDeg: (e.x * 180) / Math.PI,
                ryDeg: -(e.z * 180) / Math.PI,
                rzDeg: (e.y * 180) / Math.PI,
              } as LabRotation,
            };
          });
          // Primary's lastResult.rotationLab might be stale (engine path
          // doesn't always populate it). Read the wrapper directly so the
          // committed rotation matches what the user sees.
          const primaryGroup = this.selectedRigid[0].group;
          const eP = new THREE.Euler().setFromQuaternion(primaryGroup.quaternion, "YXZ");
          const primaryResult: PlacementResult = {
            ...this.lastResult,
            rotationLab: {
              rxDeg: (eP.x * 180) / Math.PI,
              ryDeg: -(eP.z * 180) / Math.PI,
              rzDeg: (eP.y * 180) / Math.PI,
            },
          };
          this.callbacks.onDragEnd({
            primary: { objectId: this.attachedObject.id, result: primaryResult },
            followers,
          });
        }
        this.lastResult = null;
        this.alternativeIndex = 0;
      }
    });

    this.controls.addEventListener("objectChange", () => {
      this.runEngineFromGizmoPose();
    });

    // Tab key during drag → cycle alternatives.
    document.addEventListener("keydown", this.onKeyDown);
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Tab") return;
    if (!this.attachedObject || !this.lastResult) return;
    if (this.lastResult.alternatives.length === 0) return;
    event.preventDefault();
    this.alternativeIndex =
      (this.alternativeIndex + 1) % (this.lastResult.alternatives.length + 1);
    if (this.alternativeIndex === 0) {
      // Re-run engine with default ranking
      this.runEngineFromGizmoPose();
    } else {
      const alt = this.lastResult.alternatives[this.alternativeIndex - 1];
      // Force the gizmo + result to use the alternative instead.
      this.applySnapToGizmo(alt.pointLab);
      this.lastResult = {
        ...this.lastResult,
        positionLab: alt.pointLab,
        snappedTo: alt,
        reasoning: `[Tab ${this.alternativeIndex}] snapped to ${alt.label} (Δ ${alt.distanceMm.toFixed(1)} mm)`,
      };
      this.callbacks.onDragUpdate(this.lastResult);
    }
  };

  attach(args: {
    primary: { id: string; componentId: string; group: THREE.Group };
    followers?: Array<{ id: string; componentId: string; group: THREE.Group }>;
    /** Lab-mm coords of the pivot point. For a single object this is its
     *  body centre; for multi-select the centroid of all selected bodies.
     *  When omitted the proxy lands on the primary's wrapper world
     *  position (legacy behaviour). */
    pivotLabMm?: LabPoint;
  }): void {
    this.detach();
    const { primary, followers = [] } = args;
    // Position proxy at the requested pivot (lab mm → three units).
    if (args.pivotLabMm) {
      this.proxy.position.set(
        args.pivotLabMm.x / 100,
        args.pivotLabMm.z / 100,
        -args.pivotLabMm.y / 100,
      );
    } else {
      // Fallback: proxy at primary's wrapper world position.
      const w = new THREE.Vector3();
      primary.group.getWorldPosition(w);
      this.proxy.position.copy(w);
    }
    this.proxy.quaternion.set(0, 0, 0, 1);
    this.proxy.updateMatrixWorld(true);
    this.initialProxyPosThree.copy(this.proxy.position);
    this.initialProxyQuat.copy(this.proxy.quaternion);

    // Capture all selected wrappers (primary + followers) so we can apply
    // the proxy's drag delta to every one of them.
    const allSelected = [primary, ...followers];
    this.selectedRigid = allSelected.map((s) => ({
      id: s.id,
      componentId: s.componentId,
      group: s.group,
      initialPosThree: s.group.position.clone(),
      initialQuat: s.group.quaternion.clone(),
    }));

    this.controls.attach(this.proxy);
    // Force visible helper on (some three versions leave it false on
    // attach until mode toggles).
    const helperFn = (this.controls as unknown as { getHelper?: () => THREE.Object3D }).getHelper;
    if (typeof helperFn === "function") {
      helperFn.call(this.controls).visible = true;
    } else {
      (this.controls as unknown as THREE.Object3D).visible = true;
    }
    // Keep the legacy attachedObject + followers fields populated so the
    // single-object snap-engine path (computePlacement) still works.
    const labCurrent: LabPoint = threeToLabPointMm(primary.group.position);
    const labRotation: LabRotation = {
      rxDeg: (primary.group.rotation.x * 180) / Math.PI,
      ryDeg: -(primary.group.rotation.z * 180) / Math.PI,
      rzDeg: (primary.group.rotation.y * 180) / Math.PI,
    };
    this.attachedObject = {
      id: primary.id,
      componentId: primary.componentId,
      group: primary.group,
      initialLab: labCurrent,
      initialRot: labRotation,
    };
    this.followers = followers.map((f) => ({
      id: f.id,
      componentId: f.componentId,
      group: f.group,
      initialLab: threeToLabPointMm(f.group.position),
    }));
    this.applyOrientation();
  }

  detach(): void {
    this.controls.detach();
    this.attachedObject = null;
    this.followers = [];
    this.selectedRigid = [];
    this.lastResult = null;
    this.alternativeIndex = 0;
  }

  setOrientation(orientation: GizmoOrientation): void {
    this.orientation = orientation;
    this.applyOrientation();
  }

  setMode(mode: "translate" | "rotate" | "scale"): void {
    this.controls.setMode(mode);
  }

  /** Re-derive the gizmo's local frame from current orientation + scene. */
  private applyOrientation(): void {
    if (!this.attachedObject) return;
    if (this.orientation === "global") {
      this.controls.setSpace("world");
      return;
    }
    if (this.orientation === "local") {
      this.controls.setSpace("local");
      return;
    }
    if (this.orientation === "beam") {
      // Beam-axis: orient gizmo X along the nearest beam from the attached
      // object's current world position. If no beam → fall back to local.
      const scene = this.config.scene();
      const objLab = this.attachedObject.initialLab;
      const nearest = nearestBeamForPoint(scene, objLab);
      if (!nearest) {
        this.controls.setSpace("local");
        return;
      }
      // TransformControls only exposes "world" / "local". To get an arbitrary
      // frame we have to rotate the attached object's underlying group's
      // matrix temporarily. Implementation detail: skip arbitrary frame in
      // this iteration — TransformControls "local" already uses the object's
      // own rotation, which is what the user probably wants anyway. (Step 4
      // will add a custom proxy Group if true beam-axis is required.)
      this.controls.setSpace("local");
    }
  }

  private applySnapToGizmo(snapLab: LabPoint): void {
    if (!this.attachedObject) return;
    // Convert lab → THREE units and update the attached group's position.
    this.attachedObject.group.position.set(
      snapLab.x / 100,
      snapLab.z / 100,
      -snapLab.y / 100,
    );
    this.attachedObject.group.updateMatrixWorld(true);
  }

  private runEngineFromGizmoPose(): void {
    if (this.selectedRigid.length === 0 || !this.attachedObject) return;

    // Compute proxy drag delta (rigid transform around the proxy origin).
    const deltaPos = this.proxy.position.clone().sub(this.initialProxyPosThree);
    const inverseInitialQuat = this.initialProxyQuat.clone().invert();
    const deltaQuat = this.proxy.quaternion.clone().multiply(inverseInitialQuat);

    // Apply (translate + rotate-around-proxy-origin) to every selected
    // wrapper. This is the core "rigid group transform" semantics the user
    // asked for: single object → pivot at body centre (proxy = body center
    // → relative = 0 → only rotation around its own centre); multi → pivot
    // at collective centroid → each object orbits the centroid AND
    // rotates itself.
    for (const sel of this.selectedRigid) {
      const relative = sel.initialPosThree.clone().sub(this.initialProxyPosThree);
      relative.applyQuaternion(deltaQuat);
      const newPos = this.initialProxyPosThree.clone().add(deltaPos).add(relative);
      sel.group.position.copy(newPos);
      const newQuat = deltaQuat.clone().multiply(sel.initialQuat);
      sel.group.quaternion.copy(newQuat);
      sel.group.updateMatrixWorld(true);
    }

    // For SINGLE-object selection we still run the snap engine — it gives
    // the magnetism / snap-target overlay during translate. For multi we
    // skip snap (snap targets are object-local; centroid pivoting makes
    // them ambiguous). Either way we emit an onDragUpdate so the React
    // side keeps updating overlays.
    let result: PlacementResult;
    if (this.selectedRigid.length === 1) {
      const sel = this.selectedRigid[0];
      const candidatePosLab: LabPoint = threeToLabPointMm(sel.group.position);
      const input: PlacementInput = {
        scene: this.config.scene(),
        cursorMm: this.config.cursorMm(),
        target: {
          id: this.attachedObject.id,
          componentId: this.attachedObject.componentId,
          currentLab: this.attachedObject.initialLab,
        },
        intent: {
          candidatePosLab,
          snapEnabled: this.config.snapEnabled(),
          snapCategories: this.config.snapCategories(),
          axisLock: null,
        },
        config: {
          thresholdsMm: this.config.thresholdsMm() as Partial<Record<import("./engine").SnapTargetKind, number>>,
          gridStepMm: this.config.gridStepMm(),
        },
        componentGroup: this.config.componentGroup(),
      };
      result = computePlacement(input);
      // If a snap landed on a different position, nudge the wrapper +
      // proxy + initial state so subsequent drag deltas are relative to
      // the snapped position. Without this the gizmo would snap-jump and
      // then immediately un-snap on the next mouse move.
      if (result.snappedTo) {
        const snapThree = new THREE.Vector3(
          result.positionLab.x / 100,
          result.positionLab.z / 100,
          -result.positionLab.y / 100,
        );
        sel.group.position.copy(snapThree);
        sel.group.updateMatrixWorld(true);
        // The proxy is at the same delta from the wrapper as before — just
        // shift it by the snap correction to keep them aligned.
        const correction = snapThree.clone().sub(
          this.initialProxyPosThree.clone().add(deltaPos),
        );
        this.proxy.position.add(correction);
        this.proxy.updateMatrixWorld(true);
      }
    } else {
      // Multi-select: synthesise a no-snap result for the primary so the
      // existing UI plumbing stays happy.
      const primary = this.selectedRigid[0];
      const primaryLab: LabPoint = threeToLabPointMm(primary.group.position);
      result = {
        positionLab: primaryLab,
        snappedTo: null,
        alternatives: [],
        intentMetadata: { kind: "absolute", recordedAt: new Date().toISOString() },
        reasoning: `Group transform — ${this.selectedRigid.length} objects rotating/translating around shared centroid`,
      };
    }
    this.lastResult = result;
    this.alternativeIndex = 0;
    this.callbacks.onDragUpdate(result);
  }

  dispose(): void {
    this.controls.detach();
    document.removeEventListener("keydown", this.onKeyDown);
    const helper = (this.controls as unknown as { getHelper?: () => THREE.Object3D }).getHelper;
    const obj = typeof helper === "function" ? helper.call(this.controls) : (this.controls as unknown as THREE.Object3D);
    this.scene.remove(obj);
    this.controls.dispose();
  }
}

function nearestBeamForPoint(
  scene: SceneSnapshot,
  point: LabPoint,
): { from: LabPoint; to: LabPoint; linkId: string } | null {
  const objByCompId = new Map(scene.objects.map((o) => [o.componentId, o]));
  let bestDist = Infinity;
  let best: { from: LabPoint; to: LabPoint; linkId: string } | null = null;
  for (const link of scene.opticalLinks) {
    const from = objByCompId.get(link.fromObjectId);
    const to = objByCompId.get(link.toObjectId);
    if (!from || !to) continue;
    const a = { x: from.xMm, y: from.yMm, z: from.zMm };
    const b = { x: to.xMm, y: to.yMm, z: to.zMm };
    // Dist from point to segment midpoint as cheap proxy
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
    const d = Math.hypot(point.x - mid.x, point.y - mid.y, point.z - mid.z);
    if (d < bestDist) {
      bestDist = d;
      best = { from: a, to: b, linkId: link.id };
    }
  }
  return best;
}
