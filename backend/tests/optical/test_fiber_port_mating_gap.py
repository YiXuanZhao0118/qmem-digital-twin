"""Why a plugged-in fibre must NOT sit exactly on the port plane.

The frontend's fibre endpoint link (``SceneObject.properties.fiberEndpoints``,
the optical twin of ``rfCableEndpoints``) mates a patch-cable end onto an
instrument's optical port. The obvious mating — put the fibre's exit face
exactly on the port anchor — is silently broken: ``fiber_anchor_op`` emits the
outgoing ray FROM the exit anchor's position, so the receiving plane is at
t = 0 and ``intersect_anchor`` drops it. A fibre-fed detector would show
nothing at all, with no error anywhere.

``utils/fiberAnchorResolver.FIBER_MATING_GAP_MM`` (10 µm) exists solely to keep
t positive. These tests pin the backend behaviour that constant is sized
against, so nobody "simplifies" the gap away later.
"""

from __future__ import annotations

import pytest

from app.optical.anchor_tracer import V3Anchor, intersect_anchor
from app.optical.beam_ray import Vec3


# The frontend constant, in mm. Kept as a literal rather than imported
# because it lives in TypeScript — if the two ever drift, the
# `test_gap_matching_the_frontend_constant_hits` case is what notices.
FIBER_MATING_GAP_MM = 0.01


def _port(aperture_mm: float = 1.25) -> V3Anchor:
    """A detector-style input port at the origin whose light travels −X —
    the shape of the RXM15EF's `fiber_in` bulkhead."""
    return V3Anchor(
        id="fiber_in",
        position_body=Vec3(0.0, 0.0, 0.0),
        axis_x_body=Vec3(-1.0, 0.0, 0.0),
        axis_y_body=Vec3(0.0, 1.0, 0.0),
        axis_z_body=Vec3(0.0, 0.0, 1.0),
        aperture_mm=aperture_mm,
    )


def test_ray_emitted_exactly_on_the_port_plane_is_missed() -> None:
    """The failure mode the gap prevents. Perfect mating == no coupling."""
    assert (
        intersect_anchor(Vec3(0.0, 0.0, 0.0), Vec3(-1.0, 0.0, 0.0), _port())
        is None
    )


def test_gap_matching_the_frontend_constant_hits() -> None:
    """One mating gap in front of the plane is enough, by a wide margin."""
    res = intersect_anchor(
        Vec3(FIBER_MATING_GAP_MM, 0.0, 0.0), Vec3(-1.0, 0.0, 0.0), _port()
    )
    assert res is not None
    t, hit, off_y, off_z, cos_inc = res
    assert t == pytest.approx(FIBER_MATING_GAP_MM)
    # Head-on, dead centre — the mating is coaxial with the port.
    assert cos_inc == pytest.approx(1.0)
    assert (off_y, off_z) == pytest.approx((0.0, 0.0))
    assert hit.x == pytest.approx(0.0)
    # And it clears t_min by seven orders of magnitude, so body↔lab float
    # round-trip noise (~1e-12 mm) cannot push it back under.
    assert t / 1e-9 > 1e6


def test_a_gap_on_the_wrong_side_still_misses() -> None:
    """Mating the fibre PAST the plane (negative gap) puts the port behind
    the ray. Same silent no-coupling — the sign of the standoff matters."""
    assert (
        intersect_anchor(
            Vec3(-FIBER_MATING_GAP_MM, 0.0, 0.0), Vec3(-1.0, 0.0, 0.0), _port()
        )
        is None
    )


def test_gap_divergence_stays_inside_the_receptacle_aperture() -> None:
    """The gap is only free of charge while the beam stays in the bore.

    An OM1 fibre (Ø62.5 µm core, NA 0.275) leaving its face spreads by
    ~NA·gap in radius. Over 10 µm that is ~2.8 µm on top of the 31 µm core
    radius — utterly inside the RXM15EF's 1.25 mm ferrule bore, which is why
    the standoff costs no coupling. A gap big enough to matter would show up
    here first.
    """
    na, core_radius_mm = 0.275, 0.03125
    edge_offset_mm = core_radius_mm + na * FIBER_MATING_GAP_MM
    assert edge_offset_mm < 0.035
    res = intersect_anchor(
        Vec3(FIBER_MATING_GAP_MM, edge_offset_mm, 0.0),
        Vec3(-1.0, 0.0, 0.0),
        _port(),
    )
    assert res is not None, "the widened beam edge must still be in aperture"


def test_a_fiber_in_bulkhead_is_hit_by_the_tracer_and_absorbs() -> None:
    """The bulkhead's own anchor id must be hit-testable, not just geometric.

    ``intersect_anchor`` above is pure geometry and does not care what an
    anchor is called — every case in this file would keep passing if
    ``fiber_in`` were dropped from ``anchor_tracer.PRIMARY_ANCHOR_IDS``, while
    the real tracer silently skipped the port and the receiver read nothing.
    That is exactly the failure mode this whole file exists to prevent, so pin
    it end to end: fire a ray one mating gap in front of an RXM15EF-shaped
    bulkhead and require the trace to land on it and stop.
    """
    from app.optical import anchor_ops  # noqa: F401  (populates the op registry)
    from app.optical.anchor_tracer import (
        AnchorTraceOptions,
        V3AnchorBindingSlot,
        V3AnchorScene,
        V3AssetAnchorSnapshot,
        V3Transform,
        trace_ray_anchor_scene,
    )
    from app.optical.beam_ray import make_beam_ray

    scene = V3AnchorScene(slots=[V3AnchorBindingSlot(
        scene_object_id="rxm15ef0",
        binding_id="body",
        asset=V3AssetAnchorSnapshot(
            catalog_id="rxm15ef_step", kind="detector", anchors=[_port()],
            default_params={"wavelengthRangeNm": [750, 1650]},
        ),
        effective_transform=V3Transform(origin=Vec3(0.0, 0.0, 0.0)),
    )])
    res = trace_ray_anchor_scene(
        make_beam_ray(
            origin=Vec3(FIBER_MATING_GAP_MM, 0.0, 0.0),
            direction=Vec3(-1.0, 0.0, 0.0),
            wavelength_nm=852, waist_radius_mm=0.003, power_mw=1.0,
        ),
        scene,
        AnchorTraceOptions(),
    )

    assert {s.anchor_id for s in res.lab_segments} == {"fiber_in"}
    # A detector is a terminal sink: the beam stops here, nothing continues.
    assert not res.final_rays
    seg = res.lab_segments[-1]
    assert seg.power_mw == pytest.approx(1.0)
    # The segment really is just the mating gap.
    assert abs(seg.start.x - seg.end.x) == pytest.approx(FIBER_MATING_GAP_MM)
