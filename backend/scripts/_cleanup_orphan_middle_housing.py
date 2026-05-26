"""Throwaway: drop the obsolete middle_housing Asset3D + its IO-3 binding.
faraday_rod's 3D model now serves as the magnet housing visual."""

import asyncio
import sys
from pathlib import Path
sys.path.append(str(Path(__file__).resolve().parents[1]))

from sqlalchemy import text
from app.db import AsyncSessionLocal, engine


async def main() -> None:
    async with AsyncSessionLocal() as s:
        # Find the asset id first so we can drop its component_bindings rows.
        res = await s.execute(text(
            "SELECT id FROM assets_3d WHERE catalog_id = 'thorlabs_io_3_850_middle_housing'"
        ))
        rows = res.fetchall()
        if not rows:
            print("No middle_housing asset row found — already clean.")
            await engine.dispose()
            return
        asset_id = rows[0][0]
        # Drop bindings that reference this asset.
        await s.execute(
            text("DELETE FROM component_bindings WHERE asset_3d_id = :aid"),
            {"aid": asset_id},
        )
        await s.execute(
            text("DELETE FROM assets_3d WHERE id = :aid"),
            {"aid": asset_id},
        )
        await s.commit()
        print(f"Deleted middle_housing asset {asset_id} + dependent bindings.")
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
