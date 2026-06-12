"""Laser emit: a per-instance ``nominalPowerMw`` (the asset's own param key,
written to SceneObject.dynamic_sources by the tunable-param editor) drives the
emitted beam power.

Guards the param-ownership rework: the emit op must read ``nominalPowerMw`` from
the merged dynamic bag — not only the legacy ``powerMw``/``laserPowerMw``
aliases — or tuning a laser's power per-instance silently no-ops (the beam scope
keeps showing the asset default).
"""

import pytest

from app.optical import anchor_ops  # noqa: F401  (register ops)
from app.optical.anchor_ops.emit_laser_source import emit_anchor_source_rays
from app.optical.anchor_tracer import (
    V3Anchor, V3AnchorBindingSlot, V3AnchorScene, V3AssetAnchorSnapshot,
)
from app.optical.beam_ray import Vec3
from app.optical.pose import V3Transform


def _laser_scene(dynamic: dict | None):
    anchor = V3Anchor(
        id="intercept_out",
        position_body=Vec3(0, 0, 0),
        axis_x_body=Vec3(0, 0, 1),
        axis_y_body=Vec3(0, 1, 0),
        axis_z_body=Vec3(1, 0, 0),
        aperture_mm=0,
    )
    snap = V3AssetAnchorSnapshot(
        catalog_id="scratch_laser", kind="laser_source", anchors=[anchor],
        default_params={"centerWavelengthNm": 852.0, "nominalPowerMw": 50.0},
    )
    slot = V3AnchorBindingSlot(
        scene_object_id="laser0", binding_id="b0", asset=snap,
        effective_transform=V3Transform(origin=Vec3(0, 0, 0)),
        dynamic_sources=dynamic,
    )
    return V3AnchorScene(slots=[slot])


def test_tunable_nominal_power_overrides_default():
    rays = emit_anchor_source_rays(_laser_scene({"nominalPowerMw": 80.0}))
    assert rays, "laser should emit one ray"
    assert rays[0][0].power_mw == pytest.approx(80.0)


def test_no_override_uses_asset_default():
    rays = emit_anchor_source_rays(_laser_scene(None))
    assert rays[0][0].power_mw == pytest.approx(50.0)


def test_legacy_power_mw_alias_still_works():
    # Lasers seeded before the rework carry the legacy ``powerMw`` alias from the
    # opticalSources beam path; it must still drive power when no tunable override.
    rays = emit_anchor_source_rays(_laser_scene({"powerMw": 12.0}))
    assert rays[0][0].power_mw == pytest.approx(12.0)
