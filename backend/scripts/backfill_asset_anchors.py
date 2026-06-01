"""Phase 9.1.b — backfill ``Asset3D.anchors`` from current ``faces[]``.

Converts each v3 catalog Asset3D to the anchor-centric schema:
    {
      id, positionMmBodyLocal,
      axisXBodyLocal, axisYBodyLocal, axisZBodyLocal,
      apertureMm, apertureShape,
    }

Per-kind rule (see docs §3 once rewritten in Phase 9.9):

    Rule 1 — slab (lens / waveplate / polarizer / EOM / Faraday / TA):
        1 primary anchor at slab CENTRE; axisX = (B.pos - A.pos).normalize.
        2 secondary anchors at the A/B face positions (kept for align hint).

    Rule 2 — mirror / dichroic_mirror:
        1 anchor at face centre; axisX = face normal (outward).

    Rule 3 — cube (pbs / beam_splitter / glan_polarizer):
        1 primary anchor at B1 (internal Brewster plate); axisX = B1.normal.
        4 port anchors at back/front/left/right for align hints.

    Rule 4 — source (laser_source):
        1 anchor at the emission face; axisX = emission direction.

    Rule 5 — fiber (now dual-anchor; fiber_end kind retired):
        2 tip anchors at each end of the fiber Asset3D.

axisY derivation per kind:
    waveplate:   from default_params.fastAxisDegBodyLocal (rotate axisY
                 around axisX by that angle)
    polarizer:   from default_params.transmissionAxisDegBodyLocal
    pbs/glan:    perpendicular to axisX, in the plane containing body +Y
                 (s-polarization reference)
    aom:         from default_params.rfPropagationDirectionBodyLocal
    others:      perpendicular fallback (Gram-Schmidt against body +Y or +Z)

axisZ = axisX × axisY (right-handed).

This script is idempotent. Run as:
    .venv/Scripts/python scripts/backfill_asset_anchors.py
"""

from __future__ import annotations

import asyncio
import json
import math
from typing import Optional

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import AsyncSessionLocal
from app.models import Asset3D


Vec = tuple[float, float, float]


def _sub(a: Vec, b: Vec) -> Vec:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _add(a: Vec, b: Vec) -> Vec:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def _scale(v: Vec, s: float) -> Vec:
    return (v[0] * s, v[1] * s, v[2] * s)


def _dot(a: Vec, b: Vec) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a: Vec, b: Vec) -> Vec:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _norm(v: Vec) -> Vec:
    m = math.sqrt(_dot(v, v))
    if m < 1e-12:
        return (0.0, 0.0, 0.0)
    return (v[0] / m, v[1] / m, v[2] / m)


def _vec_dict(v: Vec) -> dict:
    return {"x": float(v[0]), "y": float(v[1]), "z": float(v[2])}


def _read_vec(d: Optional[dict]) -> Optional[Vec]:
    if not d:
        return None
    return (float(d.get("x", 0.0)), float(d.get("y", 0.0)), float(d.get("z", 0.0)))


def _build_transverse_axes(axis_x: Vec, axis_y_hint: Optional[Vec]) -> tuple[Vec, Vec]:
    """Given axisX + optional axisY hint, return orthonormal (axisY, axisZ).
    Hint is projected onto plane perpendicular to axisX; falls back to body
    +Y or +Z if hint is colinear with axisX."""
    if axis_y_hint is not None:
        # Project hint onto plane ⊥ axisX
        d = _dot(axis_y_hint, axis_x)
        proj = _sub(axis_y_hint, _scale(axis_x, d))
        if _dot(proj, proj) > 1e-12:
            ay = _norm(proj)
            az = _norm(_cross(axis_x, ay))
            return ay, az
    # Fallback: use body +Y if not colinear with axisX, else body +Z
    for candidate in [(0.0, 1.0, 0.0), (0.0, 0.0, 1.0), (1.0, 0.0, 0.0)]:
        d = _dot(candidate, axis_x)
        proj = _sub(candidate, _scale(axis_x, d))
        if _dot(proj, proj) > 1e-9:
            ay = _norm(proj)
            az = _norm(_cross(axis_x, ay))
            return ay, az
    # Should never reach here for a unit axisX
    return ((0.0, 1.0, 0.0), (0.0, 0.0, 1.0))


def _rotate_around_axis(v: Vec, axis: Vec, theta_rad: float) -> Vec:
    """Rodrigues' formula — rotate v by theta around unit axis."""
    c, s = math.cos(theta_rad), math.sin(theta_rad)
    cross = _cross(axis, v)
    dot = _dot(axis, v)
    return (
        v[0] * c + cross[0] * s + axis[0] * dot * (1 - c),
        v[1] * c + cross[1] * s + axis[1] * dot * (1 - c),
        v[2] * c + cross[2] * s + axis[2] * dot * (1 - c),
    )


def _anchor(
    aid: str, pos: Vec, axis_x: Vec, axis_y: Vec, axis_z: Vec,
    aperture_mm: float, aperture_shape: str = "circle",
    connector_type: Optional[str] = None,
) -> dict:
    anchor = {
        "id": aid,
        "positionMmBodyLocal": _vec_dict(pos),
        "axisXBodyLocal": _vec_dict(axis_x),
        "axisYBodyLocal": _vec_dict(axis_y),
        "axisZBodyLocal": _vec_dict(axis_z),
        "apertureMm": float(aperture_mm),
        "apertureShape": aperture_shape,
    }
    if connector_type is not None:
        # The RF Link panel reads the connector family off the anchor; an
        # RF port (rf_in / ttl_in / ...) with no connectorType renders
        # "NO CONN" and can't be wired. See alembic 0098.
        anchor["connectorType"] = connector_type
    return anchor


def _face_by_id(faces: list[dict], fid: str) -> Optional[dict]:
    return next((f for f in faces or [] if f.get("id") == fid), None)


# ─── Per-kind builders ─────────────────────────────────────────────────────


SLAB_KINDS = {"lens", "waveplate", "polarizer", "eom", "faraday_rotator",
              "tapered_amplifier"}
MIRROR_KINDS = {"mirror", "dichroic_mirror"}
CUBE_KINDS = {"pbs", "beam_splitter", "glan_polarizer"}


def build_slab_anchors(a: Asset3D) -> list[dict]:
    faces = a.faces or []
    face_a = _face_by_id(faces, "A")
    face_b = _face_by_id(faces, "B")
    if not face_a or not face_b:
        return []
    pa = _read_vec(face_a.get("positionMmBodyLocal")) or (0, 0, 0)
    pb = _read_vec(face_b.get("positionMmBodyLocal")) or (0, 0, 0)
    midpoint = _scale(_add(pa, pb), 0.5)
    axis_x_raw = _sub(pb, pa)
    axis_x = _norm(axis_x_raw)
    if axis_x == (0, 0, 0):
        axis_x = (0.0, 0.0, 1.0)

    # axisY hint by kind
    axis_y_hint: Optional[Vec] = None
    params = a.default_params or {}
    if a.kind_id == "waveplate":
        deg = params.get("fastAxisDegBodyLocal")
        if isinstance(deg, (int, float)):
            ay_base, _ = _build_transverse_axes(axis_x, None)
            axis_y_hint = _rotate_around_axis(ay_base, axis_x, math.radians(deg))
    elif a.kind_id == "polarizer":
        deg = params.get("transmissionAxisDegBodyLocal")
        if isinstance(deg, (int, float)):
            ay_base, _ = _build_transverse_axes(axis_x, None)
            axis_y_hint = _rotate_around_axis(ay_base, axis_x, math.radians(deg))
    elif a.kind_id == "tapered_amplifier":
        pol = params.get("inputPolarization")
        if isinstance(pol, dict) and "exRe" in pol:
            ay_base, _ = _build_transverse_axes(axis_x, None)
            axis_y_hint = ay_base  # preserve default

    axis_y, axis_z = _build_transverse_axes(axis_x, axis_y_hint)

    aperture = max(
        float(face_a.get("apertureMm", 0)),
        float(face_b.get("apertureMm", 0)),
    )

    anchors = [
        _anchor("optical_center", midpoint, axis_x, axis_y, axis_z,
                aperture, face_a.get("apertureShape", "circle")),
        _anchor("intercept_in", pa,
                _norm(_sub(pa, pb)) if pb != pa else axis_x,
                axis_y, axis_z,
                float(face_a.get("apertureMm", aperture)),
                face_a.get("apertureShape", "circle")),
        _anchor("intercept_out", pb,
                _norm(_sub(pb, pa)) if pb != pa else _scale(axis_x, -1),
                axis_y, axis_z,
                float(face_b.get("apertureMm", aperture)),
                face_b.get("apertureShape", "circle")),
    ]
    return anchors


def build_mirror_anchors(a: Asset3D) -> list[dict]:
    faces = a.faces or []
    face_a = _face_by_id(faces, "A") or (faces[0] if faces else None)
    if not face_a:
        return []
    pos = _read_vec(face_a.get("positionMmBodyLocal")) or (0, 0, 0)
    normal = _read_vec(face_a.get("normalBodyLocal")) or (0, 0, 1)
    axis_x = _norm(normal)
    axis_y, axis_z = _build_transverse_axes(axis_x, None)
    return [
        _anchor("reflection_surface", pos, axis_x, axis_y, axis_z,
                float(face_a.get("apertureMm", 12.7)),
                face_a.get("apertureShape", "circle")),
    ]


def build_cube_anchors(a: Asset3D) -> list[dict]:
    """Cube elements (PBS / BS / Glan-Laser) now expose ONLY the
    reflective coating plane (B1) as a single anchor. Outer port faces
    were dropped — physics emerges from offset/tilt at the coating
    plane and the kind's branch op decides transmit vs reflect."""
    faces = a.faces or []
    b1 = _face_by_id(faces, "B1")
    if not b1:
        return []
    pos = _read_vec(b1.get("positionMmBodyLocal")) or (0, 0, 0)
    normal = _read_vec(b1.get("normalBodyLocal")) or (1, 0, 0)
    axis_x = _norm(normal)
    # s-polarisation reference: perpendicular to axisX, prefer body +Y
    # projection
    axis_y, axis_z = _build_transverse_axes(axis_x, (0.0, 1.0, 0.0))
    return [_anchor(
        "coating_plane", pos, axis_x, axis_y, axis_z,
        float(b1.get("apertureMm", 12.7)),
        b1.get("apertureShape", "rectangle"),
    )]


def build_source_anchors(a: Asset3D) -> list[dict]:
    faces = a.faces or []
    if not faces:
        return []
    f = faces[0]
    pos = _read_vec(f.get("positionMmBodyLocal")) or (0, 0, 0)
    normal = _read_vec(f.get("normalBodyLocal")) or (0, 0, 1)
    axis_x = _norm(normal)

    # Polarization reference from default_params
    axis_y_hint: Optional[Vec] = None
    pol = (a.default_params or {}).get("polarization")
    if isinstance(pol, dict) and pol.get("exRe", 0) != 0:
        # ex axis is conventionally the s-polarization basis;
        # leave hint as body +Y projection
        pass

    axis_y, axis_z = _build_transverse_axes(axis_x, axis_y_hint)
    return [_anchor("emit_point", pos, axis_x, axis_y, axis_z,
                    float(f.get("apertureMm", 0)),
                    f.get("apertureShape", "circle"))]


def build_aom_anchors(a: Asset3D) -> list[dict]:
    # AOM is a slab with one extra RF anchor in legacy. Treat the optical
    # A/B as slab Rule 1, then attach an "rf_in" anchor if present in faces.
    slab = build_slab_anchors(a)
    # Override slab anchor id to interaction_center + use acoustic axis
    if slab:
        # axisY = acoustic propagation direction from kindParams
        params = a.default_params or {}
        rf_dir = params.get("rfPropagationDirectionBodyLocal")
        if isinstance(rf_dir, list) and len(rf_dir) == 3:
            ic = slab[0]
            ax = _read_vec(ic["axisXBodyLocal"])
            ay_hint = (float(rf_dir[0]), float(rf_dir[1]), float(rf_dir[2]))
            ay, az = _build_transverse_axes(ax, ay_hint)
            ic["axisYBodyLocal"] = _vec_dict(ay)
            ic["axisZBodyLocal"] = _vec_dict(az)
        slab[0]["id"] = "interaction_center"

    rf_in = _face_by_id(a.faces or [], "rf_in")
    if rf_in:
        pos = _read_vec(rf_in.get("positionMmBodyLocal")) or (0, 0, 0)
        normal = _read_vec(rf_in.get("normalBodyLocal")) or (1, 0, 0)
        axis_x = _norm(normal)
        ay, az = _build_transverse_axes(axis_x, None)
        connector = (a.default_params or {}).get("connectorType") or "sma"
        slab.append(_anchor("rf_in", pos, axis_x, ay, az, 0.0, "circle",
                            connector_type=connector))
    return slab


def build_fiber_anchors(a: Asset3D) -> list[dict]:
    # Fiber catalog rows historically have a single `tip` anchor on
    # `fiber_end` Assets — but Phase 9.X retired fiber_end as a kind.
    # For fiber Assets themselves the legacy `anchors` may include
    # endA/endB; we synthesise tip_a + tip_b from faces if present, else
    # fall back to two anchors at (0,0,±L/2) using default_params.lengthM.
    faces = a.faces or []
    fa = _face_by_id(faces, "A") or _face_by_id(faces, "tip_a")
    fb = _face_by_id(faces, "B") or _face_by_id(faces, "tip_b")
    if fa and fb:
        pa = _read_vec(fa.get("positionMmBodyLocal")) or (0, 0, 0)
        pb = _read_vec(fb.get("positionMmBodyLocal")) or (0, 0, 0)
        ax_a = _norm(_sub(pa, pb)) if pa != pb else (0.0, 0.0, -1.0)
        ax_b = _norm(_sub(pb, pa)) if pa != pb else (0.0, 0.0, 1.0)
        ay_a, az_a = _build_transverse_axes(ax_a, None)
        ay_b, az_b = _build_transverse_axes(ax_b, None)
        ap_a = float(fa.get("apertureMm", 0.005))
        ap_b = float(fb.get("apertureMm", 0.005))
        return [
            _anchor("tip_a", pa, ax_a, ay_a, az_a, ap_a, "circle"),
            _anchor("tip_b", pb, ax_b, ay_b, az_b, ap_b, "circle"),
        ]
    # Fallback synth from lengthM
    length_m = float((a.default_params or {}).get("lengthM", 1.0))
    length_mm = length_m * 1000.0
    return [
        _anchor("tip_a", (0, 0, -length_mm / 2), (0.0, 0.0, -1.0),
                (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), 0.005, "circle"),
        _anchor("tip_b", (0, 0, length_mm / 2), (0.0, 0.0, 1.0),
                (1.0, 0.0, 0.0), (0.0, -1.0, 0.0), 0.005, "circle"),
    ]


def build_anchors_for_asset(a: Asset3D) -> list[dict]:
    kind = a.kind_id
    if kind in SLAB_KINDS:
        return build_slab_anchors(a)
    if kind in MIRROR_KINDS:
        return build_mirror_anchors(a)
    if kind in CUBE_KINDS:
        return build_cube_anchors(a)
    if kind == "laser_source":
        return build_source_anchors(a)
    if kind == "aom":
        return build_aom_anchors(a)
    if kind == "fiber":
        return build_fiber_anchors(a)
    # rf_* and other non-trace kinds: leave anchors as-is
    return []


# ─── Main ──────────────────────────────────────────────────────────────────

async def backfill(session: AsyncSession, *, dry_run: bool = False) -> dict:
    rows = (
        await session.scalars(
            select(Asset3D).where(Asset3D.kind_id.isnot(None))
        )
    ).all()
    stats = {"updated": 0, "skipped": 0, "by_kind": {}}
    for a in rows:
        anchors = build_anchors_for_asset(a)
        kind = a.kind_id
        stats["by_kind"].setdefault(kind, 0)
        if not anchors:
            stats["skipped"] += 1
            continue
        if dry_run:
            print(f"  {a.catalog_id} ({kind}): would write {len(anchors)} "
                  f"anchors ({[x['id'] for x in anchors]})")
        else:
            await session.execute(
                text("UPDATE assets_3d SET anchors = CAST(:p AS JSONB) "
                     "WHERE id = :id"),
                {"p": json.dumps(anchors), "id": str(a.id)},
            )
        stats["updated"] += 1
        stats["by_kind"][kind] = stats["by_kind"].get(kind, 0) + 1
    if not dry_run:
        await session.commit()
    return stats


async def main():
    import sys
    dry = "--dry-run" in sys.argv
    async with AsyncSessionLocal() as s:
        stats = await backfill(s, dry_run=dry)
    print()
    print(f"Updated: {stats['updated']}, Skipped: {stats['skipped']}")
    print(f"By kind:")
    for k, n in sorted(stats["by_kind"].items()):
        print(f"  {k}: {n}")


if __name__ == "__main__":
    asyncio.run(main())
