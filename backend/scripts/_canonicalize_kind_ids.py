"""One-shot: canonicalize legacy kind_id aliases that survived M5 to
their canonical Kind registry slugs.

Mapping decisions (per current keep-list data):
  - components.kind_id = 'optical_component' (the IO-3-850-HP Isolator)
    → 'isolator'
  - assets_3d.kind_id = 'lens' (LA1540, LA1614) → 'lens_plano_convex'

Aliases that are *kept as-is* because they're either real composite
kinds (no canonical mapping) or intentional bucket markers:
  - 'pbs', 'isolator', 'faraday_rotator', 'none', 'optical_table'

Idempotent — re-runs are no-ops once the data is canonicalized.
"""

import asyncio
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from sqlalchemy import text  # noqa: E402
from app.db import AsyncSessionLocal, engine  # noqa: E402


COMPONENT_RENAMES = {
    "optical_component": "isolator",
}
ASSET_RENAMES = {
    "lens": "lens_plano_convex",
}


async def main() -> None:
    async with AsyncSessionLocal() as s:
        for src, dst in COMPONENT_RENAMES.items():
            r = await s.execute(
                text("UPDATE components SET kind_id = :dst "
                     "WHERE kind_id = :src AND archived_at IS NULL "
                     "RETURNING id"),
                {"src": src, "dst": dst},
            )
            rows = r.fetchall()
            print(f"components: {src} -> {dst}: {len(rows)} rows")
        for src, dst in ASSET_RENAMES.items():
            r = await s.execute(
                text("UPDATE assets_3d SET kind_id = :dst WHERE kind_id = :src RETURNING id"),
                {"src": src, "dst": dst},
            )
            rows = r.fetchall()
            print(f"assets_3d: {src} -> {dst}: {len(rows)} rows")
        await s.commit()
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
