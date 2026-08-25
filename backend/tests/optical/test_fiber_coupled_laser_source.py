"""A fibre-coupled ``laser_source`` — an emit face and a bulkhead at one point.

Alembic 0137 gave ``laser_source`` the optional ``fiber_in`` role so a source
whose light leaves down a patch cable (the ``fiber_checker`` handheld VFL is
the first one) can declare the socket the cable plugs into. But
``emit_anchor_source_rays`` spawns the seed ray from ``intercept_out`` and
nothing else, so such a part has to carry BOTH anchors, coincident on the
ferrule-bore face.

That is only safe because of an interaction two files apart, which is what
these tests pin:

  * the emit anchor's ``exclude_face_key`` covers ``intercept_out`` alone, so
    the coincident ``fiber_in`` is NOT excluded by id, and
  * ``fiber_in`` IS in ``PRIMARY_ANCHOR_IDS``, so it is hit-tested,
  * but the ray starts exactly on that anchor's plane, giving ``t = 0``, which
    ``intersect_anchor`` drops under ``t_min = 1e-9``.

Loosen ``t_min``, or start excluding by position instead of by anchor key, and
a fibre-coupled laser silently terminates its own beam on its own socket
instead of reaching the fibre — with no error anywhere. Hence the test.
"""

import pytest

from app.optical import anchor_ops  # noqa: F401  (register ops)
from app.optical.anchor_ops.emit_laser_source import emit_anchor_source_rays
from app.optical.anchor_tracer import (
    PRIMARY_ANCHOR_IDS,
    V3Anchor,
    V3AnchorBindingSlot,
    V3AnchorScene,
    V3AssetAnchorSnapshot,
    nearest_anchor_hit,
)
from app.optical.beam_ray import Vec3
from app.optical.pose import V3Transform

# The fiber_checker frame: bore face at the origin of the anchor pair, optical
# axis 13 mm up, +X out of the connector. Aperture is the 2.5 mm ferrule bore
# as a semi-axis, same as the rxm15ef bulkhead.
AXIS_Z = 13.0
APERTURE_MM = 1.25


def _anchor(anchor_id: str) -> V3Anchor:
    return V3Anchor(
        id=anchor_id,
        position_body=Vec3(0.0, 0.0, AXIS_Z),
        axis_x_body=Vec3(1.0, 0.0, 0.0),
        axis_y_body=Vec3(0.0, 0.0, 1.0),
        axis_z_body=Vec3(0.0, -1.0, 0.0),
        aperture_mm=APERTURE_MM,
    )


def _vfl_slot() -> V3AnchorBindingSlot:
    snap = V3AssetAnchorSnapshot(
        catalog_id="fiber_checker",
        kind="laser_source",
        anchors=[_anchor("intercept_out"), _anchor("fiber_in")],
        default_params={"centerWavelengthNm": 650.0, "nominalPowerMw": 10.0},
    )
    return V3AnchorBindingSlot(
        scene_object_id="vfl0", binding_id="b0", asset=snap,
        effective_transform=V3Transform(origin=Vec3(0.0, 0.0, 0.0)),
        dynamic_sources=None,
    )


def _downstream_slot(x_mm: float) -> V3AnchorBindingSlot:
    """Something for the beam to actually reach, x_mm in front of the socket."""
    target = V3Anchor(
        id="intercept_in",
        position_body=Vec3(x_mm, 0.0, AXIS_Z),
        axis_x_body=Vec3(1.0, 0.0, 0.0),
        axis_y_body=Vec3(0.0, 0.0, 1.0),
        axis_z_body=Vec3(0.0, -1.0, 0.0),
        aperture_mm=APERTURE_MM,
    )
    snap = V3AssetAnchorSnapshot(
        catalog_id="scratch_sink", kind="detector", anchors=[target],
        default_params={},
    )
    return V3AnchorBindingSlot(
        scene_object_id="sink0", binding_id="b1", asset=snap,
        effective_transform=V3Transform(origin=Vec3(0.0, 0.0, 0.0)),
        dynamic_sources=None,
    )


def test_bulkhead_is_hit_tested_at_all():
    """Guards the premise of the test below — if `fiber_in` stopped being
    primary the self-hit question would be vacuous rather than answered."""
    assert "fiber_in" in PRIMARY_ANCHOR_IDS


def test_emits_once_from_the_intercept_not_the_bulkhead():
    rays = emit_anchor_source_rays(V3AnchorScene(slots=[_vfl_slot()]))
    assert len(rays) == 1, "the bulkhead must not emit a second beam"
    ray = rays[0][0]
    assert ray.origin.x == pytest.approx(0.0)
    assert ray.origin.z == pytest.approx(AXIS_Z)
    assert ray.direction.x == pytest.approx(1.0)
    assert ray.power_mw == pytest.approx(10.0)
    assert ray.wavelength_nm == pytest.approx(650.0)
    # Excluded by anchor id, which is exactly why the coincident `fiber_in`
    # needs the t_min guard rather than this key.
    assert ray.exclude_face_key.endswith("/intercept_out")


def test_beam_reaches_downstream_instead_of_its_own_socket():
    vfl = _vfl_slot()
    sink = _downstream_slot(250.0)
    ray = emit_anchor_source_rays(V3AnchorScene(slots=[vfl]))[0][0]

    hit = nearest_anchor_hit(
        ray, [vfl, sink], exclude_anchor_key=ray.exclude_face_key,
    )
    assert hit is not None, "the beam has to reach something"
    assert hit.anchor.id == "intercept_in"
    assert hit.slot.scene_object_id == "sink0"
    assert hit.t_lab == pytest.approx(250.0)


def test_bulkhead_alone_emits_nothing():
    """Documents WHY the asset carries both anchors: build it with only the
    socket and the part is optically dead, silently."""
    snap = V3AssetAnchorSnapshot(
        catalog_id="socket_only", kind="laser_source",
        anchors=[_anchor("fiber_in")],
        default_params={"centerWavelengthNm": 650.0, "nominalPowerMw": 10.0},
    )
    slot = V3AnchorBindingSlot(
        scene_object_id="vfl1", binding_id="b0", asset=snap,
        effective_transform=V3Transform(origin=Vec3(0.0, 0.0, 0.0)),
        dynamic_sources=None,
    )
    assert emit_anchor_source_rays(V3AnchorScene(slots=[slot])) == []


def test_manifest_offers_the_bulkhead_role_on_laser_source():
    from app.kinds_manifest import kind_rows_from_manifest

    template = kind_rows_from_manifest()["laser_source"]["anchor_template"]
    assert "fiber_in" in template["optional"]
    assert "fiber_in" in template["needs_aperture"]
    assert "fiber_in" in template["needs_direction"]
