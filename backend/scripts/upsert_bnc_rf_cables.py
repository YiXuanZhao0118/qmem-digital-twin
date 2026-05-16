"""Upsert mixed / BNC variants of the procedural RF cable.

Both rows share the existing `primitive_rf_cable` procedural asset that
the original `thorlabs_ca2906_sma_cable` already uses. The catalog rows
differ only in `properties.endAConnector` / `endBConnector`, which the
cable renderer (`createSmaCableSpline` in `frontend/src/three/loadAsset.ts`)
reads to pick SMA-male vs BNC-male geometry per spline endpoint.

Variants:
  - rf_cable_sma_to_bnc  — End A SMA male, End B BNC male.
  - rf_cable_bnc_to_bnc  — Both ends BNC male.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from sqlalchemy import select

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.db import AsyncSessionLocal  # noqa: E402
from app.models import Asset3D, Component  # noqa: E402


# Reuse the existing primitive cable asset that the legacy
# `thorlabs_ca2906_sma_cable` already points at; no new Asset3D row needed.
EXISTING_ASSET_NAME = "primitive_thorlabs_ca2906_cable"


COMPONENTS: list[dict[str, object]] = [
    {
        "name": "rf_cable_sma_to_bnc",
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


async def upsert_component(session, data: dict[str, object], asset_id) -> Component | None:
    payload = data.copy()
    payload["asset_3d_id"] = asset_id

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
        asset = await session.scalar(select(Asset3D).where(Asset3D.name == EXISTING_ASSET_NAME))
        if asset is None:
            raise RuntimeError(
                f"Expected existing Asset3D '{EXISTING_ASSET_NAME}' (the procedural RF "
                "cable primitive). Run `upsert_thorlabs_rf_cables.py` first."
            )

        for component_data in COMPONENTS:
            await upsert_component(session, component_data, asset.id)

        await session.commit()
        print(f"Upserted {len(COMPONENTS)} BNC-variant RF cable rows.")


if __name__ == "__main__":
    asyncio.run(main())
