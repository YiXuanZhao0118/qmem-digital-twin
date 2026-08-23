"""A pigtailed device's ports come from the fibre connectors bound at them.

`db_scene_loader._port_connector_anchors`: bind a `fiber_connector` asset in
the Component and tag the binding `properties.portAnchor = "intercept_in"` /
`"intercept_out"`, and that connector's MATING FACE becomes the port —
position, aperture, and the PM slow-axis key (axisY).

It has to be a derivation rather than just using the connector's own anchors:
the mating face is not in `PRIMARY_ANCHOR_IDS`, so the tracer can never hit
it. The EOSpace EOM is the first device built this way.

The mating face has two live spellings — `fiber_out` on a fibre connector
(alembic 0135) and `connect_in` on a coax one, resolved by
`db_scene_loader._find_anchor`. Every case here runs against BOTH, because the
lookup silently falling back to the legacy name is exactly the kind of bug
that leaves the rename half-done and nobody notices.
"""

import pytest

import asyncio
import math
import types

from app.optical.anchor_tracer import V3Anchor, V3AssetAnchorSnapshot
from app.optical.beam_ray import Vec3
from app.optical.db_scene_loader import _port_connector_anchors
from app.optical.pose import V3Pose, binding_pose_to_transform, identity_transform


# (cable root, mating face) per spelling. `fiber` is what the catalog holds
# after 0135; `coax` is what an rf_cable_connector still holds.
SPELLINGS = {
    "fiber": ("fiber_root", "fiber_out"),
    "coax": ("connect_out", "connect_in"),
}


def _connector(axis_y=(0.0, 1.0, 0.0), aperture=0.125, spelling="fiber"):
    """A stub FC/APC ferrule: body along +Z, face 59.333 mm out."""
    root_id, face_id = SPELLINGS[spelling]
    return types.SimpleNamespace(kind_id="fiber_connector", anchors=[
        {"id": root_id, "positionMmBodyLocal": {"x": 0.0, "y": 0.0, "z": 0.0}},
        {"id": face_id,
         "positionMmBodyLocal": {"x": 0.0, "y": 0.0, "z": 59.333},
         "axisXBodyLocal": {"x": 0.0, "y": 0.0, "z": 1.0},
         "axisYBodyLocal": {"x": axis_y[0], "y": axis_y[1], "z": axis_y[2]},
         "apertureMm": aperture}])


def _binding(bid, port, pose):
    return types.SimpleNamespace(
        id=bid, target_kind="asset", asset_3d_id=f"asset-{bid}",
        parent_binding_id=None, properties={"portAnchor": port},
        local_x_mm=pose[0], local_y_mm=pose[1], local_z_mm=pose[2],
        local_rx_deg=pose[3], local_ry_deg=pose[4], local_rz_deg=pose[5])


class _Session:
    def __init__(self, by_id): self._by_id = by_id
    async def get(self, _model, asset_id): return self._by_id.get(asset_id)


PORT = V3Anchor(id="intercept_out", position_body=Vec3(999, 0, 0),
                axis_x_body=Vec3(1, 0, 0), axis_y_body=Vec3(0, 1, 0),
                axis_z_body=Vec3(0, 0, -1), aperture_mm=5.0)
OTHER = V3Anchor(id="rf_in", position_body=Vec3(40, 0, 13.5),
                 axis_x_body=Vec3(0, 0, 1), axis_y_body=Vec3(1, 0, 0),
                 axis_z_body=Vec3(0, -1, 0), aperture_mm=0.0)


def _run(bindings, connectors, snap_anchors=(PORT, OTHER)):
    snap = V3AssetAnchorSnapshot(catalog_id="dev", kind="eom",
                                 anchors=list(snap_anchors))
    return asyncio.run(_port_connector_anchors(
        _Session(connectors), snap, identity_transform(), list(bindings),
        {b.id: b for b in bindings}, {}, {}, identity_transform()))


@pytest.mark.parametrize("spelling", sorted(SPELLINGS))
def test_port_lands_on_the_connectors_mating_face(spelling):
    """ry=+90 lays the ferrule along +X, so its face sits 59.333 mm out."""
    b = _binding("p", "intercept_out", (0, 0, 0, 0, 90, 0))
    out = _run([b], {"asset-p": _connector(spelling=spelling)})
    port = next(a for a in out.anchors if a.id == "intercept_out")
    assert port.position_body.x == 59.333
    assert abs(port.position_body.y) < 1e-9 and abs(port.position_body.z) < 1e-9
    assert port.aperture_mm == 0.125          # the connector's, not the 5.0 stub


def test_axis_y_carries_the_pm_key():
    """Rotating the connector about its own axis rotates the port's axisY —
    this is what makes the modulator's accepted polarization adjustable."""
    b = _binding("p", "intercept_out", (0, 0, 0, 0, 90, 0))
    flat = _run([b], {"asset-p": _connector(axis_y=(0.0, 1.0, 0.0))})
    # axisY must be perpendicular to the ferrule axis (+Z); +X is the 90° key.
    turned = _run([b], {"asset-p": _connector(axis_y=(1.0, 0.0, 0.0))})
    ay1 = next(a for a in flat.anchors if a.id == "intercept_out").axis_y_body
    ay2 = next(a for a in turned.anchors if a.id == "intercept_out").axis_y_body
    assert abs(ay1.dot(ay2)) < 1e-9           # the two keys are 90° apart
    assert abs(ay1.length() - 1.0) < 1e-12 and abs(ay2.length() - 1.0) < 1e-12


def test_direction_keeps_the_devices_own_sense():
    """An INPUT bulkhead faces backwards up the beam. Taking its mating
    normal raw would reverse the direction the op emits along, so axisX is
    flipped to agree with what the device authored."""
    b = _binding("p", "intercept_out", (0, 0, 0, 0, -90, 0))   # ferrule along −X
    out = _run([b], {"asset-p": _connector()})
    port = next(a for a in out.anchors if a.id == "intercept_out")
    assert port.axis_x_body.dot(PORT.axis_x_body) > 0.999      # still +X
    assert port.position_body.x == -59.333                     # face still moved


def test_axes_stay_orthonormal():
    b = _binding("p", "intercept_out", (0, 0, 0, 12.0, 90, 33.0))
    port = next(a for a in _run([b], {"asset-p": _connector()}).anchors
                if a.id == "intercept_out")
    for u, v in ((port.axis_x_body, port.axis_y_body),
                 (port.axis_y_body, port.axis_z_body),
                 (port.axis_z_body, port.axis_x_body)):
        assert abs(u.dot(v)) < 1e-9
    assert abs(port.axis_z_body.length() - 1.0) < 1e-9


def test_untagged_anchors_and_no_connector_are_left_alone():
    b = _binding("p", "intercept_out", (0, 0, 0, 0, 90, 0))
    out = _run([b], {"asset-p": _connector()})
    assert next(a for a in out.anchors if a.id == "rf_in") is OTHER
    # No portAnchor tag anywhere -> the snapshot comes back untouched.
    plain = types.SimpleNamespace(
        id="q", target_kind="asset", asset_3d_id="asset-p", parent_binding_id=None,
        properties={}, local_x_mm=0, local_y_mm=0, local_z_mm=0,
        local_rx_deg=0, local_ry_deg=0, local_rz_deg=0)
    same = _run([plain], {"asset-p": _connector()})
    assert same.anchors[0] is PORT


def test_a_non_connector_asset_at_the_port_is_ignored():
    """Only a fiber_connector defines a port; a mount bound there must not."""
    b = _binding("p", "intercept_out", (0, 0, 0, 0, 90, 0))
    mount = types.SimpleNamespace(kind_id="mechanical", anchors=[])
    assert _run([b], {"asset-p": mount}).anchors[0] is PORT


def test_both_spellings_of_the_mating_face_give_the_same_port():
    """The rename must be a pure rename.

    `_find_anchor` tries `fiber_out` then `connect_in`, so a bug that broke
    the new spelling would fall back to the old one and every other case in
    this file would keep passing on legacy fixtures. Compare the two directly:
    same geometry in, byte-identical port out.
    """
    b = _binding("p", "intercept_out", (0, 0, 0, 0, 90, 0))
    ports = {}
    for spelling in SPELLINGS:
        out = _run([b], {"asset-p": _connector(spelling=spelling)})
        a = next(x for x in out.anchors if x.id == "intercept_out")
        ports[spelling] = (
            (a.position_body.x, a.position_body.y, a.position_body.z),
            (a.axis_x_body.x, a.axis_x_body.y, a.axis_x_body.z),
            (a.axis_y_body.x, a.axis_y_body.y, a.axis_y_body.z),
            a.aperture_mm,
        )
    assert ports["fiber"] == ports["coax"]
    # And it really did move — a no-op derivation would also compare equal.
    assert ports["fiber"][0][0] == 59.333


def test_the_new_spelling_wins_when_an_asset_carries_both():
    """A row caught mid-migration must resolve to the fibre anchor, whatever
    order the JSON happens to list them in."""
    conn = types.SimpleNamespace(kind_id="fiber_connector", anchors=[
        {"id": "connect_out", "positionMmBodyLocal": {"x": 0.0, "y": 0.0, "z": 0.0}},
        {"id": "connect_in",
         "positionMmBodyLocal": {"x": 0.0, "y": 0.0, "z": 10.0},
         "axisXBodyLocal": {"x": 0.0, "y": 0.0, "z": 1.0},
         "apertureMm": 9.9},
        {"id": "fiber_root", "positionMmBodyLocal": {"x": 0.0, "y": 0.0, "z": 0.0}},
        {"id": "fiber_out",
         "positionMmBodyLocal": {"x": 0.0, "y": 0.0, "z": 59.333},
         "axisXBodyLocal": {"x": 0.0, "y": 0.0, "z": 1.0},
         "apertureMm": 0.125},
    ])
    b = _binding("p", "intercept_out", (0, 0, 0, 0, 90, 0))
    port = next(
        a for a in _run([b], {"asset-p": conn}).anchors if a.id == "intercept_out"
    )
    assert port.position_body.x == 59.333   # fiber_out, not the 10.0 decoy
    assert port.aperture_mm == 0.125


def test_the_reseat_does_not_touch_the_authored_anchor():
    """The other half of the two-readings invariant (frontend side:
    ``utils/__tests__/portConnectorPlacement.test.ts``).

    The re-seat must produce a NEW snapshot and leave the input alone. The
    authored position is what the PHY Editor writes and what
    ``buildPigtailNodes`` welds the pigtail's node 0 to — if the loader
    mutated it in place, the pigtail would be redrawn from the connector's
    mating face instead of the device body, i.e. a jacket of length zero
    hanging off a connector 91 mm away from where the fibre actually leaves
    the package.
    """
    b = _binding("p", "intercept_out", (0, 0, 0, 0, 90, 0))
    snap = V3AssetAnchorSnapshot(catalog_id="dev", kind="eom", anchors=[PORT, OTHER])
    before = (PORT.position_body.x, PORT.position_body.y, PORT.position_body.z)

    out = asyncio.run(_port_connector_anchors(
        _Session({"asset-p": _connector()}), snap, identity_transform(), [b],
        {b.id: b}, {}, {}, identity_transform()))

    assert out is not snap
    # The authored anchor object still reads 999 — the stub's body position.
    assert (PORT.position_body.x, PORT.position_body.y, PORT.position_body.z) == before
    assert next(a for a in snap.anchors if a.id == "intercept_out").position_body.x == 999
    # ...while the returned one has moved onto the connector's mating face.
    assert next(a for a in out.anchors if a.id == "intercept_out").position_body.x == 59.333
