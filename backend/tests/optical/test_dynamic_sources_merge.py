"""db_scene_loader: the SceneObject.dynamic_sources COLUMN merges over the
asset default_params at trace-load time (alembic 0113).

This guards the param-ownership rework: per-instance tunable values now live in
``objects.dynamic_sources`` (the per-binding ``param_overrides`` column was
dropped), and the anchor loader must fold that dict into each slot's
``dynamic_sources`` so the tracer's ``{**default_params, **dynamic_sources}``
merge picks it up. Runs against the local dev postgres; scratch rows are cleaned
up on teardown.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import delete

from app.db import AsyncSessionLocal
from app.models import Asset3D, Component, ComponentBinding, SceneObject
from app.optical.db_scene_loader import load_anchor_scene_from_db


@pytest.fixture(autouse=True)
async def _reset_engine_pool():
    from app.db import engine

    await engine.dispose()
    yield


def _tri_axis_anchor() -> dict:
    return {
        "id": "intercept_in",
        "positionMmBodyLocal": {"x": 0, "y": 0, "z": 0},
        "axisXBodyLocal": {"x": 0, "y": 0, "z": 1},
        "axisYBodyLocal": {"x": 0, "y": 1, "z": 0},
        "axisZBodyLocal": {"x": 1, "y": 0, "z": 0},
        "apertureMm": 10,
        "apertureShape": "circle",
    }


@pytest.fixture
async def scratch():
    ids: dict[str, list[uuid.UUID]] = {"objects": [], "components": [], "assets": []}
    yield ids
    async with AsyncSessionLocal() as db:
        if ids["objects"]:
            await db.execute(delete(SceneObject).where(SceneObject.id.in_(ids["objects"])))
        if ids["components"]:
            await db.execute(delete(Component).where(Component.id.in_(ids["components"])))
        if ids["assets"]:
            await db.execute(delete(Asset3D).where(Asset3D.id.in_(ids["assets"])))
        await db.commit()


async def _make_scene(db, dynamic_sources: dict | None, tunable_params: list[str] | None = None):
    asset = Asset3D(
        name=f"scratch-lens-{uuid.uuid4().hex[:8]}",
        asset_type="optical",
        file_path="primitive://box",
        kind_id="lens_plano_convex",
        default_params={"focalLengthMm": 100.0},
        tunable_params=tunable_params or [],
        anchors=[_tri_axis_anchor()],
    )
    db.add(asset)
    await db.flush()
    comp = Component(name=f"scratch-comp-{uuid.uuid4().hex[:8]}", kind_id="none")
    db.add(comp)
    await db.flush()
    binding = ComponentBinding(
        component_id=comp.id, target_kind="asset", asset_3d_id=asset.id, role="b0",
    )
    db.add(binding)
    so = SceneObject(component_id=comp.id, dynamic_sources=dynamic_sources)
    db.add(so)
    await db.commit()
    return asset.id, comp.id, so.id


async def test_tunable_key_overrides(scratch):
    async with AsyncSessionLocal() as db:
        asset_id, comp_id, so_id = await _make_scene(
            db, {"focalLengthMm": 250.0}, tunable_params=["focalLengthMm"],
        )
        scratch["assets"].append(asset_id)
        scratch["components"].append(comp_id)
        scratch["objects"].append(so_id)

        anchor_scene = await load_anchor_scene_from_db(db)

    slot = next(s for s in anchor_scene.slots if s.scene_object_id == str(so_id))
    # focalLengthMm IS tunable → the per-instance column value wins.
    assert slot.dynamic_sources is not None
    assert slot.dynamic_sources["focalLengthMm"] == pytest.approx(250.0)


async def test_non_tunable_key_is_dropped(scratch):
    # The sync fix: a leftover/legacy per-instance value for a NON-tunable param
    # must NOT shadow the asset default — the object tracks the asset.
    async with AsyncSessionLocal() as db:
        asset_id, comp_id, so_id = await _make_scene(
            db, {"focalLengthMm": 250.0}, tunable_params=[],
        )
        scratch["assets"].append(asset_id)
        scratch["components"].append(comp_id)
        scratch["objects"].append(so_id)

        anchor_scene = await load_anchor_scene_from_db(db)

    slot = next(s for s in anchor_scene.slots if s.scene_object_id == str(so_id))
    # focalLengthMm is NOT tunable → the stale override is dropped; asset wins.
    assert not (slot.dynamic_sources or {}).get("focalLengthMm")
    assert slot.asset.default_params["focalLengthMm"] == pytest.approx(100.0)


async def test_no_dynamic_sources_leaves_defaults(scratch):
    async with AsyncSessionLocal() as db:
        asset_id, comp_id, so_id = await _make_scene(db, None)
        scratch["assets"].append(asset_id)
        scratch["components"].append(comp_id)
        scratch["objects"].append(so_id)

        anchor_scene = await load_anchor_scene_from_db(db)

    slot = next(s for s in anchor_scene.slots if s.scene_object_id == str(so_id))
    # No per-instance override → the asset default_params alone drive the trace.
    assert not (slot.dynamic_sources or {}).get("focalLengthMm")
    assert slot.asset.default_params["focalLengthMm"] == pytest.approx(100.0)
