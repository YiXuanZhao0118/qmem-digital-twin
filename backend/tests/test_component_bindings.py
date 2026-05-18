"""ComponentBinding model + CRUD tests (alembic 0062).

Covers the binding-tree contract:

* Migration backfill produced one root binding per legacy
  ``Component.asset_3d_id``.
* CHECK constraints reject ill-formed rows (both targets set, neither
  set, target_kind mismatched, self subcomponent).
* Cycle detection rejects sub-component graphs that would close back to
  the container.
* Tree parent/child cascade-delete works (deleting a parent binding
  drops its children).

Runs against the local dev postgres (port 55432). Each test creates
uniquely-named scratch rows and cleans up on teardown.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from app.db import AsyncSessionLocal
from app.models import Asset3D, Component, ComponentBinding
from app.routers.component_bindings import _has_subcomponent_cycle


@pytest.fixture(autouse=True)
async def _reset_engine_pool():
    """pytest-asyncio gives each test a fresh loop; the global engine
    was bound at module-import to a now-defunct loop. Dispose so a new
    pool attaches to *this* test's loop.
    """
    from app.db import engine

    await engine.dispose()
    yield


@pytest.fixture
async def scratch_ids():
    """Track component / asset ids created in the test; teardown deletes
    them (and their cascaded bindings) so the dev catalog is untouched.
    """
    component_ids: list[uuid.UUID] = []
    asset_ids: list[uuid.UUID] = []
    yield {"components": component_ids, "assets": asset_ids}
    async with AsyncSessionLocal() as db:
        if component_ids:
            await db.execute(
                delete(Component).where(Component.id.in_(component_ids))
            )
        if asset_ids:
            await db.execute(delete(Asset3D).where(Asset3D.id.in_(asset_ids)))
        await db.commit()


async def _mk_asset(db, name_suffix: str) -> Asset3D:
    asset = Asset3D(
        name=f"test_binding_{name_suffix}_{uuid.uuid4().hex[:6]}",
        asset_type="stl",
        file_path=f"files/stl/test_{name_suffix}.stl",
    )
    db.add(asset)
    await db.flush()
    return asset


async def _mk_component(db, name_suffix: str) -> Component:
    component = Component(
        name=f"test_binding_comp_{name_suffix}_{uuid.uuid4().hex[:6]}",
        component_type="custom_3d",
    )
    db.add(component)
    await db.flush()
    return component


# ---------------------------------------------------------------------------
# Migration backfill
# ---------------------------------------------------------------------------


async def test_migration_backfilled_root_binding_per_component():
    """Every component with non-null asset_3d_id should have at least one
    binding row (the root produced by alembic 0062's backfill INSERT)."""
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(Component.id)
            .where(Component.asset_3d_id.is_not(None))
            .where(
                ~select(ComponentBinding.id)
                .where(ComponentBinding.component_id == Component.id)
                .exists()
            )
        )
        missing = list(result.scalars().all())
        assert not missing, f"{len(missing)} components missing a binding row"


# ---------------------------------------------------------------------------
# CHECK constraints
# ---------------------------------------------------------------------------


async def test_constraint_rejects_both_targets_set(scratch_ids):
    async with AsyncSessionLocal() as db:
        asset = await _mk_asset(db, "both")
        container = await _mk_component(db, "both_container")
        other = await _mk_component(db, "both_other")
        scratch_ids["assets"].append(asset.id)
        scratch_ids["components"].extend([container.id, other.id])
        await db.commit()

        bad = ComponentBinding(
            component_id=container.id,
            target_kind="asset",
            asset_3d_id=asset.id,
            sub_component_id=other.id,  # both targets — illegal
        )
        db.add(bad)
        with pytest.raises(IntegrityError):
            await db.commit()


async def test_constraint_rejects_no_targets(scratch_ids):
    async with AsyncSessionLocal() as db:
        container = await _mk_component(db, "none_container")
        scratch_ids["components"].append(container.id)
        await db.commit()

        bad = ComponentBinding(
            component_id=container.id,
            target_kind="asset",
            # neither asset_3d_id nor sub_component_id — illegal
        )
        db.add(bad)
        with pytest.raises(IntegrityError):
            await db.commit()


async def test_constraint_rejects_target_kind_mismatch(scratch_ids):
    async with AsyncSessionLocal() as db:
        asset = await _mk_asset(db, "mismatch")
        container = await _mk_component(db, "mismatch_container")
        scratch_ids["assets"].append(asset.id)
        scratch_ids["components"].append(container.id)
        await db.commit()

        bad = ComponentBinding(
            component_id=container.id,
            target_kind="subcomponent",  # says subcomponent
            asset_3d_id=asset.id,  # but provides asset — mismatch
        )
        db.add(bad)
        with pytest.raises(IntegrityError):
            await db.commit()


async def test_constraint_rejects_self_subcomponent(scratch_ids):
    async with AsyncSessionLocal() as db:
        container = await _mk_component(db, "self_ref")
        scratch_ids["components"].append(container.id)
        await db.commit()

        bad = ComponentBinding(
            component_id=container.id,
            target_kind="subcomponent",
            sub_component_id=container.id,  # direct self ref — illegal
        )
        db.add(bad)
        with pytest.raises(IntegrityError):
            await db.commit()


# ---------------------------------------------------------------------------
# Cycle detection helper
# ---------------------------------------------------------------------------


async def test_cycle_detection_direct(scratch_ids):
    async with AsyncSessionLocal() as db:
        a = await _mk_component(db, "cycle_a")
        scratch_ids["components"].append(a.id)
        await db.commit()
        assert await _has_subcomponent_cycle(db, a.id, a.id)


async def test_cycle_detection_transitive(scratch_ids):
    """A → B → C, then trying to put A as a sub of C should be rejected."""
    async with AsyncSessionLocal() as db:
        asset = await _mk_asset(db, "trans")
        a = await _mk_component(db, "trans_a")
        b = await _mk_component(db, "trans_b")
        c = await _mk_component(db, "trans_c")
        scratch_ids["assets"].append(asset.id)
        scratch_ids["components"].extend([a.id, b.id, c.id])

        # A binds B as sub-component
        db.add(
            ComponentBinding(
                component_id=a.id,
                target_kind="subcomponent",
                sub_component_id=b.id,
            )
        )
        # B binds C as sub-component
        db.add(
            ComponentBinding(
                component_id=b.id,
                target_kind="subcomponent",
                sub_component_id=c.id,
            )
        )
        await db.commit()

        # Now putting A under C would close the cycle.
        assert await _has_subcomponent_cycle(db, c.id, a.id)
        # B → C already exists; the cycle check is "would adding this CREATE
        # a cycle that didn't exist before", not "is this edge already in
        # the graph", so this is False.
        assert not await _has_subcomponent_cycle(db, b.id, c.id)


# ---------------------------------------------------------------------------
# Parent/child tree
# ---------------------------------------------------------------------------


async def test_parent_cascade_delete(scratch_ids):
    """Deleting a parent binding should cascade-delete its children."""
    async with AsyncSessionLocal() as db:
        asset = await _mk_asset(db, "tree")
        container = await _mk_component(db, "tree_container")
        scratch_ids["assets"].append(asset.id)
        scratch_ids["components"].append(container.id)

        root = ComponentBinding(
            component_id=container.id,
            target_kind="asset",
            asset_3d_id=asset.id,
            role="body",
        )
        db.add(root)
        await db.flush()

        child = ComponentBinding(
            component_id=container.id,
            parent_binding_id=root.id,
            target_kind="asset",
            asset_3d_id=asset.id,
            role="internal_part",
        )
        db.add(child)
        await db.commit()
        child_id = child.id

        # Delete root → child should be cascaded out by the DB-level FK
        # CASCADE on parent_binding_id. Use a bulk DELETE so the cascade
        # path runs against postgres rather than SQLAlchemy ORM cascade
        # (this is what the real DELETE /api/component-bindings/{id} call
        # is closer to once production load is high enough).
        await db.execute(
            delete(ComponentBinding).where(ComponentBinding.id == root.id)
        )
        await db.commit()

    # Fresh session — the identity map of the previous session still
    # holds a strong ref to the deleted child row, which would make
    # ``db.get(ComponentBinding, child_id)`` return that stale ORM object
    # instead of going back to the DB. A new session is the cleanest way
    # to verify the row really is gone.
    async with AsyncSessionLocal() as db2:
        leftover = await db2.get(ComponentBinding, child_id)
        assert leftover is None
