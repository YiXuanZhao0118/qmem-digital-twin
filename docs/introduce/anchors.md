[← Doc index](README.md)

# Coordinate frames & the anchor architecture (frames flattened: 0093; faces/transitions → anchors: 0106)

> Related: [asset.md](asset.md) (anchors live on the Asset3D), [object.md](object.md) (Lab pose), [optics.md](optics.md) (how the tracer uses anchor directions).

**Three runtime coordinate frames** (note: this replaces the "4-frame" model of the older docs):
1. **Lab frame** — scene / world. A SceneObject's `x/y/z mm` + `rx/ry/rz deg` place one component instance in the lab.
2. **Component frame** — assembly / template. A Component's ComponentBindings place assets and sub-components under the component root; tunable axes and object-level binding overrides move/rotate things within this frame.
3. **Asset/CAD frame** — the geometry-local frame of a single Asset3D. Anchors are annotated directly in it. **There is no separate runtime body frame.**

**Transform chain and formulas:**
```
anchor_asset_local → ComponentBinding pose → SceneObject Lab pose → Lab frame

P_lab = T_sceneObject_lab · T_componentBinding · P_anchor_asset
D_lab = R_sceneObject_lab · R_componentBinding · D_anchor_asset
```
- Lab and three.js are **both Z-up**; runtime math must **not** swap lab↔three axes any more.
- Rotations use the row-vector convention: `M_row = Rx(rx)·Ry(ry)·Rz(rz)`, `R_lab = transpose(M_row)`. Example: `ryDeg=45` maps CAD `[0,0,1]` to Lab `[-0.707, 0, 0.707]`.
- The old body-frame layer (`body_frame_rotation` / `bodyFramePositionMm`) was removed by **0093** and baked into the anchors; runtime must never apply `R_body` / `bfp` again. A misaligned CAD axis is fixed at catalog-import time, not at trace/render time.
- Compatibility: field names still contain `BodyLocal` (`positionMmBodyLocal`, `directionBodyLocal`, …) but their meaning is now Asset/CAD-local.

**Anchors (optical interfaces):** `anchors[]` **replaces the old `faces[]` / `transitions[]`** — every anchor is itself a directed optical interface carrying its own **direction** and **aperture**. So there is **no more "two-port asset with physical faces `A`/`B`", and no more directed `transitions[]` (A→B, B→A) naming**. Direction, reciprocity, diffraction order, RF side and so on are decided in place by each kind's PhysicsOp from the anchor's direction (see [optics.md](optics.md), [kinds.md](kinds.md)).

Each anchor (API `AnchorV3` / runtime `V3Anchor`, body-local) stores (runtime dataclass names in parentheses):
- `id`
- `positionMmBodyLocal` (`position_body`, the point the interface plane passes through)
- three axes `axisXBodyLocal` / `axisYBodyLocal` / `axisZBodyLocal` (`axis_x/y/z_body`): axisX = propagation / normal direction, axisY = transverse 1 (fast axis / s-pol …), axisZ = transverse 2 (= axisX × axisY)
- `apertureMm` + `apertureShape` (`circle`, …)

The tracer does a ray-plane hit test against "the plane through `position`, perpendicular to `axisX`" and clips it with the aperture (anything outside `apertureMm` counts as a miss). Through bindings / `exposedFaces`, a Component maps outward semantic ports (e.g. `optical_in`) onto `assetBindingId + anchorId`.

- An anchor's `axisX` (the normal) is the ground truth for Snell / Fresnel / reflection (s/p decomposition: `s=(k×axisX)/|·|`, `p=k×s`); **the tracer decides the outgoing direction, not the op**.
- A 5×5 augmented matrix (V=[x,θx,y,θy,1]) handles transverse displacement (prism wedge angle, the Glan-Laser 38.5° decenter); the general case uses 2×2 ABCD; cylindrical lenses and Glan prisms use abcdXY (x and y separately).

Frame math: frontend `optical/frames.ts`, `optical/pose.ts`, `utils/anchorAccess.ts`; backend `optical/db_scene_loader.py`.

**Pose quantization (stored resolution).** Every position / Euler value that gets **persisted** is snapped onto a fixed grid: **1 nm** for mm lengths, **1e-9°** for angles. Reason: decomposing a quaternion / rotation matrix back to Euler (`sceneObjectEulerFromQuaternion`, `euler_from_matrix`) returns ~1e-15 of double residue on the axes that are mathematically zero, which used to be stored and displayed as `ryDeg = -8.995967132789893e-15`. The grid is ~1000× (position) / ~5700× (angle) finer than the O-1 1 µm / O-2 0.1 µrad budget in [objectives.md](../objectives.md), so quantizing costs nothing measurable, while being far coarser than double dust — residue lands on an exact `0` (never `-0`).

- Definitions + invariants: `frontend/src/optical/poseQuantize.ts` and `backend/app/pose_quantize.py` (mirrors — keep the two grids in step).
- Enforced at the write choke points: the `PoseMm` / `PoseDeg` annotated types on `SceneObjectBase` / `SceneObjectUpdate` / `ComponentBindingBase` / `ComponentBindingUpdate` in `backend/app/schemas.py:33` (they run on the `…Out` models too, so even an un-scrubbed legacy row reads back clean), `assembly_solver.euler_from_matrix`, `frames.ts:sceneObjectEulerFromQuaternion`, `sceneStore.preparePatch` (lock filter → quantize, the single gate for object patches) and the PHY Editor's Alt+drag commit in `ComponentsEditor.tsx`.
- Invariant: a value at or above the objectives' budget must survive untouched — only sub-grid dust may move.

**The decomposition itself is conditioned at the gimbal pole (2026-09-22).** Quantizing only works if the Euler angles being quantized are right, and at ry = ±90° they were not. `frames.sceneObjectEulerFromQuaternion` (and its port `align/frames.scene_object_euler_from_quaternion`) took `ry = asin(r20)` and cut to the gimbal branch at a fixed `|cos ry| ≤ 1e-8`. asin is flat at ±1, so an `r20` rounded one ulp short of 1 read as ry = 90° − 1.5e-8 rad. That cleared the cut, and rx / rz then came from `atan2` of entries that are pure rounding noise at the pole. For the live MIRROR2 (roll 90° onto a beam 8.1 mrad off the y axis) "Align to beam" returned ry 8.5e-7° short of −90 and a pose whose align direction was **2.75e-4 rad** off the beam. On the mirror-coupling U-turn fixture a planned mirror normal came out **45°** wrong. The objective is 0.1 µrad ([objectives.md](../objectives.md)).

Now, in `frames.sceneObjectEulerRadFromQuaternion` (`frontend/src/optical/frames.ts`) and its Python port:

- `ry = atan2(r20, hypot(r00, r10))`, well-conditioned everywhere.
- `rz = atan2(−r10, r00)` from the entries of size cos ry. It is pinned to 0, the old convention at the pole, below `GIMBAL_COS_TOL = 4·ε`. That tolerance is tied to the conditioning: pinning moves the orientation by at most π·tol ≈ 3e-15 rad.
- `rx` comes from the O(1) entries **given** rz, through the exact identities `sin rx = sin rz·r02 + cos rz·r12` and `cos rx = sin rz·r01 + cos rz·r11`. rx therefore absorbs whatever rz cannot resolve (at the pole only rx ± rz is defined), and the recomposed rotation equals the input to rounding (< 4e-15, with ry 1e-3° … 1e-9° from ±90° and exactly at it).

Measured afterwards: MIRROR2's pose sits exactly on ry = −90°, and its direction is 1.3e-12 rad off the beam, the 1e-9° grid on rx.

`assembly_solver.euler_from_matrix` (the relation solver's `Rz·Rx·Ry`, pole at rx = ±90°, fixed cut 1e-7) gets the same treatment. Quantization is unchanged: each angle is still snapped to the grid afterwards.

Pinned by:

- `frontend/src/optical/frames.test.ts` and `backend/tests/test_euler_pole.py`, independently on each side.
- `backend/tests/fixtures/align/euler.json` plus the MIRROR2 cases in `point_dir.json`, for TS↔Python parity at 1e-9 (see [mirror-coupling.md](mirror-coupling.md#one-implementation-and-what-pins-it)).

## Reading an anchor's pose in lab mm

One helper, used by anything that solves against a real optical face:
`utils/anchorPose.resolveAnchorPosesLab(component, sceneObject, scene)` (plus
`resolveAnchorPoseLab` for a single id and `resolveObjectAnchorPosesLab` when
you only have the SceneObject). It returns each anchor's origin and axisX in
BOTH the Component CAD frame (`posCad` / `axisXCad`, what the align helpers
take) and lab mm (`posLab` / `axisXLab`), plus the clear-aperture **radius**
and, TS-only (2026-09-22), `axisYCad` — axisY through the same chain, read by
the RF connector side basis (`resolveLinkedRfCableEndpoint` / `ppgMounting`),
which the backend ports do not carry.

It exists because `componentBindings.anchorsInBindingTree` answers a different
question: it returns anchors in their owning ASSET's body frame, so a composite
Component's binding transform is still missing. Before this helper each caller
re-derived part of the walk and none composed nested bindings.

Two conventions meet inside it and must not be swapped:

- asset body -> Component CAD: the binding's **raw XYZ Euler**
  (`bindingTreeObject.applyBindingLocalTransform`, mirrored by the backend's
  `pose._binding_rotation_of`).
- Component CAD -> lab: the SceneObject's **YXZ-remapped** convention
  (`optical/frames.rotateLabDir` / `sceneObjectToQuaternion`).

Invariant: the result must equal the backend's
(`db_scene_loader._binding_tree_transform` composed with
`pose.pose_to_transform`), or a pose solved from these numbers lands where the
tracer disagrees. Pinned in `utils/__tests__/anchorPose.test.ts` against
MIRROR5's traced hit point and reflected direction (both backend outputs). See
[mirror-coupling.md](mirror-coupling.md) for its first consumer. Since
2026-09-22 the fibre-port sweep (`sceneStore.collectFiberPortsLab`) and the
plugged-end re-snap (`resnapFibersLinkedTo`) use it too, instead of a local
rotation copy that skipped the binding transform ([fiber.md](fiber.md#the-backend-port-2026-09-22)),
and so does every RF port lookup — connect, resnap, align candidates, the PPG
mount (both plugs) and the viewer's cable re-derive — through
`rfCableAnchorResolver.rfPortPoses` / `resolveRfPortPose` (backend
`rf_cables/ports.port_poses`), instead of the anchor in its own asset's frame
([rf.md](rf.md) §7 item 5).

**The backend has the same helper (2026-09-22)**:
`backend/app/optical/align/anchor_poses.py` — `resolve_binding_tree` (:160)
and `resolve_anchor_poses_lab` (:223), used by the `/api/v3/align/*`
endpoints ([api.md](api.md)). Its walk is the TS walk (roots in stored order,
a node's own anchors before its children, a sub-Component's roots spliced in
with no per-instance deltas, `id|name` dedupe first-wins, the legacy
`component.asset3dId` fallback); its transforms are
`_binding_tree_transform` + `pose_to_transform` themselves. The two are pinned
by `backend/tests/fixtures/align/anchor_poses.json`, generated from
`resolveAnchorPosesLab` over composite and random binding trees (see
[mirror-coupling.md](mirror-coupling.md#one-implementation-and-what-pins-it)),
and agreed within 1e-9 on all 73 objects of the live scene.

**`ObjectBinding.asset_3d_id_override` is honoured (2026-09-22)**, the way the
tracer's loader honours it (`db_scene_loader.load_anchor_scene_from_db`): an
**asset** binding of the object's **own** Component resolves to the instance's
override when one is set, else to its own `asset3dId`
(`componentBindings.effectiveBindingAssetId` / `anchor_poses.effective_asset_id`).
Never on an `empty` / `subcomponent` binding, never inside a spliced
sub-Component (the loader does not walk sub-Components at all), never on a
binding-less legacy Component; an override onto an asset that does not exist
is **missing**, not the catalog asset. Where it applies:

- `resolveAnchorPosesLab` / `resolve_anchor_poses_lab` — always (they must pose
  the anchors the trace hits).
- `resolveBindingTree(…, { honourAssetOverride: true })` /
  `resolve_binding_tree(…, honour_asset_override=True)` — opt-in, **off by
  default**, so the renderer and the Object-panel trees keep drawing the
  catalog asset (the render path has never swapped assets; see
  [rendering.md](rendering.md)).
- `componentBindings.primaryAssetForObject` / `AlignScene.primary_asset(comp,
  object_id)` — the override-aware "main asset" the align paths use
  (`AlignToBeamControls`' primary-anchor fallback, the AOM check and Bragg
  frame; `service.resolve_align_point_dir` / `aom_bragg_align`). Plain
  `primaryAsset` / `rf_resolve._primary_asset_id` stay override-blind on
  purpose — the RF BFS parity rule in [rf.md](rf.md) §4.

Pinned by the `asset-override` scene of `anchor_poses.json` (anchors and
`primaryAssetId` per object) and by
`test_align_endpoints.py::test_align_follows_the_instance_asset_swap`.

## The poses the tracer actually receives

The helpers above pose the **stored** anchors. The tracer's loader
(`db_scene_loader.load_anchor_scene_from_db`) rewrites a few before tracing:
a pigtail's ports move onto the fibre connector bound at them
(`_port_connector_anchors`), an AOM with no stored `interaction_center` gets
one at the midpoint of its faces, a connector fibre's coupling ports are
synthesized from its `kindParams.endA/endB`, and nothing inside a spliced
sub-Component is loaded at all. `POST /api/v3/anchors/traced`
(`routers/v3_anchors.py`, shape in [api.md](api.md)) returns that loaded
scene's anchors in lab mm, each with the slot's `bindingId` (what trace
segments report) and a `synthesized` flag — for a client that must draw the
faces the trace hits. The runtime `V3Anchor` carries the stored `name` and
that flag as metadata for this (`anchor_tracer.py:50`); the trace reads
neither. Pinned against the loader by
`backend/tests/optical/test_anchors_traced.py`.
