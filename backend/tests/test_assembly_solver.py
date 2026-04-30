import math
import uuid

import pytest

from app.assembly_solver import (
    add,
    anchor_for,
    dot,
    length,
    mul,
    normalize,
    normalize_anchor_id,
    placement_rotation,
    rotate_vec,
    standard_anchor,
    sub,
    vec,
    world_anchor_direction,
    world_anchor_position,
)
from app.models import Asset3D, Component, Placement


def approx(a: dict, b: dict, tol: float = 1e-9) -> bool:
    return all(abs(a[axis] - b[axis]) < tol for axis in ("x", "y", "z"))


# --- pure vec helpers ---------------------------------------------------------


def test_vec_defaults():
    assert vec() == {"x": 0.0, "y": 0.0, "z": 0.0}
    assert vec(1, 2, 3) == {"x": 1.0, "y": 2.0, "z": 3.0}


def test_add_sub_mul():
    a = vec(1, 2, 3)
    b = vec(4, 5, 6)
    assert add(a, b) == vec(5, 7, 9)
    assert sub(b, a) == vec(3, 3, 3)
    assert mul(a, 2) == vec(2, 4, 6)


def test_dot_length_normalize():
    assert dot(vec(1, 0, 0), vec(0, 1, 0)) == 0
    assert dot(vec(1, 2, 3), vec(4, 5, 6)) == 32
    assert length(vec(3, 4, 0)) == 5
    assert normalize(vec(0, 0, 0)) is None
    n = normalize(vec(3, 0, 4))
    assert n is not None
    assert math.isclose(length(n), 1.0, abs_tol=1e-12)


# --- rotate_vec convention ---------------------------------------------------
# Convention: R_lab = Rz(rz) · Rx(rx) · Ry(ry)
# Matches the YXZ-intrinsic Euler order applied by the Three.js renderer.


def test_rotate_vec_identity():
    v = vec(1, 2, 3)
    assert approx(rotate_vec(v, 0, 0, 0), v)


def test_rotate_vec_z_axis():
    # Rz(90) takes +X to +Y
    assert approx(rotate_vec(vec(1, 0, 0), 0, 0, 90), vec(0, 1, 0))
    # Rz(90) takes +Y to -X
    assert approx(rotate_vec(vec(0, 1, 0), 0, 0, 90), vec(-1, 0, 0))


def test_rotate_vec_x_axis():
    # Rx(90) takes +Y to +Z
    assert approx(rotate_vec(vec(0, 1, 0), 90, 0, 0), vec(0, 0, 1))
    # Rx(90) takes +Z to -Y
    assert approx(rotate_vec(vec(0, 0, 1), 90, 0, 0), vec(0, -1, 0))


def test_rotate_vec_y_axis():
    # Ry(90) takes +Z to +X (right-hand rule around +Y)
    assert approx(rotate_vec(vec(0, 0, 1), 0, 90, 0), vec(1, 0, 0))
    # Ry(90) takes +X to -Z
    assert approx(rotate_vec(vec(1, 0, 0), 0, 90, 0), vec(0, 0, -1))


def test_rotate_vec_composition_order():
    # R = Rz · Rx · Ry. So Ry runs first.
    # Apply to +X: Ry(90)*+X = -Z; then Rx(90)*-Z = +Y; then Rz(0) = +Y
    assert approx(rotate_vec(vec(1, 0, 0), 90, 90, 0), vec(0, 1, 0))


def test_rotate_vec_preserves_length():
    v = vec(1, -2, 3)
    rotated = rotate_vec(v, 30, 45, 60)
    assert math.isclose(length(rotated), length(v), abs_tol=1e-9)


# --- anchor id normalization --------------------------------------------------


@pytest.mark.parametrize(
    ("alias", "expected"),
    [
        (None, "center"),
        ("", "center"),
        ("center", "center"),
        ("Centre", "center"),
        ("+X face", "+x"),
        ("x+", "+x"),
        ("right", "+x"),
        ("LEFT", "-x"),
        ("top", "+y"),
        ("bottom", "-y"),
        ("front", "+z"),
        ("back", "-z"),
        ("custom_anchor_id", "custom_anchor_id"),  # passthrough
    ],
)
def test_normalize_anchor_id(alias, expected):
    assert normalize_anchor_id(alias) == expected


# --- standard box anchors ----------------------------------------------------


def test_standard_anchor_center():
    a = standard_anchor("center", vec(100, 100, 100))
    assert a is not None
    assert a["localPosition"] == vec(0, 0, 0)
    assert a["type"] == "center"


def test_standard_anchor_faces_use_half_size():
    size = vec(40, 60, 80)
    expected = {
        "+x": (vec(20, 0, 0), vec(1, 0, 0)),
        "-x": (vec(-20, 0, 0), vec(-1, 0, 0)),
        "+y": (vec(0, 30, 0), vec(0, 1, 0)),
        "-y": (vec(0, -30, 0), vec(0, -1, 0)),
        "+z": (vec(0, 0, 40), vec(0, 0, 1)),
        "-z": (vec(0, 0, -40), vec(0, 0, -1)),
    }
    for anchor_id, (pos, direction) in expected.items():
        a = standard_anchor(anchor_id, size)
        assert a is not None, anchor_id
        assert a["localPosition"] == pos
        assert a["localDirection"] == direction


def test_standard_anchor_unknown_returns_none():
    assert standard_anchor("not_a_real_anchor", vec(10, 10, 10)) is None


# --- placement_rotation -------------------------------------------------------


def test_placement_rotation_reads_floats():
    p = Placement(rx_deg=10, ry_deg=20, rz_deg=30)
    assert placement_rotation(p) == (10.0, 20.0, 30.0)


def test_placement_rotation_handles_none_axes():
    p = Placement()
    p.rx_deg = None  # SQLAlchemy default not applied outside session
    p.ry_deg = None
    p.rz_deg = None
    assert placement_rotation(p) == (0.0, 0.0, 0.0)


# --- world anchor position/direction with rotation ---------------------------
# These exercise the bug fix: rotating a placement should rotate its anchors.


def make_placement(
    *,
    x: float = 0,
    y: float = 0,
    z: float = 0,
    rx: float = 0,
    ry: float = 0,
    rz: float = 0,
    size: tuple[float, float, float] = (100, 100, 100),
    anchors: list[dict] | None = None,
) -> Placement:
    """Build a Placement with `properties.anchors` pre-populated so anchor_for
    skips the DB lookup. session=None is fine."""
    sx, sy, sz = size
    base_anchors = [
        {"id": "center", "name": "Center", "type": "center", "localPosition": vec()},
        {"id": "+x", "name": "+X", "type": "face", "localPosition": vec(sx / 2, 0, 0), "localDirection": vec(1, 0, 0)},
        {"id": "-x", "name": "-X", "type": "face", "localPosition": vec(-sx / 2, 0, 0), "localDirection": vec(-1, 0, 0)},
        {"id": "+y", "name": "+Y", "type": "face", "localPosition": vec(0, sy / 2, 0), "localDirection": vec(0, 1, 0)},
        {"id": "-y", "name": "-Y", "type": "face", "localPosition": vec(0, -sy / 2, 0), "localDirection": vec(0, -1, 0)},
        {"id": "+z", "name": "+Z", "type": "face", "localPosition": vec(0, 0, sz / 2), "localDirection": vec(0, 0, 1)},
        {"id": "-z", "name": "-Z", "type": "face", "localPosition": vec(0, 0, -sz / 2), "localDirection": vec(0, 0, -1)},
    ]
    return Placement(
        id=uuid.uuid4(),
        component_id=uuid.uuid4(),
        x_mm=x,
        y_mm=y,
        z_mm=z,
        rx_deg=rx,
        ry_deg=ry,
        rz_deg=rz,
        visible=True,
        locked=False,
        properties={"anchors": anchors if anchors is not None else base_anchors},
    )


@pytest.mark.asyncio
async def test_world_anchor_position_no_rotation():
    p = make_placement(x=10, y=20, z=30, size=(40, 40, 40))
    pos = await world_anchor_position(None, p, "+x")
    # +X face = (20, 0, 0) in local; placement at (10,20,30) → world (30, 20, 30)
    assert approx(pos, vec(30, 20, 30))


@pytest.mark.asyncio
async def test_world_anchor_position_with_rotation():
    # Placement rotated 90° around lab Z. Local +X face should move to +Y world.
    p = make_placement(x=0, y=0, z=0, rz=90, size=(40, 40, 40))
    pos = await world_anchor_position(None, p, "+x")
    # local +X (20,0,0) rotated by Rz(90) → (0,20,0). Plus placement origin = (0,20,0).
    assert approx(pos, vec(0, 20, 0))


@pytest.mark.asyncio
async def test_world_anchor_direction_with_rotation():
    p = make_placement(rz=90)
    direction = await world_anchor_direction(None, p, "+x")
    # +X local direction rotated by Rz(90) → +Y
    assert direction is not None
    assert approx(direction, vec(0, 1, 0))


@pytest.mark.asyncio
async def test_world_anchor_position_translation_plus_rotation():
    # Combined: rotated and translated.
    p = make_placement(x=100, y=0, z=0, rz=90, size=(40, 40, 40))
    pos = await world_anchor_position(None, p, "+x")
    # local (20,0,0) → rotated (0,20,0) → +translation = (100, 20, 0)
    assert approx(pos, vec(100, 20, 0))


@pytest.mark.asyncio
async def test_world_anchor_center_unaffected_by_rotation():
    p = make_placement(x=5, y=6, z=7, rx=45, ry=30, rz=60)
    pos = await world_anchor_position(None, p, "center")
    # Center is at origin locally; rotation of zero vector is still zero.
    assert approx(pos, vec(5, 6, 7))


# --- anchor resolution chain: placement override > asset > standard box ------


class FakeSession:
    """Async session double sufficient for component_for / asset_for which only
    call session.get(Model, id)."""

    def __init__(self, components: dict, assets: dict) -> None:
        self.components = components
        self.assets = assets

    async def get(self, model, item_id):
        if model is Component:
            return self.components.get(item_id)
        if model is Asset3D:
            return self.assets.get(item_id)
        return None


def make_bare_placement(component_id, *, size=(40, 40, 40)) -> Placement:
    """Placement with no properties.anchors so resolution falls through."""
    sx, sy, sz = size
    return Placement(
        id=uuid.uuid4(),
        component_id=component_id,
        x_mm=0,
        y_mm=0,
        z_mm=0,
        rx_deg=0,
        ry_deg=0,
        rz_deg=0,
        visible=True,
        locked=False,
        properties={"size": {"x": sx, "y": sy, "z": sz}},
    )


@pytest.mark.asyncio
async def test_anchor_for_falls_back_to_standard_when_no_overrides():
    # No placement anchors, no asset, component has no asset_3d_id → standard box.
    component_id = uuid.uuid4()
    component = Component(id=component_id, name="c", component_type="custom_3d", properties={})
    session = FakeSession({component_id: component}, {})

    placement = make_bare_placement(component_id, size=(40, 40, 40))
    anchor = await anchor_for(session, placement, "+x")

    assert anchor["localPosition"] == vec(20, 0, 0)
    assert anchor["localDirection"] == vec(1, 0, 0)


@pytest.mark.asyncio
async def test_anchor_for_uses_asset_anchor_when_no_placement_override():
    component_id = uuid.uuid4()
    asset_id = uuid.uuid4()
    asset = Asset3D(
        id=asset_id,
        name="a",
        asset_type="stl",
        file_path="x.stl",
        unit="mm",
        scale_factor=1.0,
        anchors=[
            {"id": "fiber_port", "name": "Fiber port", "type": "custom",
             "localPosition": {"x": 12, "y": 3, "z": 4},
             "localDirection": {"x": 0, "y": 1, "z": 0}},
        ],
    )
    component = Component(
        id=component_id, name="c", component_type="custom_3d", asset_3d_id=asset_id, properties={}
    )
    session = FakeSession({component_id: component}, {asset_id: asset})

    placement = make_bare_placement(component_id)
    anchor = await anchor_for(session, placement, "fiber_port")

    assert anchor["localPosition"] == {"x": 12, "y": 3, "z": 4}
    assert anchor["localDirection"] == {"x": 0, "y": 1, "z": 0}


@pytest.mark.asyncio
async def test_anchor_for_placement_override_beats_asset():
    # Same anchor id "+x" defined on both placement and asset; placement wins.
    component_id = uuid.uuid4()
    asset_id = uuid.uuid4()
    asset = Asset3D(
        id=asset_id, name="a", asset_type="stl", file_path="x.stl", unit="mm", scale_factor=1.0,
        anchors=[{"id": "+x", "localPosition": {"x": 999, "y": 0, "z": 0}}],  # asset value
    )
    component = Component(
        id=component_id, name="c", component_type="custom_3d", asset_3d_id=asset_id, properties={}
    )
    session = FakeSession({component_id: component}, {asset_id: asset})

    placement = Placement(
        id=uuid.uuid4(),
        component_id=component_id,
        x_mm=0, y_mm=0, z_mm=0,
        rx_deg=0, ry_deg=0, rz_deg=0,
        visible=True, locked=False,
        properties={
            "anchors": [{"id": "+x", "localPosition": {"x": 7, "y": 0, "z": 0}}],
        },
    )
    anchor = await anchor_for(session, placement, "+x")
    assert anchor["localPosition"] == {"x": 7, "y": 0, "z": 0}  # placement override


@pytest.mark.asyncio
async def test_anchor_for_falls_through_asset_to_standard_when_id_not_in_asset():
    # Asset defines a custom anchor but query is for "+x" → standard box.
    component_id = uuid.uuid4()
    asset_id = uuid.uuid4()
    asset = Asset3D(
        id=asset_id, name="a", asset_type="stl", file_path="x.stl", unit="mm", scale_factor=1.0,
        anchors=[{"id": "fiber_port", "localPosition": {"x": 12, "y": 0, "z": 0}}],
    )
    component = Component(
        id=component_id, name="c", component_type="custom_3d", asset_3d_id=asset_id, properties={}
    )
    session = FakeSession({component_id: component}, {asset_id: asset})

    placement = make_bare_placement(component_id, size=(40, 40, 40))
    anchor = await anchor_for(session, placement, "+x")
    # No "+x" in asset → standard box +x at half-size.
    assert anchor["localPosition"] == vec(20, 0, 0)


@pytest.mark.asyncio
async def test_anchor_for_handles_none_session():
    # No session → can't load component/asset. Should still return standard box.
    placement = make_bare_placement(uuid.uuid4(), size=(40, 40, 40))
    anchor = await anchor_for(None, placement, "+x")
    assert anchor["localPosition"] == vec(20, 0, 0)
