"""Locked-row write guard (alembic 0112; Component joined in 0128).

A locked Kind / Asset3D / Device / Component is human-confirmed "complete,
do not adjust". The API must reject every write that changes a field other
than ``locked`` itself (so unlock is the only legal mutation while locked).

Pure-function tests cover the rule; DB-backed tests confirm the kinds and
components routers actually enforce it end-to-end.

Component is the newest and was the odd one out: until alembic 0128 it had
an ad-hoc ``properties['locked']`` JSONB flag that guarded delete only, and
answered 409 instead of 422. The tests below pin it to the shared contract.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import delete

from app import schemas
from app.db import AsyncSessionLocal
from app.lock_guard import assert_delete_allowed, assert_update_allowed
from app.models import Component, Kind
from app.routers.components import delete_component, update_component
from app.routers.kinds import delete_kind, update_kind


# ---------------------------------------------------------------------------
# Pure guard logic
# ---------------------------------------------------------------------------


def test_unlocked_row_allows_any_update():
    # No exception expected.
    assert_update_allowed(
        locked=False, changed_fields={"display_name", "default_params"}, label="x"
    )


def test_locked_row_rejects_non_lock_fields():
    with pytest.raises(HTTPException) as exc:
        assert_update_allowed(
            locked=True, changed_fields={"display_name"}, label="Kind 'foo'"
        )
    assert exc.value.status_code == 422
    assert "locked" in exc.value.detail.lower()


def test_locked_row_allows_pure_unlock():
    # Toggling only ``locked`` is the one permitted write while locked.
    assert_update_allowed(locked=True, changed_fields={"locked"}, label="x")


def test_locked_row_rejects_unlock_bundled_with_edit():
    with pytest.raises(HTTPException) as exc:
        assert_update_allowed(
            locked=True, changed_fields={"locked", "display_name"}, label="x"
        )
    assert exc.value.status_code == 422


def test_delete_guard():
    assert_delete_allowed(locked=False, label="x")  # no raise
    with pytest.raises(HTTPException) as exc:
        assert_delete_allowed(locked=True, label="Kind 'foo'")
    assert exc.value.status_code == 422


# ---------------------------------------------------------------------------
# End-to-end: kinds router enforces the guard
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
async def _reset_engine_pool():
    from app.db import engine

    await engine.dispose()
    yield


@pytest.fixture
async def locked_kind_id():
    kid = uuid.uuid4()
    async with AsyncSessionLocal() as db:
        db.add(
            Kind(
                id=kid,
                name=f"test_locked_{kid.hex[:8]}",
                display_name="Test Locked Kind",
                domains=["optical"],
                op_set_name="mirror",
                locked=True,
            )
        )
        await db.commit()
    yield kid
    async with AsyncSessionLocal() as db:
        await db.execute(delete(Kind).where(Kind.id == kid))
        await db.commit()


async def test_update_kind_rejects_edit_while_locked(locked_kind_id):
    async with AsyncSessionLocal() as db:
        with pytest.raises(HTTPException) as exc:
            await update_kind(
                locked_kind_id,
                schemas.KindUpdate(display_name="hacked"),
                db,
            )
        assert exc.value.status_code == 422


async def test_delete_kind_rejects_while_locked(locked_kind_id):
    async with AsyncSessionLocal() as db:
        with pytest.raises(HTTPException) as exc:
            await delete_kind(locked_kind_id, db)
        assert exc.value.status_code == 422


async def test_update_kind_allows_pure_unlock(locked_kind_id):
    async with AsyncSessionLocal() as db:
        result = await update_kind(
            locked_kind_id, schemas.KindUpdate(locked=False), db
        )
        assert result.locked is False


# ---------------------------------------------------------------------------
# Component (alembic 0128) — same contract, real column, shared guard
# ---------------------------------------------------------------------------


@pytest.fixture
async def locked_component_id():
    cid = uuid.uuid4()
    async with AsyncSessionLocal() as db:
        db.add(
            Component(
                id=cid,
                name=f"test_locked_component_{cid.hex[:8]}",
                kind_id="mirror",
                locked=True,
            )
        )
        await db.commit()
    yield cid
    async with AsyncSessionLocal() as db:
        await db.execute(delete(Component).where(Component.id == cid))
        await db.commit()


async def test_update_component_rejects_edit_while_locked(locked_component_id):
    async with AsyncSessionLocal() as db:
        with pytest.raises(HTTPException) as exc:
            await update_component(
                locked_component_id,
                schemas.ComponentUpdate(name="hacked"),
                db,
            )
        assert exc.value.status_code == 422


async def test_delete_component_rejects_while_locked(locked_component_id):
    """422, not the pre-0128 409 — Component now answers like every other
    locked table so a client can handle one status code."""
    async with AsyncSessionLocal() as db:
        with pytest.raises(HTTPException) as exc:
            await delete_component(locked_component_id, db)
        assert exc.value.status_code == 422


async def test_update_component_allows_pure_unlock(locked_component_id):
    async with AsyncSessionLocal() as db:
        result = await update_component(
            locked_component_id, schemas.ComponentUpdate(locked=False), db
        )
        assert result.locked is False


async def test_unlocked_component_still_editable(locked_component_id):
    """Unlock, then edit — proves the guard is the only thing that blocked it."""
    async with AsyncSessionLocal() as db:
        await update_component(
            locked_component_id, schemas.ComponentUpdate(locked=False), db
        )
    async with AsyncSessionLocal() as db:
        result = await update_component(
            locked_component_id, schemas.ComponentUpdate(notes="edited"), db
        )
        assert result.notes == "edited"
