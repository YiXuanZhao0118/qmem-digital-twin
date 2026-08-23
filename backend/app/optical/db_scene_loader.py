"""Load a V3Scene snapshot from the live DB.

The stateless `/api/v3/solver/run` endpoint expects the caller to ship a
complete V3Scene JSON in the request body. That is fine for unit tests
or external callers, but the Lab viewer + UI panels just want to "trace
the current scene" ??they shouldn't have to serialize the scene first.

This module reads SceneObject ??Component ??ComponentBinding ??Asset3D
rows and builds the V3Scene dataclass tree directly. SceneObjects whose
Asset3Ds lack v3 fields (kind_id / faces / transitions) are
skipped silently ??the v2-only objects can co-exist while migration
proceeds.

Dynamic sources (laser power, channel freq, etc.) are picked up from
SceneObject.properties for now (v2 location); when Phase 7 adds a
dedicated dynamic_sources column the lookup moves there.
"""

from __future__ import annotations

import dataclasses
import math

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Asset3D,
    Component,
    ComponentBinding,
    DeviceState,
    ObjectBinding,
    PhysicsElement,
    SceneObject,
)
from app.optical.anchor_tracer import (
    V3Anchor,
    V3AnchorBindingSlot,
    V3AnchorScene,
    V3AssetAnchorSnapshot,
)
from app.optical.beam_ray import Vec3
from app.optical.pose import (
    V3Pose,
    binding_pose_to_transform,
    compose_transforms,
    dir_body_to_lab_t,
    dir_lab_to_body_t,
    point_body_to_lab_t,
    point_lab_to_body_t,
    pose_to_transform,
)
from app.optical.rf_resolve import hydrate_aom_rf_drive


_DYNAMIC_KEYS = {
    "laserPowerMw", "powerMw", "centerWavelengthNm",
    "polarization", "spatialModeX", "spatialModeY",
    "transverseMode", "channels",
    "aomFreqMhz", "aomRfPowerDbm", "rfFrequencyMhz", "rfDrivePowerW",
    "beamProfile",
}


def _vec3(d: dict) -> Vec3:
    return Vec3(float(d["x"]), float(d["y"]), float(d["z"]))


def _extract_dynamic(properties: dict | None) -> dict | None:
    """Per-instance dynamic overrides the v3 ops read, from SceneObject.properties.

    Merges two sources:
      1. The laser beam the Object panel writes to ``opticalSources[0].beam``
         (V2 BeamSource shape), converted to the legacy kindParams shape the
         emit op reads (centerWavelengthNm / powerMw / spatialModeX/Y /
         polarization) via ``legacy_laser_kind_params_from_beam`` — so panel
         beam edits (waist, wavelength, polarization) actually reach the emit op.
         Without this, only ``powerMw`` round-tripped and waist/wavelength/pol
         silently fell back to the asset default_params.
      2. The whitelist of explicit top-level keys (AOM RF freq, RF channels,
         a manual ``spatialModeX`` override, …). These WIN over beam-derived.
    """
    # Local import avoids an import cycle with app.bindings at module load.
    from app.bindings import legacy_laser_kind_params_from_beam

    if not properties:
        return None
    out: dict = {}
    # (1) Laser beam → legacy dynamic keys the emit op reads.
    sources = properties.get("opticalSources")
    if isinstance(sources, list) and sources and isinstance(sources[0], dict):
        beam = sources[0].get("beam")
        if isinstance(beam, dict):
            legacy = legacy_laser_kind_params_from_beam(beam)
            power = legacy.get("nominalPowerMw")
            if isinstance(power, (int, float)):
                out["powerMw"] = float(power)
            for key in ("centerWavelengthNm", "spatialModeX", "spatialModeY", "polarization"):
                if key in legacy:
                    out[key] = legacy[key]
    # (2) Explicit top-level whitelist overrides (win over beam-derived).
    for key in _DYNAMIC_KEYS:
        if key in properties:
            out[key] = properties[key]
    return out or None


def _num_delta(value: float | None) -> float:
    return float(value) if value is not None else 0.0


def _binding_pose_with_override(
    binding: ComponentBinding,
    override: ObjectBinding | None,
) -> V3Pose:
    """ComponentBinding pose plus the per-SceneObject ObjectBinding delta.

    Mirrors frontend ``utils/componentBindings._effectiveTransform`` so
    the ray solver flattens composite assets exactly like SenseObject /
    PHY Editor rendering does.
    """
    return V3Pose(
        x_mm=binding.local_x_mm + _num_delta(override.local_x_mm_delta if override else None),
        y_mm=binding.local_y_mm + _num_delta(override.local_y_mm_delta if override else None),
        z_mm=binding.local_z_mm + _num_delta(override.local_z_mm_delta if override else None),
        rx_deg=binding.local_rx_deg + _num_delta(override.local_rx_deg_delta if override else None),
        ry_deg=binding.local_ry_deg + _num_delta(override.local_ry_deg_delta if override else None),
        rz_deg=binding.local_rz_deg + _num_delta(override.local_rz_deg_delta if override else None),
    )


def _binding_tree_transform(
    binding: ComponentBinding,
    binding_by_id: dict[object, ComponentBinding],
    override_by_binding_id: dict[object, ObjectBinding],
    memo: dict[object, object],
    visiting: set[object],
):
    """Effective Component-frame transform for one binding.

    ComponentBinding rows form a tree via ``parent_binding_id``. The
    renderer composes ``parent * child``; the backend solver must do the
    same or nested composite optics trace with the wrong coating normal.
    """
    binding_id = binding.id
    if binding_id in memo:
        return memo[binding_id]
    if binding_id in visiting:
        raise ValueError(f"cycle in ComponentBinding tree at {binding_id}")
    visiting.add(binding_id)

    local_transform = binding_pose_to_transform(
        _binding_pose_with_override(binding, override_by_binding_id.get(binding_id))
    )
    effective = local_transform
    if binding.parent_binding_id is not None:
        parent = binding_by_id.get(binding.parent_binding_id)
        if parent is not None:
            effective = compose_transforms(
                _binding_tree_transform(
                    parent, binding_by_id, override_by_binding_id, memo, visiting
                ),
                local_transform,
            )

    visiting.remove(binding_id)
    memo[binding_id] = effective
    return effective




# ??? Phase 9.2 ??anchor-centric scene loader ???????????????????????????????


def _anchor_from_dict(d: dict) -> V3Anchor:
    return V3Anchor(
        id=d["id"],
        position_body=_vec3(d["positionMmBodyLocal"]),
        axis_x_body=_vec3(d["axisXBodyLocal"]),
        axis_y_body=_vec3(d["axisYBodyLocal"]),
        axis_z_body=_vec3(d["axisZBodyLocal"]),
        aperture_mm=float(d.get("apertureMm", 0)),
        aperture_shape=d.get("apertureShape", "circle"),
    )


def _derive_aom_interaction_center(anchors: list[dict]) -> dict | None:
    """AOM stores intercept_in + intercept_out as the entry / exit faces.
    The Bragg interaction physics happens at the crystal midpoint, which
    is the midpoint of those two faces. Synthesize ``interaction_center``
    from that midpoint at load time so the tracer's primary-anchor hit
    test has a target without us storing a redundant anchor row.
    """
    in_a = next((a for a in anchors if a.get("id") == "intercept_in"), None)
    out_a = next((a for a in anchors if a.get("id") == "intercept_out"), None)
    if not in_a or not out_a:
        return None
    in_pos = in_a.get("positionMmBodyLocal") or {}
    out_pos = out_a.get("positionMmBodyLocal") or {}
    midpoint = {
        "x": (float(in_pos.get("x", 0)) + float(out_pos.get("x", 0))) / 2.0,
        "y": (float(in_pos.get("y", 0)) + float(out_pos.get("y", 0))) / 2.0,
        "z": (float(in_pos.get("z", 0)) + float(out_pos.get("z", 0))) / 2.0,
    }
    # Use intercept_in's tri-axis frame for the synthetic anchor ??both
    # face the same way along the optical axis so the basis is shared.
    return {
        "id": "interaction_center",
        "positionMmBodyLocal": midpoint,
        "axisXBodyLocal": in_a["axisXBodyLocal"],
        "axisYBodyLocal": in_a["axisYBodyLocal"],
        "axisZBodyLocal": in_a["axisZBodyLocal"],
        "apertureMm": in_a.get("apertureMm", 0),
        "apertureShape": in_a.get("apertureShape", "circle"),
    }



def anchor_asset_to_snapshot(asset: Asset3D) -> V3AssetAnchorSnapshot | None:
    """Build the anchor-centric snapshot from Asset3D, or None if no
    anchors are populated yet (Phase 9.1 backfill not run for this row).

    Anchors are stored directly in Asset/CAD-local coordinates, ready to
    compose with ComponentBinding and SceneObject poses.
    """
    if not asset.kind_id:
        return None
    anchors = list(asset.anchors or [])
    if not anchors:
        return None
    # Only accept the NEW schema (anchors with axisX/Y/Z). Legacy v2
    # anchors (intercept_in / etc. without tri-axis) are ignored.
    if not isinstance(anchors[0], dict) or "axisXBodyLocal" not in anchors[0]:
        return None
    # AOM: derive interaction_center from intercept_in/out midpoint when
    # missing. The stored data only carries the boundary faces; the
    # tracer's primary-anchor hit test needs interaction_center to fire
    # the Bragg op.
    if asset.kind_id == "aom" and not any(
        a.get("id") == "interaction_center" for a in anchors
    ):
        synth = _derive_aom_interaction_center(anchors)
        if synth is not None:
            anchors.append(synth)
    return V3AssetAnchorSnapshot(
        catalog_id=asset.catalog_id or asset.name,
        kind=asset.kind_id,
        anchors=[_anchor_from_dict(a) for a in anchors],
        default_params=asset.default_params or {},
    )


# Fallback ferrule length used ONLY when the bound connector asset doesn't
# expose connect_in/connect_out. Normally the tip offset (junction → optical
# face) is read from the connector asset's `connect_in` position so the fiber
# coupling face = the connect_in the user defines on the asset (see
# `_connector_tip_and_aperture`). 36.28 mm matches the Thorlabs FC 30126A9
# housing (frontend `utils/fiberAnchorResolver.ts:32`).
FIBER_FERRULE_TIP_MM = 36.28


def _cross(a: Vec3, b: Vec3) -> Vec3:
    return Vec3(
        a.y * b.z - a.z * b.y,
        a.z * b.x - a.x * b.z,
        a.x * b.y - a.y * b.x,
    )


def _ortho_basis(axis_x: Vec3) -> tuple[Vec3, Vec3]:
    """An arbitrary orthonormal (axisY, axisZ) perpendicular to axis_x. The
    fiber op only uses r = √(off_y²+off_z²) (rotation-invariant), so any
    perpendicular basis is fine for the coupling hit/offset math."""
    ref = Vec3(0.0, 0.0, 1.0) if abs(axis_x.z) < 0.9 else Vec3(0.0, 1.0, 0.0)
    ay = _cross(axis_x, ref).normalized()
    az = _cross(axis_x, ay)
    return ay, az


def _slow_axis_basis(outward: Vec3, slow_axis_deg: float) -> tuple[Vec3, Vec3]:
    """(axisY, axisZ) for a fibre end, with **axisY on the PM slow axis**.

    ``_ortho_basis`` gives a deterministic but otherwise arbitrary transverse
    reference; the connector key angle (``endX.slowAxisDegInBodyFrame``, the
    number the Object panel's per-end editor writes and the viewer draws the
    key along) rotates axisY around the ferrule axis from it. The coupling
    maths only ever used r = √(off_y²+off_z²), which is rotation-invariant —
    so this changes no geometry, it only gives ``fiber_anchor_op`` an axis to
    resolve polarization against.

    Caveat: the ZERO of that angle is this function's ``_ortho_basis``
    reference, which has not been reconciled with the frontend's ferrule
    orientation. The angle BETWEEN two ends (the twist of a patch cord) and
    the angle between an end and another element's axisY are therefore what
    to trust; the absolute number against the drawn key mark is not verified.
    """
    ay0, az0 = _ortho_basis(outward)
    a = math.radians(slow_axis_deg)
    c, sn = math.cos(a), math.sin(a)
    ay = Vec3(
        ay0.x * c + az0.x * sn,
        ay0.y * c + az0.y * sn,
        ay0.z * c + az0.z * sn,
    ).normalized()
    return ay, _cross(outward, ay)


# A cable-end connector owns two geometric anchors: the MATING FACE (the
# ferrule / pin end that goes into a socket) and the CABLE ROOT (the spline
# junction inside the jacket, where the endpoint node pins).
#
# Two spellings are live and both must be accepted (2026-08-23):
#   * fibre  — ``fiber_out`` / ``fiber_root``, renamed by alembic 0135 so the
#     whole fibre vocabulary reads from the FIBRE's point of view:
#     ``fiber_in`` is where a fibre goes into an instrument, ``fiber_out``
#     where it comes out of its own connector, ``fiber_root`` where it is
#     anchored into the cable.
#   * coax — ``connect_in`` / ``connect_out``, unchanged. The rename was
#     deliberately scoped to fibre, and ``fiber_*`` would be a lie on an SMA.
#
# NOTE ``fiber_out`` is NOT in ``anchor_tracer.PRIMARY_ANCHOR_IDS`` — same as
# ``connect_in`` never was. It belongs to the connector, which is passthrough;
# the traced coupling happens on the SYNTHESIZED ``intercept_in/out`` that
# ``_synth_fiber_slot`` derives from it. Making it primary would put two
# hit-testable anchors at the same point.
_MATING_FACE_IDS = ("fiber_out", "connect_in")
_CABLE_ROOT_IDS = ("fiber_root", "connect_out")


def _find_anchor(anchors, ids: tuple[str, ...]) -> dict | None:
    for wanted in ids:
        for a in anchors or []:
            if isinstance(a, dict) and a.get("id") == wanted:
                return a
    return None


async def _port_connector_anchors(
    session: AsyncSession,
    snap,
    effective,
    binding_rows: list,
    binding_by_id: dict,
    override_by_binding_id: dict,
    memo: dict,
    so_transform,
):
    """Re-seat a device's optical ports onto the FIBER CONNECTORS bound at them.

    A pigtailed instrument (the EOSpace EOM is the first) does not really have
    a bare optical face — it has an FC/APC bulkhead you mate a patch cord to.
    Model that the way the hardware is built: bind a ``fiber_connector`` asset
    at each port in the Component, tag the binding
    ``properties.portAnchor = "intercept_in" | "intercept_out"``, and this
    turns that connector's ``connect_in`` into the port.

    Why it has to be a derivation and not just a rename: ``connect_in`` /
    ``connect_out`` are NOT in ``anchor_tracer.PRIMARY_ANCHOR_IDS``, so the
    tracer can never hit them — a port made only of connector anchors would
    pass light straight through. ``exposedFaces`` cannot help either; it is
    stored and drawn by the PHY Editor but no loader or tracer reads it. So
    the physics anchor stays ``intercept_in`` / ``intercept_out`` on the body,
    and the connector supplies its numbers. Same move ``_synth_fiber_slot``
    makes for a patch cord, one level up.

    What the connector defines, all of it live and per-binding:
      * **position** — the port face lands exactly on ``connect_in``, so
        rotating or sliding the connector binding moves the coupling face.
      * **aperture** — ``connect_in.apertureMm``.
      * **axisY** — the PM slow-axis key. For a pigtailed modulator that IS
        the TM axis the waveguide guides (the factory aligns the pigtail's
        PM axis to the crystal), so rotating the connector in its adapter
        rotates what polarization the device accepts — which is the physical
        adjustment, and now the modelled one.

    What it deliberately does NOT define: the port's **direction**. axisX
    keeps the sense the device authored (the connector's mating normal is
    flipped to agree with it), because that is what the op reads to decide
    which way light leaves — an input bulkhead faces backwards up the beam
    and would otherwise reverse the exit. Scalars like ``coreMfdUm`` also
    stay on the device: they describe its pigtail, and the two ports would
    disagree.
    """
    ports: dict[str, tuple[object, Asset3D]] = {}
    for b in binding_rows:
        props = b.properties or {}
        target = props.get("portAnchor")
        if b.target_kind != "asset" or not isinstance(target, str):
            continue
        override = override_by_binding_id.get(b.id)
        asset_id = (
            override.asset_3d_id_override
            if override is not None and override.asset_3d_id_override is not None
            else b.asset_3d_id
        )
        if not asset_id:
            continue
        conn = await session.get(Asset3D, asset_id)
        if conn is not None and conn.kind_id == "fiber_connector":
            ports[target] = (b, conn)
    if not ports:
        return snap

    rebuilt = []
    for anchor in snap.anchors:
        entry = ports.get(anchor.id)
        if entry is None:
            rebuilt.append(anchor)
            continue
        b, conn = entry
        c_in = _find_anchor(conn.anchors, _MATING_FACE_IDS)
        if c_in is None:
            rebuilt.append(anchor)
            continue
        t_conn = compose_transforms(
            so_transform,
            _binding_tree_transform(
                b, binding_by_id, override_by_binding_id, memo, set()
            ),
        )

        def _v(raw, fallback: Vec3) -> Vec3:
            if isinstance(raw, dict):
                return Vec3(float(raw.get("x", 0.0)), float(raw.get("y", 0.0)),
                            float(raw.get("z", 0.0)))
            return fallback

        # connector-local → lab → this device asset's own frame.
        def _to_device_point(raw, fallback):
            return point_lab_to_body_t(
                point_body_to_lab_t(_v(raw, fallback), t_conn), effective
            )

        def _to_device_dir(raw, fallback):
            return dir_lab_to_body_t(
                dir_body_to_lab_t(_v(raw, fallback), t_conn), effective
            ).normalized()

        pos = _to_device_point(c_in.get("positionMmBodyLocal"), anchor.position_body)
        ax = _to_device_dir(c_in.get("axisXBodyLocal"), anchor.axis_x_body)
        ay = _to_device_dir(c_in.get("axisYBodyLocal"), anchor.axis_y_body)
        # Keep the device's own sense of "which way is out" (see docstring).
        if ax.dot(anchor.axis_x_body) < 0.0:
            ax = ax * -1.0
        # Gram-Schmidt: the mating normal and the key axis need not be exactly
        # orthogonal once both have been through two frame hops.
        ay = (ay - ax * ay.dot(ax))
        ay = ay.normalized() if ay.length() > 1e-9 else _ortho_basis(ax)[0]
        ap = c_in.get("apertureMm")
        rebuilt.append(V3Anchor(
            id=anchor.id,
            position_body=pos,
            axis_x_body=ax,
            axis_y_body=ay,
            axis_z_body=_cross(ax, ay),
            aperture_mm=(float(ap) if isinstance(ap, (int, float)) and ap > 0
                         else anchor.aperture_mm),
            aperture_shape=anchor.aperture_shape,
        ))
    return dataclasses.replace(snap, anchors=rebuilt)


def _connector_tip_and_aperture(
    connector_asset: Asset3D | None,
    fallback_tip_mm: float,
    fallback_aperture_mm: float,
) -> tuple[float, float]:
    """Read the optical-face offset + hit aperture from the bound connector
    asset's `connect_in` anchor — the single asset-side definition of the
    fiber's coupling face (= where the beam waist sits) and acceptance window.

    Both are user-editable in the ASSET3D anchor editor:
      * tip_mm   = |connect_in − connect_out| (junction → ferrule face). The
                   synthesized intercept port lands exactly on connect_in, so
                   moving connect_in on the asset moves the optical face.
      * aperture = connect_in.apertureMm (whether the beam centre counts as
                   entering the fiber; η then falls off via Marcuse overlap).
    Falls back to the FC housing length / the fiber end's apertureDiameterMm
    when the connector or its anchors are missing."""
    tip_mm, aperture_mm = fallback_tip_mm, fallback_aperture_mm
    if connector_asset is None:
        return tip_mm, aperture_mm
    anchors = connector_asset.anchors or []
    c_in = _find_anchor(anchors, _MATING_FACE_IDS)
    c_out = _find_anchor(anchors, _CABLE_ROOT_IDS)
    if c_in is not None:
        ap = c_in.get("apertureMm")
        if isinstance(ap, (int, float)) and ap > 0:
            aperture_mm = float(ap)
        p_in = c_in.get("positionMmBodyLocal") or {}
        p_out = (c_out or {}).get("positionMmBodyLocal") or {}
        try:
            dx = float(p_in.get("x", 0.0)) - float(p_out.get("x", 0.0))
            dy = float(p_in.get("y", 0.0)) - float(p_out.get("y", 0.0))
            dz = float(p_in.get("z", 0.0)) - float(p_out.get("z", 0.0))
            d = (dx * dx + dy * dy + dz * dz) ** 0.5
            if d > 1e-6:
                tip_mm = d
        except (TypeError, ValueError):
            pass
    return tip_mm, aperture_mm


def _spline_length_m(properties: dict | None) -> float:
    """Fiber length (m) for Beer-Lambert attenuation, summed from the
    per-instance spline node positions when present; else 1.0 m (a short
    patch — attenuation is negligible either way)."""
    nodes = (properties or {}).get("fiberNodes") if isinstance(properties, dict) else None
    if not isinstance(nodes, list) or len(nodes) < 2:
        return 1.0
    total_mm = 0.0
    prev = None
    for n in nodes:
        p = n.get("posMm") if isinstance(n, dict) else None
        if not (isinstance(p, list) and len(p) == 3):
            return 1.0
        cur = Vec3(float(p[0]), float(p[1]), float(p[2]))
        if prev is not None:
            total_mm += (cur - prev).length()
        prev = cur
    return total_mm / 1000.0 if total_mm > 0 else 1.0


async def _synth_fiber_slot(
    session: AsyncSession,
    so: SceneObject,
    pe: PhysicsElement,
    binding_rows: list,
    override_by_binding_id: dict,
    so_transform,
) -> V3AnchorBindingSlot | None:
    """Synthesize the kind="fiber" optical slot for a connector-component
    fiber so the v3 tracer can couple light through it.

    The bound `fiber_connector` assets are passthrough (connect_in/out aren't
    PRIMARY_ANCHOR_IDS), so the fiber's optical ports live ONLY on the fiber
    PhysicsElement's kindParams.endA/endB (the per-instance pose Align writes).
    This builds an intercept_in (endA) + intercept_out (endB) anchor pair from
    that pose so `fiber_anchor_op` fires. Returns None when endA/endB lack the
    posMm + tensionHandleMm needed to place the ports.
    """
    kp = pe.kind_params or {}
    end_a = kp.get("endA") if isinstance(kp.get("endA"), dict) else None
    end_b = kp.get("endB") if isinstance(kp.get("endB"), dict) else None
    if not end_a or not end_b:
        return None

    # Resolve each end's connector asset (for the editable hit aperture),
    # matched by binding splineEnd / role.
    async def _connector_asset(end_letter: str) -> Asset3D | None:
        for b in binding_rows:
            if b.target_kind != "asset":
                continue
            props = b.properties or {}
            role = b.role or ""
            if props.get("splineEnd") == end_letter or role == f"end_{end_letter.lower()}":
                override = override_by_binding_id.get(b.id)
                asset_id = (
                    override.asset_3d_id_override
                    if override is not None and override.asset_3d_id_override is not None
                    else b.asset_3d_id
                )
                return await session.get(Asset3D, asset_id) if asset_id else None
        return None

    def _vec_or_none(v):
        if not (isinstance(v, list) and len(v) == 3):
            return None
        try:
            return Vec3(float(v[0]), float(v[1]), float(v[2]))
        except (TypeError, ValueError):
            return None

    def _make_anchor(anchor_id: str, end: dict, ap_mm: float, tip_mm: float) -> V3Anchor | None:
        pos = _vec_or_none(end.get("posMm"))
        tau = _vec_or_none(end.get("tensionHandleMm"))
        if pos is None or tau is None or tau.length() < 1e-9:
            return None
        outward = tau.normalized() * -1.0   # ferrule faces away from wire
        tip = pos + outward * tip_mm        # junction → optical face (= connect_in)
        raw_slow = end.get("slowAxisDegInBodyFrame")
        ay, az = _slow_axis_basis(
            outward,
            float(raw_slow) if isinstance(raw_slow, (int, float)) else 0.0,
        )
        return V3Anchor(
            id=anchor_id,
            position_body=tip,
            axis_x_body=outward,
            axis_y_body=ay,
            axis_z_body=az,
            aperture_mm=ap_mm,
            aperture_shape="circle",
        )

    tip_a, ap_a = _connector_tip_and_aperture(
        await _connector_asset("A"),
        FIBER_FERRULE_TIP_MM, float(end_a.get("apertureDiameterMm", 0.125)),
    )
    tip_b, ap_b = _connector_tip_and_aperture(
        await _connector_asset("B"),
        FIBER_FERRULE_TIP_MM, float(end_b.get("apertureDiameterMm", 0.125)),
    )
    in_anchor = _make_anchor("intercept_in", end_a, ap_a, tip_a)
    out_anchor = _make_anchor("intercept_out", end_b, ap_b, tip_b)
    if in_anchor is None or out_anchor is None:
        return None

    # Map the fiber PE kindParams to the keys fiber_anchor_op reads via
    # ctx.params (= snapshot.default_params here — no dynamic_sources merge
    # needed for the synthetic slot). Note the key rename
    # glassIndexAtDesignLambda → coreRefractiveIndex.
    atten = kp.get("attenuationCurve")
    atten_db_km = 4.0
    if isinstance(atten, list) and atten and isinstance(atten[0], dict):
        atten_db_km = float(atten[0].get("dbPerKm", 4.0))
    default_params = {
        "coreMfdUm": float(end_a.get("modeFieldDiameterUm", 5.3)),
        "numericalAperture": float(end_a.get("numericalAperture", 0.13)),
        "coreRefractiveIndex": float(end_a.get("glassIndexAtDesignLambda", 1.46)),
        "attenuationDbPerKm": atten_db_km,
        "lengthM": _spline_length_m(so.properties),
        # Polarization: which axis pair the op resolves against is carried by
        # the anchors' axisY above; these two say whether it should bother.
        "fiberType": str(kp.get("fiberType", "single_mode")),
        "polarizationExtinctionRatioDb": float(
            kp.get("polarizationExtinctionRatioDb", 25.0)
        ),
    }

    return V3AnchorBindingSlot(
        scene_object_id=str(so.id),
        binding_id="fiber_body",
        asset=V3AssetAnchorSnapshot(
            catalog_id="fiber",
            kind="fiber",
            anchors=[in_anchor, out_anchor],
            default_params=default_params,
        ),
        effective_transform=so_transform,
        dynamic_sources=None,
        powered_on=True,
    )


async def load_anchor_scene_from_component(
    session: AsyncSession,
    component_id: object,
) -> V3AnchorScene:
    """Build an anchor scene from ONE Component's bindings, in COMPONENT
    frame (no SceneObject pose).

    Powers the PHY Editor COMPONENT preview's probe-beam trace: the
    assembly is traced by the SAME live engine as the Lab (same anchor ops,
    same binding-tree pose math) but without placing the component in the
    scene. ``effective_transform`` is the binding-tree transform ALONE
    (identity SceneObject pose), so the returned segments live in the
    component frame the preview renders in, and per-asset Jones/polarization
    reflects the authoritative physics — including the Faraday rotator.

    Unlike ``load_anchor_scene_from_db`` there is no SceneObject, so: no
    ObjectBinding deltas, no per-instance dynamic_sources, no RF cable
    resolution, no power-panel gating (everything powered on). The probe
    ray is supplied by the caller as an initial ray.
    """
    comp = await session.get(Component, component_id)
    if comp is None:
        return V3AnchorScene(slots=[])
    binding_rows = (await session.scalars(
        select(ComponentBinding).where(ComponentBinding.component_id == comp.id)
    )).all()
    binding_by_id = {b.id: b for b in binding_rows}
    memo: dict[object, object] = {}
    slots: list[V3AnchorBindingSlot] = []
    for b in binding_rows:
        if b.target_kind != "asset" or not b.asset_3d_id:
            continue
        asset_row = await session.get(Asset3D, b.asset_3d_id)
        if asset_row is None:
            continue
        snap = anchor_asset_to_snapshot(asset_row)
        if snap is None:
            continue
        # Binding-tree transform only (no so_transform): component frame.
        effective = _binding_tree_transform(b, binding_by_id, {}, memo, set())
        slots.append(V3AnchorBindingSlot(
            scene_object_id=f"preview:{comp.id}",
            binding_id=b.role or str(b.id),
            asset=snap,
            effective_transform=effective,
            dynamic_sources=None,
            powered_on=True,
        ))
    return V3AnchorScene(slots=slots)


async def load_anchor_scene_from_db(
    session: AsyncSession,
    dynamic_overrides: dict[str, dict] | None = None,
    scrub_time_ns: float | None = None,
) -> V3AnchorScene:
    """Walk SceneObjects and flatten to V3AnchorBindingSlot list (anchor-centric).

    Mirrors ``load_scene_from_db`` but emits the new anchor-based scene
    structure consumed by ``trace_ray_anchor_scene``.

    Each AOM's effective RF drive (aomFreqMhz / rfDrivePowerW) is resolved
    server-side from the RF cable graph via ``hydrate_aom_rf_drive`` — sampled at
    ``scrub_time_ns`` (None = the "scrub stopped" rest snapshot). ``dynamic_overrides``
    maps SceneObject id -> dynamic-key dict and is merged LAST (after the resolved
    RF drive) so a manual / test override still wins.
    """
    dynamic_overrides = dynamic_overrides or {}
    so_rows = (await session.scalars(select(SceneObject))).all()
    slots: list[V3AnchorBindingSlot] = []

    # PhysicsElements (one per SceneObject) — keyed by object_id. Needed to
    # synthesize the fiber optical slot from the fiber PE's kindParams.endA/endB
    # (the connector-component fiber's ports live there, not on a fiber Asset3D).
    pe_by_object_id = {
        pe.object_id: pe
        for pe in (await session.scalars(select(PhysicsElement))).all()
    }

    # Resolve each AOM's RF drive from the cable graph (rf_source -> amp ->
    # switch -> aom rf_in), time-sampled at scrub_time_ns. Keyed by AOM
    # SceneObject id; merged onto the AOM slot's dynamic below.
    rf_drive = await hydrate_aom_rf_drive(session, scrub_time_ns)

    # Instrument power panel: objects whose device_states.state.power is False
    # are powered off. Emitters skip those slots (no beam / no ASE on power-off).
    ds_rows = (await session.scalars(select(DeviceState))).all()
    powered_off_ids = {
        ds.object_id for ds in ds_rows
        if isinstance(ds.state, dict) and ds.state.get("power") is False
    }

    for so in so_rows:
        if not so.component_id:
            continue
        comp = await session.get(Component, so.component_id)
        if comp is None:
            continue

        powered_on = so.id not in powered_off_ids
        # Per-emission presentation overrides (Visualization card). Only
        # `visible` is honoured server-side — a hidden emission is not emitted
        # at all, so downstream optics stop reflecting it.
        emission_visuals = (
            so.properties.get("emissionVisuals")
            if isinstance(so.properties, dict) else None
        )

        binding_rows = (await session.scalars(
            select(ComponentBinding).where(ComponentBinding.component_id == comp.id)
        )).all()
        binding_by_id = {b.id: b for b in binding_rows}
        object_binding_rows = (await session.scalars(
            select(ObjectBinding).where(ObjectBinding.object_id == so.id)
        )).all()
        override_by_binding_id = {
            ob.component_binding_id: ob for ob in object_binding_rows
        }
        binding_transform_memo: dict[object, object] = {}

        so_transform = pose_to_transform(V3Pose(
            x_mm=so.x_mm, y_mm=so.y_mm, z_mm=so.z_mm,
            rx_deg=so.rx_deg, ry_deg=so.ry_deg, rz_deg=so.rz_deg,
        ))

        for b in binding_rows:
            override = override_by_binding_id.get(b.id)
            asset_id = (
                override.asset_3d_id_override
                if override is not None and override.asset_3d_id_override is not None
                else b.asset_3d_id
            )
            if b.target_kind != "asset" or not asset_id:
                continue
            asset_row = await session.get(Asset3D, asset_id)
            if asset_row is None:
                continue
            snap = anchor_asset_to_snapshot(asset_row)
            if snap is None:
                continue

            # Binding pose uses RAW XYZ and must include the whole parent
            # binding chain (plus ObjectBinding deltas), matching the
            # frontend binding-tree renderer. IO-3-850-HP's back Glan lives
            # under a rotated parent; using only the leaf binding flips the
            # reflected branch to the wrong quadrant.
            local_transform = _binding_tree_transform(
                b,
                binding_by_id,
                override_by_binding_id,
                binding_transform_memo,
                set(),
            )
            effective = compose_transforms(so_transform, local_transform)

            binding_id = b.role or str(b.id)
            dyn = _extract_dynamic(so.properties)
            # Per-instance tunable values (SceneObject.dynamic_sources column,
            # alembic 0113). The asset author marks which default_params keys are
            # tunable (Asset3D.tunable_params); the SceneObject editor writes
            # those values here, and they merge on top of the asset defaults so
            # the anchor tracer's {**default_params, **dynamic_sources} merge
            # picks them up with no per-kind backend code. Object-scoped (not
            # per-binding), which suits the single-asset source components
            # (laser / rf_source) that actually carry tunable params.
            if isinstance(so.dynamic_sources, dict) and so.dynamic_sources:
                dyn = {**(dyn or {}), **so.dynamic_sources}
            # Enforce the tunable contract: a per-instance value may override a
            # default_params key ONLY if the asset marks it tunable. Drop every
            # other asset-param key from the per-instance bag so NON-tunable
            # params always track the asset — legacy laser-beam snapshots (in
            # SceneObject.properties.opticalSources or a dormant dynamic_sources
            # column written by the old write_laser_dynamic_sources path) no
            # longer shadow asset edits. Keys that aren't asset params at all
            # (aomFreqMhz, channels, … runtime coupling) pass through untouched.
            if dyn:
                asset_defaults = asset_row.default_params or {}
                tunable = set(asset_row.tunable_params or [])
                dyn = {
                    k: v for k, v in dyn.items()
                    if k not in asset_defaults or k in tunable
                }
            # Server-resolved AOM RF drive (RF cable graph) wins over asset
            # defaults / dynamic_sources; a request dynamic_override still wins
            # over it (manual / test escape hatch).
            rf = rf_drive.get(str(so.id))
            if rf:
                dyn = {**(dyn or {}), **rf}
            ov = dynamic_overrides.get(str(so.id))
            if ov:
                dyn = {**(dyn or {}), **ov}
            # A pigtailed device's ports are the fibre connectors bound at
            # them (Component binding properties.portAnchor) — see
            # _port_connector_anchors. No-op for everything else.
            if snap.kind != "fiber_connector":
                snap = await _port_connector_anchors(
                    session, snap, effective, binding_rows, binding_by_id,
                    override_by_binding_id, binding_transform_memo, so_transform,
                )
            slots.append(V3AnchorBindingSlot(
                scene_object_id=str(so.id),
                binding_id=binding_id,
                asset=snap,
                effective_transform=effective,
                dynamic_sources=dyn,
                powered_on=powered_on,
                emission_visuals=(
                    emission_visuals if isinstance(emission_visuals, dict) else None
                ),
            ))

        # Connector-component fiber: the bound fiber_connector assets are
        # passthrough, so synthesize the kind="fiber" optical slot (intercept_in
        # /out from the fiber PE's kindParams.endA/endB) — otherwise the beam
        # passes straight through with no Marcuse coupling. The connector
        # passthrough slots above stay (harmless: connect_* aren't primary).
        if comp.kind_id == "fiber":
            fiber_pe = pe_by_object_id.get(so.id)
            if fiber_pe is not None and fiber_pe.element_kind == "fiber":
                fiber_slot = await _synth_fiber_slot(
                    session, so, fiber_pe, binding_rows,
                    override_by_binding_id, so_transform,
                )
                if fiber_slot is not None:
                    slots.append(fiber_slot)

    return V3AnchorScene(slots=slots)
