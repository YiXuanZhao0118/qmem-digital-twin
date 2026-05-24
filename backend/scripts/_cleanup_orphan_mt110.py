"""Throwaway: remove the wrong aa_mt110_a1_780 Asset3D row after
renaming the catalog to aa_mt80_a1_5_ir (matching the user's actual
MT80-A1.5-IR AOM)."""

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
            "WHERE catalog_id = 'aa_mt110_a1_780' "
            "RETURNING catalog_id"
        ))
        deleted = res.fetchall()
        await s.commit()
        print(f"Deleted {len(deleted)} rows: {[r[0] for r in deleted]}")
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
