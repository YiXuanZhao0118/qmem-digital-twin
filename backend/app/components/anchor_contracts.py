"""Per-component-type anchor contracts.

Mirrors the per-ElementKind `KIND_REGISTRY` pattern in
`frontend/src/kinds/_registry.ts`, but at the **component_type**
level — needed when one ElementKind (e.g. `rf_source`) covers devices
with different physical port layouts (single-channel synth vs. 4-channel
AD9959 DDS).

A component_type appearing in this registry has its anchor identity
(id + name + count) **locked**: the PHY Editor hides the +Add / Delete
buttons and the id `<select>`, and the `upsert_*` scripts seed the
asset's `anchors[]` from this single source of truth so a stale dataset
can be rebuilt deterministically. Anchor **position/direction** stay
editable so the user can drag them onto the real STL geometry.

The frontend mirror lives at
`frontend/src/components/componentAnchorContracts.ts` and must be kept
in sync. There is no automated consistency check yet — review the two
files together when editing.
"""

from __future__ import annotations

from typing import TypedDict

from app.schemas import AssetAnchorId


class Vec3Dict(TypedDict):
    x: float
    y: float
    z: float


class AnchorTemplate(TypedDict, total=False):
    id: AssetAnchorId
    name: str
    positionMmBodyLocal: Vec3Dict
    directionBodyLocal: Vec3Dict


COMPONENT_ANCHOR_CONTRACTS: dict[str, list[AnchorTemplate]] = {
    # Analog Devices AD9959/PCBZ — 4-channel DDS evaluation board.
    # 4 SMA outputs (CH0..CH3) on the +X edge of the 165.1 x 114.3 x 19.3
    # mm STL mesh (body centred at origin, Z-up). Z=4 mm puts the anchor on
    # top of the 9.65-mm-half-thickness PCB; tweak in PHY Editor to match
    # the actual SMA centre once you eyeball it against the mesh.
    # REF_IN / SYS_IN / SYS_OUT removed 2026-05-13 — the system clock fans
    # in from `dds_tcxo_fanout_module` and sync chaining is handled at the
    # chassis level, not as per-AD9959 anchors.
    "dds_ad9959_pcb": [
        {
            "id": "rf_out",
            "name": "CH0",
            "positionMmBodyLocal": {"x": 82.55, "y": -30.0, "z": 4.0},
            "directionBodyLocal": {"x": 1.0, "y": 0.0, "z": 0.0},
        },
        {
            "id": "rf_out",
            "name": "CH1",
            "positionMmBodyLocal": {"x": 82.55, "y": -10.0, "z": 4.0},
            "directionBodyLocal": {"x": 1.0, "y": 0.0, "z": 0.0},
        },
        {
            "id": "rf_out",
            "name": "CH2",
            "positionMmBodyLocal": {"x": 82.55, "y": 10.0, "z": 4.0},
            "directionBodyLocal": {"x": 1.0, "y": 0.0, "z": 0.0},
        },
        {
            "id": "rf_out",
            "name": "CH3",
            "positionMmBodyLocal": {"x": 82.55, "y": 30.0, "z": 4.0},
            "directionBodyLocal": {"x": 1.0, "y": 0.0, "z": 0.0},
        },
    ],
}


def get_anchor_contract(component_type: str) -> list[AnchorTemplate] | None:
    """Return the locked anchor template list for a component_type, or None
    if the component_type isn't in the registry (= no identity lock)."""
    return COMPONENT_ANCHOR_CONTRACTS.get(component_type)
