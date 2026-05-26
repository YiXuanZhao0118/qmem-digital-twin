"""Quick check that v3 seed wrote rows correctly. Throwaway."""
import asyncio
import sys
from pathlib import Path
sys.path.append(str(Path(__file__).resolve().parents[1]))

from sqlalchemy import text
from app.db import AsyncSessionLocal, engine


async def main() -> None:
    async with AsyncSessionLocal() as session:
        print("=== Asset3D v3 rows ===")
        rows = (await session.execute(text(
            "SELECT catalog_id, kind_id, name FROM assets_3d "
            "WHERE catalog_id IS NOT NULL ORDER BY catalog_id"
        ))).all()
        for r in rows:
            print(f"  {r[0]:50s}  kind={r[1] or '(mech)':20s}  name={r[2]}")

        print("\n=== Component v3 rows ===")
        rows = (await session.execute(text(
            "SELECT catalog_id, name FROM components "
            "WHERE catalog_id IS NOT NULL ORDER BY catalog_id"
        ))).all()
        for r in rows:
            print(f"  {r[0]:50s}  name={r[1]}")

        print("\n=== IO-3-850-HP bindings ===")
        rows = (await session.execute(text("""
            SELECT cb.sort_order,
                   cb.properties->>'bindingId',
                   a.catalog_id,
                   cb.local_z_mm,
                   cb.local_rz_deg
            FROM component_bindings cb
            JOIN components c ON cb.component_id = c.id
            LEFT JOIN assets_3d a ON cb.asset_3d_id = a.id
            WHERE c.catalog_id = 'thorlabs_io_3_850_hp'
            ORDER BY cb.sort_order
        """))).all()
        for r in rows:
            print(f"  [{r[0]}] {r[1]:18s}  asset={r[2]:45s}  z={r[3]:+6.1f}  rz={r[4]:+5.1f}")

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
