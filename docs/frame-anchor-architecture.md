# Frame / Anchor Architecture

Status: canonical as of alembic `0093_flatten_asset_frame_anchors`.

This project intentionally has three runtime frames only:

1. **Lab frame**
   The scene/world frame. A `SceneObject` pose (`xMm/yMm/zMm/rxDeg/ryDeg/rzDeg`) places one component instance into the lab.

2. **Component frame**
   The assembly/template frame. A `Component` owns `ComponentBinding` rows that place assets or subcomponents relative to the component root. Tunable axes and object-level binding overrides move or rotate bindings inside this frame tree.

3. **Asset/CAD frame**
   The geometry-local frame for one `Asset3D`. Anchors are authored directly in this frame. There is no separate runtime body frame.

## Transform Chain

For a root asset binding:

```text
anchor_asset_local
  -> ComponentBinding local pose
  -> SceneObject lab pose
  -> Lab frame
```

Formula:

```text
P_lab = T_scene_object_lab * T_component_binding * P_anchor_asset
D_lab = R_scene_object_lab * R_component_binding * D_anchor_asset
```

`R_scene_object_lab` is the physical lab Z-up rotation. Three.js is configured
as Z-up too, so runtime math must not apply an extra lab/three axis swap.
SceneObject rotation follows the user-facing XYZ 4x4 matrix convention, written
for row vectors:

```text
M_row = Rx(rxDeg) * Ry(ryDeg) * Rz(rzDeg)
R_scene_object_lab = transpose(M_row)
```

This means a `SceneObject` with `ryDeg=90` maps an Asset/CAD-local direction
`[0, 0, 1]` to Lab `[-1, 0, 0]`; `ryDeg=45` maps it to
`[-0.707, 0, 0.707]`.

For a single-asset legacy component with no binding tree, `T_component_binding` is identity.

## Removed Body-Frame Layer

The old runtime layer

```text
Asset/CAD -> bodyFrameRotation/bodyFramePositionMm -> Anchor
```

was removed by `0093_flatten_asset_frame_anchors`. That migration bakes existing `body_frame_rotation` and `properties.bodyFramePositionMm` into stored anchors/faces, removes `properties.bodyFramePositionMm`, and drops `assets_3d.body_frame_rotation`.

Runtime code must not reapply `bodyFramePositionMm`, `bodyFrameRotation`, `R_body`, or `bfp`. If imported CAD axes are inconvenient, fix the imported mesh/anchor data at catalog bake or import time, not during scene tracing/rendering.

## Data Semantics

The field names still contain `BodyLocal` for compatibility with existing JSON and API shapes:

- `positionMmBodyLocal`
- `axisXBodyLocal`
- `axisYBodyLocal`
- `axisZBodyLocal`
- `directionBodyLocal`

Semantically these are now Asset/CAD-local values. A future cosmetic migration may rename them to `AssetLocal` or `CadLocal`, but current code should not introduce a fourth frame just to rename fields.

## Code Ownership

- Frontend anchor reads go through `frontend/src/utils/anchorAccess.ts`.
- Backend anchor snapshots read anchors directly in `backend/app/optical/db_scene_loader.py`.
- PHY Editor displays meshes and anchors in native Asset/CAD coordinates.
- Component assembly is owned by `ComponentBinding` and object-level binding overrides.
- Lab placement is owned by `SceneObject` pose.

## Invariants

- Moving a `SceneObject` moves the whole component in Lab frame.
- Moving a `ComponentBinding` moves that asset/subcomponent inside the component frame.
- Editing an anchor changes the asset/CAD-local physical port/surface.
- Solver, snapping, beam preview, and render overlays must all consume the same Asset/CAD-local anchor values.
- No runtime code should read or write `bodyFramePositionMm`, `bodyFrameRotation`, `body_frame_rotation`, `R_body`, or `bfp` outside historical migrations.
