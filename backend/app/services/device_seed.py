"""Device-driven asset seeding (RF_ARCHITECTURE_PLAN §2.3 / §6 Phase 2).

When an Asset3D points at a `device_id`, its anchors are a materialised view
of that device's template (from the kinds.json `devices` block) and its
`kind_id` is written through from the device's `behavioralKind`. This module
turns a device record into the anchor dicts stored on `Asset3D.anchors` — the
in-app replacement for the `upsert_dds_chassis_1u.py` seed script ("一鍵 seed,
零 Python").

The tracer reads `Asset3D.anchors` directly, so seeding writes exactly the
tri-axis Phase 9.1 anchor shape (`positionMmBodyLocal` + `axisX/Y/Z`). Anchor
identity (id + name) is fixed by the device; coordinates are seeded here and
the user may fine-tune + save them afterwards (the editor sends explicit
`anchors`, which the update handler prefers over a re-seed).
"""

from __future__ import annotations

import math
from typing import Any

Vec3 = tuple[float, float, float]


def _normalize(v: Vec3, fallback: Vec3 = (1.0, 0.0, 0.0)) -> Vec3:
    n = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    if n < 1e-9:
        return fallback
    return (v[0] / n, v[1] / n, v[2] / n)


def _cross(a: Vec3, b: Vec3) -> Vec3:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _frame_from_axis_x(axis_x: Vec3) -> tuple[Vec3, Vec3, Vec3]:
    """Build an orthonormal (X, Y, Z) frame from a propagation axis. Y/Z are
    arbitrary but consistent — RF ports don't use them, so any valid
    complement works; the user re-derives them by dragging if it matters."""
    x = _normalize(axis_x)
    ref: Vec3 = (0.0, 0.0, 1.0)
    if abs(x[2]) > 0.9:  # x near world-Z → pick a different reference
        ref = (0.0, 1.0, 0.0)
    y = _normalize(_cross(ref, x))
    z = _normalize(_cross(x, y))
    return x, y, z


def _frame_from_axes(axis_x: Vec3, axis_y: Vec3 | None) -> tuple[Vec3, Vec3, Vec3]:
    """Orthonormal (X, Y, Z) frame. When the device anchor declares an explicit
    body-local axisY (polarisation-sensitive optics: waveplate / PBS / Glan /
    Faraday), honour it — Gram-Schmidt it against X to stay orthonormal, then
    Z = X × Y. Without an explicit axisY, fall back to the arbitrary RF-port
    complement (`_frame_from_axis_x`)."""
    x = _normalize(axis_x)
    if axis_y is None:
        return _frame_from_axis_x(x)
    dot = axis_y[0] * x[0] + axis_y[1] * x[1] + axis_y[2] * x[2]
    y_orth = (axis_y[0] - dot * x[0], axis_y[1] - dot * x[1], axis_y[2] - dot * x[2])
    y = _normalize(y_orth, fallback=_frame_from_axis_x(x)[1])
    z = _normalize(_cross(x, y))
    return x, y, z


def _vec(d: dict[str, Any] | None, fallback: Vec3) -> Vec3:
    if not isinstance(d, dict):
        return fallback
    return (
        float(d.get("x", fallback[0])),
        float(d.get("y", fallback[1])),
        float(d.get("z", fallback[2])),
    )


def materialize_device_anchors(device: dict[str, Any]) -> list[dict[str, Any]]:
    """Convert a manifest device record's `anchors` into the camelCase tri-axis
    anchor dicts stored on `Asset3D.anchors`. `role` → anchor `id`; the
    device's `direction_body_local` becomes `axisX`."""
    out: list[dict[str, Any]] = []
    for a in device.get("anchors") or []:
        pos = _vec(a.get("position_mm_body_local"), (0.0, 0.0, 0.0))
        explicit_y = a.get("axis_y_body_local")
        axis_x, axis_y, axis_z = _frame_from_axes(
            _vec(a.get("direction_body_local"), (1.0, 0.0, 0.0)),
            _vec(explicit_y, (0.0, 1.0, 0.0)) if explicit_y is not None else None,
        )
        anchor: dict[str, Any] = {
            "id": a["role"],
            "positionMmBodyLocal": {"x": pos[0], "y": pos[1], "z": pos[2]},
            "axisXBodyLocal": {"x": axis_x[0], "y": axis_x[1], "z": axis_x[2]},
            "axisYBodyLocal": {"x": axis_y[0], "y": axis_y[1], "z": axis_y[2]},
            "axisZBodyLocal": {"x": axis_z[0], "y": axis_z[1], "z": axis_z[2]},
        }
        if a.get("name") is not None:
            anchor["name"] = a["name"]
        if a.get("connector_type") is not None:
            anchor["connectorType"] = a["connector_type"]
        if a.get("aperture_mm") is not None:
            anchor["apertureMm"] = a["aperture_mm"]
        if a.get("aperture_shape") is not None:
            anchor["apertureShape"] = a["aperture_shape"]
        if a.get("aperture_width_mm") is not None:
            anchor["apertureWidthMm"] = a["aperture_width_mm"]
        if a.get("aperture_height_mm") is not None:
            anchor["apertureHeightMm"] = a["aperture_height_mm"]
        out.append(anchor)
    return out
