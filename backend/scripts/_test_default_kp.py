import asyncio
import json
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select, text
from app.db import AsyncSessionLocal
from app.models import Component
from app.routers.components import default_kind_params_for_component


async def main() -> None:
    async with AsyncSessionLocal() as s:
        comp = (await s.scalars(
            select(Component).where(Component.component_type == "fiber").where(Component.archived_at.is_(None)).limit(1)
        )).first()
        if comp is None:
            print("no fiber component")
            return
        print("Component:", comp.name, "componentType:", comp.component_type)
        print("Component.properties.fiberNodes:", comp.properties.get("fiberNodes"))
        kp = default_kind_params_for_component("fiber", comp)
        print("default_kind_params_for_component output endA:")
        print(json.dumps(kp.get("endA"), indent=2))


asyncio.run(main())
