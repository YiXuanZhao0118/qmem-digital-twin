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
    """sinc^2 Bragg phase-matching factor for a given angular MISMATCH.

    Thick-grating coupled-wave theory: diffraction efficiency scales as
    sinc^2(dk*L/2), where dk is the longitudinal wave-vector mismatch produced
    by deviating from the matched incidence angle by ``dtheta_ext_rad``:

        K       = 2*pi*f / v                 (acoustic grating vector, 1/m)
        theta_B = asin(lambda*f / (2*n*v))   (internal Bragg angle)
        dk      = K * cos(theta_B) * (dtheta_ext / n)   (Snell to internal)
        xi      = dk * L / 2
        factor  = (sin xi / xi)^2            (-> 1 as xi -> 0)

    Zero mismatch returns 1.0 exactly. The factor is even in the mismatch, so
    callers pass a SIGNED mismatch freely.

    NOTE: the mismatch is measured against the order's Bragg-matched incidence
    (``bragg_matched_incidence_rad``), NOT against the crystal's optical axis —
    use ``bragg_order_detune`` rather than calling this with a raw incidence
    angle. A real AOM peaks when the cell is rotated by theta_B, which is what
    the two functions together encode.
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


def bragg_matched_incidence_rad(order: int, theta_b_rad: float) -> float:
    """Signed external incidence angle at which diffraction order ``order`` is
    Bragg-matched, measured from the plane perpendicular to the acoustic axis
    (positive = the beam leans toward +acoustic).

    Momentum conservation with |k_out| = |k_in| and k_out = k_in + m*K*a_hat:

        k_hat_in . a_hat = -m * K / (2k) = -m * sin(theta_B)
        => theta_in = -m * theta_B

    The diffracted order then leaves at +m*theta_B (the op adds 2*m*theta_B to
    the input direction along +a_hat), giving the familiar symmetric
    in/out geometry. Independent of which face the beam entered — the Bragg
    condition constrains only ``k_hat . a_hat``.

    Mirrors the frontend's ``expectedInputDotD2`` (dot form, D2 = acoustic
    axis) — same convention, angle instead of sine.
    """
    return -float(order) * theta_b_rad


def acoustic_incidence_rad(
    direction: tuple[float, float, float],
    acoustic_axis: tuple[float, float, float],
    optical_axis: tuple[float, float, float],
) -> float | None:
    """Signed incidence angle of a (body-frame) ray direction relative to the
    plane perpendicular to the acoustic axis: ``asin(k_hat . a_hat_perp)``.

    ``a_hat_perp`` is the acoustic direction projected perpendicular to the
    optical axis and normalised — the acoustic axis authored on an asset is
    only nominally perpendicular, and the component along the optical axis
    carries no Bragg geometry.

    Returns None when either vector is degenerate or the acoustic axis is
    parallel to the optical axis (no Bragg plane defined).
    """
    ax = _unit(optical_axis)
    a = _unit(acoustic_axis)
    if ax is None or a is None:
        return None
    par = a[0] * ax[0] + a[1] * ax[1] + a[2] * ax[2]
    perp = _unit((a[0] - ax[0] * par, a[1] - ax[1] * par, a[2] - ax[2] * par))
    if perp is None:
        return None
    d = _unit(direction)
    if d is None:
        return None
    s = d[0] * perp[0] + d[1] * perp[1] + d[2] * perp[2]
    return math.asin(max(-1.0, min(1.0, s)))


def bragg_order_detune(
    order: int,
    theta_in_rad: float,
    theta_b_rad: float,
    wavelength_nm: float,
    freq_mhz: float,
    v_acoustic: float,
    n: float,
    l_mm: float,
) -> float:
    """Phase-matching factor for ONE diffraction order at the actual incidence.

    ``theta_in_rad`` is the signed incidence from ``acoustic_incidence_rad``.
    Order m peaks when the cell is rotated so ``theta_in = -m*theta_B``, and
    falls off as sinc^2 of the residual — so +1 and -1 are matched at opposite
    tilts (2*theta_B apart) and the classic "rotate the AOM for maximum
    diffraction" alignment is reproduced.

    Order 0 is not diffracted, so it carries no phase-matching factor (the ops
    give it whatever power the diffracted orders leave behind).
    """
    if order == 0:
        return 1.0
    mismatch = theta_in_rad - bragg_matched_incidence_rad(order, theta_b_rad)
    return bragg_detuning_sinc2(
        mismatch, wavelength_nm, freq_mhz, v_acoustic, n, l_mm,
    )


def _unit(v: tuple[float, float, float]) -> tuple[float, float, float] | None:
    m = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    if m < 1e-12:
        return None
    return (v[0] / m, v[1] / m, v[2] / m)


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


DEFAULT_PEAK_EFFICIENCY = 0.85
DEFAULT_RF_POWER_FOR_PEAK_W = 2.2
DEFAULT_PEAK_REF_WAVELENGTH_NM = 1100.0
DEFAULT_CENTER_FREQ_MHZ = 80.0
DEFAULT_FREQ_SHIFT_BANDWIDTH_MHZ = 15.0
# exp(-_BW_K) = 0.75 at the band edge (AA MT80 variable-freq: >80% @F0,
# >60% over the +/-band -> edge/centre ~= 0.75).
_BW_K = -math.log(0.75)


def rf_frequency_factor(
    freq_mhz: float, center_mhz: float, half_bandwidth_mhz: float,
) -> float:
    """RF carrier-frequency efficiency factor G(f) in [0, 1]: a Gaussian peaked
    at ``center_mhz``, dropping to ~0.75 at ``center +/- half_bandwidth_mhz``
    (matches the MT80 frequency-shift bandwidth: >80% @F0, >60% over +/-15 MHz).
    A non-positive bandwidth disables the rolloff (returns 1)."""
    if half_bandwidth_mhz <= 0:
        return 1.0
    x = (freq_mhz - center_mhz) / half_bandwidth_mhz
    return math.exp(-_BW_K * x * x)


def rf_power_for_peak_w_at(
    rf_power_for_peak_w: float, peak_ref_wavelength_nm: float, wavelength_nm: float,
) -> float:
    """RF power needed for peak efficiency at ``wavelength_nm``. AA: the power
    for a given efficiency scales as lambda^2, so P_peak(lambda) =
    P_peak_ref * (lambda / lambda_ref)^2."""
    if peak_ref_wavelength_nm <= 0 or rf_power_for_peak_w <= 0:
        return rf_power_for_peak_w
    return rf_power_for_peak_w * (wavelength_nm / peak_ref_wavelength_nm) ** 2


def first_order_efficiency(
    *,
    wavelength_nm: float,
    freq_mhz: float,
    rf_power_w: float | None,
    peak_efficiency: float,
    rf_power_for_peak_w: float,
    peak_ref_wavelength_nm: float,
    center_freq_mhz: float,
    freq_shift_bandwidth_mhz: float,
    requires_rf_drive: bool,
) -> float:
    """On-Bragg first-order diffraction efficiency (before the off-Bragg angle
    detune the caller applies).

    Datasheet-calibrated model (AA MT80-A1.5-IR):
        eta = peak_efficiency * sin^2( (pi/2) * sqrt(P / P_peak(lambda)) ) * G(f)
      - P_peak(lambda) scales as lambda^2 (rf_power_for_peak_w_at).
      - At P = P_peak the sin^2 reaches 1 -> eta = peak_efficiency (the >85%
        nom-90% datasheet peak); P = 0 -> eta = 0; over-driving past P_peak rolls
        back over (sin^2 past pi/2), as the relative-efficiency-vs-RF-power curve
        shows.
      - G(f) is the RF carrier-frequency bandwidth factor (rf_frequency_factor).
      - requires_rf_drive and NO RF source -> 0 (cell off). With no RF source but
        requires_rf_drive False, we assume the rated operating point (P = P_peak)
        so the cell still shows its rated diffraction. An explicit P = 0 (RF
        turned off) gives eta = 0.
    """
    if requires_rf_drive and rf_power_w is None:
        return 0.0
    p_peak = rf_power_for_peak_w_at(
        rf_power_for_peak_w, peak_ref_wavelength_nm, wavelength_nm,
    )
    if p_peak <= 0:
        return 0.0
    # No RF source -> rated operating point (drives to peak). Explicit 0 -> off.
    p_eff = rf_power_w if rf_power_w is not None else p_peak
    nu = (math.pi / 2.0) * math.sqrt(max(0.0, p_eff) / p_peak)
    rel_amp = math.sin(nu) ** 2
    g = rf_frequency_factor(freq_mhz, center_freq_mhz, freq_shift_bandwidth_mhz)
    return clamp01(peak_efficiency * rel_amp * g)
