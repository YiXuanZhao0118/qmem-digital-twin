"""Throwaway: confirm component_type / physics_kind columns dropped."""
import asyncio
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from sqlalchemy import text  # noqa: E402
from app.db import AsyncSessionLocal, engine  # noqa: E402


async def main() -> None:
    async with AsyncSessionLocal() as s:
        r = await s.execute(text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name='components' "
            "AND column_name IN ('component_type', 'kind_id')"
        ))
        print("components:", [row[0] for row in r.fetchall()])
        r = await s.execute(text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name='assets_3d' "
            "AND column_name IN ('physics_kind', 'kind_id')"
        ))
        print("assets_3d:", [row[0] for row in r.fetchall()])
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
