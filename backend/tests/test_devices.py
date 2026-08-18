"""The device registry as DB rows (alembic 0123).

Devices used to be TypeScript files exported into
``backend/data/kinds.json::devices[]``; adding an instrument meant editing
two files, re-running ``npm run export:kinds`` and restarting the backend.
They are ``devices`` table rows now, written through ``/api/devices``.

What this file holds:

* the **anchor-contract derivation**, moved here from
  ``test_kinds_manifest.py`` because its source moved from the manifest to
  the DB. The load-bearing rule is the componentType filter: a contract is
  emitted only when ``component_type != behavioral_kind``, because many
  devices share one behavioural kind and a generic-form key would have them
  overwrite each other;
* the **guards** that make the registry safe to expose to an editor: a
  locked device rejects edits and deletes, and a device an Asset3D still
  points at cannot be deleted out from under it.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import delete

from app import schemas
from app.components.anchor_contracts import (
    all_anchor_contracts,
    get_anchor_contract,
)
from app.db import AsyncSessionLocal
from app.models import Asset3D, Device
from app.routers.devices import create_device, delete_device, update_device


@pytest.fixture(autouse=True)
async def _reset_engine_pool():
    from app.db import engine

    await engine.dispose()
    yield


def _device(**overrides) -> schemas.DeviceCreate:
    payload = {
        "slug": f"test_dev_{uuid.uuid4().hex[:8]}",
        "display_name": "Test Device",
        "behavioral_kind": "mirror",
        "component_type": "mirror",
        "mesh": "test.stl",
        "anchors": [],
        "default_params": {},
    }
    payload.update(overrides)
    return schemas.DeviceCreate(**payload)


async def _drop(slugs: list[str]) -> None:
    async with AsyncSessionLocal() as db:
        await db.execute(delete(Device).where(Device.slug.in_(slugs)))
        await db.commit()


# ---------------------------------------------------------------------------
# Anchor contracts, derived from the devices table
# ---------------------------------------------------------------------------


async def test_dds_ad9959_pcb_has_four_rf_out_anchors():
    async with AsyncSessionLocal() as db:
        templates = await get_anchor_contract(db, "dds_ad9959_pcb")
    assert templates is not None
    assert len(templates) == 4
    assert all(t["id"] == "rf_out" for t in templates)
    assert {t.get("name") for t in templates} == {"CH0", "CH1", "CH2", "CH3"}


async def test_templates_carry_position_and_direction():
    """Real geometry reaches the backend through the contract.

    Deliberately asserts no specific coordinate. This used to pin CH0 at
    (82.55, -30.0), which made it a change-detector: those were nominal
    placeholders, and syncing the template to the measured board
    (2026-08-17, see docs/float64-audit.md §3-5) broke the test without
    anything being wrong. What matters is that the fields survive and
    carry usable, distinct values.
    """
    async with AsyncSessionLocal() as db:
        templates = await get_anchor_contract(db, "dds_ad9959_pcb")

    seen: set[tuple[float, float, float]] = set()
    for t in templates:
        assert "positionMmBodyLocal" in t
        assert "directionBodyLocal" in t
        pos = t["positionMmBodyLocal"]
        seen.add((pos["x"], pos["y"], pos["z"]))
    assert len(seen) == 4, "each channel sits at its own board position"


async def test_generic_form_devices_get_no_contract():
    """A device whose componentType equals its behavioural kind is skipped.

    Many devices share e.g. ``mirror``; keying a contract off that would
    have them clobber each other, so only distinct part-forms
    (``dds_ad9959_pcb``) get an identity lock.
    """
    async with AsyncSessionLocal() as db:
        contracts = await all_anchor_contracts(db)
    assert "mirror" not in contracts
    assert "dds_ad9959_pcb" in contracts


# ---------------------------------------------------------------------------
# Router guards
# ---------------------------------------------------------------------------


async def test_create_rejects_unregistered_behavioral_kind():
    async with AsyncSessionLocal() as db:
        with pytest.raises(HTTPException) as exc:
            await create_device(_device(behavioral_kind="not_a_real_kind"), db)
        assert exc.value.status_code == 400


async def test_create_allows_null_behavioral_kind():
    """Render-only mechanical fixtures pin no kind at all."""
    payload = _device(behavioral_kind=None, component_type="mechanical")
    async with AsyncSessionLocal() as db:
        created = await create_device(payload, db)
    assert created.behavioral_kind is None
    await _drop([payload.slug])


async def test_locked_device_rejects_edit_and_delete():
    payload = _device()
    async with AsyncSessionLocal() as db:
        created = await create_device(payload, db)
        await update_device(created.id, schemas.DeviceUpdate(locked=True), db)

        with pytest.raises(HTTPException) as exc:
            await update_device(
                created.id, schemas.DeviceUpdate(display_name="hacked"), db
            )
        assert exc.value.status_code == 422

        with pytest.raises(HTTPException) as exc:
            await delete_device(created.id, db)
        assert exc.value.status_code == 422

        # Unlock is the one legal write while locked.
        unlocked = await update_device(
            created.id, schemas.DeviceUpdate(locked=False), db
        )
        assert unlocked.locked is False
    await _drop([payload.slug])


async def test_delete_refuses_while_an_asset_points_at_the_slug():
    payload = _device()
    asset_id = uuid.uuid4()
    async with AsyncSessionLocal() as db:
        created = await create_device(payload, db)
        db.add(
            Asset3D(
                id=asset_id,
                name=f"test_asset_{asset_id.hex[:8]}",
                asset_type="stl",
                file_path="test.stl",
                kind_id="unclassified",
                device_id=payload.slug,
            )
        )
        await db.commit()

        with pytest.raises(HTTPException) as exc:
            await delete_device(created.id, db)
        assert exc.value.status_code == 409

        await db.execute(delete(Asset3D).where(Asset3D.id == asset_id))
        await db.commit()

        # With the last reference gone the delete goes through.
        await delete_device(created.id, db)


async def test_anchors_patch_is_a_whole_list_overwrite():
    """The editor always sends the full layout, so a patch replaces it."""
    payload = _device(
        anchors=[
            schemas.DeviceAnchorTemplate(
                role="intercept_in",
                name="A",
                aperture_mm=12.7,
            ),
            schemas.DeviceAnchorTemplate(role="intercept_out", name="B"),
        ]
    )
    async with AsyncSessionLocal() as db:
        created = await create_device(payload, db)
        assert len(created.anchors) == 2

        patched = await update_device(
            created.id,
            schemas.DeviceUpdate(
                anchors=[schemas.DeviceAnchorTemplate(role="intercept_in")]
            ),
            db,
        )
    assert len(patched.anchors) == 1
    assert patched.anchors[0].aperture_mm is None
    await _drop([payload.slug])
