"""Throwaway: remove the stale glan_polarizer_calcite_prism row left
behind after the asset moved from polarizer/ to pbs/."""

import asyncio
import sys
from pathlib import Path
sys.path.append(str(Path(__file__).resolve().parents[1]))

from sqlalchemy import text
from app.db import AsyncSessionLocal, engine


async def main() -> None:
    async with AsyncSessionLocal() as s:
        res = await s.execute(text(
            "DELETE FROM assets_3d "
            "WHERE catalog_id = 'glan_polarizer_calcite_prism' "
            "RETURNING catalog_id"
        ))
        deleted = res.fetchall()
        await s.commit()
        print(f"Deleted {len(deleted)} orphan rows: {[r[0] for r in deleted]}")
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
