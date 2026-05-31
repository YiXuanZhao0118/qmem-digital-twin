"""Load a V3Scene snapshot from the live DB.

The stateless `/api/v3/solver/run` endpoint expects the caller to ship a
complete V3Scene JSON in the request body. That is fine for unit tests
or external callers, but the Lab viewer + UI panels just want to "trace
the current scene" ??they shouldn't have to serialize the scene first.

This module reads SceneObject ??Component ??ComponentBinding ??Asset3D
rows and builds the V3Scene dataclass tree directly. SceneObjects whose
Asset3Ds lack v3 fields (kind_id / faces / transitions) are
skipped silently ??the v2-only objects can co-exist while migration
proceeds.

Dynamic sources (laser power, channel freq, etc.) are picked up from
SceneObject.properties for now (v2 location); when Phase 7 adds a
dedicated dynamic_sources column the lookup moves there.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Asset3D, Component, ComponentBinding, DeviceState, ObjectBinding, SceneObject
from app.optical.anchor_tracer import (
    V3Anchor,
    V3AnchorBindingSlot,
    V3AnchorScene,
    V3AssetAnchorSnapshot,
)
from app.optical.beam_ray import Vec3
from app.optical.pose import (
    V3Pose,
    binding_pose_to_transform,
    compose_transforms,
    pose_to_transform,
)
from app.optical.ray_tracer_v3 import (
    V3AssetSnapshot,
    V3ComponentBinding,
    V3ComponentSnapshot,
    V3Scene,
    V3SceneObject,
    V3TransitionDescriptor,
)
from app.optical.registry import Face


_DYNAMIC_KEYS = {
    "laserPowerMw", "powerMw", "centerWavelengthNm",
    "polarization", "spatialModeX", "spatialModeY",
    "transverseMode", "channels",
    "aomFreqMhz", "aomRfPowerDbm", "rfFrequencyMhz", "rfDrivePowerW",
    "beamProfile",
}


def _vec3(d: dict) -> Vec3:
    return Vec3(float(d["x"]), float(d["y"]), float(d["z"]))


def _face(d: dict) -> Face:
    return Face(
        id=d["id"],
        position_mm_body_local=_vec3(d["positionMmBodyLocal"]),
        normal_body_local=_vec3(d["normalBodyLocal"]) if d.get("normalBodyLocal") else None,
        aperture_mm=float(d.get("apertureMm", 0)),
        aperture_shape=d.get("apertureShape", "rectangle"),
    )


def _transition(d: dict) -> V3TransitionDescriptor:
    return V3TransitionDescriptor(
        in_face=d["in"],
        out_face=d["out"],
        op=d["op"],
        params=d.get("params"),
        matrix5x5=d.get("matrix5x5"),
        abcd=d.get("abcd"),
        via=tuple(d.get("via") or ()),
    )


def asset_to_snapshot(asset: Asset3D) -> V3AssetSnapshot | None:
    """Build a V3AssetSnapshot from an Asset3D row, or return None if
    the row lacks v3 fields (then it can't participate in v3 trace)."""
    if not (asset.kind_id and asset.faces and asset.transitions):
        return None
    return V3AssetSnapshot(
        catalog_id=asset.catalog_id or asset.name,
        kind=asset.kind_id,
        faces=[_face(f) for f in asset.faces],
        transitions=[_transition(t) for t in asset.transitions],
        default_params=asset.default_params or {},
    )


def _extract_dynamic(properties: dict | None) -> dict | None:
    """Per-instance dynamic overrides the v3 ops read, from SceneObject.properties.

    Merges two sources:
      1. The laser beam the Object panel writes to ``opticalSources[0].beam``
         (V2 BeamSource shape), converted to the legacy kindParams shape the
         emit op reads (centerWavelengthNm / powerMw / spatialModeX/Y /
         polarization) via ``legacy_laser_kind_params_from_beam`` — so panel
         beam edits (waist, wavelength, polarization) actually reach the emit op.
         Without this, only ``powerMw`` round-tripped and waist/wavelength/pol
         silently fell back to the asset default_params.
      2. The whitelist of explicit top-level keys (AOM RF freq, RF channels,
         a manual ``spatialModeX`` override, …). These WIN over beam-derived.
    """
    # Local import avoids an import cycle with app.v2_bindings at module load.
    from app.v2_bindings import legacy_laser_kind_params_from_beam

    if not properties:
        return None
    out: dict = {}
    # (1) Laser beam → legacy dynamic keys the emit op reads.
    sources = properties.get("opticalSources")
    if isinstance(sources, list) and sources and isinstance(sources[0], dict):
        beam = sources[0].get("beam")
        if isinstance(beam, dict):
            legacy = legacy_laser_kind_params_from_beam(beam)
            power = legacy.get("nominalPowerMw")
            if isinstance(power, (int, float)):
                out["powerMw"] = float(power)
            for key in ("centerWavelengthNm", "spatialModeX", "spatialModeY", "polarization"):
                if key in legacy:
                    out[key] = legacy[key]
    # (2) Explicit top-level whitelist overrides (win over beam-derived).
    for key in _DYNAMIC_KEYS:
        if key in properties:
            out[key] = properties[key]
    return out or None


def _num_delta(value: float | None) -> float:
    return float(value) if value is not None else 0.0


def _binding_pose_with_override(
    binding: ComponentBinding,
    override: ObjectBinding | None,
) -> V3Pose:
    """ComponentBinding pose plus the per-SceneObject ObjectBinding delta.

    Mirrors frontend ``utils/componentBindings._effectiveTransform`` so
    the ray solver flattens composite assets exactly like SenseObject /
    PHY Editor rendering does.
    """
    return V3Pose(
        x_mm=binding.local_x_mm + _num_delta(override.local_x_mm_delta if override else None),
        y_mm=binding.local_y_mm + _num_delta(override.local_y_mm_delta if override else None),
        z_mm=binding.local_z_mm + _num_delta(override.local_z_mm_delta if override else None),
        rx_deg=binding.local_rx_deg + _num_delta(override.local_rx_deg_delta if override else None),
        ry_deg=binding.local_ry_deg + _num_delta(override.local_ry_deg_delta if override else None),
        rz_deg=binding.local_rz_deg + _num_delta(override.local_rz_deg_delta if override else None),
    )


def _binding_tree_transform(
    binding: ComponentBinding,
    binding_by_id: dict[object, ComponentBinding],
    override_by_binding_id: dict[object, ObjectBinding],
    memo: dict[object, object],
    visiting: set[object],
):
    """Effective Component-frame transform for one binding.

    ComponentBinding rows form a tree via ``parent_binding_id``. The
    renderer composes ``parent * child``; the backend solver must do the
    same or nested composite optics trace with the wrong coating normal.
    """
    binding_id = binding.id
    if binding_id in memo:
        return memo[binding_id]
    if binding_id in visiting:
        raise ValueError(f"cycle in ComponentBinding tree at {binding_id}")
    visiting.add(binding_id)

    local_transform = binding_pose_to_transform(
        _binding_pose_with_override(binding, override_by_binding_id.get(binding_id))
    )
    effective = local_transform
    if binding.parent_binding_id is not None:
        parent = binding_by_id.get(binding.parent_binding_id)
        if parent is not None:
            effective = compose_transforms(
                _binding_tree_transform(
                    parent, binding_by_id, override_by_binding_id, memo, visiting
                ),
                local_transform,
            )

    visiting.remove(binding_id)
    memo[binding_id] = effective
    return effective


async def load_scene_from_db(session: AsyncSession) -> V3Scene:
    """Walk all SceneObjects in the current scene and build a V3Scene.

    SceneObjects whose Component's bindings don't resolve to v3 Asset3D
    rows are skipped (those still on the v2 path). The remainder form a
    valid V3Scene the v3 tracer can consume.
    """
    so_rows = (await session.scalars(select(SceneObject))).all()
    objects: list[V3SceneObject] = []

    for so in so_rows:
        if not so.component_id:
            continue
        comp = await session.get(Component, so.component_id)
        if comp is None:
            continue

        binding_rows = (await session.scalars(
            select(ComponentBinding).where(ComponentBinding.component_id == comp.id)
        )).all()
        v3_bindings: list[V3ComponentBinding] = []
        for b in binding_rows:
            if b.target_kind != "asset" or not b.asset_3d_id:
                continue
            asset_row = await session.get(Asset3D, b.asset_3d_id)
            if asset_row is None:
                continue
            snap = asset_to_snapshot(asset_row)
            if snap is None:
                continue
            v3_bindings.append(V3ComponentBinding(
                binding_id=b.role or str(b.id),
                asset=snap,
                local_pose=V3Pose(
                    x_mm=b.local_x_mm, y_mm=b.local_y_mm, z_mm=b.local_z_mm,
                    rx_deg=b.local_rx_deg, ry_deg=b.local_ry_deg, rz_deg=b.local_rz_deg,
                ),
            ))
        if not v3_bindings:
            continue

        objects.append(V3SceneObject(
            id=str(so.id),
            pose=V3Pose(
                x_mm=so.x_mm, y_mm=so.y_mm, z_mm=so.z_mm,
                rx_deg=so.rx_deg, ry_deg=so.ry_deg, rz_deg=so.rz_deg,
            ),
            asset=None,
            component=V3ComponentSnapshot(
                catalog_id=comp.model or comp.name,
                bindings=v3_bindings,
            ),
            dynamic_sources=_extract_dynamic(so.properties),
        ))

    return V3Scene(objects=objects)


# ??? Phase 9.2 ??anchor-centric scene loader ???????????????????????????????


def _anchor_from_dict(d: dict) -> V3Anchor:
    return V3Anchor(
        id=d["id"],
        position_body=_vec3(d["positionMmBodyLocal"]),
        axis_x_body=_vec3(d["axisXBodyLocal"]),
        axis_y_body=_vec3(d["axisYBodyLocal"]),
        axis_z_body=_vec3(d["axisZBodyLocal"]),
        aperture_mm=float(d.get("apertureMm", 0)),
        aperture_shape=d.get("apertureShape", "circle"),
    )


def _derive_aom_interaction_center(anchors: list[dict]) -> dict | None:
    """AOM stores intercept_in + intercept_out as the entry / exit faces.
    The Bragg interaction physics happens at the crystal midpoint, which
    is the midpoint of those two faces. Synthesize ``interaction_center``
    from that midpoint at load time so the tracer's primary-anchor hit
    test has a target without us storing a redundant anchor row.
    """
    in_a = next((a for a in anchors if a.get("id") == "intercept_in"), None)
    out_a = next((a for a in anchors if a.get("id") == "intercept_out"), None)
    if not in_a or not out_a:
        return None
    in_pos = in_a.get("positionMmBodyLocal") or {}
    out_pos = out_a.get("positionMmBodyLocal") or {}
    midpoint = {
        "x": (float(in_pos.get("x", 0)) + float(out_pos.get("x", 0))) / 2.0,
        "y": (float(in_pos.get("y", 0)) + float(out_pos.get("y", 0))) / 2.0,
        "z": (float(in_pos.get("z", 0)) + float(out_pos.get("z", 0))) / 2.0,
    }
    # Use intercept_in's tri-axis frame for the synthetic anchor ??both
    # face the same way along the optical axis so the basis is shared.
    return {
        "id": "interaction_center",
        "positionMmBodyLocal": midpoint,
        "axisXBodyLocal": in_a["axisXBodyLocal"],
        "axisYBodyLocal": in_a["axisYBodyLocal"],
        "axisZBodyLocal": in_a["axisZBodyLocal"],
        "apertureMm": in_a.get("apertureMm", 0),
        "apertureShape": in_a.get("apertureShape", "circle"),
    }



def anchor_asset_to_snapshot(asset: Asset3D) -> V3AssetAnchorSnapshot | None:
    """Build the anchor-centric snapshot from Asset3D, or None if no
    anchors are populated yet (Phase 9.1 backfill not run for this row).

    Anchors are stored directly in Asset/CAD-local coordinates, ready to
    compose with ComponentBinding and SceneObject poses.
    """
    if not asset.kind_id:
        return None
    anchors = list(asset.anchors or [])
    if not anchors:
        return None
    # Only accept the NEW schema (anchors with axisX/Y/Z). Legacy v2
    # anchors (intercept_in / etc. without tri-axis) are ignored.
    if not isinstance(anchors[0], dict) or "axisXBodyLocal" not in anchors[0]:
        return None
    # AOM: derive interaction_center from intercept_in/out midpoint when
    # missing. The stored data only carries the boundary faces; the
    # tracer's primary-anchor hit test needs interaction_center to fire
    # the Bragg op.
    if asset.kind_id == "aom" and not any(
        a.get("id") == "interaction_center" for a in anchors
    ):
        synth = _derive_aom_interaction_center(anchors)
        if synth is not None:
            anchors.append(synth)
    return V3AssetAnchorSnapshot(
        catalog_id=asset.catalog_id or asset.name,
        kind=asset.kind_id,
        anchors=[_anchor_from_dict(a) for a in anchors],
        default_params=asset.default_params or {},
    )


async def load_anchor_scene_from_db(session: AsyncSession) -> V3AnchorScene:
    """Walk SceneObjects and flatten to V3AnchorBindingSlot list (anchor-centric).

    Mirrors ``load_scene_from_db`` but emits the new anchor-based scene
    structure consumed by ``trace_ray_anchor_scene``.
    """
    so_rows = (await session.scalars(select(SceneObject))).all()
    slots: list[V3AnchorBindingSlot] = []

    # Instrument power panel: objects whose device_states.state.power is False
    # are powered off. Emitters skip those slots (no beam / no ASE on power-off).
    ds_rows = (await session.scalars(select(DeviceState))).all()
    powered_off_ids = {
        ds.object_id for ds in ds_rows
        if isinstance(ds.state, dict) and ds.state.get("power") is False
    }

    for so in so_rows:
        if not so.component_id:
            continue
        comp = await session.get(Component, so.component_id)
        if comp is None:
            continue

        powered_on = so.id not in powered_off_ids

        binding_rows = (await session.scalars(
            select(ComponentBinding).where(ComponentBinding.component_id == comp.id)
        )).all()
        binding_by_id = {b.id: b for b in binding_rows}
        object_binding_rows = (await session.scalars(
            select(ObjectBinding).where(ObjectBinding.object_id == so.id)
        )).all()
        override_by_binding_id = {
            ob.component_binding_id: ob for ob in object_binding_rows
        }
        binding_transform_memo: dict[object, object] = {}

        so_transform = pose_to_transform(V3Pose(
            x_mm=so.x_mm, y_mm=so.y_mm, z_mm=so.z_mm,
            rx_deg=so.rx_deg, ry_deg=so.ry_deg, rz_deg=so.rz_deg,
        ))

        for b in binding_rows:
            override = override_by_binding_id.get(b.id)
            asset_id = (
                override.asset_3d_id_override
                if override is not None and override.asset_3d_id_override is not None
                else b.asset_3d_id
            )
            if b.target_kind != "asset" or not asset_id:
                continue
            asset_row = await session.get(Asset3D, asset_id)
            if asset_row is None:
                continue
            snap = anchor_asset_to_snapshot(asset_row)
            if snap is None:
                continue

            # Binding pose uses RAW XYZ and must include the whole parent
            # binding chain (plus ObjectBinding deltas), matching the
            # frontend binding-tree renderer. IO-3-850-HP's back Glan lives
            # under a rotated parent; using only the leaf binding flips the
            # reflected branch to the wrong quadrant.
            local_transform = _binding_tree_transform(
                b,
                binding_by_id,
                override_by_binding_id,
                binding_transform_memo,
                set(),
            )
            effective = compose_transforms(so_transform, local_transform)

            slots.append(V3AnchorBindingSlot(
                scene_object_id=str(so.id),
                binding_id=b.role or str(b.id),
                asset=snap,
                effective_transform=effective,
                dynamic_sources=_extract_dynamic(so.properties),
                powered_on=powered_on,
            ))

    return V3AnchorScene(slots=slots)
