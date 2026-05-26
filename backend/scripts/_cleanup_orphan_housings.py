"""Throwaway: drop the input/output housing Asset3D rows.
Faraday_rod now hosts the full IO-3-850-HP assembly STL,
so separate housing assets are redundant."""

import asyncio
import sys
from pathlib import Path
sys.path.append(str(Path(__file__).resolve().parents[1]))

from sqlalchemy import text
from app.db import AsyncSessionLocal, engine


CATALOG_IDS = (
    "thorlabs_io_3_850_input_housing",
    "thorlabs_io_3_850_output_housing",
)


async def main() -> None:
    async with AsyncSessionLocal() as s:
        for cid in CATALOG_IDS:
            res = await s.execute(text(
                "SELECT id FROM assets_3d WHERE catalog_id = :cid"
            ), {"cid": cid})
            rows = res.fetchall()
            if not rows:
                print(f"  - {cid}: already gone")
                continue
            asset_id = rows[0][0]
            await s.execute(
                text("DELETE FROM component_bindings WHERE asset_3d_id = :aid"),
                {"aid": asset_id},
            )
            await s.execute(
                text("DELETE FROM assets_3d WHERE id = :aid"),
                {"aid": asset_id},
            )
            print(f"  - {cid}: deleted (asset {asset_id} + bindings)")
        await s.commit()
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
