"""PHY Editor COMPONENT preview probe trace (load_anchor_scene_from_component).

Verifies the backend path that powers the COMPONENT preview's per-asset
polarization: build an anchor scene from ONE component's bindings (component
frame, no SceneObject), trace a probe ray, and confirm the segment Jones
reflects the authoritative physics — here, the non-reciprocal Faraday rotator
turns pure-s into a 45°-rotated state.

Runs against the local dev postgres (port 55432). Creates uniquely-named
scratch rows and cleans up on teardown.
"""

from __future__ import annotations

import math
import uuid

import pytest
from sqlalchemy import delete

from app.db import AsyncSessionLocal
from app.models import Asset3D, Component, ComponentBinding
from app.optical import anchor_ops  # noqa: F401  (registers anchor ops)
from app.optical.anchor_tracer import AnchorTraceOptions
from app.optical.beam_ray import Vec3, make_beam_ray
from app.optical.db_scene_loader import load_anchor_scene_from_component
from app.optical.solver import solve_anchor_scene


@pytest.fixture(autouse=True)
async def _reset_engine_pool():
    from app.db import engine

    await engine.dispose()
    yield


@pytest.fixture
async def scratch_ids():
    component_ids: list[uuid.UUID] = []
    asset_ids: list[uuid.UUID] = []
    yield {"components": component_ids, "assets": asset_ids}
    async with AsyncSessionLocal() as db:
        if component_ids:
            await db.execute(delete(Component).where(Component.id.in_(component_ids)))
        if asset_ids:
            await db.execute(delete(Asset3D).where(Asset3D.id.in_(asset_ids)))
        await db.commit()


def _faraday_anchor() -> dict:
    # optical_center with axisX along +x (probe propagation axis).
    return {
        "id": "optical_center",
        "positionMmBodyLocal": {"x": 0.0, "y": 0.0, "z": 0.0},
        "axisXBodyLocal": {"x": 1.0, "y": 0.0, "z": 0.0},
        "axisYBodyLocal": {"x": 0.0, "y": 1.0, "z": 0.0},
        "axisZBodyLocal": {"x": 0.0, "y": 0.0, "z": 1.0},
        "apertureMm": 5.0,
        "apertureShape": "circle",
    }


async def test_component_probe_through_faraday_rotates_polarization(scratch_ids):
    async with AsyncSessionLocal() as db:
        asset = Asset3D(
            name=f"test_fr_{uuid.uuid4().hex[:6]}",
            asset_type="stl",
            file_path="files/stl/test_fr.stl",
            kind_id="faraday_rotator",
            anchors=[_faraday_anchor()],
            default_params={"rotationDeg": 45, "lengthMm": 18, "refractiveIndex": 1.95},
        )
        db.add(asset)
        await db.flush()
        scratch_ids["assets"].append(asset.id)

        component = Component(name=f"test_fr_comp_{uuid.uuid4().hex[:6]}")
        db.add(component)
        await db.flush()
        scratch_ids["components"].append(component.id)

        db.add(ComponentBinding(
            component_id=component.id,
            target_kind="asset",
            asset_3d_id=asset.id,
            role="rod",
            local_x_mm=0.0, local_y_mm=0.0, local_z_mm=0.0,
            local_rx_deg=0.0, local_ry_deg=0.0, local_rz_deg=0.0,
            sort_order=0,
        ))
        await db.commit()

        scene = await load_anchor_scene_from_component(db, component.id)

    # One asset binding → one slot, in component frame.
    assert len(scene.slots) == 1
    assert scene.slots[0].asset.kind == "faraday_rotator"

    # Probe: pure-s along +x through the rod.
    probe = make_beam_ray(
        origin=Vec3(-10, 0, 0), direction=Vec3(1, 0, 0),
        wavelength_nm=780, power_mw=1.0,
    ).replaced(jones=(complex(1, 0), complex(0, 0)))

    result = solve_anchor_scene(scene, [probe], AnchorTraceOptions())
    lab = result.to_dict()["labSegments"]
    assert lab, "probe produced no segments"

    # Downstream of the rod the Jones must be rotated 45°: pure-s (1,0) →
    # (cos45, −sin45), so |E_p| ≈ 1/√2 (was 0 at the source).
    a = math.sqrt(0.5)
    downstream = lab[-1]["jones"]
    assert abs(complex(downstream[1]["re"], downstream[1]["im"])) == pytest.approx(a, abs=1e-3)
