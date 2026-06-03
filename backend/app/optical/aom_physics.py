"""Shared AOM physics — pure functions used by BOTH the production anchor op
(``anchor_ops/aom.py``) and the v3 kind op (``kinds/aom/physics.py``) so the
two trace paths can't drift apart.

Pure math only: no op-context types here. Callers extract the primitives
(incidence angle, wavelength, RF frequency, params) and pass them in.
"""

from __future__ import annotations

import math


def clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def bragg_detuning_sinc2(
    dtheta_ext_rad: float,
    wavelength_nm: float,
    freq_mhz: float,
    v_acoustic: float,
    n: float,
    l_mm: float,
) -> float:
    """sinc^2 Bragg phase-matching factor for off-axis incidence.

    Thick-grating coupled-wave theory: diffraction efficiency scales as
    sinc^2(dk*L/2), where dk is the longitudinal wave-vector mismatch produced
    by deviating from the matched (on-axis) incidence angle:

        K       = 2*pi*f / v                 (acoustic grating vector, 1/m)
        theta_B = asin(lambda*f / (2*n*v))   (internal Bragg angle)
        dk      = K * cos(theta_B) * (dtheta_ext / n)   (Snell to internal)
        xi      = dk * L / 2
        factor  = (sin xi / xi)^2            (-> 1 as xi -> 0)

    On-axis incidence (dtheta_ext = 0) returns 1.0 exactly. As the beam (or the
    AOM) tilts away from match, the factor falls — so rotating the AOM lowers
    the diffraction efficiency.
    """
    if dtheta_ext_rad == 0.0:
        return 1.0
    if v_acoustic <= 0.0 or freq_mhz <= 0.0 or l_mm <= 0.0 or n <= 0.0:
        return 1.0
    lambda_m = wavelength_nm * 1e-9
    f_hz = freq_mhz * 1e6
    l_m = l_mm * 1e-3
    k_acoustic = (2.0 * math.pi * f_hz) / v_acoustic
    theta_b_int = math.asin(max(-1.0, min(1.0, (lambda_m * f_hz) / (2.0 * n * v_acoustic))))
    dtheta_int = dtheta_ext_rad / n
    dk = k_acoustic * math.cos(theta_b_int) * dtheta_int
    xi = dk * l_m / 2.0
    if xi == 0.0:
        return 1.0
    return clamp01((math.sin(xi) / xi) ** 2)


def order_efficiency(order: int, first_order_efficiency: float) -> float:
    """Power fraction into diffraction order m given the first-order
    efficiency eta:

        +1 -> eta                (the diffracted order)
         0 -> 1 - eta            (undiffracted leftover; grows as eta drops)
        -1 -> eta * 0.01         (wrong-sign, ~1% suppressed)
      other -> 0
    """
    eta = clamp01(first_order_efficiency)
    if order == 1:
        return eta
    if order == 0:
        return max(0.0, 1.0 - eta)
    if order == -1:
        return eta * 0.01
    return 0.0
