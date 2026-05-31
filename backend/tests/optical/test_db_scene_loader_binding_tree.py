from __future__ import annotations

import uuid

import pytest

from app.models import ComponentBinding
from app.optical.beam_ray import Vec3
from app.optical.db_scene_loader import _binding_tree_transform
from app.optical.pose import dir_body_to_lab_t


def _binding(
    *,
    binding_id: uuid.UUID,
    component_id: uuid.UUID,
    parent_binding_id: uuid.UUID | None = None,
    role: str = "body",
    rz_deg: float = 0.0,
) -> ComponentBinding:
    return ComponentBinding(
        id=binding_id,
        component_id=component_id,
        parent_binding_id=parent_binding_id,
        target_kind="asset",
        asset_3d_id=uuid.uuid4(),
        role=role,
        local_x_mm=0.0,
        local_y_mm=0.0,
        local_z_mm=0.0,
        local_rx_deg=0.0,
        local_ry_deg=0.0,
        local_rz_deg=rz_deg,
        sort_order=0,
    )


def test_binding_tree_transform_applies_parent_rotation_for_io3_back_glan() -> None:
    component_id = uuid.uuid4()
    parent_id = uuid.uuid4()
    child_id = uuid.uuid4()
    parent = _binding(
        binding_id=parent_id,
        component_id=component_id,
        role="io_3_850_hp_back_piece",
        rz_deg=90.0,
    )
    child = _binding(
        binding_id=child_id,
        component_id=component_id,
        parent_binding_id=parent_id,
        role="back",
        rz_deg=225.0,
    )

    transform = _binding_tree_transform(
        child,
        {parent.id: parent, child.id: child},
        {},
        {},
        set(),
    )
    axis = dir_body_to_lab_t(Vec3(0.622510, 0.0, -0.782612), transform)

    assert axis.x == pytest.approx(0.440181, abs=1e-6)
    assert axis.y == pytest.approx(-0.440181, abs=1e-6)
    assert axis.z == pytest.approx(-0.782612, abs=1e-6)
