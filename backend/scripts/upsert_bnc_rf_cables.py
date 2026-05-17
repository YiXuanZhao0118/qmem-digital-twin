"""Upsert mixed / BNC variants of the procedural RF cable.

Each variant gets its OWN Asset3D row so the PHY Editor can edit rf_in
/ rf_out anchor positions independently per cable (SMA-to-SMA and
SMA-to-BNC and BNC-to-BNC connectors sit at physically different
positions). All three rows share the same `primitive://sma_short_cable`
file_path — the renderer (`createSmaShortCable` in
`frontend/src/three/loadAsset.ts`) reads `properties.endAConnector` /
`endBConnector` to pick SMA-male vs BNC-male geometry per spline
endpoint.

Variants:
  - rf_cable_sma_to_bnc  — End A SMA male, End B BNC male.
  - rf_cable_bnc_to_bnc  — Both ends BNC male.

Initial per-variant anchors are seeded by cloning whatever the legacy
shared CA2906 asset currently has. Subsequent runs of this script leave
existing anchors alone (so user edits in PHY Editor survive).
"""

from __future__ import annotations

import asyncio
import copy
import sys
from pathlib import Path

from sqlalchemy import select

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.db import AsyncSessionLocal  # noqa: E402
from app.models import Asset3D, Component  # noqa: E402


# Reused as the seed source for anchor positions on a fresh DB only —
# the per-variant rows below are the actual asset_3d_id targets.
SEED_ASSET_NAME = "primitive_thorlabs_ca2906_cable"


# Per-variant Asset3D rows. file_path / source / unit match the existing
# CA2906 procedural primitive — only `name` differs so each catalog
# entry can carry its own anchors.
ASSETS: list[dict[str, object]] = [
    {
        "name": "primitive_rf_cable_sma_to_bnc",
        "asset_type": "primitive",
        "file_path": "primitive://sma_short_cable",
        "source": "Generic SMA → BNC adapter cable (rendered procedurally)",
        "source_url": None,
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "primitive_rf_cable_bnc_to_bnc",
        "asset_type": "primitive",
        "file_path": "primitive://sma_short_cable",
        "source": "Generic BNC ↔ BNC cable (rendered procedurally)",
        "source_url": None,
        "unit": "mm",
        "scale_factor": 1.0,
    },
]


COMPONENTS: list[dict[str, object]] = [
    {
        "name": "rf_cable_sma_to_bnc",
        "asset": "primitive_rf_cable_sma_to_bnc",
        "component_type": "rf_cable",
        "brand": "Generic",
        "model": "SMA to BNC cable",
        "physics_capabilities": ["rf"],
        "properties": {
            "geometry": "sma_cable",
            "lengthMm": 300.0,
            "cableType": "RG-316",
            # `connectorType` retained for backwards compat (used by
            # consumers that pick a single connector family per cable).
            # `endAConnector` / `endBConnector` are the renderer's
            # source-of-truth for per-end geometry.
            "connectorType": "sma",
            "endAConnector": "sma",
            "endBConnector": "bnc",
            "connectors": ["SMA male straight", "BNC male straight"],
            "impedanceOhm": 50,
            "maxFrequencyGhz": 3.0,
            "jacketColor": "#c4a884",
        },
    },
    {
        "name": "rf_cable_bnc_to_bnc",
        "asset": "primitive_rf_cable_bnc_to_bnc",
        "component_type": "rf_cable",
        "brand": "Generic",
        "model": "BNC cable",
        "physics_capabilities": ["rf"],
        "properties": {
            "geometry": "sma_cable",
            "lengthMm": 300.0,
            "cableType": "RG-58",
            "connectorType": "bnc",
            "endAConnector": "bnc",
            "endBConnector": "bnc",
            "connectors": ["BNC male straight", "BNC male straight"],
            "impedanceOhm": 50,
            "maxFrequencyGhz": 1.0,
            "jacketColor": "#c4a884",
        },
    },
]


async def upsert_asset(session, data: dict[str, object], seed_anchors: list) -> Asset3D:
    """Create the Asset3D row if it doesn't exist (with seed anchors), or
    leave the existing row alone — including its anchors, so user edits
    in PHY Editor survive subsequent script runs."""
    asset = await session.scalar(select(Asset3D).where(Asset3D.name == data["name"]))
    if asset is None:
        asset = Asset3D(**data, anchors=seed_anchors)
        session.add(asset)
        await session.flush()
        return asset
    # Update metadata fields but DO NOT touch `anchors` — anchors are the
    # user-editable PHY Editor surface for this asset.
    for key, value in data.items():
        if key == "anchors":
            continue
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
        seed = await session.scalar(select(Asset3D).where(Asset3D.name == SEED_ASSET_NAME))
        if seed is None:
            raise RuntimeError(
                f"Expected existing Asset3D '{SEED_ASSET_NAME}' (the procedural "
                "RF cable primitive). Run `upsert_thorlabs_rf_cables.py` first."
            )
        seed_anchors = copy.deepcopy(list(seed.anchors or []))

        assets_by_name: dict[str, Asset3D] = {}
        for asset_data in ASSETS:
            asset = await upsert_asset(session, asset_data.copy(), seed_anchors)
            assets_by_name[asset.name] = asset

        for component_data in COMPONENTS:
            await upsert_component(session, component_data, assets_by_name)

        await session.commit()
        print(
            f"Upserted {len(ASSETS)} per-variant assets "
            f"and {len(COMPONENTS)} BNC-variant catalog components."
        )


if __name__ == "__main__":
    asyncio.run(main())
