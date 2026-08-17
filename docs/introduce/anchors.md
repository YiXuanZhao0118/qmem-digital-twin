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
