"""One-shot rename of existing Components and SceneObjects to the new default
naming policy (confirmed with user 2026-05-16):

- Component.name = model  (fallback: component_type, fallback: "component"),
  with case-insensitive `-N` suffixing on collision.
- SceneObject.name = UPPER(component_type) + 0-based index per category
  (e.g. AOM0, AOM1, MIRROR0).

Run from the backend dir:  python scripts/rename_to_defaults.py

Idempotent: re-running after a manual rename will renumber objects in
component_type order and rebase components onto model+suffix.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
import sys

from sqlalchemy import select

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.db import AsyncSessionLocal  # noqa: E402
from app.models import Component, SceneObject  # noqa: E402


def _component_base(component: Component) -> str:
    base = (component.model or "").strip() or (component.component_type or "").strip()
    return base or "component"


def _object_base(component_type: str | None) -> str:
    return (component_type or "").strip().upper() or "OBJECT"


async def main() -> None:
    async with AsyncSessionLocal() as session:
        # ----------------------------------------------------------------
        # Components — only rename non-archived rows. Archived components
        # are "in trash" — leaving their names alone matches the runtime
        # uniqueness check which also filters archived out.
        # Order by id for deterministic suffix assignment.
        # ----------------------------------------------------------------
        components = list(
            (
                await session.scalars(
                    select(Component)
                    .where(Component.archived_at.is_(None))
                    .order_by(Component.id)
                )
            ).all()
        )
        used: set[str] = set()
        comp_renames = 0
        for comp in components:
            base = _component_base(comp)
            candidate = base
            if candidate.lower() in used:
                i = 2
                while f"{base}-{i}".lower() in used:
                    i += 1
                candidate = f"{base}-{i}"
            used.add(candidate.lower())
            if comp.name != candidate:
                comp.name = candidate
                comp_renames += 1

        # ----------------------------------------------------------------
        # Objects — DB has UNIQUE(name). Two-phase: first move everything
        # to a placeholder so the second pass can freely assign finals
        # without tripping the unique index mid-flush.
        # Build ctype map from ALL components (incl. archived) so objects
        # linked to archived rows still get a meaningful category prefix.
        # ----------------------------------------------------------------
        ctype_by_cid = dict(
            (cid, ctype)
            for cid, ctype in (
                await session.execute(select(Component.id, Component.component_type))
            )
        )

        objects = list(
            (await session.scalars(select(SceneObject).order_by(SceneObject.id))).all()
        )

        for obj in objects:
            obj.name = f"__rename_{obj.id}"
        await session.flush()

        per_base_index: dict[str, int] = {}
        obj_renames = 0
        for obj in objects:
            base = _object_base(ctype_by_cid.get(obj.component_id))
            idx = per_base_index.get(base, 0)
            final = f"{base}{idx}"
            per_base_index[base] = idx + 1
            obj.name = final
            obj_renames += 1

        await session.commit()
        print(
            f"Renamed {comp_renames} components and {obj_renames} objects."
        )


if __name__ == "__main__":
    asyncio.run(main())
