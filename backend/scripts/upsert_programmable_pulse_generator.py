"""Upsert the Programmable Pulse Generator (PPG) catalog.

Source-like RF element: one rf_out anchor emits a TTL/RF signal downstream.
Ships as two variants — SMA (rendered via the SMA thumb-antenna GLB) and
BNC (rendered via the BNC-M / RCA-F adapter GLB) — both under the single
`programmable_pulse_generator` componentType so they appear as two catalog
rows under one "Programmable Pulse Generator" group in the RF catalog.

Also archives the legacy `thumb_antenna` / `bnc_rca_adapter` catalog rows
(both introduced earlier in this session) since this is their replacement.

ElementKind: `programmable_pulse_generator` (added 2026-05-15, replaces
the short-lived `thumb_antenna` + `bnc_rca_adapter` kinds).
"""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.db import AsyncSessionLocal  # noqa: E402
from app.models import Asset3D, Component  # noqa: E402


# Existing GLB assets (unchanged — they were uploaded earlier this session).
ASSETS: list[dict[str, object]] = [
    {
        "name": "thumb_antenna_glb",
        "asset_type": "gltf",
        "file_path": "files/glb/thumb_antenna.glb",
        "source": "Generic 2.4 GHz SMA thumb antenna (user-supplied GLB)",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "bnc_m_rca_f_adapter_glb",
        "asset_type": "gltf",
        "file_path": "files/glb/bnc_m_rca_f_adapter.glb",
        "source": "Generic BNC-M / RCA-F coaxial adapter (user-supplied GLB)",
        "unit": "mm",
        "scale_factor": 1.0,
    },
]


COMPONENTS: list[dict[str, object]] = [
    {
        "name": "programmable_pulse_generator_sma",
        "component_type": "programmable_pulse_generator",
        "brand": "Generic",
        "model": "Programmable Pulse Generator (SMA)",
        "asset": "thumb_antenna_glb",
        "physics_capabilities": ["rf"],
        "properties": {
            "geometry": "programmable_pulse_generator",
            "connectorType": "sma",
        },
    },
    {
        "name": "programmable_pulse_generator_bnc",
        "component_type": "programmable_pulse_generator",
        "brand": "Generic",
        "model": "Programmable Pulse Generator (BNC)",
        "asset": "bnc_m_rca_f_adapter_glb",
        "physics_capabilities": ["rf"],
        "properties": {
            "geometry": "programmable_pulse_generator",
            "connectorType": "bnc",
        },
    },
]


# Catalog rows superseded by the PPG entries above. Archive (don't hard-delete)
# so any historical SceneObject references remain resolvable.
LEGACY_COMPONENT_NAMES: list[str] = [
    "thumb_antenna_2_4ghz_sma",
    "bnc_m_rca_f_adapter",
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


async def archive_legacy(session, name: str) -> bool:
    row = await session.scalar(select(Component).where(Component.name == name))
    if row is None or row.archived_at is not None:
        return False
    row.archived_at = datetime.now(timezone.utc)
    await session.flush()
    return True


async def main() -> None:
    async with AsyncSessionLocal() as session:
        assets_by_name: dict[str, Asset3D] = {}
        for asset_data in ASSETS:
            asset = await upsert_asset(session, asset_data.copy())
            assets_by_name[asset.name] = asset

        for component_data in COMPONENTS:
            await upsert_component(session, component_data, assets_by_name)

        archived = 0
        for name in LEGACY_COMPONENT_NAMES:
            if await archive_legacy(session, name):
                archived += 1

        await session.commit()
        print(
            f"Upserted {len(ASSETS)} PPG assets, "
            f"{len(COMPONENTS)} catalog components, "
            f"archived {archived} legacy rows."
        )


if __name__ == "__main__":
    asyncio.run(main())
