"""One-off: spawn paired fiber_end SceneObjects for any fiber body that
doesn't have endA/BObjectId set yet.

Why: alembic 0052 split historical fibers, and the new
`auto_create_physics_element_for_object` hook spawns ends for fibers
created via the catalog from now on. Anything created in the gap
between those two (i.e. a fiber created via the API while the auto-
create hook was still missing) ends up as a single SceneObject with no
ends — node-edit endpoint drag goes through the legacy "stays pinned"
fallback because there's no fiber_end to route the drag to.

This script delegates to the same `_spawn_fiber_end_pair_for_body`
helper used by the auto-create hook so the resulting data is bit-for-
bit identical.

Run with:
    .venv/Scripts/python.exe scripts/backfill_fiber_ends.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from sqlalchemy import select

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.db import AsyncSessionLocal  # noqa: E402
from app.models import Component, PhysicsElement, SceneObject  # noqa: E402
from app.routers.components import _spawn_fiber_end_pair_for_body  # noqa: E402


async def main() -> None:
    async with AsyncSessionLocal() as session:
        fibers = (
            await session.scalars(
                select(PhysicsElement).where(PhysicsElement.element_kind == "fiber")
            )
        ).all()
        orphans = [
            pe
            for pe in fibers
            if not (pe.kind_params or {}).get("endAObjectId")
            and not (pe.kind_params or {}).get("endBObjectId")
        ]
        if not orphans:
            print("No fibers without paired ends found. Nothing to do.")
            return

        for fiber_pe in orphans:
            fiber_obj = await session.get(SceneObject, fiber_pe.object_id)
            if fiber_obj is None:
                print(f"  skipping {fiber_pe.object_id}: SceneObject missing")
                continue
            fiber_component = await session.get(Component, fiber_obj.component_id)
            if fiber_component is None:
                print(f"  skipping {fiber_obj.name}: catalog Component missing")
                continue
            await _spawn_fiber_end_pair_for_body(
                session, fiber_obj, fiber_pe, fiber_component
            )
            print(f"  Backfilled paired ends for {fiber_obj.name}")

        await session.commit()
        print(f"Done. Backfilled {len(orphans)} fiber(s).")


if __name__ == "__main__":
    asyncio.run(main())
