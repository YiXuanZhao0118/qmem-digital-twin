"""Locked-row write guard (alembic 0112).

A locked Kind / Asset3D is human-confirmed "complete, do not adjust". The
API must reject every write that changes a field other than ``locked``
itself (so unlock is the only legal mutation while locked).

Pure-function tests cover the rule; one DB-backed test confirms the kinds
router actually enforces it end-to-end.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import delete

from app import schemas
from app.db import AsyncSessionLocal
from app.lock_guard import assert_delete_allowed, assert_update_allowed
from app.models import Kind
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
