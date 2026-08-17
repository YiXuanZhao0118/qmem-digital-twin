"""CI guard for the anchor precision budget.

The float64 audit (``docs/float64-audit.md``) found the machine path —
DB → API → tracer — already clean float64, with every loss in the authoring
UI. These tests keep it that way: they fail if anyone reintroduces a narrower
column, a rounding step in serialisation, or a lossy round trip.

Witness values carry 17 significant digits, the shortest round-trip repr of a
float64. float32 loses them at the 8th digit and a ``toFixed(3)``-style
quantiser at the 5th, so either regression flips an EXACT comparison — these
tests deliberately use ``==`` and not ``pytest.approx``.

Budget being defended: 1 µm position / 0.1 µrad direction
(``docs/objectives.md`` O-1/O-2).
"""

from __future__ import annotations

import json
import uuid

import pytest
from sqlalchemy import delete, text

from app.db import AsyncSessionLocal
from app.models import Asset3D, Component, SceneObject
from app.routers.assets import _anchors_camel
from app.schemas import Asset3DCreate

# Position in mm, and a normalised axis triple — the latter is the actual
# Gram-Schmidt output the PHY Editor writes for axisX=(1, 0.7, 0), i.e. a
# value the UI really produces rather than a synthetic one.
POS = (12.3456789012345, -0.000123456789012345, 98.7654321098765)
AXIS_Y = (-0.5734623443633284, 0.8192319205190405, 0.0)

# Pose columns must be float8. float4 would round 141.85123456789012 to
# ~141.85123, losing 8 digits.
POSE_X_MM = 141.85123456789012
POSE_RX_DEG = 42.123456789012345


def _anchor_payload() -> dict:
    return {
        "id": "intercept_in",
        "positionMmBodyLocal": {"x": POS[0], "y": POS[1], "z": POS[2]},
        "axisXBodyLocal": {"x": 1.0, "y": 0.0, "z": 0.0},
        "axisYBodyLocal": {"x": AXIS_Y[0], "y": AXIS_Y[1], "z": AXIS_Y[2]},
        "axisZBodyLocal": {"x": 0.0, "y": 0.0, "z": 1.0},
        "apertureMm": 6.4,
        "apertureShape": "circle",
    }


# ---------------------------------------------------------------------------
# 1. Serialisation — no DB required, so this one runs anywhere.
# ---------------------------------------------------------------------------

def test_witness_values_can_actually_detect_a_regression():
    """Self-guard on the constants above.

    Every test in this file is an exact comparison against those witnesses, so
    replacing them with round numbers (12.35, 0.5) would leave the suite green
    while checking nothing at all. These assertions fail the moment a witness
    stops being able to distinguish float64 from the two regressions we care
    about.
    """
    import struct

    for value in (*POS, *AXIS_Y[:2], POSE_X_MM, POSE_RX_DEG):
        assert round(value, 3) != value, f"{value!r} survives 3-decimal rounding"
        as_float32 = struct.unpack("f", struct.pack("f", value))[0]
        assert as_float32 != value, f"{value!r} survives a float32 round trip"


def test_anchor_serialisation_is_bit_exact():
    """`_anchors_camel` → JSON text → back must not move a single bit.

    This is the layer a rounding "cleanup" is most likely to be added to,
    because the 17-digit output looks like noise to a human reader.
    """
    payload = Asset3DCreate(
        name="precision-guard",
        assetType="stl",
        filePath="files/stl/x.stl",
        kindId="lens_plano_convex",
        defaultParams={"focalLengthMm": 100},
        anchors=[_anchor_payload()],
    )
    stored = _anchors_camel(payload.anchors)
    reloaded = json.loads(json.dumps(stored))

    pos = reloaded[0]["positionMmBodyLocal"]
    assert (pos["x"], pos["y"], pos["z"]) == POS

    axis_y = reloaded[0]["axisYBodyLocal"]
    assert (axis_y["x"], axis_y["y"], axis_y["z"]) == AXIS_Y


def test_serialised_anchor_keeps_full_repr_in_json_text():
    """Belt and braces on the text form: the digits must actually be written
    out, not rounded on the way to the string. Catches a custom encoder with
    a float formatter, which the value comparison above would still pass if
    the loss happened symmetrically on both sides.
    """
    payload = Asset3DCreate(
        name="precision-guard",
        assetType="stl",
        filePath="files/stl/x.stl",
        kindId="lens_plano_convex",
        anchors=[_anchor_payload()],
    )
    text_form = json.dumps(_anchors_camel(payload.anchors))
    assert "12.3456789012345" in text_form
    assert "-0.5734623443633284" in text_form


# ---------------------------------------------------------------------------
# 2 + 3. DB-backed. Run against the local dev postgres (see tests/conftest.py);
#        scratch rows are cleaned up on teardown.
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
async def _reset_engine_pool():
    """Each async test gets its own event loop; asyncpg connections are bound
    to the loop that opened them, so a pooled connection carried over raises
    "another operation is in progress". Same guard as
    tests/optical/test_dynamic_sources_merge.py.
    """
    from app.db import engine

    await engine.dispose()
    yield


@pytest.fixture
async def scratch():
    ids: dict[str, list[uuid.UUID]] = {"objects": [], "components": [], "assets": []}
    yield ids
    async with AsyncSessionLocal() as db:
        if ids["objects"]:
            await db.execute(delete(SceneObject).where(SceneObject.id.in_(ids["objects"])))
        if ids["components"]:
            await db.execute(delete(Component).where(Component.id.in_(ids["components"])))
        if ids["assets"]:
            await db.execute(delete(Asset3D).where(Asset3D.id.in_(ids["assets"])))
        await db.commit()


async def test_anchor_survives_db_round_trip(scratch):
    """A full-precision anchor written to `assets_3d.anchors` (JSONB) must
    read back identical. JSONB stores numbers as `numeric`, so this is
    lossless today; the test pins that against a column type change.
    """
    async with AsyncSessionLocal() as db:
        asset = Asset3D(
            name=f"precision-guard-{uuid.uuid4().hex[:8]}",
            asset_type="optical",
            file_path="primitive://box",
            kind_id="lens_plano_convex",
            anchors=[_anchor_payload()],
        )
        db.add(asset)
        await db.commit()
        scratch["assets"].append(asset.id)
        asset_id = asset.id

    async with AsyncSessionLocal() as db:
        row = await db.get(Asset3D, asset_id)
        pos = row.anchors[0]["positionMmBodyLocal"]
        axis_y = row.anchors[0]["axisYBodyLocal"]

    assert (pos["x"], pos["y"], pos["z"]) == POS
    assert (axis_y["x"], axis_y["y"], axis_y["z"]) == AXIS_Y


async def test_object_pose_survives_db_round_trip(scratch):
    """The other half of the transform chain: the SceneObject pose columns."""
    async with AsyncSessionLocal() as db:
        comp = Component(name=f"precision-guard-{uuid.uuid4().hex[:8]}", kind_id="none")
        db.add(comp)
        await db.flush()
        scratch["components"].append(comp.id)
        obj = SceneObject(component_id=comp.id, x_mm=POSE_X_MM, rx_deg=POSE_RX_DEG)
        db.add(obj)
        await db.commit()
        scratch["objects"].append(obj.id)
        obj_id = obj.id

    async with AsyncSessionLocal() as db:
        row = await db.get(SceneObject, obj_id)

    assert row.x_mm == POSE_X_MM
    assert row.rx_deg == POSE_RX_DEG


async def test_pose_columns_are_double_precision():
    """`sa.Float()` compiles to bare `FLOAT`, which Postgres reads as
    `double precision`. A migration that wrote `REAL`/`float4` instead would
    silently cap the pose at ~7 significant digits — 0.6 µm of error at
    100 mm, most of the O-1 budget — without failing any value test that
    uses a tolerance.
    """
    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                text(
                    "select column_name, data_type from information_schema.columns "
                    "where table_name = 'objects' and column_name in "
                    "('x_mm','y_mm','z_mm','rx_deg','ry_deg','rz_deg')"
                )
            )
        ).all()

    types = {name: dtype for name, dtype in rows}
    assert set(types) == {"x_mm", "y_mm", "z_mm", "rx_deg", "ry_deg", "rz_deg"}
    assert set(types.values()) == {"double precision"}, types


async def test_anchor_column_is_jsonb():
    """`anchors` must stay JSONB. Plain `json` would still round-trip today,
    but the numeric-vs-text storage difference is exactly the kind of thing
    that gets changed for indexing reasons without considering precision.
    """
    async with AsyncSessionLocal() as db:
        dtype = (
            await db.execute(
                text(
                    "select data_type from information_schema.columns "
                    "where table_name = 'assets_3d' and column_name = 'anchors'"
                )
            )
        ).scalar_one()
    assert dtype == "jsonb"
