"""A deleted kind stays deleted (alembic 0138).

The bug this closes: ``restart-stack.ps1`` runs ``alembic upgrade head``
before uvicorn, and the resync migrations insert whatever
``backend/data/kinds.json`` has and the table lacks (0126's insert path,
0136 wholesale). Deleting a plugin-backed kind in the Kinds editor therefore
survived only until the next migration landed — 0136's docstring records the
four it re-created while believing they had "never been inserted".

``kind_deletions`` records the deletion and a BEFORE INSERT trigger on
``kinds`` skips any insert of a tombstoned name, so the manifest can propose
and the user's deletion still disposes. Re-creating the kind through the
editor clears the tombstone — that is the release valve, and the third test
below is what keeps it working.

Runs against the dev DB (see conftest). Every test cleans up both rows.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import delete, select, text

from app import schemas
from app.db import AsyncSessionLocal
from app.models import Kind, KindDeletion
from app.routers.kinds import create_kind, delete_kind


@pytest.fixture(autouse=True)
async def _reset_engine_pool():
    from app.db import engine

    await engine.dispose()
    yield


def _payload(name: str) -> schemas.KindCreate:
    return schemas.KindCreate(
        name=name,
        display_name="Throwaway",
        domains=["optical"],
        op_set_name="mirror",
    )


async def _drop(name: str) -> None:
    async with AsyncSessionLocal() as db:
        await db.execute(delete(Kind).where(Kind.name == name))
        await db.execute(delete(KindDeletion).where(KindDeletion.name == name))
        await db.commit()


async def _resync_insert(name: str) -> None:
    """The INSERT shape every resync migration uses (0126 / 0136)."""
    async with AsyncSessionLocal() as db:
        await db.execute(
            text(
                "INSERT INTO kinds (name, display_name, op_set_name, domains, "
                "default_params, anchor_template, needs_aperture) VALUES "
                "(:n, 'Resynced', 'mirror', ARRAY['optical']::text[], "
                "'{}'::jsonb, '{}'::jsonb, false) ON CONFLICT (name) DO NOTHING"
            ),
            {"n": name},
        )
        await db.commit()


async def _row_count(name: str) -> int:
    async with AsyncSessionLocal() as db:
        return len((await db.scalars(select(Kind).where(Kind.name == name))).all())


@pytest.fixture
async def throwaway_kind():
    name = f"test_kind_{uuid.uuid4().hex[:8]}"
    async with AsyncSessionLocal() as db:
        await create_kind(_payload(name), db)
    yield name
    await _drop(name)


async def test_delete_writes_a_tombstone(throwaway_kind: str) -> None:
    async with AsyncSessionLocal() as db:
        kind = (await db.scalars(select(Kind).where(Kind.name == throwaway_kind))).one()
        await delete_kind(kind.id, db)

    async with AsyncSessionLocal() as db:
        tombstone = await db.get(KindDeletion, throwaway_kind)
    assert tombstone is not None, "deleting a kind must record why it is absent"


async def test_a_resync_insert_cannot_resurrect_a_tombstoned_kind(
    throwaway_kind: str,
) -> None:
    """The regression proper — this insert is what a restart used to run."""
    async with AsyncSessionLocal() as db:
        kind = (await db.scalars(select(Kind).where(Kind.name == throwaway_kind))).one()
        await delete_kind(kind.id, db)

    await _resync_insert(throwaway_kind)

    assert await _row_count(throwaway_kind) == 0, (
        "a tombstoned kind was re-inserted — the kinds_skip_tombstoned trigger "
        "is missing or was dropped"
    )


async def test_an_untombstoned_kind_still_inserts(throwaway_kind: str) -> None:
    """The trigger must narrow nothing but the tombstoned names."""
    other = f"{throwaway_kind}_x"
    try:
        await _resync_insert(other)
        assert await _row_count(other) == 1
    finally:
        await _drop(other)


async def test_recreating_a_kind_clears_its_tombstone(throwaway_kind: str) -> None:
    async with AsyncSessionLocal() as db:
        kind = (await db.scalars(select(Kind).where(Kind.name == throwaway_kind))).one()
        await delete_kind(kind.id, db)

    async with AsyncSessionLocal() as db:
        recreated = await create_kind(_payload(throwaway_kind), db)
    assert recreated.name == throwaway_kind

    async with AsyncSessionLocal() as db:
        assert await db.get(KindDeletion, throwaway_kind) is None
    assert await _row_count(throwaway_kind) == 1
