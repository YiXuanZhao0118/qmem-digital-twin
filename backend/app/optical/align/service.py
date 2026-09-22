"""Align endpoints' orchestration: DB rows -> the pure ports -> JSON.

What the web app does in React around the pure TS functions — which anchor
is the mirror face, where a pass-through optic's align point is, which
(point, direction) an optic aligns by, which order / frequency an AOM is
Bragg-aligned for — is done here, following the TS call sites line for line
(``components/optical/MirrorCouplingPanel.tsx`` and
``components/physics/AlignToBeamControls.tsx``), so a second client gets the
same answer without re-implementing any of it.

Everything is compute-only. Each ``*_align`` function takes an
:class:`AlignScene` (loaded once per request by :func:`load_align_scene`) and
returns plain JSON; bad input raises :class:`AlignError` with the HTTP status
the router should answer with.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Asset3D, Component, ComponentBinding, ObjectBinding, SceneObject
from app.optical.align.anchor_poses import (
    AlignScene,
    anchor_primary_dir,
    object_pose,
    resolve_anchor_poses_lab,
    resolve_binding_tree,
)
from app.optical.align.aom_bragg import (
    aom_bragg_readout,
    bragg_tilt_rad,
    compute_aom_bragg_align_pose,
    compute_aom_tilt_nudge_pose,
    resolve_aom_bragg_frame,
)
from app.optical.align.mirror_coupling import (
    DEFAULT_MIRROR_APERTURE_MM,
    MIRROR_FACE_ANCHOR_ID,
    MirrorFacts,
    Ray,
    SolveError,
    check_mirror_touch,
    plan_mirror_coupling,
)
from app.optical.align.point_dir import (
    RoleCentre,
    collect_role_centres,
    compute_point_dir_align_pose,
    compute_translate_only_pose,
    pick_polariser_centre,
)
from app.optical.align.ts_compat import V, js_num, js_round, read_xyz, to_json, v_neg
from app.optical.kinds.aom.physics import bragg_angle_rad
from app.optical.rf_resolve import RfInputs, port_key, rf_snapshot_at


class AlignError(Exception):
    """A request the solver cannot answer; ``status`` is the HTTP code."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


async def load_align_scene(session: AsyncSession) -> AlignScene:
    """One read of the scene slice the align solvers need (SELECTs only).

    Bindings come in ``GET /api/scene`` order (component, ``sort_order``, then
    ``created_at``) and archived Components are left out, as the snapshot the
    web app works from leaves them out."""
    objects = (await session.scalars(select(SceneObject))).all()
    components = (await session.scalars(
        select(Component).where(Component.archived_at.is_(None))
    )).all()
    bindings = (await session.scalars(
        select(ComponentBinding).order_by(
            ComponentBinding.component_id,
            ComponentBinding.sort_order,
            ComponentBinding.created_at,
        )
    )).all()
    object_bindings = (await session.scalars(select(ObjectBinding))).all()
    assets = (await session.scalars(select(Asset3D))).all()

    by_component: dict[str, list[Any]] = {}
    for b in bindings:
        by_component.setdefault(str(b.component_id), []).append(b)
    ob_by_object: dict[str, dict[Any, Any]] = {}
    for ob in object_bindings:
        ob_by_object.setdefault(str(ob.object_id), {})[ob.component_binding_id] = ob
    return AlignScene(
        objects={str(o.id): o for o in objects},
        components={str(c.id): c for c in components},
        bindings_by_component=by_component,
        object_bindings=ob_by_object,
        assets={str(a.id): a for a in assets},
    )


# ─── shared lookups ────────────────────────────────────────────────────────

def _object(scene: AlignScene, object_id: str) -> Any:
    so = scene.objects.get(object_id)
    if so is None:
        raise AlignError(404, f"SceneObject {object_id} not found.")
    return so


def _component(scene: AlignScene, so: Any) -> Any:
    comp = scene.component_of(so)
    if comp is None:
        raise AlignError(422, f"{so.name}: Component row not in the scene store.")
    return comp


def _props(so: Any) -> dict:
    return so.properties if isinstance(so.properties, dict) else {}


def _vec3_from_array(a: Any) -> V | None:
    """``AlignToBeamControls.vec3FromArray``: exactly 3 finite numbers."""
    if isinstance(a, list) and len(a) == 3 and all(
        isinstance(n, (int, float)) and not isinstance(n, bool) and math.isfinite(n) for n in a
    ):
        return V(float(a[0]), float(a[1]), float(a[2]))
    return None


def _align_spec(comp: Any) -> dict:
    props = comp.properties if isinstance(comp.properties, dict) else {}
    spec = props.get("alignSpec")
    return spec if isinstance(spec, dict) else {}


def _reverse_and_roll(so: Any, reverse: bool | None, roll_deg: float | None) -> tuple[bool, float]:
    """The per-object align choices the Object panel persists
    (``properties.alignReverse`` / ``alignRollDeg``); a request value wins."""
    props = _props(so)
    rev = reverse if reverse is not None else props.get("alignReverse") is True
    stored_roll = props.get("alignRollDeg")
    roll = roll_deg if roll_deg is not None else (
        float(stored_roll)
        if isinstance(stored_roll, (int, float)) and not isinstance(stored_roll, bool)
        else 0.0
    )
    return rev, roll


# ─── mirror coupling ───────────────────────────────────────────────────────

# MirrorCouplingPanel.tsx: the kinds it steers with, and the anchors that can
# be a destination (a face light goes INTO; intercept_out is an exit face).
STEERING_KINDS = frozenset({"mirror", "dichroic_mirror"})
TARGET_ANCHOR_IDS = ("intercept_in", "fiber_in", "seed")


def mirror_facts_from_object(scene: AlignScene, so: Any) -> MirrorFacts:
    """TS ``mirrorFactsFromObject``, raising instead of returning ``{error}``."""
    comp = _component(scene, so)
    face = next(
        (a for a in resolve_anchor_poses_lab(scene, comp, so) if a.anchor_id == MIRROR_FACE_ANCHOR_ID),
        None,
    )
    if face is None:
        raise AlignError(422, f"{so.name}: no `{MIRROR_FACE_ANCHOR_ID}` anchor in its binding tree.")
    if face.axis_x_lab is None or face.axis_x_cad is None:
        raise AlignError(
            422,
            f"{so.name}: `{MIRROR_FACE_ANCHOR_ID}` declares no direction. "
            "Set the face normal (axisX) in PHY Editor -> Optical.",
        )
    return MirrorFacts(
        object_id=str(so.id),
        name=so.name,
        scene_object=object_pose(so),
        centre_cad=face.pos_cad,
        normal_cad=face.axis_x_cad,
        centre_lab=face.pos_lab,
        normal_lab=face.axis_x_lab,
        aperture_mm=face.aperture_mm if face.aperture_mm is not None else DEFAULT_MIRROR_APERTURE_MM,
    )


def _pass_through_align_point_cad(scene: AlignScene, comp: Any, so: Any) -> V | None:
    """``MirrorCouplingPanel.passThroughAlignPointCad``: alignSpec.pointMm,
    else the entry anchor (intercept_in, intercept_face, else the first)."""
    p = _align_spec(comp).get("pointMm")
    if isinstance(p, list) and len(p) == 3 and all(
        isinstance(n, (int, float)) and not isinstance(n, bool) for n in p
    ):
        return V(float(p[0]), float(p[1]), float(p[2]))
    anchors = resolve_anchor_poses_lab(scene, comp, so)
    hit = (
        next((a for a in anchors if a.anchor_id == "intercept_in"), None)
        or next((a for a in anchors if a.anchor_id == "intercept_face"), None)
        or (anchors[0] if anchors else None)
    )
    return hit.pos_cad if hit is not None else None


def _mirror_out(m: MirrorFacts, locked: bool) -> dict:
    return {
        "objectId": m.object_id,
        "name": m.name,
        "locked": locked,
        "centreCad": to_json(m.centre_cad),
        "normalCad": to_json(m.normal_cad),
        "centreLab": to_json(m.centre_lab),
        "normalLab": to_json(m.normal_lab),
        "apertureMm": m.aperture_mm,
    }


def mirror_coupling_align(
    scene: AlignScene,
    *,
    mirror_a_id: str,
    mirror_b_id: str,
    in_ray: Ray,
    target_object_id: str,
    target_anchor_id: str,
    target_anchor_name: str | None = None,
    fold_mm: float | None = None,
    pass_through_object_ids: list[str] | tuple[str, ...] = (),
) -> dict:
    """Solve the two-mirror coupling for a seed ray arriving at mirror A and a
    destination anchor, exactly as ``MirrorCouplingPanel`` does once the user
    has picked the seed and the target."""
    if mirror_a_id == mirror_b_id:
        raise AlignError(422, "Mirror A and mirror B must be two different objects.")
    so_a = _object(scene, mirror_a_id)
    so_b = _object(scene, mirror_b_id)
    for so in (so_a, so_b):
        if (_component(scene, so).kind_id or "") not in STEERING_KINDS:
            raise AlignError(422, f"{so.name} is not a mirror — select two mirrors.")
    a = mirror_facts_from_object(scene, so_a)
    b = mirror_facts_from_object(scene, so_b)

    if target_object_id in (mirror_a_id, mirror_b_id):
        raise AlignError(422, "The destination must be a third object, not one of the two mirrors.")
    if target_anchor_id not in TARGET_ANCHOR_IDS:
        raise AlignError(
            422,
            f"`{target_anchor_id}` is not a coupling destination; use one of "
            + ", ".join(TARGET_ANCHOR_IDS) + ".",
        )
    so_t = _object(scene, target_object_id)
    target = next(
        (
            an for an in resolve_anchor_poses_lab(scene, _component(scene, so_t), so_t)
            if an.anchor_id == target_anchor_id
            and (target_anchor_name is None or an.anchor_name == target_anchor_name)
        ),
        None,
    )
    if target is None or target.axis_x_lab is None:
        raise AlignError(
            422,
            f"{so_t.name}: no `{target_anchor_id}` anchor with a direction in its binding tree.",
        )
    # axisX on an entry face is the OUTWARD normal: light goes in along -axisX.
    target_ray = Ray(origin=target.pos_lab, dir=v_neg(target.axis_x_lab))

    touch = check_mirror_touch(in_ray=in_ray, target_ray=target_ray, a=a, b=b)
    plan = plan_mirror_coupling(
        in_ray=in_ray, target_ray=target_ray, a=a, b=b, fold_mm=fold_mm, touch=touch,
    )

    moves: list[dict] = []
    skipped: list[dict] = []
    if not isinstance(plan, SolveError):
        for oid in pass_through_object_ids:
            so = scene.objects.get(oid)
            comp = scene.component_of(so) if so is not None else None
            if so is None or comp is None:
                skipped.append({"objectId": oid, "reason": "not found"})
                continue
            if so.locked:
                skipped.append({"objectId": oid, "reason": "locked"})
                continue
            point = _pass_through_align_point_cad(scene, comp, so)
            if point is None:
                skipped.append({"objectId": oid, "reason": "no align point"})
                continue
            pose = compute_translate_only_pose(
                point_cad_mm=point, scene_object=object_pose(so),
                beam_dir=target_ray.dir, beam_ref=target_ray.origin,
            )
            moves.append({"objectId": oid, "name": so.name, "pose": to_json(pose)})

    return {
        "mirrorA": _mirror_out(a, bool(so_a.locked)),
        "mirrorB": _mirror_out(b, bool(so_b.locked)),
        "inRay": to_json(in_ray),
        "targetRay": to_json(target_ray),
        "touch": to_json(touch),
        "plan": None if isinstance(plan, SolveError) else to_json(plan),
        "error": plan.error if isinstance(plan, SolveError) else None,
        "passThroughMoves": moves,
        "passThroughSkipped": skipped,
    }


# ─── point + direction align (the isolator and every pass-through optic) ───

# AlignToBeamControls.tsx: the single-asset fallback's reference anchors.
PRIMARY_ALIGN_ANCHOR_IDS = ("intercept_in", "intercept_face", "in", "seed", "tip", "intercept_out")


@dataclass(frozen=True)
class AlignPointDir:
    point: V
    dir: V
    source: str  # "alignSpec" | "polariserCentres" | "primaryAnchor"


def resolve_align_point_dir(scene: AlignScene, comp: Any, so: Any) -> AlignPointDir:
    """``AlignToBeamControls.resolved``: (point, direction) in the Component
    CAD frame — the Component's ``alignSpec``, else the binding tree's front /
    back polariser centres (an isolator), else the primary asset's entry
    anchor with direction ``-axisX``."""
    spec = _align_spec(comp)
    spec_point = _vec3_from_array(spec.get("pointMm"))
    spec_dir = _vec3_from_array(spec.get("directionMm"))
    if spec_point is not None and spec_dir is not None and math.hypot(*spec_dir) > 1e-6:
        return AlignPointDir(spec_point, spec_dir, "alignSpec")

    centres: list[RoleCentre] = []
    collect_role_centres(resolve_binding_tree(scene, comp, str(so.id)), centres)
    front = pick_polariser_centre(centres, "front")
    back = pick_polariser_centre(centres, "back")
    if front is not None and back is not None:
        return AlignPointDir(
            front, V(back.x - front.x, back.y - front.y, back.z - front.z), "polariserCentres",
        )

    asset = scene.primary_asset(comp)
    anchors = [a for a in ((asset.anchors or []) if asset is not None else []) if isinstance(a, dict)]
    anchor = None
    for aid in PRIMARY_ALIGN_ANCHOR_IDS:
        anchor = next((x for x in anchors if x.get("id") == aid), None)
        if anchor is not None:
            break
    if anchor is not None:
        pos = read_xyz(anchor.get("positionMmBodyLocal"))
        axis = anchor_primary_dir(anchor)
        if pos is not None and axis is not None:
            return AlignPointDir(pos, v_neg(axis), "primaryAnchor")
    raise AlignError(
        422,
        "No align point/direction. Define point + direction in PHY Editor → Component (Align), "
        "or check the asset's intercept anchor.",
    )


def isolator_align(
    scene: AlignScene,
    *,
    object_id: str,
    beam_dir: V,
    beam_ref: V,
    reverse: bool | None = None,
    roll_deg: float | None = None,
) -> dict:
    """"Align to beam" as the Object panel runs it: (point, direction) from
    :func:`resolve_align_point_dir`, then ``computePointDirAlignPose``."""
    so = _object(scene, object_id)
    comp = _component(scene, so)
    pd = resolve_align_point_dir(scene, comp, so)
    rev, roll = _reverse_and_roll(so, reverse, roll_deg)
    pose = compute_point_dir_align_pose(
        point_cad_mm=pd.point, dir_cad_mm=pd.dir, scene_object=object_pose(so),
        beam_dir=beam_dir, beam_ref=beam_ref, reverse=rev, roll_deg=roll,
    )
    return {
        "objectId": object_id,
        "name": so.name,
        "locked": bool(so.locked),
        "alignSource": pd.source,
        "pointCadMm": to_json(pd.point),
        "dirCadMm": to_json(pd.dir),
        "reverse": rev,
        "rollDeg": roll,
        "pose": to_json(pose),
        "error": None if pose is not None
        else "Align direction is degenerate — check the Component's alignSpec / axis.",
    }


# ─── AOM Bragg align ───────────────────────────────────────────────────────

MRAD = 1000


def rf_link_freq_mhz(inputs: RfInputs, object_id: str, scrub_time_ns: float | None) -> float | None:
    """The carrier arriving at this AOM's ``rf_in`` in the RF snapshot the
    trace uses at ``scrub_time_ns`` (``rf_resolve.rf_snapshot_at``). ``None``
    for a manual-mode AOM, an AOM without ``rf_in``, or no signal."""
    aom = next((a for a in inputs.aoms if a.object_id == object_id), None)
    if aom is None or aom.manual:
        return None
    _, snapshot = rf_snapshot_at(inputs, scrub_time_ns)
    sig = snapshot.signal_at_port.get(port_key(object_id, aom.rf_in_anchor_name))
    return sig.frequency_mhz if sig is not None else None


def aom_bragg_align(
    scene: AlignScene,
    *,
    object_id: str,
    beam_dir: V,
    beam_ref: V,
    wavelength_nm: float | None = None,
    order: int | None = None,
    fine_tune_mrad: float | None = None,
    reverse: bool | None = None,
    roll_deg: float | None = None,
    freq_mhz: float | None = None,
    rf_freq_mhz: float | None = None,
    nudge_mrad: float | None = None,
) -> dict:
    """The AOM Bragg section of the Object panel: the two-stage align pose for
    the selected order (+ fine tune), a readout of the current pose and of the
    proposed one, and optionally the rotation-stage nudge.

    Parameter resolution follows ``AlignToBeamControls.AomBraggSection``:
    order = request, else ``dynamicSources.diffractionOrder``, else the
    asset's ``diffractionOrder``, else 1; fine tune = request, else
    ``properties.aomBraggFineTuneMrad``, else 0; v / n / L from the asset's
    ``default_params`` (4200 m/s, 2.26, 22.4 mm); wavelength = request, else
    780 nm. The RF frequency is the request's, else ``rf_freq_mhz`` (the RF
    link, resolved by the caller with :func:`rf_link_freq_mhz`), else
    ``dynamicSources.aomFreqMhz``, else the asset's ``centerFreqMhz``, else 80.
    """
    so = _object(scene, object_id)
    comp = _component(scene, so)
    asset = scene.primary_asset(comp)
    if asset is None or asset.kind_id != "aom":
        raise AlignError(422, f"{so.name} is not an AOM (its primary asset is not of kind `aom`).")
    frame = resolve_aom_bragg_frame(asset.anchors, asset.default_params)
    if frame is None:
        raise AlignError(
            422,
            "No Bragg geometry: the AOM asset needs intercept_in / intercept_out and an "
            "acoustic direction (acoustic_axis anchor or rfPropagationDirectionBodyLocal).",
        )

    params = asset.default_params if isinstance(asset.default_params, dict) else {}
    dyn = so.dynamic_sources if isinstance(so.dynamic_sources, dict) else {}
    props = _props(so)
    sel_order = order if order is not None else js_round(
        js_num(dyn.get("diffractionOrder"), js_num(params.get("diffractionOrder"), 1))
    )
    fine = fine_tune_mrad if fine_tune_mrad is not None else js_num(props.get("aomBraggFineTuneMrad"), 0)
    v_acoustic = js_num(params.get("acousticVelocityMps"), 4200)
    refractive_index = js_num(params.get("refractiveIndex"), 2.26)
    crystal_length_mm = js_num(params.get("crystalLengthMm"), 22.4)
    lam = wavelength_nm if wavelength_nm is not None else 780.0

    dyn_freq = js_num(dyn.get("aomFreqMhz"), math.nan)
    asset_freq = js_num(params.get("centerFreqMhz"), math.nan)
    if freq_mhz is not None:
        freq, freq_source = freq_mhz, "request"
    elif rf_freq_mhz is not None:
        freq, freq_source = rf_freq_mhz, "rfLink"
    elif not math.isnan(dyn_freq):
        freq, freq_source = dyn_freq, "dynamicSources"
    elif not math.isnan(asset_freq):
        freq, freq_source = asset_freq, "asset"
    else:
        freq, freq_source = 80.0, "default"

    theta_b = bragg_angle_rad(lam, freq, v_acoustic)
    orders = [1, -1] if sel_order == 0 else [sel_order, -sel_order]
    pose0 = object_pose(so)
    readout = aom_bragg_readout(
        frame=frame, scene_object=pose0, beam_dir=beam_dir, theta_b_rad=theta_b,
        wavelength_nm=lam, freq_mhz=freq, acoustic_velocity_mps=v_acoustic,
        refractive_index=refractive_index, crystal_length_mm=crystal_length_mm, orders=orders,
    )
    tilt = bragg_tilt_rad(sel_order, theta_b) + fine / MRAD
    rev, roll = _reverse_and_roll(so, reverse, roll_deg)

    pose = None
    readout_after = None
    error = None
    if sel_order == 0:
        error = "Order 0 is the undiffracted beam — nothing to Bragg-align. Pick ±1."
    else:
        pose = compute_aom_bragg_align_pose(
            frame=frame, scene_object=pose0, beam_dir=beam_dir, beam_ref=beam_ref,
            reverse=rev, roll_deg=roll, tilt_rad=tilt,
        )
        if pose is None:
            error = "Bragg align failed — degenerate AOM geometry."
        else:
            readout_after = aom_bragg_readout(
                frame=frame, scene_object=pose.as_v3_pose(), beam_dir=beam_dir,
                theta_b_rad=theta_b, wavelength_nm=lam, freq_mhz=freq,
                acoustic_velocity_mps=v_acoustic, refractive_index=refractive_index,
                crystal_length_mm=crystal_length_mm, orders=orders,
            )
    nudge = (
        compute_aom_tilt_nudge_pose(frame=frame, scene_object=pose0, delta_rad=nudge_mrad / MRAD)
        if nudge_mrad is not None else None
    )
    return {
        "objectId": object_id,
        "name": so.name,
        "locked": bool(so.locked),
        "frame": to_json(frame),
        "order": sel_order,
        "fineTuneMrad": fine,
        "reverse": rev,
        "rollDeg": roll,
        "wavelengthNm": lam,
        "freqMhz": freq,
        "freqSource": freq_source,
        "acousticVelocityMps": v_acoustic,
        "refractiveIndex": refractive_index,
        "crystalLengthMm": crystal_length_mm,
        "thetaBRad": theta_b,
        "tiltRad": tilt,
        "readout": to_json(readout),
        "pose": to_json(pose),
        "readoutAfter": to_json(readout_after),
        "nudgePose": to_json(nudge),
        "error": error,
    }
