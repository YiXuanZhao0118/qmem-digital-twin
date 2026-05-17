import asyncio
import json
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from sqlalchemy import text
from app.db import AsyncSessionLocal


async def main() -> None:
    async with AsyncSessionLocal() as s:
        r = await s.execute(text(
            "SELECT pe.kind_params FROM physics_elements pe JOIN objects o ON o.id = pe.object_id WHERE o.name = 'FIBER0' AND pe.element_kind = 'fiber'"
        ))
        rows = list(r)
        if not rows:
            print("no FIBER0 fiber PE in DB")
            return
        kp = rows[0].kind_params
        print("DB raw kindParams.endA:")
        print(json.dumps(kp.get("endA"), indent=2))


asyncio.run(main())
