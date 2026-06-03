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


# ---------------------------------------------------------------------------
# RF drive readers (dict-based so both op-context types can call them) and the
# RF-power-dependent first-order (peak) efficiency.
# ---------------------------------------------------------------------------

RF_LOAD_Z_OHM = 50.0


def _finite(v) -> float | None:
    return float(v) if isinstance(v, (int, float)) and math.isfinite(float(v)) else None


def _pos_finite(v) -> float | None:
    n = _finite(v)
    return n if (n is not None and n > 0) else None


def _first(*vs):
    for v in vs:
        if v is not None:
            return v
    return None


def _vpp_to_w(vpp: float, z_ohm: float = RF_LOAD_Z_OHM) -> float:
    return (vpp * vpp) / (8.0 * z_ohm)


def _dbm_to_w(dbm: float) -> float:
    return 10.0 ** ((dbm - 30.0) / 10.0)


def read_rf_frequency_mhz(params: dict, dynamic: dict) -> float:
    """RF drive frequency (MHz). dynamic overrides win over asset params."""
    d, p = dynamic or {}, params or {}
    return (
        _pos_finite(d.get("aomFreqMhz"))
        or _pos_finite(d.get("rfFrequencyMhz"))
        or _pos_finite(d.get("aomRfFreqMhz"))
        or _pos_finite(p.get("aomFreqMhz"))
        or _pos_finite(p.get("centerFreqMhz"))
        or 80.0
    )


def read_rf_drive_power_w(params: dict, dynamic: dict) -> float | None:
    """RF drive power (W), resolved from W / Vpp / dBm in dynamic or params
    (dynamic wins), clamped to rfPowerMaxW. None when no RF drive is given."""
    d, p = dynamic or {}, params or {}
    watts = _first(
        _finite(d.get("rfDrivePowerW")), _finite(d.get("aomRfPowerW")),
        _finite(p.get("rfDrivePowerW")), _finite(p.get("aomRfPowerW")),
    )
    if watts is None:
        vpp = _first(
            _pos_finite(d.get("aomRfVpp")), _pos_finite(d.get("rfVpp")),
            _pos_finite(p.get("aomRfVpp")), _pos_finite(p.get("rfVpp")),
        )
        if vpp is not None:
            watts = _vpp_to_w(vpp)
    if watts is None:
        dbm = _first(
            _finite(d.get("aomRfPowerDbm")), _finite(d.get("rfPowerDbm")),
            _finite(p.get("aomRfPowerDbm")), _finite(p.get("rfPowerDbm")),
        )
        if dbm is not None:
            watts = _dbm_to_w(dbm)
    if watts is None or not math.isfinite(watts) or watts < 0:
        return None
    max_w = _pos_finite(p.get("rfPowerMaxW"))
    return min(watts, max_w) if max_w is not None else watts


def first_order_efficiency(
    wavelength_nm: float,
    theta_b_rad: float,
    *,
    rf_power_w: float | None,
    m2: float | None,
    l_mm: float | None,
    w_mm: float | None,
    base_efficiency: float | None,
    requires_rf_drive: bool,
) -> float:
    """Peak (on-Bragg) first-order diffraction efficiency.

    Precedence MIRRORS the frontend ``diffractionEfficiency`` (physics.ts) so
    the panel readout and the traced beams agree (single model):

      1. requires_rf_drive and no RF power -> 0 (cell off, no diffraction).
      2. An explicit ``base_efficiency`` is the user's measured/calibrated
         override (the panel's "set η directly" checkbox) and WINS — the seeded
         M2/L/W closed form is only a rough proxy, so a datasheet value pinned on
         the asset takes priority.
      3. Otherwise (no override) with full params (RF power + M2 + L + W) use the
         closed form eta = sin^2( (pi*L)/(2*lambda*cos theta_B) * sqrt(2*M2*P/W) ).
      4. Otherwise fall back to the default base efficiency.
    """
    if requires_rf_drive and rf_power_w is None:
        return 0.0
    if base_efficiency is not None and math.isfinite(base_efficiency):
        return clamp01(base_efficiency)
    if (rf_power_w is not None and m2 is not None and l_mm is not None
            and w_mm is not None):
        lambda_m = wavelength_nm * 1e-9
        l_m = l_mm * 1e-3
        w_m = w_mm * 1e-3
        # eta = sin^2( (pi/(lambda*cos)) * sqrt(M2*L*P/(2*W)) )  (Saleh-Teich).
        # L is INSIDE the root (linear). The old form pulled L outside as a
        # (pi*L/2lambda) prefactor, which is sqrt(L^2) under the root -> an extra
        # sqrt(L_metres) ~ 0.04 factor -> eta ~600x too small.
        arg = (math.pi / (lambda_m * math.cos(theta_b_rad))) * math.sqrt(
            (m2 * l_m * rf_power_w) / (2.0 * w_m)
        )
        return clamp01(math.sin(arg) ** 2)
    return 0.85
