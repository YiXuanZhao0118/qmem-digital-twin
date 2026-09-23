"""RF propagation readout — POST /api/v3/rf/propagation.

Compute-only (writes nothing). The web app's RF Link panel computes this map
in the browser (``frontend/src/utils/rfPropagation.ts``); a second client (the
qmem-blender add-on) must not grow a third copy, so the backend's
authoritative BFS (``app/optical/rf_resolve.py``) is exposed here instead.

The snapshot rule is the solver's: ``load_rf_inputs`` +
``rf_resolve.rf_readout_at``, which shares ``rf_snapshot_at`` and
``aom_drives_from_snapshot`` with ``resolve_aom_rf_drive`` (what
``/api/v3/solver/run-from-db`` merges onto each AOM slot). So for the same
``scrubTimeNs`` the ``aomDrives`` returned here are exactly the drives the
trace used — including ``scrubTimeNs = null`` = the "scrub stopped" rest
snapshot, where each PPG sits at its ``restState``. Each drive also carries
``eta``, the first-order efficiency the tracer's AOM op applies with it,
computed over the loader's own AOM slots (``app/optical/aom_readout.py``).
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.optical.aom_readout import (
    aom_drive_efficiencies,
    scene_emitter_wavelength_nm,
)
from app.optical.db_scene_loader import load_anchor_scene_from_db
from app.optical.rf_resolve import (
    RfReadout,
    load_rf_inputs,
    rf_readout_at,
    vpp_to_power_w,
)
from app.schemas import CamelModel


router = APIRouter(prefix="/v3/rf", tags=["v3-rf"])


class RfPropagationRequest(CamelModel):
    # Scrub-bar time in ns; ``None`` = scrub stopped (the rest snapshot).
    # Same meaning as ``SolverRunFromDbRequest.scrub_time_ns``.
    scrub_time_ns: Optional[float] = None


class RfSignalOut(CamelModel):
    """The signal at one port (``rf_resolve.RfSignalState`` + ``powerW``)."""

    frequency_mhz: float
    vpp: float
    # Vpp^2 / (8 * 50 ohm) — the same conversion the AOM drive uses.
    power_w: float
    source_object_id: str
    source_anchor_name: str
    cumulative_gain_db: float
    passthrough_object_ids: list[str]
    saturated: bool


class RfPropagationOut(CamelModel):
    # Echo of the request, so a debounced client can drop stale replies.
    scrub_time_ns: Optional[float]
    # Keyed "<objectId>|<anchorName>" (anchorName = anchor.name ?? anchor.id).
    signal_at_port: dict[str, RfSignalOut]
    # Every port with a cable / PPG attachment on it (topology, sorted).
    connected_ports: list[str]
    # PPG SceneObject ids whose gate is HIGH in this snapshot (sorted).
    ppg_gate_high_object_ids: list[str]
    # AOM SceneObject id -> the drive the solver merges onto that AOM:
    # {"aomFreqMhz": f, "rfDrivePowerW": p} when a carrier arrives, or
    # {"rfDrivePowerW": 0.0} when wired but gated off. Manual-mode and
    # unwired AOMs are absent (they keep their own / rated drive). Passed
    # through verbatim from ``aom_drives_from_snapshot`` so the keys cannot
    # drift from what the trace reads — plus "eta", the on-Bragg first-order
    # efficiency the tracer's AOM op applies with that drive at the scene's
    # emitter wavelength (``aom_readout``); absent only for an AOM the tracer
    # has no slot for.
    aom_drives: dict[str, dict[str, float]]
    # The wavelength every ``aomDrives[*].eta`` above was evaluated at, in nm —
    # the scene's emitter wavelength as the TRACER decides it
    # (``aom_readout.scene_emitter_wavelength_nm``), or the 780 nm fallback when
    # the scene emits several. ``None`` when no AOM drive was computed, so there
    # is no eta to qualify. Reported because ``P_peak ∝ λ²``: a client that also
    # shows "the drive that would peak this AOM" must use the SAME λ as the eta
    # beside it, and it has no way to derive it (the web RF Link panel's own
    # emitter scan is what drifted to 780 nm on the live bench — rf.md §3).
    aom_eta_wavelength_nm: Optional[float] = None
    # Every timing-section boundary across all programs, plus 0 (sorted).
    section_starts_ns: list[float]


def readout_to_out(readout: RfReadout, scrub_time_ns: float | None) -> RfPropagationOut:
    snap = readout.snapshot
    return RfPropagationOut(
        scrub_time_ns=scrub_time_ns,
        signal_at_port={
            key: RfSignalOut(
                frequency_mhz=sig.frequency_mhz,
                vpp=sig.vpp,
                power_w=vpp_to_power_w(sig.vpp),
                source_object_id=sig.source_object_id,
                source_anchor_name=sig.source_anchor_name,
                cumulative_gain_db=sig.cumulative_gain_db,
                passthrough_object_ids=list(sig.passthrough_object_ids),
                saturated=sig.saturated,
            )
            for key, sig in snap.signal_at_port.items()
        },
        connected_ports=sorted(snap.connected_ports),
        ppg_gate_high_object_ids=sorted(snap.ppg_gate_high_object_ids),
        aom_drives=readout.aom_drives,
        section_starts_ns=list(readout.section_starts_ns),
    )


@router.post("/propagation", response_model=RfPropagationOut)
async def rf_propagation(
    request: RfPropagationRequest = RfPropagationRequest(),
    session: AsyncSession = Depends(get_session),
) -> RfPropagationOut:
    """The RF signal at every port for one scrub time, plus the per-AOM drive
    the optical trace uses at that instant, the first-order efficiency that
    drive buys (``eta``) and the wavelength it was evaluated at
    (``aomEtaWavelengthNm``). See the module docstring."""
    inputs = await load_rf_inputs(session)
    readout = rf_readout_at(inputs, request.scrub_time_ns)
    out = readout_to_out(readout, request.scrub_time_ns)
    if readout.aom_drives:
        # The AOM slots exactly as the tracer receives them at this time (the
        # loader merges this same drive onto them), so eta is the value the
        # op applies — see ``aom_readout``.
        scene = await load_anchor_scene_from_db(session, scrub_time_ns=request.scrub_time_ns)
        etas = aom_drive_efficiencies(scene, readout.aom_drives)
        out.aom_drives = {
            oid: {**drive, **({"eta": etas[oid]} if oid in etas else {})}
            for oid, drive in readout.aom_drives.items()
        }
        out.aom_eta_wavelength_nm = scene_emitter_wavelength_nm(scene)
    return out
