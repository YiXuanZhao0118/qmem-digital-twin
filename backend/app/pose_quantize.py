"""Pose quantization — snap float dust to the authored resolution.

A rotation decomposed from a quaternion / rotation matrix, or a position
carried through a chain of transforms, comes back carrying double-precision
residue: an angle that is *exactly* 0° reads as ``-8.995967132789893e-15``,
a 12 mm offset as ``12.000000000000002``. Nothing physical cares about a
1e-14° tilt, but it does leak into the DB, into every UI number field and
into every diff, and it breaks "is this pose still identity?" comparisons.

``docs/objectives.md`` fixes the accuracy budget at **O-1 1 µm** and
**O-2 0.1 µrad**, so the grid here is deliberately far finer than either:

* ``POSITION_DECIMALS_MM = 6`` → 1 nm, 1000× below the 1 µm budget
* ``ANGLE_DECIMALS_DEG = 9``   → 1e-9° = 1.75e-11 rad, ~5700× below 0.1 µrad

Invariants:
  * the grid is COARSER than double dust at these magnitudes (~1e-13 for
    |angle| ≤ 360, ~1e-12 for |position| ≤ 1e4 mm), so residue snaps to an
    exact ``0.0``;
  * the grid is FINER than anything physically meaningful, so quantizing
    never consumes O-1 / O-2 budget;
  * ``-0.0`` is normalized to ``0.0`` — the sign of a zero is never data.

Applied at every write choke point: the SceneObject / ComponentBinding
pydantic schemas (:mod:`app.schemas`) and the relation solver's Euler
decomposition (:func:`app.assembly_solver.euler_from_matrix`). The frontend
mirrors this in ``frontend/src/optical/poseQuantize.ts`` — keep the two in
step.
"""

from __future__ import annotations

import math
from typing import overload

POSITION_DECIMALS_MM = 6
ANGLE_DECIMALS_DEG = 9


def _quantize(value: float | None, decimals: int) -> float | None:
    if value is None:
        return None
    value = float(value)
    if not math.isfinite(value):
        return value
    # Decimal rounding (not ``round(v / q) * q``) — multiplying back by a
    # non-representable quantum would reintroduce the dust we just removed.
    # ``+ 0.0`` turns a resulting ``-0.0`` into ``0.0``.
    return round(value, decimals) + 0.0


@overload
def quantize_mm(value: float) -> float: ...
@overload
def quantize_mm(value: None) -> None: ...
def quantize_mm(value: float | None) -> float | None:
    """Snap a millimetre length onto the 1 nm grid."""
    return _quantize(value, POSITION_DECIMALS_MM)


@overload
def quantize_deg(value: float) -> float: ...
@overload
def quantize_deg(value: None) -> None: ...
def quantize_deg(value: float | None) -> float | None:
    """Snap an angle in degrees onto the 1e-9° grid."""
    return _quantize(value, ANGLE_DECIMALS_DEG)
