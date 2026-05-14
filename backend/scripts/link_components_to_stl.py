"""One-shot link: Component.asset_3d_id -> Asset3D by name convention.

For every Component whose asset_3d_id currently points at a primitive (or is
null), look for an Asset3D named `<component.name>_stl` whose filePath is a
real STL (not a `primitive://` URI). If found, set asset_3d_id to that
asset's id. No other Component fields are touched.

Run from repo root:
    python -m backend.scripts.link_components_to_stl

Idempotent — re-running only changes rows that still don't point at the STL.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from sqlalchemy import select

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.db import AsyncSessionLocal  # noqa: E402
from app.models import Asset3D, Component  # noqa: E402


async def main() -> None:
    async with AsyncSessionLocal() as session:
        components = (await session.scalars(select(Component))).all()
        assets = (await session.scalars(select(Asset3D))).all()

        assets_by_name: dict[str, Asset3D] = {a.name: a for a in assets}

        linked: list[tuple[str, str, str]] = []
        already_ok: list[str] = []
        no_match: list[str] = []

        for c in components:
            stl_name = f"{c.name}_stl"
            target = assets_by_name.get(stl_name)
            if target is None or not target.file_path or target.file_path.startswith("primitive://"):
                no_match.append(c.name)
                continue
            if c.asset_3d_id == target.id:
                already_ok.append(c.name)
                continue
            old = str(c.asset_3d_id) if c.asset_3d_id else "(null)"
            c.asset_3d_id = target.id
            linked.append((c.name, old, target.file_path))

        await session.commit()

        print(f"Linked     : {len(linked)}")
        print(f"Already OK : {len(already_ok)}")
        print(f"No STL     : {len(no_match)}")
        if linked:
            print("\nFirst 15 linked:")
            for name, old, fp in linked[:15]:
                print(f"  {name:50s} {old[:8]:9s} -> {fp}")


if __name__ == "__main__":
    asyncio.run(main())
