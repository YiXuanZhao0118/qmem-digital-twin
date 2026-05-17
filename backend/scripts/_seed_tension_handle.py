import asyncio, sys
from pathlib import Path
from sqlalchemy import select
sys.path.append(str(Path("C:/repos/qmem-digital-twin/backend").resolve()))
from app.db import AsyncSessionLocal
from app.models import SceneObject, PhysicsElement
from sqlalchemy.orm.attributes import flag_modified

async def main():
    async with AsyncSessionLocal() as s:
        pes = (await s.scalars(select(PhysicsElement).where(PhysicsElement.element_kind == "fiber_end"))).all()
        patched = 0
        for pe in pes:
            obj = await s.get(SceneObject, pe.object_id)
            if obj is None: continue
            props = dict(obj.properties or {})
            if isinstance(props.get("tensionHandleMm"), list) and len(props["tensionHandleMm"]) == 3:
                continue
            props["tensionHandleMm"] = [0.0, 30.0, 0.0]
            obj.properties = props
            flag_modified(obj, "properties")
            patched += 1
        await s.commit()
        print(f"Patched {patched} fiber_end SceneObjects with tensionHandleMm default.")

asyncio.run(main())
