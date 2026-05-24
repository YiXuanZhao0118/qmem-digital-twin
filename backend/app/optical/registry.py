"""Kind Registry — Python mirror of frontend/src/optical/registry.ts.

Each op is a callable: (BeamRay, PhysicsOpContext) -> list[BeamRay].
Pure functions, no I/O, no side effects.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Optional, Union

from .beam_ray import BeamRay, Vec3


# ---------------------------------------------------------------------------
# Public types
# ---------------------------------------------------------------------------

# OpticalKind taxonomy (string aliases for clarity)
OpticalKind = str  # one of {"lens", "mirror", "polarizer", ...}


@dataclass(frozen=True)
class Face:
    id: str
    position_mm_body_local: Vec3
    normal_body_local: Optional[Vec3] = None
    aperture_mm: float = 0.0
    aperture_shape: str = "rectangle"   # "rectangle" | "ellipse" | "circle"


# Transfer matrix: 2x2, separate xy, or full 5x5. Each as tuple-of-tuples
# (immutable) so it can be hashed / compared.
TransferMatrix = Union[
    tuple[str, tuple[tuple[float, ...], ...]],   # ("abcd", ((A,B),(C,D)))
    tuple[str, tuple[tuple[float, ...], ...], tuple[tuple[float, ...], ...]],  # ("abcdXY", Mx, My)
    tuple[str, tuple[float, ...]],                # ("matrix5x5", (25 floats,))
]


KindParams = dict[str, object]
DynamicSources = dict[str, object]


@dataclass(frozen=True)
class PhysicsOpContext:
    face_in: Face
    face_out: Face
    params: KindParams
    dynamic: Optional[DynamicSources] = None
    transfer_matrix: Optional[TransferMatrix] = None
    # Internal face chain for multi-hop reflective elements (see
    # asset-physics-model.md §3.3). Empty tuple = 2-port slab.
    # Tracer applies mirror at B*-prefixed faces, Snell at A*-prefixed.
    face_via: tuple[Face, ...] = ()


PhysicsOp = Callable[[BeamRay, PhysicsOpContext], list[BeamRay]]


@dataclass
class KindEntry:
    ops: dict[str, PhysicsOp] = field(default_factory=dict)
    needs_aperture: bool = True
    default_wavelength_range_nm: Optional[tuple[float, float]] = None


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

_REGISTRY: dict[OpticalKind, KindEntry] = {}


def register_kind(kind: OpticalKind, entry: KindEntry) -> None:
    if kind in _REGISTRY:
        raise ValueError(f'kind "{kind}" already registered')
    _REGISTRY[kind] = entry


def register_ops(kind: OpticalKind, ops: dict[str, PhysicsOp]) -> None:
    """Add additional ops to an already-registered kind. Used by variant
    modules (e.g. glan-laser adds glan_transmit_p / glan_reject_s under
    the existing polarizer kind)."""
    entry = _REGISTRY.get(kind)
    if entry is None:
        raise KeyError(
            f'register_ops: kind "{kind}" not registered yet — '
            f'import its base module first'
        )
    for name, op in ops.items():
        if name in entry.ops:
            raise ValueError(
                f'register_ops: op "{name}" already registered under kind "{kind}"'
            )
        entry.ops[name] = op


def get_op(kind: OpticalKind, op_name: str) -> PhysicsOp:
    entry = _REGISTRY.get(kind)
    if entry is None:
        raise KeyError(f'kind "{kind}" not registered')
    op = entry.ops.get(op_name)
    if op is None:
        raise KeyError(f'op "{op_name}" not found in kind "{kind}"')
    return op


def has_op(kind: OpticalKind, op_name: str) -> bool:
    entry = _REGISTRY.get(kind)
    return entry is not None and op_name in entry.ops


def list_registered_kinds() -> list[OpticalKind]:
    return list(_REGISTRY.keys())


def _clear_registry_for_tests() -> None:
    _REGISTRY.clear()
