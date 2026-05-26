"""Throwaway: list distinct component_type and physics_kind values."""
import asyncio
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from sqlalchemy import text  # noqa: E402
from app.db import AsyncSessionLocal, engine  # noqa: E402


async def main() -> None:
    async with AsyncSessionLocal() as s:
        print("=== components.kind_id ===")
        r = await s.execute(text(
            "SELECT kind_id, COUNT(*) FROM components "
            "WHERE archived_at IS NULL GROUP BY kind_id ORDER BY 2 DESC"
        ))
        for row in r.fetchall():
            print(row)
        print()
        print("=== assets_3d.kind_id ===")
        r = await s.execute(text(
            "SELECT kind_id, COUNT(*) FROM assets_3d GROUP BY kind_id ORDER BY 2 DESC"
        ))
        for row in r.fetchall():
            print(row)
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
