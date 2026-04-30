from __future__ import annotations

import asyncio
from pathlib import Path
import sys

from sqlalchemy import select

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.db import AsyncSessionLocal  # noqa: E402
from app.models import Asset3D, Component, Placement  # noqa: E402


ASSET = {
    "name": "primitive_table",
    "asset_type": "primitive",
    "file_path": "primitive://table",
    "unit": "mm",
    "scale_factor": 1.0,
}

COMPONENT = {
    "name": "optical_table_1",
    "component_type": "optical_table",
    "brand": "Newport",
    "model": "RS4000 1200x3600x457 + S-2000A",
    "properties": {
        "geometry": "newport_rs4000_table",
        "dimensionsMm": [3600, 1200, 457],
        "topHeightMm": 860,
        "holeGrid": [144, 48],
        "thread": "M6",
        "isolatorModel": "S-2000A",
        "isolatorCount": 6,
        "locked": True,
    },
}

PLACEMENT = {
    "object_name": "optical_table_1_object_1",
    "x_mm": 0,
    "y_mm": 0,
    "z_mm": 0,
    "rx_deg": 0,
    "ry_deg": 0,
    "rz_deg": 0,
    "visible": True,
    "locked": True,
}


async def main() -> None:
    async with AsyncSessionLocal() as session:
        asset = await session.scalar(select(Asset3D).where(Asset3D.name == ASSET["name"]))
        if asset is None:
            asset = Asset3D(**ASSET)
            session.add(asset)
            await session.flush()
        else:
            for key, value in ASSET.items():
                setattr(asset, key, value)

        component = await session.scalar(select(Component).where(Component.name == COMPONENT["name"]))
        if component is None:
            component = Component(**COMPONENT, asset_3d_id=asset.id)
            session.add(component)
            await session.flush()
        else:
            for key, value in COMPONENT.items():
                setattr(component, key, value)
            component.asset_3d_id = asset.id
            await session.flush()

        placements = (
            await session.scalars(select(Placement).where(Placement.component_id == component.id))
        ).all()
        placement = next(
            (item for item in placements if item.object_name == PLACEMENT["object_name"]),
            placements[0] if placements else None,
        )
        if placement is None:
            session.add(Placement(component_id=component.id, **PLACEMENT))
        else:
            for key, value in PLACEMENT.items():
                setattr(placement, key, value)

        await session.commit()
        print("Upserted locked optical table component.")


if __name__ == "__main__":
    asyncio.run(main())
