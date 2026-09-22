"""The first-order AOM efficiency a readout reports — the one the tracer applies.

``POST /api/v3/rf/propagation`` returns, per RF-driven AOM, the drive the
solver merges onto it (``aomDrives``). ``aomDrives[*].eta`` adds what that
drive buys: the on-Bragg first-order efficiency ``anchor_ops.aom`` computes
for a ray arriving at the AOM, through the op's own function
(``on_bragg_first_order_efficiency``) and the op's own parameters — the AOM
slot exactly as ``db_scene_loader.load_anchor_scene_from_db`` hands it to the
tracer (asset ``default_params`` + the slot's ``dynamic_sources``, which is
where the loader merged the RF-link drive).

The one input the op takes per RAY is the wavelength. A readout has no ray,
so it takes the scene's emitter wavelength, the rule the web RF Link panel's
η badge uses (``RfLinkPanel.sceneWavelengthNm``, docs/introduce/rf.md §3): the
single wavelength the scene emits, else a nominal 780 nm when there are
several (``P_peak ∝ λ²``, so 780 vs 852 nm moves η visibly). "Emits" is
decided the way the tracer decides it (``solver.solve_anchor_scene``): the
laser sources' emissions (``emit_anchor_source_rays``, which already honours a
hidden emission and resolves each wavelength as the emitted ray does); a
tapered amplifier's own wavelength only counts when the scene has no laser
emission at all, because a TA in a laser's path is seeded and emits nothing of
its own. (The panel counts every TA, so a seeded TA with a different nominal
wavelength sends it to 780 nm while the tracer's rays stay at the laser's.)
"""

from __future__ import annotations

import math
from collections.abc import Iterable

from app.optical.anchor_ops.aom import on_bragg_first_order_efficiency
from app.optical.anchor_ops.emit_laser_source import (
    emit_anchor_source_rays,
    emit_ta_ase_rays,
)
from app.optical.anchor_tracer import V3AnchorScene

# RfLinkPanel.tsx DEFAULT_LAMBDA_NM — the several-wavelengths / no-emitter fallback.
DEFAULT_READOUT_WAVELENGTH_NM = 780.0


def scene_emitter_wavelength_nm(scene: V3AnchorScene) -> float:
    """The one wavelength the scene's emitters send, else 780 nm."""
    emitted = [ray.wavelength_nm for ray, *_ in emit_anchor_source_rays(scene)]
    if not emitted:
        emitted = [ray.wavelength_nm for ray, *_ in emit_ta_ase_rays(scene, set())]
    found = {w for w in emitted if math.isfinite(w) and w > 0}
    return next(iter(found)) if len(found) == 1 else DEFAULT_READOUT_WAVELENGTH_NM


def aom_drive_efficiencies(
    scene: V3AnchorScene, object_ids: Iterable[str],
) -> dict[str, float]:
    """``{aom object id: η}`` for each id that has an ``aom`` slot in
    ``scene`` (first such slot wins; the op runs on it). An id with no AOM
    slot — e.g. an asset with no anchors, which the tracer never sees — is
    left out."""
    wanted = set(object_ids)
    lam = scene_emitter_wavelength_nm(scene)
    out: dict[str, float] = {}
    for slot in scene.slots:
        oid = slot.scene_object_id
        if slot.asset.kind != "aom" or oid not in wanted or oid in out:
            continue
        # The tracer's AnchorOpContext pair (anchor_tracer, "Dispatch op").
        dynamic = dict(slot.dynamic_sources or {})
        params = {**slot.asset.default_params, **dynamic}
        out[oid] = on_bragg_first_order_efficiency(params, dynamic, lam)
    return out
