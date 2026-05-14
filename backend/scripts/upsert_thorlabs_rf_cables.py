"""Upsert Thorlabs catalog RF coaxial cables.

CA29xx series — SMA-to-SMA RG-316 cable assemblies (DC to 3 GHz, 50 Ω).
Each part number is one Component pointing at the shared procedural SMA
cable primitive (renderer in `frontend/src/three/loadAsset.ts ::
createSmaShortCable`, scaled by `properties.lengthMm`).

ElementKind: `rf_cable` (added 2026-05-13, parallel to `fiber`).
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from sqlalchemy import select

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.db import AsyncSessionLocal  # noqa: E402
from app.models import Asset3D, Component  # noqa: E402


ASSETS: list[dict[str, object]] = [
    {
        "name": "primitive_thorlabs_ca2906_cable",
        "asset_type": "primitive",
        "file_path": "primitive://sma_short_cable",
        "source": "Thorlabs CA2906 SMA-M / SMA-M 6 inch RG-316 (rendered procedurally)",
        "source_url": "https://www.thorlabs.com/thorproduct.cfm?partnumber=CA2906",
        "unit": "mm",
        "scale_factor": 1.0,
    },
]


# Catalog rule of thumb: properties carry the static datasheet specs (immutable
# per-part); kindParams on a SceneObject carry the runtime / per-instance
# state (which doesn't apply here — RF cables are passive). The default
# kindParams ({}) means a SceneObject inherits RfCableParams defaults from
# DEFAULT_KIND_PARAMS["rf_cable"] in the frontend.
COMPONENTS: list[dict[str, object]] = [
    {
        "name": "thorlabs_ca2906_sma_cable",
        "component_type": "rf_cable",
        "brand": "Thorlabs",
        "model": "CA2906",
        "asset": "primitive_thorlabs_ca2906_cable",
        "physics_capabilities": ["rf"],
        "properties": {
            "geometry": "sma_cable",
            "lengthMm": 152.4,
            "cableType": "RG-316",
            "connectorType": "sma",
            "connectors": ["SMA male straight", "SMA male straight"],
            "impedanceOhm": 50,
            "maxFrequencyGhz": 3.0,
            "workingVoltageVRms": 250,
            "dielectricVoltageVRms": 750,
            "approxWeightKg": 0.03,
            "jacketColor": "#c4a884",
            "datasheetUrl": "https://media.thorlabs.com/globalassets/items/c/ca/ca2/ca2906/8935-e0w.pdf",
        },
    },
]


async def upsert_asset(session, data: dict[str, object]) -> Asset3D:
    asset = await session.scalar(select(Asset3D).where(Asset3D.name == data["name"]))
    if asset is None:
        asset = Asset3D(**data)
        session.add(asset)
        await session.flush()
    else:
        for key, value in data.items():
            setattr(asset, key, value)
        await session.flush()
    return asset


async def upsert_component(
    session,
    data: dict[str, object],
    assets_by_name: dict[str, Asset3D],
) -> Component | None:
    payload = data.copy()
    asset_name = payload.pop("asset")
    payload["asset_3d_id"] = assets_by_name[asset_name].id

    component = await session.scalar(select(Component).where(Component.name == payload["name"]))
    if component is not None and component.archived_at is not None:
        return None

    if component is None:
        component = Component(**payload)
        session.add(component)
        await session.flush()
    else:
        for key, value in payload.items():
            setattr(component, key, value)
        await session.flush()
    return component


async def main() -> None:
    async with AsyncSessionLocal() as session:
        assets_by_name: dict[str, Asset3D] = {}
        for asset_data in ASSETS:
            asset = await upsert_asset(session, asset_data.copy())
            assets_by_name[asset.name] = asset

        for component_data in COMPONENTS:
            await upsert_component(session, component_data, assets_by_name)

        await session.commit()
        print(
            f"Upserted {len(ASSETS)} Thorlabs RF-cable assets "
            f"and {len(COMPONENTS)} catalog components."
        )


if __name__ == "__main__":
    asyncio.run(main())
