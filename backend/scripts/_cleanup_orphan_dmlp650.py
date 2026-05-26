"""Throwaway: drop the DMLP650 Asset3D + any component bindings.
User removed the dichroic from the catalog."""

import asyncio
import sys
from pathlib import Path
sys.path.append(str(Path(__file__).resolve().parents[1]))

from sqlalchemy import text
from app.db import AsyncSessionLocal, engine


async def main() -> None:
    async with AsyncSessionLocal() as s:
        res = await s.execute(text(
            "SELECT id FROM assets_3d WHERE catalog_id = 'thorlabs_dmlp650'"
        ))
        rows = res.fetchall()
        if not rows:
            print("No dmlp650 asset row — already clean.")
            await engine.dispose()
            return
        asset_id = rows[0][0]
        await s.execute(
            text("DELETE FROM component_bindings WHERE asset_3d_id = :aid"),
            {"aid": asset_id},
        )
        await s.execute(
            text("DELETE FROM assets_3d WHERE id = :aid"),
            {"aid": asset_id},
        )
        await s.commit()
        print(f"Deleted dmlp650 asset {asset_id} + dependent bindings.")
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
