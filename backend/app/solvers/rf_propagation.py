"""RF signal propagation through the rf_cable graph — backend mirror of
``frontend/src/utils/rfPropagation.ts``.

Replaces the direct-only ``rf_source ↔ AOM`` walk that used to live inside
``hydrate_aom_rf_drive``. With this module a chain like

    AD9959.CH0 ──cable──► ZHL-1-2W.rf_in │ rf_out ──cable──► AOM.rf_in

is traversed end-to-end: the source channel's Vpp propagates through every
amplifier's gain (and ``outputPowerMaxDbm`` clamp), and the resulting state
is recorded at every port the signal passes. ``hydrate_aom_rf_drive`` then
just looks up ``signal_at_port[(aom_id, rf_in_anchor_name)]`` instead of
re-walking the graph.

Keep the constants and transfer-function logic in sync with the frontend
file; the unit test ``test_rf_propagation.py`` pins both directions to the
same numeric answers for a representative source → amp → AOM chain.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping

# Keep in sync with `AD9959_VPP_FULL_SCALE` in
# `frontend/src/utils/rfPropagation.ts`.
AD9959_VPP_FULL_SCALE: float = 1.0
RF_LOAD_Z_OHM: float = 50.0


def vpp_to_power_w(vpp: float, z_ohm: float = RF_LOAD_Z_OHM) -> float:
    return (vpp * vpp) / (8.0 * z_ohm)


def power_w_to_vpp(p_w: float, z_ohm: float = RF_LOAD_Z_OHM) -> float:
    return math.sqrt(8.0 * z_ohm * max(0.0, p_w))


def dbm_to_w(dbm: float) -> float:
    return 10.0 ** ((dbm - 30.0) / 10.0)


# Port identifier: (object_id, anchor_name). Anchor name is unique within
# an object's asset, so this tuple is sufficient for graph keys.
PortKey = tuple[Any, str]


@dataclass(frozen=True)
class RfSignalState:
    frequency_mhz: float
    vpp: float
    source_object_id: Any
    source_anchor_name: str
    cumulative_gain_db: float = 0.0
    passthrough_object_ids: tuple = field(default_factory=tuple)
    saturated: bool = False


@dataclass
class RfPropagationResult:
    signal_at_port: dict[PortKey, RfSignalState]


# ---------------------------------------------------------------------------
# Cable / anchor reading
# ---------------------------------------------------------------------------


def _read_cables(objects_by_id: Mapping[Any, Any], elements: Iterable[Any]) -> list[dict]:
    """Return a list of {cable_object_id, a, b} dicts. Each endpoint is
    {target_object_id, target_anchor_name}. Cables with missing endpoints
    are skipped (matches frontend behaviour). Endpoint id coercion follows
    the type of the objects_by_id keys so uuid/string scenes both work."""
    cable_objs: set = {
        e.object_id for e in elements if e.element_kind == "rf_cable"
    }
    edges: list[dict] = []
    key_type = None
    for k in objects_by_id.keys():
        key_type = type(k)
        break
    for obj_id, obj in objects_by_id.items():
        if obj_id not in cable_objs:
            continue
        props = getattr(obj, "properties", None) or {}
        eps = props.get("rfCableEndpoints") if isinstance(props, dict) else None
        if not isinstance(eps, dict):
            continue
        a = eps.get("A")
        b = eps.get("B")
        if not isinstance(a, dict) or not isinstance(b, dict):
            continue
        try:
            a_id = key_type(a["targetObjectId"]) if key_type else a["targetObjectId"]
            b_id = key_type(b["targetObjectId"]) if key_type else b["targetObjectId"]
        except (KeyError, ValueError):
            continue
        a_name = a.get("targetAnchorName")
        b_name = b.get("targetAnchorName")
        if a_name is None or b_name is None:
            continue
        edges.append({
            "cable_object_id": obj_id,
            "a": {"target_object_id": a_id, "target_anchor_name": a_name},
            "b": {"target_object_id": b_id, "target_anchor_name": b_name},
        })
    return edges


def _build_anchors_by_object(
    objects_by_id: Mapping[Any, Any],
    components_by_id: Mapping[Any, Any],
    assets_by_id: Mapping[Any, Any],
) -> dict[Any, list[dict]]:
    """Map SceneObject.id → list of anchor dicts. Each anchor dict has at
    least ``id`` and ``name`` (matching the frontend Asset3D anchors shape).
    Returns an empty list for objects with no resolvable asset."""
    out: dict[Any, list[dict]] = {}
    for obj_id, obj in objects_by_id.items():
        comp_id = getattr(obj, "component_id", None)
        if comp_id is None:
            out[obj_id] = []
            continue
        comp = components_by_id.get(comp_id)
        if comp is None:
            out[obj_id] = []
            continue
        asset_id = getattr(comp, "asset_3d_id", None)
        if asset_id is None:
            out[obj_id] = []
            continue
        asset = assets_by_id.get(asset_id)
        if asset is None:
            out[obj_id] = []
            continue
        out[obj_id] = list(getattr(asset, "anchors", None) or [])
    return out


def find_anchor_by_role(anchors: Iterable[dict], role: str) -> dict | None:
    """Return the first anchor with ``id`` matching ``role`` (``rf_in`` /
    ``rf_out``). Mirrors the frontend's ``findAnchorByRole``."""
    for a in anchors:
        if a.get("id") == role:
            return a
    return None


def anchor_lookup_name(anchor: dict) -> str:
    """An anchor's display/lookup name — falls back to its id when name is
    unset, matching the frontend's ``a.name ?? a.id``."""
    name = anchor.get("name")
    if isinstance(name, str) and name:
        return name
    return str(anchor.get("id"))


# ---------------------------------------------------------------------------
# Passthrough transfer functions
# ---------------------------------------------------------------------------


def _rf_amplifier_transfer(
    *,
    incoming: RfSignalState,
    kind_params: dict,
    anchors: list[dict],
    object_id: Any,
) -> list[tuple[str, RfSignalState]] | None:
    """ZHL-1-2W-style gain block: rf_in → rf_out, Vpp ×10^(gainDb/20), with
    optional output-power clamp at ``outputPowerMaxDbm`` (saturated=True
    when the clamp fires). Mirrors ``rfAmplifierTransfer`` in the frontend."""
    out_anchor = find_anchor_by_role(anchors, "rf_out")
    if out_anchor is None:
        return None
    gain_db = float(kind_params.get("gainDb") or 0.0)
    gain_linear = 10.0 ** (gain_db / 20.0)
    out_vpp = incoming.vpp * gain_linear
    saturated = incoming.saturated
    max_dbm = kind_params.get("outputPowerMaxDbm")
    if isinstance(max_dbm, (int, float)) and math.isfinite(max_dbm):
        max_vpp = power_w_to_vpp(dbm_to_w(float(max_dbm)))
        if out_vpp > max_vpp:
            out_vpp = max_vpp
            saturated = True
    outgoing = RfSignalState(
        frequency_mhz=incoming.frequency_mhz,
        vpp=out_vpp,
        source_object_id=incoming.source_object_id,
        source_anchor_name=incoming.source_anchor_name,
        cumulative_gain_db=incoming.cumulative_gain_db + gain_db,
        passthrough_object_ids=incoming.passthrough_object_ids + (object_id,),
        saturated=saturated,
    )
    return [(anchor_lookup_name(out_anchor), outgoing)]


# Registry of passthrough transfers per element kind. Add new kinds here as
# the link graph grows (rf_switch, rf_attenuator, rf_filter, …). Must stay
# parallel to PASSTHROUGH_BY_KIND in the frontend.
PASSTHROUGH_BY_KIND: dict[str, Callable[..., list[tuple[str, RfSignalState]] | None]] = {
    "rf_amplifier": _rf_amplifier_transfer,
}


# ---------------------------------------------------------------------------
# Main entrypoint
# ---------------------------------------------------------------------------


def build_rf_propagation(
    *,
    objects_by_id: Mapping[Any, Any],
    elements: list[Any],
    components_by_id: Mapping[Any, Any],
    assets_by_id: Mapping[Any, Any],
) -> RfPropagationResult:
    """Walk every rf_source channel forward through the rf_cable graph,
    transforming the signal at each passthrough (amplifier / switch / …)
    and recording the state at every port the wave reaches.

    See module docstring for the algorithm; keep parity with
    ``buildRfPropagation`` in ``frontend/src/utils/rfPropagation.ts``."""
    edges = _read_cables(objects_by_id, elements)
    # Undirected port → list-of-peer-endpoints adjacency.
    adj: dict[PortKey, list[dict]] = {}
    for e in edges:
        ka: PortKey = (e["a"]["target_object_id"], e["a"]["target_anchor_name"])
        kb: PortKey = (e["b"]["target_object_id"], e["b"]["target_anchor_name"])
        adj.setdefault(ka, []).append(e["b"])
        adj.setdefault(kb, []).append(e["a"])

    anchors_by_obj = _build_anchors_by_object(objects_by_id, components_by_id, assets_by_id)
    pe_by_obj: dict[Any, Any] = {e.object_id: e for e in elements}

    signal_at_port: dict[PortKey, RfSignalState] = {}
    queue: deque[tuple[PortKey, RfSignalState]] = deque()

    # Seed: every rf_source channel emits at its anchor.
    #
    # Defensive fallback: when `channels[]` is null/empty (the
    # dds_ad9959_pcb auto-create path leaves it that way until the user
    # edits a channel), synthesise a default seed for each rf_out anchor
    # on the asset so the propagation still drives downstream sinks.
    # Mirrors the frontend `buildRfPropagation` and the panel's
    # EditableAd9959Row — both default to 80 MHz at full amplitude when
    # no explicit channel is stored.
    for e in elements:
        if e.element_kind != "rf_source":
            continue
        channels = (e.kind_params or {}).get("channels") or []
        seeds: list[tuple[str, float, float]] = []
        for ch in channels:
            anchor_name = ch.get("anchorName")
            if not isinstance(anchor_name, str):
                continue
            seeds.append((
                anchor_name,
                float(ch.get("frequencyMhz", 80.0)),
                float(ch.get("amplitudeScale") or 0.0),
            ))
        if not seeds:
            anchors = anchors_by_obj.get(e.object_id) or []
            for a in anchors:
                if a.get("id") != "rf_out":
                    continue
                seeds.append((anchor_lookup_name(a), 80.0, 1.0))
        for anchor_name, freq_mhz, amp_scale in seeds:
            signal = RfSignalState(
                frequency_mhz=freq_mhz,
                vpp=amp_scale * AD9959_VPP_FULL_SCALE,
                source_object_id=e.object_id,
                source_anchor_name=anchor_name,
            )
            key: PortKey = (e.object_id, anchor_name)
            signal_at_port[key] = signal
            queue.append((key, signal))

    # BFS through the cable graph. First arrival at a port wins (matches
    # frontend) — multi-source superposition is out of scope for Phase 1.
    while queue:
        key, signal = queue.popleft()
        neighbors = adj.get(key)
        if not neighbors:
            continue
        for peer in neighbors:
            peer_key: PortKey = (peer["target_object_id"], peer["target_anchor_name"])
            if peer_key in signal_at_port:
                continue
            signal_at_port[peer_key] = signal
            peer_pe = pe_by_obj.get(peer["target_object_id"])
            if peer_pe is None:
                continue
            transfer = PASSTHROUGH_BY_KIND.get(peer_pe.element_kind)
            if transfer is None:
                continue
            anchors = anchors_by_obj.get(peer["target_object_id"]) or []
            outputs = transfer(
                incoming=signal,
                kind_params=peer_pe.kind_params or {},
                anchors=anchors,
                object_id=peer["target_object_id"],
            )
            if not outputs:
                continue
            for out_anchor_name, outgoing in outputs:
                out_key: PortKey = (peer["target_object_id"], out_anchor_name)
                if out_key in signal_at_port:
                    continue
                signal_at_port[out_key] = outgoing
                queue.append((out_key, outgoing))

    return RfPropagationResult(signal_at_port=signal_at_port)
