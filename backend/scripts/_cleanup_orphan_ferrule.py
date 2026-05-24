"""Throwaway: remove procedural_ferrule Asset3D row.
fiber_end is no longer a v3 kind (alembic 0056 collapsed fiber ends
back into the parent fiber SceneObject)."""

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
            "WHERE catalog_id = 'procedural_ferrule' "
            "RETURNING catalog_id"
        ))
        deleted = res.fetchall()
        await s.commit()
        print(f"Deleted {len(deleted)} rows: {[r[0] for r in deleted]}")
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
