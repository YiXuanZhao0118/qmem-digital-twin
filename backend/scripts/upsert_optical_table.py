from __future__ import annotations

import asyncio
from pathlib import Path
import sys

from sqlalchemy import select

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.db import AsyncSessionLocal  # noqa: E402
from app.models import Asset3D, CollectionMember, Component, Kind, SceneObject  # noqa: E402
from app.routers.collections import get_master_collection  # noqa: E402


KIND = {
    "name": "optical_table",
    "display_name": "Optical Table",
    "domains": ["mechanical"],
    "op_set_name": "optical_table",
    "default_params": {},
    "anchor_template": {},
    "needs_aperture": False,
    "wavelength_range_nm": None,
    "description": "Passive mechanical optical table primitive used as the lab reference surface.",
}

ASSET = {
    "name": "primitive_table",
    "asset_type": "primitive",
    "file_path": "primitive://table",
    "unit": "mm",
    "scale_factor": 1.0,
    "kind_id": "optical_table",
}

COMPONENT = {
    "name": "optical_table_1",
    "kind_id": "optical_table",
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

SCENE_OBJECT = {
    "name": "optical_table_1_object_1",
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
        kind = await session.scalar(select(Kind).where(Kind.name == KIND["name"]))
        if kind is None:
            kind = Kind(**KIND)
            session.add(kind)
            await session.flush()
        else:
            for key, value in KIND.items():
                setattr(kind, key, value)

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

        scene_objects = (
            await session.scalars(select(SceneObject).where(SceneObject.component_id == component.id))
        ).all()
        scene_object = next(
            (item for item in scene_objects if item.name == SCENE_OBJECT["name"]),
            scene_objects[0] if scene_objects else None,
        )
        if scene_object is None:
            scene_object = SceneObject(component_id=component.id, **SCENE_OBJECT)
            session.add(scene_object)
        else:
            for key, value in SCENE_OBJECT.items():
                setattr(scene_object, key, value)
        await session.flush()

        # The Outliner is keyed by collection membership: a SceneObject with no
        # CollectionMember renders in 3D but is invisible to (and unremovable
        # from) the collection tree. Mirror create_object / seed.py and
        # guarantee a Master Collection home.
        existing_member = await session.scalars(
            select(CollectionMember).where(CollectionMember.object_id == scene_object.id)
        )
        if existing_member.first() is None:
            master = await get_master_collection(session)
            session.add(
                CollectionMember(collection_id=master.id, object_id=scene_object.id)
            )

        await session.commit()
        print("Upserted locked optical table component.")


if __name__ == "__main__":
    asyncio.run(main())
