"""One-time: copy viewerHints (deletedCentroids that exclude front + back
Glan partitions) from the partitioned IO-3 body asset onto the v3
thorlabs_io_3_850_faraday_rod row. That makes faraday_rod render only
the magnet housing root body — what the user calls the
"Component composer root (body)" — not the entire isolator assembly."""

import asyncio
import sys
from pathlib import Path
sys.path.append(str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select
from app.db import AsyncSessionLocal, engine
from app.models import Asset3D


BODY_NAME = "thorlabs_io_3_850_hp_stl"
TARGET_CATALOG_ID = "thorlabs_io_3_850_faraday_rod"


async def main() -> None:
    async with AsyncSessionLocal() as s:
        body = (await s.execute(
            select(Asset3D).where(Asset3D.name == BODY_NAME)
        )).scalar_one_or_none()
        if body is None:
            print(f"  - Body asset '{BODY_NAME}' not found.")
            await engine.dispose()
            return
        body_props = body.properties or {}
        body_vh = body_props.get("viewerHints") or {}
        if "deletedCentroids" not in body_vh:
            print(f"  - Body asset has no viewerHints.deletedCentroids — nothing to copy.")
            await engine.dispose()
            return
        print(f"  - Body deletedCentroids: {len(body_vh['deletedCentroids'])} entries")
        print(f"  - Body bundledOverlay: {body_vh.get('bundledOverlay')}")

        target = (await s.execute(
            select(Asset3D).where(Asset3D.catalog_id == TARGET_CATALOG_ID)
        )).scalar_one_or_none()
        if target is None:
            print(f"  - Target '{TARGET_CATALOG_ID}' not found.")
            await engine.dispose()
            return

        target_props = dict(target.properties or {})
        target_props["viewerHints"] = {
            "bundledOverlay": body_vh.get("bundledOverlay", False),
            "deletedCentroids": list(body_vh["deletedCentroids"]),
        }
        # Also align file_path in case it drifts (defensive).
        target.file_path = body.file_path
        target.properties = target_props
        await s.commit()
        print(
            f"  - Copied viewerHints from {body.id} -> {target.id} "
            f"({len(target_props['viewerHints']['deletedCentroids'])} centroids)."
        )
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
