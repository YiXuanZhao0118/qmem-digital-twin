"""Backend RF resolution — server-side port of ``frontend/src/utils/rfPropagation.ts``.

Graph BFS over the RF cable adjacency (rf_source -> rf_amplifier -> rf_switch
-> AOM ``rf_in``), carrying an :class:`RfSignalState` at every port. Topology is
derived from ``SceneObject.properties.rfCableEndpoints.{A,B}`` (the same source
the frontend edits) — there is no separate RF-link table.

This module is the real ``hydrate_aom_rf_drive`` that comments across the
codebase have long referenced; until now it only existed in the frontend. The
v3 anchor solver calls it so the *authoritative* backend trace resolves each
AOM's effective RF drive itself (headless / API / cron runs no longer depend on
the frontend injecting ``dynamicOverrides``). ``frontend/src/utils/rfPropagation.ts``
stays as a live-UI readout mirror (RF Link panel, cable animation, in-browser
preview tracer).

Time model: quasi-steady per-snapshot. A PPG-driven switch's TTL is sampled at a
scrub time; within one timing section the routing — and therefore the whole
propagation map — is constant. ``hydrate_aom_rf_drive`` builds one snapshot per
section boundary and looks up the section containing ``scrub_time_ns`` (``None``
resolves to the dedicated "scrub stopped" rest snapshot).

Parity note: helper names and control flow mirror the TS source 1:1 so the two
can be diffed side by side. Keep them in lockstep when either changes.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Asset3D,
    Component,
    ComponentBinding,
    DeviceState,
    PhysicsElement,
    SceneObject,
)
from app.models.timing import TimingProgram
from app.optical.aom_physics import RF_LOAD_Z_OHM

# AD9959 single-ended into 50 ohm at default Rset has ~1.0 Vpp full-scale.
AD9959_VPP_FULL_SCALE = 1.0


def vpp_to_power_w(vpp: float, z_ohm: float = RF_LOAD_Z_OHM) -> float:
    """Vpp -> W under a sinusoid into resistive Z: P = Vpp^2 / (8*Z)."""
    return (vpp * vpp) / (8.0 * z_ohm)


def power_w_to_vpp(p: float, z_ohm: float = RF_LOAD_Z_OHM) -> float:
    """W -> Vpp inverse: Vpp = sqrt(8*Z*P)."""
    return math.sqrt(8.0 * z_ohm * max(0.0, p))


def dbm_to_w(dbm: float) -> float:
    """dBm -> W."""
    return 10.0 ** ((dbm - 30.0) / 10.0)


def port_key(object_id: str, anchor_name: str) -> str:
    """Port identifier ``"{objectId}|{anchorName}"`` (mirrors TS ``portKey``)."""
    return f"{object_id}|{anchor_name}"


def _num(v, default: float = 0.0) -> float:
    """Finite-number coercion mirroring TS ``typeof x === 'number'`` (bools excluded)."""
    if isinstance(v, bool):
        return default
    if isinstance(v, (int, float)) and math.isfinite(float(v)):
        return float(v)
    return default


def _opt_num(v) -> float | None:
    """Like :func:`_num` but returns ``None`` instead of a default (for ``?? x`` sites)."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)) and math.isfinite(float(v)):
        return float(v)
    return None


def _anchor_name(anchor: dict) -> str:
    """Anchor port name, mirroring TS ``a.name ?? a.id``.

    Multi-port RF assets share one ``id`` (``rf_out``) and distinguish ports by
    ``name`` (``CH0``..``CH3`` for the AD9959, ``RF1``/``RF2`` for a switch).
    """
    name = anchor.get("name")
    return str(name) if name else str(anchor.get("id"))


def _find_anchor_by_role(anchors, role: str) -> dict | None:
    """First anchor whose ``id`` equals ``role`` (rf_in / rf_out / ttl_in)."""
    for a in anchors:
        if a.get("id") == role:
            return a
    return None


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class RfSignalState:
    frequency_mhz: float
    vpp: float
    source_object_id: str
    source_anchor_name: str
    cumulative_gain_db: float
    passthrough_object_ids: tuple[str, ...]
    saturated: bool


@dataclass(frozen=True)
class RfPropagationResult:
    # Signal arriving at (or emitted from) each port. Source rf_out ports carry
    # their own state; sink rf_in ports the post-chain state; passthrough rf_out
    # ports the post-transform state. Keyed ``"{objectId}|{anchorName}"``.
    signal_at_port: dict[str, RfSignalState]
    # Every port with at least one edge (cable or PPG attachment) — "something
    # is plugged in here", whether or not a carrier currently arrives.
    # Time-invariant (topology, not routing). Mirrors TS ``connectedPorts``.
    connected_ports: frozenset[str] = frozenset()
    # SceneObject ids of PPGs whose gate is HIGH in this snapshot. Mirrors TS
    # ``ppgGateHighObjectIds``.
    ppg_gate_high_object_ids: frozenset[str] = frozenset()


@dataclass(frozen=True)
class RfNode:
    """One SceneObject's RF-relevant facts (pure; no ORM rows)."""

    object_id: str
    element_kind: str
    kind_params: dict
    anchors: tuple[dict, ...]
    # ``properties.rfCableEndpoints`` ({A, B} endpoint links) — only rf_cable
    # nodes carry it; it supplies the graph edges.
    rf_cable_endpoints: dict | None = None
    # ``properties.ppgAttachment`` ({targetObjectId, targetAnchorId,
    # targetAnchorName}) — only programmable_pulse_generator nodes carry it. A
    # PPG plugs straight into a port with no cable in between (its rf_out is a
    # male connector; every catalog cable is male on both ends), so the
    # attachment supplies the graph edge a cable would otherwise have. Mirrors
    # the frontend ``utils/ppgAttachment.ts``.
    ppg_attachment: dict | None = None
    # ``Asset3D.default_params`` — the asset is the authoritative store for the
    # source's spec coefficients (``fullScaleVpp`` etc.). The RF BFS reads it
    # here so coefficients live on the asset, mirroring how the optical anchor
    # tracer consumes ``default_params``.
    asset_params: dict = field(default_factory=dict)
    # ``SceneObject.dynamic_sources`` — per-instance overrides for the asset's
    # ``tunable_params`` keys (e.g. a board with a non-default Rset → different
    # ``fullScaleVpp``). Overrides ``asset_params`` for the keys it carries.
    dynamic_sources: dict = field(default_factory=dict)


@dataclass(frozen=True)
class AomPort:
    object_id: str
    rf_in_anchor_name: str
    manual: bool


@dataclass(frozen=True)
class RfInputs:
    """Pure inputs to :func:`build_rf_propagation` (DB-free, unit-testable)."""

    nodes: tuple[RfNode, ...]
    programs_by_id: dict[str, list]
    powered_off: frozenset[str]
    aoms: tuple[AomPort, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class _CableEndpoint:
    target_object_id: str
    target_anchor_name: str


# ---------------------------------------------------------------------------
# Topology
# ---------------------------------------------------------------------------

def _read_cables(nodes) -> list[tuple[_CableEndpoint, _CableEndpoint]]:
    edges: list[tuple[_CableEndpoint, _CableEndpoint]] = []
    for node in nodes:
        if node.element_kind != "rf_cable":
            continue
        eps = node.rf_cable_endpoints
        if not isinstance(eps, dict):
            continue
        a, b = eps.get("A"), eps.get("B")
        if not isinstance(a, dict) or not isinstance(b, dict):
            continue
        ta_obj, ta_an = a.get("targetObjectId"), a.get("targetAnchorName")
        tb_obj, tb_an = b.get("targetObjectId"), b.get("targetAnchorName")
        if not (ta_obj and ta_an and tb_obj and tb_an):
            continue
        edges.append((
            _CableEndpoint(str(ta_obj), str(ta_an)),
            _CableEndpoint(str(tb_obj), str(tb_an)),
        ))
    return edges


def _read_ppg_attachments(nodes) -> list[tuple[_CableEndpoint, _CableEndpoint]]:
    """Edges contributed by cable-less PPG attachments.

    A PPG mates its own ``rf_out`` onto the target anchor, so the edge is
    exactly what a zero-length cable would have supplied — the TTL pre-pass
    and the BFS need no special case. Mirrors the frontend
    ``readPpgAttachmentEdges``.
    """
    edges: list[tuple[_CableEndpoint, _CableEndpoint]] = []
    for node in nodes:
        if node.element_kind != "programmable_pulse_generator":
            continue
        att = node.ppg_attachment
        if not isinstance(att, dict):
            continue
        target_obj = att.get("targetObjectId")
        target_anchor = att.get("targetAnchorName")
        if not (target_obj and target_anchor):
            continue
        edges.append((
            _CableEndpoint(node.object_id, "rf_out"),
            _CableEndpoint(str(target_obj), str(target_anchor)),
        ))
    return edges


def _build_adjacency(edges) -> dict[str, list[_CableEndpoint]]:
    """Port key -> peer endpoints. Undirected (cables carry no direction)."""
    adj: dict[str, list[_CableEndpoint]] = {}
    for a, b in edges:
        adj.setdefault(port_key(a.target_object_id, a.target_anchor_name), []).append(b)
        adj.setdefault(port_key(b.target_object_id, b.target_anchor_name), []).append(a)
    return adj


# ---------------------------------------------------------------------------
# Passthrough transfers (rf_amplifier, rf_switch). Sinks return None.
# ---------------------------------------------------------------------------

def _rf_amplifier_transfer(
    *, incoming: RfSignalState, kind_params: dict, anchors, object_id: str,
    switch_ttl_states, powered_off,
):
    if object_id in powered_off:
        return None
    out_anchor = _find_anchor_by_role(anchors, "rf_out")
    if out_anchor is None:
        return None
    gain_db = _num(kind_params.get("gainDb"), 0.0)
    gain_linear = 10.0 ** (gain_db / 20.0)
    out_vpp = incoming.vpp * gain_linear
    saturated = incoming.saturated
    max_dbm = _opt_num(kind_params.get("outputPowerMaxDbm"))
    if max_dbm is not None:
        max_vpp = power_w_to_vpp(dbm_to_w(max_dbm))
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
    return [(_anchor_name(out_anchor), outgoing)]


def _rf_switch_transfer(
    *, incoming: RfSignalState, kind_params: dict, anchors, object_id: str,
    switch_ttl_states, powered_off,
):
    if object_id in powered_off:
        return None
    params = kind_params or {}
    state = switch_ttl_states.get(object_id) or params.get("ttlState") or "LOW"
    high_throw_raw = _opt_num(params.get("ttlActiveHighThrow"))
    high_throw = int(high_throw_raw) if high_throw_raw is not None else 2
    if state == "HIGH":
        active = high_throw
    else:
        throw_count_raw = _opt_num(params.get("throwCount"))
        throw_count = int(throw_count_raw) if throw_count_raw is not None else 2
        if throw_count == 2:
            active = 3 - high_throw
        else:
            # SP3T+ on a single TTL line: LOW is ambiguous -> no path active.
            return []
    target_name = f"RF{active}"
    active_anchor = next(
        (a for a in anchors
         if a.get("id") == "rf_out" and str(a.get("name") or "").upper() == target_name),
        None,
    )
    if active_anchor is None:
        return []
    il_db_raw = _opt_num(params.get("insertionLossDb"))
    il_db = il_db_raw if il_db_raw is not None else 1.0
    il_linear = 10.0 ** (-il_db / 20.0)
    outgoing = RfSignalState(
        frequency_mhz=incoming.frequency_mhz,
        vpp=incoming.vpp * il_linear,
        source_object_id=incoming.source_object_id,
        source_anchor_name=incoming.source_anchor_name,
        cumulative_gain_db=incoming.cumulative_gain_db - il_db,
        passthrough_object_ids=incoming.passthrough_object_ids + (object_id,),
        saturated=incoming.saturated,
    )
    return [(_anchor_name(active_anchor), outgoing)]


_PASSTHROUGH_BY_KIND = {
    "rf_amplifier": _rf_amplifier_transfer,
    "rf_switch": _rf_switch_transfer,
}


def _lookup_passthrough(element_kind: str):
    """Transfer for a passthrough kind; ``None`` for sinks / non-passthrough."""
    return _PASSTHROUGH_BY_KIND.get(element_kind)


# ---------------------------------------------------------------------------
# Timing helpers
# ---------------------------------------------------------------------------

def _ppg_interval_covers(intervals, t_ns: float) -> bool:
    """Does ``t_ns`` fall inside any HIGH interval? Half-open ``[start, end)``."""
    if not intervals:
        return False
    for iv in intervals:
        s = _opt_num(iv.get("spinCoreStartNs"))
        e = _opt_num(iv.get("spinCoreEndNs"))
        if s is not None and e is not None and s <= t_ns < e:
            return True
    return False


def collect_section_starts(programs_by_id: dict[str, list]) -> list[float]:
    """Every distinct interval boundary across all programs, plus 0."""
    starts: set[float] = {0.0}
    for intervals in programs_by_id.values():
        for iv in (intervals or []):
            s = _opt_num(iv.get("spinCoreStartNs"))
            e = _opt_num(iv.get("spinCoreEndNs"))
            if s is not None and s >= 0:
                starts.add(s)
            if e is not None and e >= 0:
                starts.add(e)
    return sorted(starts)


# ---------------------------------------------------------------------------
# Core BFS
# ---------------------------------------------------------------------------

def build_rf_propagation(
    inputs: RfInputs,
    *,
    scrub_time_ns: float | None = 0.0,
    idle_rest_mode: bool = False,
) -> RfPropagationResult:
    """Resolve the RF signal at every port. Pure (no DB).

    ``scrub_time_ns`` drives PPG-bound switch TTLs (HIGH iff any interval covers
    it). ``idle_rest_mode`` ignores intervals and takes each PPG's ``restState``
    instead — used for the "scrub stopped" rest snapshot.
    """
    scrub_t = scrub_time_ns if scrub_time_ns is not None else 0.0
    nodes = inputs.nodes
    powered_off = inputs.powered_off
    programs_by_id = inputs.programs_by_id

    node_by_id = {n.object_id: n for n in nodes}
    edges = _read_cables(nodes) + _read_ppg_attachments(nodes)
    adj = _build_adjacency(edges)

    def _resolved_params(node: RfNode) -> dict:
        """Params a passthrough transfer sees, resolved through the ownership
        chain: per-instance ``dynamic_sources`` wins, then the Asset's
        ``default_params`` (authoritative store for device coefficients), then
        the PhysicsElement's legacy ``kind_params``. Mirrors the frontend
        ``resolveElementParams`` in ``rfPropagation.ts`` — the seed loop below
        already resolves fullScaleVpp / channels this way, but the passthrough
        transfers used to read ``kind_params`` alone, which dead-ended every
        asset-authored / per-instance switch + amp knob (notably ``ttlState``).
        """
        return {
            **(node.kind_params or {}),
            **(node.asset_params or {}),
            **(node.dynamic_sources or {}),
        }

    # Gate pre-pass: the output level of every PPG in the scene.
    #
    #     level = in_interval XOR (rest_state == "HIGH")
    #
    # ``rest_state`` is the level the line sits at OUTSIDE the drawn intervals,
    # so a HIGH rest turns those intervals into LOW pulses (negative logic) —
    # the contract on ``schemas.ProgrammablePulseGeneratorParams.rest_state``,
    # mirrored by the frontend ``rfPropagation.ts`` gate pre-pass. Previously
    # active scrub was positive-logic-only (intervals assert HIGH, rest_state
    # consulted for the idle snapshot alone), so a channel resting HIGH read
    # LOW as soon as the scrub bar came on. In ``idle_rest_mode`` intervals
    # aren't consulted at all, which is what the XOR degenerates to.
    ppg_gate_high: set[str] = set()
    for node in nodes:
        if node.element_kind != "programmable_pulse_generator":
            continue
        params = _resolved_params(node)
        rest = params.get("restState") == "HIGH"
        program_id = params.get("timingProgramId")
        in_interval = (
            not idle_rest_mode
            and bool(program_id)
            and _ppg_interval_covers(programs_by_id.get(str(program_id)), scrub_t)
        )
        if in_interval != rest:
            ppg_gate_high.add(node.object_id)

    # TTL pre-pass: for each rf_switch look one hop up its ttl_in edge. A PPG
    # peer owns the line (its gate level decides the throw); with no PPG plugged
    # in, the switch's manual ttlState param applies.
    switch_ttl_states: dict[str, str] = {}
    for node in nodes:
        if node.element_kind != "rf_switch":
            continue
        ttl = _find_anchor_by_role(node.anchors, "ttl_in")
        manual = _resolved_params(node).get("ttlState") or "LOW"
        if ttl is None:
            switch_ttl_states[node.object_id] = manual
            continue
        ttl_name = _anchor_name(ttl)
        peers = adj.get(port_key(node.object_id, ttl_name), [])
        derived: str | None = None
        for peer in peers:
            peer_node = node_by_id.get(peer.target_object_id)
            if peer_node is None or peer_node.element_kind != "programmable_pulse_generator":
                continue
            derived = "HIGH" if peer.target_object_id in ppg_gate_high else "LOW"
            break
        switch_ttl_states[node.object_id] = derived or manual

    signal_at_port: dict[str, RfSignalState] = {}
    queue: deque[tuple[str, RfSignalState]] = deque()

    # Seed every rf_source rf_out anchor. Persisted channels[] entries (matched
    # by anchorName) override the per-port default of 80 MHz / amp 1.0; ports
    # with no explicit channel still emit so multi-channel chains where only
    # CH0 was edited keep driving CH1..CH3.
    for node in nodes:
        if node.element_kind != "rf_source":
            continue
        if node.object_id in powered_off:
            continue
        params = node.kind_params or {}
        # Full-scale Vpp is an ASSET coefficient (the authoritative store), with
        # an optional per-instance override in dynamic_sources (tunable). Falls
        # back to the AD9959 default when the asset doesn't specify it.
        ds_fs = _opt_num((node.dynamic_sources or {}).get("fullScaleVpp"))
        asset_fs = _opt_num((node.asset_params or {}).get("fullScaleVpp"))
        full_scale = (
            ds_fs if ds_fs is not None
            else asset_fs if asset_fs is not None
            else AD9959_VPP_FULL_SCALE
        )
        # Channels unified onto the asset model (like optical): per-instance
        # override in dynamic_sources, else asset default_params, else the
        # legacy PhysicsElement.kindParams (pre-unification instances).
        ds_ch = (node.dynamic_sources or {}).get("channels")
        asset_ch = (node.asset_params or {}).get("channels")
        explicit = (
            ds_ch if isinstance(ds_ch, list)
            else asset_ch if isinstance(asset_ch, list)
            else params.get("channels") or []
        )
        persisted: dict[str, tuple[float | None, float]] = {}
        for ch in explicit:
            an = ch.get("anchorName")
            if not an:
                continue
            persisted[an] = (_opt_num(ch.get("frequencyMhz")), _num(ch.get("amplitudeScale"), 0.0))
        seeds: list[tuple[str, float, float]] = []
        for a in node.anchors:
            if a.get("id") != "rf_out":
                continue
            an = _anchor_name(a)
            if an in persisted:
                pf, pamp = persisted[an]
                seeds.append((an, pf if pf is not None else 80.0, pamp))
            else:
                seeds.append((an, 80.0, 1.0))
        # Degenerate fallback: asset has no anchor metadata -> use channels[].
        if not seeds:
            for ch in explicit:
                an = ch.get("anchorName")
                if not an:
                    continue
                seeds.append((an, _num(ch.get("frequencyMhz"), 0.0), _num(ch.get("amplitudeScale"), 0.0)))
        for an, freq, amp in seeds:
            signal = RfSignalState(
                frequency_mhz=freq,
                vpp=amp * full_scale,
                source_object_id=node.object_id,
                source_anchor_name=an,
                cumulative_gain_db=0.0,
                passthrough_object_ids=(),
                saturated=False,
            )
            sk = port_key(node.object_id, an)
            signal_at_port[sk] = signal
            queue.append((sk, signal))

    # BFS, first-arrival-wins (no superposition / combiner modelling yet).
    while queue:
        key, signal = queue.popleft()
        neighbors = adj.get(key)
        if not neighbors:
            continue
        for peer in neighbors:
            peer_key = port_key(peer.target_object_id, peer.target_anchor_name)
            if peer_key in signal_at_port:
                continue
            signal_at_port[peer_key] = signal
            peer_node = node_by_id.get(peer.target_object_id)
            if peer_node is None:
                continue
            transfer = _lookup_passthrough(peer_node.element_kind)
            if transfer is None:
                continue
            outputs = transfer(
                incoming=signal,
                kind_params=_resolved_params(peer_node),
                anchors=peer_node.anchors,
                object_id=peer.target_object_id,
                switch_ttl_states=switch_ttl_states,
                powered_off=powered_off,
            )
            if not outputs:
                continue
            for out_name, outgoing in outputs:
                out_key = port_key(peer.target_object_id, out_name)
                if out_key in signal_at_port:
                    continue
                signal_at_port[out_key] = outgoing
                queue.append((out_key, outgoing))

    return RfPropagationResult(
        signal_at_port=signal_at_port,
        connected_ports=frozenset(adj.keys()),
        ppg_gate_high_object_ids=frozenset(ppg_gate_high),
    )


# ---------------------------------------------------------------------------
# DB load + hydrate
# ---------------------------------------------------------------------------

def _primary_asset_id(
    comp: Component, bindings: list[ComponentBinding],
) -> object | None:
    """The Component's main-geometry asset id — binding-aware.

    Exact port of the frontend ``componentBindings.primaryAsset``:
      1. single root ``target_kind='asset'`` binding -> that asset_3d_id;
      2. else legacy ``Component.asset_3d_id`` (pre-binding scenes).
    Returns ``None`` for composite Components (multi-root / subcomponent
    root) — the RF graph only seeds single-asset devices. Parity note:
    primaryAsset takes no per-instance override, so this deliberately
    ignores ``ObjectBinding.asset_3d_id_override`` (FE does the same).
    """
    roots = [b for b in bindings if b.parent_binding_id is None]
    if len(roots) == 1 and roots[0].target_kind == "asset" and roots[0].asset_3d_id:
        return roots[0].asset_3d_id
    return comp.asset_3d_id if comp.asset_3d_id else None


async def load_rf_inputs(session: AsyncSession) -> RfInputs:
    """Read the live scene once and project it to pure :class:`RfInputs`.

    Bulk selects (no N+1): one query each for objects, physics elements, device
    states, components, assets, timing programs.
    """
    so_rows = (await session.scalars(select(SceneObject))).all()
    pe_rows = (await session.scalars(select(PhysicsElement))).all()
    ds_rows = (await session.scalars(select(DeviceState))).all()
    comp_rows = (await session.scalars(select(Component))).all()
    asset_rows = (await session.scalars(select(Asset3D))).all()
    cb_rows = (await session.scalars(select(ComponentBinding))).all()
    tp_rows = (await session.scalars(select(TimingProgram))).all()

    pe_by_obj = {pe.object_id: pe for pe in pe_rows}
    comp_by_id = {c.id: c for c in comp_rows}
    asset_by_id = {a.id: a for a in asset_rows}
    bindings_by_comp: dict[object, list[ComponentBinding]] = {}
    for b in cb_rows:
        bindings_by_comp.setdefault(b.component_id, []).append(b)
    powered_off = frozenset(
        ds.object_id for ds in ds_rows
        if isinstance(ds.state, dict) and ds.state.get("power") is False
    )
    programs_by_id = {str(tp.id): list(tp.intervals or []) for tp in tp_rows}

    nodes: list[RfNode] = []
    aoms: list[AomPort] = []
    for so in so_rows:
        pe = pe_by_obj.get(so.id)
        if pe is None:
            continue  # no physics element -> not part of the RF graph
        comp = comp_by_id.get(so.component_id)
        asset_id = (
            _primary_asset_id(comp, bindings_by_comp.get(comp.id, []))
            if comp is not None
            else None
        )
        asset = asset_by_id.get(asset_id) if asset_id else None
        anchors = tuple(asset.anchors or []) if asset is not None else ()
        asset_params = (asset.default_params or {}) if asset is not None else {}
        props = so.properties if isinstance(so.properties, dict) else {}
        rf_cable_endpoints = props.get("rfCableEndpoints")
        ppg_attachment = props.get("ppgAttachment")
        dynamic_sources = so.dynamic_sources if isinstance(so.dynamic_sources, dict) else {}
        node = RfNode(
            object_id=str(so.id),
            element_kind=pe.element_kind,
            kind_params=pe.kind_params or {},
            anchors=anchors,
            rf_cable_endpoints=rf_cable_endpoints if isinstance(rf_cable_endpoints, dict) else None,
            ppg_attachment=ppg_attachment if isinstance(ppg_attachment, dict) else None,
            asset_params=asset_params if isinstance(asset_params, dict) else {},
            dynamic_sources=dynamic_sources,
        )
        nodes.append(node)
        if pe.element_kind == "aom":
            rf_in = _find_anchor_by_role(anchors, "rf_in")
            if rf_in is not None:
                aoms.append(AomPort(
                    object_id=str(so.id),
                    rf_in_anchor_name=_anchor_name(rf_in),
                    manual=(props.get("aomRfDriveMode") == "manual"),
                ))

    return RfInputs(
        nodes=tuple(nodes),
        programs_by_id=programs_by_id,
        powered_off=powered_off,
        aoms=tuple(aoms),
    )


def _snapshot_at(
    starts: list[float],
    snapshots: list[RfPropagationResult],
    rest: RfPropagationResult,
    t_ns: float | None,
) -> RfPropagationResult:
    """Snapshot valid at ``t_ns`` (``None`` -> rest snapshot)."""
    if t_ns is None or not math.isfinite(t_ns):
        return rest
    n = len(snapshots)
    if n == 0:
        return rest
    if t_ns <= starts[0]:
        return snapshots[0]
    lo, hi = 0, n - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if starts[mid] <= t_ns:
            lo = mid
        else:
            hi = mid - 1
    return snapshots[lo]


def resolve_aom_rf_drive(inputs: RfInputs, scrub_time_ns: float | None) -> dict[str, dict]:
    """Pure resolver: ``{aom_object_id: {aomFreqMhz, rfDrivePowerW}}``.

    An AOM in manual mode is skipped (its drive lives in dynamic_sources). An
    AOM with NOTHING plugged into its ``rf_in`` is skipped too, keeping its
    rated ``centerFreqMhz`` / rated drive. Once something IS plugged in, the RF
    link is the authority: an AOM gated off at this instant (switch routed away
    / source silent / source powered off) gets ``{rfDrivePowerW: 0}`` so the
    Bragg op produces no diffraction.

    Wiredness is topological on purpose. Deciding it from "does some section
    deliver a carrier" made a cabled-but-always-silent AOM look unwired, so it
    fell back to the rated drive and kept diffracting a full sideband fan with
    no RF anywhere in the chain.
    """
    starts = collect_section_starts(inputs.programs_by_id)
    snapshots = [
        build_rf_propagation(inputs, scrub_time_ns=s, idle_rest_mode=False)
        for s in starts
    ]
    rest = build_rf_propagation(inputs, scrub_time_ns=0.0, idle_rest_mode=True)
    snapshot = _snapshot_at(starts, snapshots, rest, scrub_time_ns)

    out: dict[str, dict] = {}
    for aom in inputs.aoms:
        if aom.manual:
            continue
        key = port_key(aom.object_id, aom.rf_in_anchor_name)
        if key not in snapshot.connected_ports:
            continue
        sig = snapshot.signal_at_port.get(key)
        if sig is not None and sig.vpp > 0.0:
            out[aom.object_id] = {
                "aomFreqMhz": sig.frequency_mhz,
                "rfDrivePowerW": vpp_to_power_w(sig.vpp),
            }
        else:
            # Gated OFF at this instant -> no RF -> eta = 0 (beam passes through).
            out[aom.object_id] = {"rfDrivePowerW": 0.0}
    return out


async def hydrate_aom_rf_drive(
    session: AsyncSession, scrub_time_ns: float | None = None,
) -> dict[str, dict]:
    """Resolve every AOM's effective RF drive from the live scene.

    Returns ``{aom_scene_object_id: {aomFreqMhz, rfDrivePowerW}}`` — exactly the
    dynamic-key dict ``load_anchor_scene_from_db`` merges onto each slot and the
    AOM anchor op reads. ``scrub_time_ns=None`` samples the rest snapshot.
    """
    inputs = await load_rf_inputs(session)
    return resolve_aom_rf_drive(inputs, scrub_time_ns)
