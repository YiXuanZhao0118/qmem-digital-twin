"""LOD tier storage (alembic 0122). See docs/objectives.md §R-4/R-5.

The load-bearing claim this file exists to hold: **a LOD tier can be written
to a LOCKED asset.** LOD tiers are derived render artifacts, so regenerating
them must not require a human to unlock a reviewed row — while every ordinary
write to that same row stays rejected with 422. If someone later routes this
endpoint through ``lock_guard``, these tests fail loudly rather than silently
turning tier generation into a manual unlock chore for 17 of 23 assets.

Also covers the two invalidation rules, which are correctness rather than
convenience: a tier must never outlive the mesh or the viewerHints it was
baked from.
"""

from __future__ import annotations

import io
import uuid

import pytest
from fastapi import HTTPException, UploadFile
from sqlalchemy import delete, select

from app.config import settings
from app.db import AsyncSessionLocal
from app.models import Asset3D, AssetLod
from app.routers.v3_catalog import (
    update_asset3d_by_catalog_id,
    upsert_asset3d_lod,
)
from app.schemas_v3 import Asset3DV3Update


@pytest.fixture(autouse=True)
async def _reset_engine_pool():
    from app.db import engine

    await engine.dispose()
    yield


def _glb(size: int = 128) -> UploadFile:
    """A stand-in payload — the route stores bytes and never parses them."""
    return UploadFile(file=io.BytesIO(b"glTF" + b"\0" * size), filename="tier.glb")


async def _make_asset(locked: bool) -> tuple[uuid.UUID, str]:
    aid = uuid.uuid4()
    slug = f"test_lod_{aid.hex[:8]}"
    async with AsyncSessionLocal() as db:
        db.add(Asset3D(
            id=aid,
            name="LOD test asset",
            asset_type="glb",
            file_path=f"files/glb/{slug}.glb",
            catalog_id=slug,
            kind_id="unclassified",
            anchors=[],
            properties={},
            locked=locked,
        ))
        await db.commit()
    return aid, slug


async def _cleanup(aid: uuid.UUID) -> None:
    async with AsyncSessionLocal() as db:
        tiers = (await db.execute(
            select(AssetLod).where(AssetLod.asset_id == aid)
        )).scalars().all()
        for tier in tiers:
            if tier.level > 0:
                (settings.asset_root / tier.file_path).unlink(missing_ok=True)
        await db.execute(delete(AssetLod).where(AssetLod.asset_id == aid))
        await db.execute(delete(Asset3D).where(Asset3D.id == aid))
        await db.commit()


@pytest.fixture
async def locked_asset():
    aid, slug = await _make_asset(locked=True)
    yield slug
    await _cleanup(aid)


@pytest.fixture
async def unlocked_asset():
    aid, slug = await _make_asset(locked=False)
    yield slug
    await _cleanup(aid)


# ---------------------------------------------------------------------------
# The lock interaction — why this table exists at all
# ---------------------------------------------------------------------------


async def test_tier_write_is_allowed_on_a_locked_asset(locked_asset):
    async with AsyncSessionLocal() as db:
        row = await upsert_asset3d_lod(
            locked_asset, level=1, tri_count=100_000, error_mm=0.412,
            file=_glb(), session=db,
        )
    assert row.locked is True, "the lock itself must be untouched"
    tiers = {t.level: t for t in row.lods}
    assert tiers[1].error_mm == pytest.approx(0.412)
    assert tiers[1].tri_count == 100_000


async def test_ordinary_write_to_that_same_locked_asset_still_422s(locked_asset):
    async with AsyncSessionLocal() as db:
        with pytest.raises(HTTPException) as exc:
            await update_asset3d_by_catalog_id(
                locked_asset, Asset3DV3Update(name="hacked"), db
            )
        assert exc.value.status_code == 422


# ---------------------------------------------------------------------------
# Level-0 semantics
# ---------------------------------------------------------------------------


async def test_level0_mirrors_the_asset_file_and_takes_no_upload(unlocked_asset):
    # ``file=None`` is passed explicitly throughout: calling the route
    # function directly bypasses FastAPI's dependency resolution, so an
    # omitted argument arrives as the ``File(None)`` marker object rather
    # than None. Over HTTP the default resolves to None normally.
    async with AsyncSessionLocal() as db:
        row = await upsert_asset3d_lod(
            unlocked_asset, level=0, tri_count=464_000, error_mm=0,
            file=None, session=db,
        )
    tier0 = next(t for t in row.lods if t.level == 0)
    assert tier0.file_path == row.file_path
    assert tier0.error_mm == 0.0

    async with AsyncSessionLocal() as db:
        with pytest.raises(HTTPException) as exc:
            await upsert_asset3d_lod(
                unlocked_asset, level=0, tri_count=1, error_mm=0,
                file=_glb(), session=db,
            )
        assert exc.value.status_code == 400


async def test_decimated_level_requires_a_file(unlocked_asset):
    async with AsyncSessionLocal() as db:
        with pytest.raises(HTTPException) as exc:
            await upsert_asset3d_lod(
                unlocked_asset, level=2, tri_count=20_000, error_mm=1.8,
                file=None, session=db,
            )
        assert exc.value.status_code == 400


# ---------------------------------------------------------------------------
# Upsert + invalidation
# ---------------------------------------------------------------------------


async def test_reposting_a_level_replaces_it_rather_than_duplicating(unlocked_asset):
    async with AsyncSessionLocal() as db:
        await upsert_asset3d_lod(
            unlocked_asset, level=2, tri_count=20_000, error_mm=1.8,
            file=_glb(), session=db,
        )
    async with AsyncSessionLocal() as db:
        row = await upsert_asset3d_lod(
            unlocked_asset, level=2, tri_count=19_000, error_mm=2.5,
            file=_glb(64), session=db,
        )
    level2 = [t for t in row.lods if t.level == 2]
    assert len(level2) == 1
    assert level2[0].tri_count == 19_000
    assert level2[0].error_mm == pytest.approx(2.5)


async def test_viewer_hints_edit_invalidates_every_tier(unlocked_asset):
    # viewerHints centroid keys are computed on the FULL-resolution mesh, so
    # decimation moves them all — tiers baked against the old hints filter
    # geometry that no longer exists.
    async with AsyncSessionLocal() as db:
        await update_asset3d_by_catalog_id(
            unlocked_asset,
            Asset3DV3Update(properties={"viewerHints": {"deletedCentroids": ["1,2,3"]}}),
            db,
        )
    async with AsyncSessionLocal() as db:
        row = await upsert_asset3d_lod(
            unlocked_asset, level=2, tri_count=20_000, error_mm=1.8,
            file=_glb(), session=db,
        )
        assert row.lods[0].hints_digest is not None

    # An unrelated edit must NOT drop them.
    async with AsyncSessionLocal() as db:
        row = await update_asset3d_by_catalog_id(
            unlocked_asset, Asset3DV3Update(name="renamed"), db
        )
        assert len(row.lods) == 1

    # A hints change must.
    async with AsyncSessionLocal() as db:
        row = await update_asset3d_by_catalog_id(
            unlocked_asset,
            Asset3DV3Update(properties={"viewerHints": {"deletedCentroids": ["9,9,9"]}}),
            db,
        )
        assert row.lods == []
