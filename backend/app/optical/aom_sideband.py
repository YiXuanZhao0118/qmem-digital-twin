"""AOM multi-order sideband model — the SINGLE source of truth for per-order
diffraction intensities, ported faithfully from the frontend
``frontend/src/optical/kinds/aom/physics.ts`` (besselJ / phaseModulationDepth /
sidebandIntensitiesOnBragg).

The backend solver computes the sideband table here and returns it; the Object
Panel displays exactly what the solver produced, so the panel table, the drawn
beams, and the trace all agree by construction (no FE/BE drift).

Model:
  - 0 order:        1 - sum(other orders)         (undiffracted leftover)
  - selected ±1:    efficiency                    (closed-form / override η)
  - opposite ±1:    SUPPRESSED_FIRST_ORDER_FLOOR  (residual wrong-sign)
  - |n| >= 2:       J_n(v)^2                       (Raman-Nath, v = phase mod depth)
  - normalised so the total is <= 1.
"""

from __future__ import annotations

import math

# Suppression floor for the wrong-sign ±1 order when the opposite ±1 is selected
# (residual imperfect Bragg matching). Mirrors physics.ts.
SUPPRESSED_FIRST_ORDER_FLOOR = 0.001


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def bessel_j(n: int, x: float) -> float:
    """Bessel function of the first kind, integer order, ascending series.
    Mirrors physics.ts ``besselJ`` (truncates < 1e-16 or after 100 terms)."""
    if n < 0:
        return (1.0 if (-n) % 2 == 0 else -1.0) * bessel_j(-n, x)
    if abs(x) < 1e-12:
        return 1.0 if n == 0 else 0.0
    n_fact = 1
    for i in range(2, n + 1):
        n_fact *= i
    half = x / 2.0
    term = (half ** n) / n_fact
    total = term
    for k in range(1, 100):
        term *= -(half * half) / (k * (n + k))
        total += term
        if abs(term) < 1e-16:
            break
    return total


def phase_modulation_depth(*, first_order_efficiency: float) -> float:
    """Raman-Nath phase-modulation depth v that drives the multi-order spread.

    Tied to the drive: v = 2*sqrt(eta_first), where eta_first is the on-Bragg
    first-order efficiency (already folding RF power + the carrier-frequency
    factor). The spread grows with the RF drive and collapses to v = 0 (only the
    0 order) as eta_first -> 0 — e.g. when the RF is turned off."""
    return 2.0 * math.sqrt(_clamp01(first_order_efficiency))


def sideband_intensities_on_bragg(
    current_order: int,
    efficiency: float,
    phase_mod_depth: float,
    max_order: int,
) -> dict[int, float]:
    """Per-order intensity fractions (on-Bragg). Mirrors physics.ts
    ``sidebandIntensitiesOnBragg``. Returns {order: fraction}, total <= 1."""
    orders = list(range(-max_order, max_order + 1))
    selected_first = 0.0 if current_order == 0 else efficiency

    def fraction_for(order: int) -> float:
        if current_order == 0:
            return 1.0 if order == 0 else 0.0
        if order == current_order:
            return selected_first
        if abs(order) == 1:
            return SUPPRESSED_FIRST_ORDER_FLOOR
        if order == 0:
            return math.nan  # filled in below
        return bessel_j(order, phase_mod_depth) ** 2

    nonzero_sum = 0.0
    out: dict[int, float] = {}
    for o in orders:
        if o == 0:
            continue
        f = fraction_for(o)
        out[o] = f
        nonzero_sum += f
    if nonzero_sum > 1:
        scale = 1.0 / nonzero_sum
        out = {k: v * scale for k, v in out.items()}
        nonzero_sum = 1.0
    out[0] = max(0.0, 1.0 - nonzero_sum)
    return out
