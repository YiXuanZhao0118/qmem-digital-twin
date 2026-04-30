from __future__ import annotations

import asyncio
from pathlib import Path
import sys

from sqlalchemy import select

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.db import AsyncSessionLocal  # noqa: E402
from app.models import Asset3D, Component, Placement  # noqa: E402


ASSET = {
    "name": "primitive_more_photonics_ts2000a",
    "asset_type": "primitive",
    "file_path": "primitive://more_photonics_ts2000a",
    "source": "More Photonics product page",
    "source_url": "https://morephotonics.com/products/laser-modules/laser-diode-mounts/ts-2000-a-laser-mount/",
    "unit": "mm",
    "scale_factor": 1.0,
}

COMPONENT = {
    "name": "more_photonics_ts2000a_laser_mount",
    "component_type": "laser_diode_mount",
    "brand": "More Photonics / Photodigm",
    "model": "TS-2000-A",
    "properties": {
        "geometry": "more_photonics_ts2000a",
        "dimensionsMm": [72.6, 50.8, 44.5],
        "package": "TOSA laser diode package test fixture",
        "zifSocket": "Zero insertion force socket for flex cable",
        "tecConnector": "15-pin D-SUB male connector",
        "laserDiodeConnector": "9-pin D-SUB male connector",
        "mountingHoles": ["2x 1/4-20", "4x #4-40 for 30 mm square cage system"],
        "finish": "Black anodized",
        "sourceUrl": "https://morephotonics.com/products/laser-modules/laser-diode-mounts/ts-2000-a-laser-mount/",
        "datasheetUrl": "https://morephotonics.com/wp-content/uploads/2023/10/TS-2000-A-Data-Sheet.pdf",
    },
}

PLACEMENT = {
    "object_name": "more_photonics_ts2000a_laser_mount_object_1",
    "x_mm": -650,
    "y_mm": -20,
    "z_mm": 30,
    "rx_deg": 0,
    "ry_deg": 0,
    "rz_deg": 0,
    "visible": True,
    "locked": False,
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
        print("Upserted TS-2000-A laser mount component.")


if __name__ == "__main__":
    asyncio.run(main())
