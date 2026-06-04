"""One-off: clone the WPHSM05-780 half-wave plate into a WPQSM05-850
quarter-wave plate (asset3d + scene component + binding + object +
physics_element). Mirrors the existing rows exactly (temp-table copy keeps
every column/type) and overrides only the QWP/850 fields + new UUIDs.

Run once:  PYTHONPATH=. .venv/Scripts/python.exe scripts/clone_wpqsm05_850.py
"""
import asyncio
import json
import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

DB = "postgresql+asyncpg://qmem:qmem_password@localhost:55432/qmem_twin"

SRC_ASSET = "0e671bf3-b697-4ee0-badf-5e90fd26bc0e"
SRC_SCENE_COMP = "7e5df091-61a9-4e5d-8843-3960f59c9887"
SRC_SCENE_BINDING = "be05743f-f574-4b25-b23a-58df4d034b74"
SRC_OBJECT = "f6a50ccf-9b3e-414d-834a-e7e06a895579"
SRC_PHYS = "a9d71c3c-25ff-4100-871c-13405acfa351"

NEW = {k: str(uuid.uuid4()) for k in ("asset", "comp", "binding", "object", "phys")}

CATALOG = "thorlabs_wpqsm05_850"
SOURCE_URL = "https://www.thorlabs.com/zh/item/WPQSM05-850"

# QWP/850 overrides applied to BOTH default_params and kind_params.
QWP = {
    "plateType": "zero_order_quarter_wave",
    "retardanceDeg": 90,
    "retardanceLambda": 0.25,
    "designWavelengthNm": 850,
    "wavelengthRangeNm": [840, 860],
}


async def main() -> None:
    eng = create_async_engine(DB)
    async with eng.begin() as c:
        # --- read JSON we need to merge ---
        dp = dict((await c.execute(
            text("select default_params from assets_3d where id=:i"), {"i": SRC_ASSET},
        )).scalar_one())
        dp.update(QWP)

        kp = dict((await c.execute(
            text("select kind_params from physics_elements where id=:i"), {"i": SRC_PHYS},
        )).scalar_one())
        kp.update(QWP)

        obj_props = (await c.execute(
            text("select properties from objects where id=:i"), {"i": SRC_OBJECT},
        )).scalar_one() or {}
        obj_props = dict(obj_props)
        # Regenerate per-object anchorBinding ids so the clone doesn't share
        # binding identity with the source object.
        abs_ = obj_props.get("anchorBindings")
        if isinstance(abs_, list):
            obj_props["anchorBindings"] = [
                {**b, "id": str(uuid.uuid4())} if isinstance(b, dict) and "id" in b else b
                for b in abs_
            ]

        # --- asset3d ---
        await c.execute(text("create temp table t_a on commit drop as select * from assets_3d where id=:i"), {"i": SRC_ASSET})
        await c.execute(text(
            "update t_a set id=:id, catalog_id=:cat, name=:nm, "
            "default_params=cast(:dp as jsonb), wavelength_range_nm=:wr"
        ), {"id": NEW["asset"], "cat": CATALOG, "nm": CATALOG, "dp": json.dumps(dp), "wr": [840.0, 860.0]})
        await c.execute(text("insert into assets_3d select * from t_a"))

        # --- scene component (kind waveplate) ---
        await c.execute(text("create temp table t_c on commit drop as select * from components where id=:i"), {"i": SRC_SCENE_COMP})
        await c.execute(text(
            "update t_c set id=:id, asset_3d_id=:a, model=:m, notes=:n"
        ), {"id": NEW["comp"], "a": NEW["asset"], "m": "WPQSM05-850",
            "n": "Thorlabs WPQSM05-850 zero-order quarter-wave plate at 850 nm in an SM05-threaded mount"})
        await c.execute(text("insert into components select * from t_c"))

        # --- component_binding (body) ---
        await c.execute(text("create temp table t_b on commit drop as select * from component_bindings where id=:i"), {"i": SRC_SCENE_BINDING})
        await c.execute(text(
            "update t_b set id=:id, component_id=:c, asset_3d_id=:a"
        ), {"id": NEW["binding"], "c": NEW["comp"], "a": NEW["asset"]})
        await c.execute(text("insert into component_bindings select * from t_b"))

        # --- object (instance) — offset +40 mm in x so it doesn't overlap ---
        await c.execute(text("create temp table t_o on commit drop as select * from objects where id=:i"), {"i": SRC_OBJECT})
        await c.execute(text(
            "update t_o set id=:id, component_id=:c, name=:n, x_mm=x_mm+40, "
            "properties=cast(:p as jsonb)"
        ), {"id": NEW["object"], "c": NEW["comp"], "n": "WPQSM05_8500", "p": json.dumps(obj_props)})
        await c.execute(text("insert into objects select * from t_o"))

        # --- physics_element ---
        await c.execute(text("create temp table t_p on commit drop as select * from physics_elements where id=:i"), {"i": SRC_PHYS})
        await c.execute(text(
            "update t_p set id=:id, object_id=:o, kind_params=cast(:kp as jsonb), "
            "wavelength_range_nm=cast(:wr as jsonb)"
        ), {"id": NEW["phys"], "o": NEW["object"], "kp": json.dumps(kp), "wr": json.dumps([840, 860])})
        await c.execute(text("insert into physics_elements select * from t_p"))

    await eng.dispose()
    print("Created WPQSM05-850:")
    for k, v in NEW.items():
        print(f"  {k:8} {v}")


if __name__ == "__main__":
    asyncio.run(main())
