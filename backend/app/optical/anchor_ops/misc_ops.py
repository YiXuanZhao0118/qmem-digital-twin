"""Faraday / EOM / tapered_amplifier / terminal-sink ops (Phase 9.3+).

Faraday rotator — single anchor, Jones rotation non-reciprocal in 5×5
sense (axis-fixed rotationDeg regardless of beam direction).

EOM — two regimes on one kind, picked by default_params.modulationKind:
"phase" is a waveplate whose retardance comes from
dynamic_sources.driveVoltageV (linear electro-optic effect), "amplitude"
is a Mach-Zehnder whose drive + bias land on power instead. Orthogonally,
default_params.fiberPigtailed says whether the output is re-emitted as the
output pigtail's fundamental mode (guided) or propagated as a free-space
slab.

Tapered amplifier — single anchor on chip centre; gain on transmit,
output beam with reshaped mode (default_params.outputSpatialModeX/Y).
Backward ASE emission left out of v1 — single-direction forward gain.

Terminal sinks (beam_dump, detector, camera, spectrometer, wavemeter,
horn_antenna): return [] so the segment renders as terminal with no
continuation.
"""

from __future__ import annotations

import math

from app.optical.anchor_tracer import (
    AnchorOpContext,
    apply_slab_state,
    beam_state_from_anchor_hit,
    out_ray_from_state,
    register_anchor_op,
)
from app.optical.beam_ray import (
    BeamRay,
    QMatrix,
    Vec3,
    nonparaxial_fundamental_waist_mm,
    vec3_distance,
)
from app.optical.jones import (
    beam_local_sp,
    jones_rotation_angle,
    q_frame_angle_to_axis,
    sp_rotation_between_directions,
    rotate_jones,
)


def _slab_passthrough(ray_in: BeamRay, ctx: AnchorOpContext) -> BeamRay:
    """Just propagate through a slab of length L/n."""
    y, theta_y, z, theta_z = beam_state_from_anchor_hit(ray_in, ctx.hit)
    L = float(ctx.params.get("lengthMm", 1.0))
    n = float(ctx.params.get("refractiveIndex", 1.5))
    L_over_n = L / n
    y_out, ty_out, z_out, tz_out = apply_slab_state(y, theta_y, z, theta_z, L_over_n)
    out_ray = out_ray_from_state(
        ray_in, ctx.anchor, y_out, ty_out, z_out, tz_out,
        flip_propagation=False,
    )
    return out_ray.replaced(
        qx=complex(ray_in.qx.real + L_over_n, ray_in.qx.imag),
        qy=complex(ray_in.qy.real + L_over_n, ray_in.qy.imag),
        path_length_mm=ray_in.path_length_mm + L,
    )


# ── Faraday rotator ────────────────────────────────────────────────────────

def faraday_anchor_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
    if ctx.anchor.id != "optical_center":
        return [ray_in]
    out_ray = _slab_passthrough(ray_in, ctx)
    rot_deg = float(ctx.params.get("rotationDeg", 45.0))
    # Faraday rotation is fixed about the lab B-field axis (the rod's
    # optical axis = anchor axisX), NOT the beam-local frame. beam_local_sp
    # keeps ŝ but flips p̂ on reversal, so a direction-independent matrix
    # reads as R(−θ) on the return pass and CANCELS the forward rotation —
    # a reciprocal optical-activity rotator that defeats the isolator.
    # Flip θ by the sign of travel along axisX so both passes have the same
    # handedness in lab and a round trip accumulates 2θ (non-reciprocal).
    # Handedness REVERSED 2026-06-12 (per request): forward pass now rotates
    # −rotationDeg about axisX (was +rotationDeg), so both passes are R(−θ)
    # in lab and a round trip accumulates −2θ. Non-reciprocity is unchanged;
    # only the rotation sense is flipped.
    fwd = 1.0 if ray_in.direction.dot(ctx.anchor.axis_x_body) >= 0.0 else -1.0
    theta = -math.radians(rot_deg) * fwd
    c, s = math.cos(theta), math.sin(theta)
    #   E_s' = c·E_s + s·E_p
    #   E_p' = −s·E_s + c·E_p
    es, ep = ray_in.jones
    new_jones = (c * es + s * ep, -s * es + c * ep)
    return [out_ray.replaced(jones=new_jones)]


register_anchor_op("faraday_rotator", faraday_anchor_op)


# ── EOM ────────────────────────────────────────────────────────────────────

def _eom_pigtail_out_ray(
    ray_in: BeamRay, ctx: AnchorOpContext, out_anchor,
) -> BeamRay:
    """Output of a FIBRE-PIGTAILED modulator.

    The light never crosses the package in free space — it is guided from
    the input pigtail through the waveguide to the output pigtail. So the
    exit is the pigtail's fundamental mode at ``intercept_out``: waist =
    coreMfdUm/2 ON the exit face, direction = that anchor's axisX, and the
    incoming tilt / offset erased. Same contract as ``fiber_anchor_op``.

    A slab passthrough would instead diffract a ~5 µm mode across the whole
    package (~100 mm for the EOSpace AZ) and deliver a metre-wide beam to
    the output pigtail — i.e. essentially zero power downstream.
    """
    w0_um = float(ctx.params.get("coreMfdUm", 5.3)) / 2.0
    q_out = _q_at_waist_mm(w0_um, ray_in.wavelength_nm)
    return ray_in.replaced(
        origin=out_anchor.position_body,
        direction=out_anchor.axis_x_body,
        qx=q_out, qy=q_out, qxy=0j,
    )


def _eom_mz_transmission(ctx: AnchorOpContext) -> float:
    """Mach-Zehnder POWER transmission at the current drive + bias.

        φ = π · (V_rf / Vπ_rf  +  V_bias / Vπ_bias)
        T = (1 + m·cos φ) / (1 + m),   m = (r−1)/(r+1),   r = 10^(ER_dB/10)

    Normalised on (1 + m) so T peaks at exactly 1 and bottoms out at 1/r.
    That way the insertion loss the caller applies separately IS the
    datasheet number (which is quoted at peak transmission), and the ratio
    between the two extremes IS the datasheet extinction ratio.
    """
    v_pi = float(ctx.params.get("vPiV", 5.0))
    v_pi_bias = float(ctx.params.get("biasVPiV", v_pi))
    # ctx.params is {**asset.default_params, **dynamic_sources}: the asset
    # carries the baseline, a per-instance knob overrides it.
    phi = math.pi * (
        float(ctx.params.get("driveVoltageV", 0.0)) / max(1e-9, v_pi)
        + float(ctx.params.get("biasVoltageV", 0.0)) / max(1e-9, v_pi_bias)
    )
    r = 10.0 ** (float(ctx.params.get("extinctionRatioDb", 30.0)) / 10.0)
    m = (r - 1.0) / (r + 1.0)
    return (1.0 + m * math.cos(phi)) / (1.0 + m)


def _eom_guided_polarization(
    ray_in: BeamRay,
    ctx: AnchorOpContext,
    exit_anchor,
    out_direction: Vec3,
) -> tuple[tuple[complex, complex], float]:
    """Single-polarization waveguide: keep the TM component, floor the rest.

    The modulated axis is ``intercept_in``'s **axisY** (the kind marks that
    role fastAxis, and a device authors it explicitly — body +Z for a z-cut
    chip lying flat in its housing). The orthogonal component is not guided;
    what survives of it is set by ``polarizationExtinctionRatioDb``, a POWER
    ratio, hence 10^(-PER/20) on the field.

    Returns the outgoing Jones **already in the exit ray's own s/p frame**
    (the guided mode is linear on the exit anchor's axisY, which is not the
    entry frame when the two ports differ) plus the power transmission
    |E_out|²/|E_in|², the Malus factor the caller multiplies into power_mw.
    """
    per_db = float(ctx.params.get("polarizationExtinctionRatioDb", 20.0))
    leak = 10.0 ** (-per_db / 20.0)

    theta_in = q_frame_angle_to_axis(ctx.anchor.axis_y_body, ray_in.direction)
    e_tm, e_te = rotate_jones(ray_in.jones, theta_in)
    guided = (e_tm, e_te * leak)

    mag_in = _jones_mag2(ray_in.jones)
    transmission = (_jones_mag2(guided) / mag_in) if mag_in > 1e-30 else 0.0

    theta_out = q_frame_angle_to_axis(exit_anchor.axis_y_body, out_direction)
    return rotate_jones(guided, -theta_out), transmission


def _eom_is_waveguide(ctx: AnchorOpContext) -> bool:
    """Is this a guided modulator (→ single-polarization) or a bulk crystal?

    A Mach-Zehnder is always a waveguide device, and so is anything with
    pigtails. A bulk phase crystal in a mount is not: it is a retarder and
    must not be polarization-filtered.
    """
    return (
        str(ctx.params.get("modulationKind", "phase")) == "amplitude"
        or bool(ctx.params.get("fiberPigtailed", False))
    )


def eom_anchor_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
    if ctx.anchor.id != "intercept_in":
        return [ray_in]

    # Geometry — guided (pigtailed) or free-space slab. Independent of which
    # modulation regime the part runs.
    exit_anchor = ctx.anchor
    if bool(ctx.params.get("fiberPigtailed", False)):
        out_anchor = next(
            (a for a in ctx.asset.anchors if a.id == "intercept_out"), None
        )
        if out_anchor is None:
            return []          # pigtailed part with no exit port — malformed
        out_ray = _eom_pigtail_out_ray(ray_in, ctx, out_anchor)
        exit_anchor = out_anchor
    else:
        out_ray = _slab_passthrough(ray_in, ctx)

    # Polarization. A guided modulator passes only its TM axis; a bulk
    # crystal is a retarder and must not be filtered.
    jones = ray_in.jones
    pol_t = 1.0
    if _eom_is_waveguide(ctx):
        jones, pol_t = _eom_guided_polarization(
            ray_in, ctx, exit_anchor, out_ray.direction,
        )

    # Insertion loss applies in every regime (kind default 0 dB).
    loss = 10.0 ** (-float(ctx.params.get("insertionLossDb", 0.0)) / 10.0)

    if str(ctx.params.get("modulationKind", "phase")) == "amplitude":
        # Mach-Zehnder: the two arms have already interfered inside the
        # device, so the drive lands on POWER, not on the Jones phase.
        return [out_ray.replaced(
            jones=jones,
            power_mw=ray_in.power_mw * loss * pol_t * _eom_mz_transmission(ctx),
        )]

    # Phase modulation — dynamic retardance from the drive voltage (linear
    # electro-optic effect):  δ = π · V / V_pi
    v_drive = float(ctx.params.get("driveVoltageV", 0.0))
    v_pi = float(ctx.params.get("vPiV", 5.0))
    delta = math.pi * v_drive / max(1e-9, v_pi)
    phase = complex(math.cos(delta), math.sin(delta))
    if _eom_is_waveguide(ctx):
        # One guided mode only — the drive is a COMMON phase on it, not a
        # retardance between two components (there is only one component).
        jones = (jones[0] * phase, jones[1] * phase)
    else:
        e_fast, e_slow = jones
        jones = (e_fast, e_slow * phase)
    return [out_ray.replaced(
        jones=jones,
        power_mw=ray_in.power_mw * loss * pol_t,
    )]


register_anchor_op("eom", eom_anchor_op)


# ── Tapered amplifier ──────────────────────────────────────────────────────

def _jones_mag2(j: tuple[complex, complex]) -> float:
    e0, e1 = j
    return (e0.real * e0.real + e0.imag * e0.imag
            + e1.real * e1.real + e1.imag * e1.imag)


def ta_saturated_power_mw(p_coupled_mw: float, params: dict) -> float:
    """Single-pass saturated gain (see docs/tapered-amplifier-model.md §5):
        P_out = P_sat · ln(1 + (P_coupled / P_sat)·(G0 − 1)),  clamp outputPowerMaxMw.
    Falls back to linear small-signal gain if P_sat is unset."""
    p_sat = float(params.get("saturationPowerMw", 0.0))
    g0 = 10.0 ** (float(params.get("smallSignalGainDb", 30.0)) / 10.0)
    if p_sat > 0.0 and p_coupled_mw > 0.0:
        p_out = p_sat * math.log1p((p_coupled_mw / p_sat) * (g0 - 1.0))
    else:
        p_out = p_coupled_mw * g0
    p_max = float(params.get("outputPowerMaxMw", 0.0))
    if p_max > 0.0:
        p_out = min(p_out, p_max)
    return max(0.0, p_out)


def _samples(params: dict, key: str) -> list[dict]:
    """Measured-table accessor. Returns [] for a missing / malformed table so
    every caller can fall back to the closed-form model."""
    rows = params.get(key)
    if not isinstance(rows, list):
        return []
    return [r for r in rows if isinstance(r, dict)]


def ta_ase_table_mw(
    samples: list[dict], drive_current_ma: float,
) -> tuple[float, float] | None:
    """Interpolate an unseeded-ASE table {driveCurrentMa → (forward, backward)}.

    Linear in drive current, clamped at both ends. Mirrors the frontend's
    ``interpolateAse`` (rayTrace.ts) so the TA panel's operating-point readout
    and the traced beam agree. Returns None for an empty table.
    """
    if not samples:
        return None
    rows = sorted(samples, key=lambda s: float(s.get("driveCurrentMa", 0.0)))
    fwd = lambda s: float(s.get("forwardPowerMw", 0.0))    # noqa: E731
    bwd = lambda s: float(s.get("backwardPowerMw", 0.0))   # noqa: E731
    if drive_current_ma <= float(rows[0].get("driveCurrentMa", 0.0)):
        return fwd(rows[0]), bwd(rows[0])
    if drive_current_ma >= float(rows[-1].get("driveCurrentMa", 0.0)):
        return fwd(rows[-1]), bwd(rows[-1])
    for prev, cur in zip(rows, rows[1:]):
        c0 = float(prev.get("driveCurrentMa", 0.0))
        c1 = float(cur.get("driveCurrentMa", 0.0))
        if drive_current_ma <= c1:
            t = (drive_current_ma - c0) / (c1 - c0) if c1 > c0 else 0.0
            return (
                fwd(prev) + (fwd(cur) - fwd(prev)) * t,
                bwd(prev) + (bwd(cur) - bwd(prev)) * t,
            )
    return None


def ta_gain_table_mw(
    samples: list[dict], input_power_mw: float, drive_current_ma: float,
) -> tuple[float, float] | None:
    """Interpolate a seeded-gain table {(inputPowerMw, driveCurrentMa) →
    (forward, backward)}.

    Inverse-distance weighting over the 4 nearest samples, with both axes
    normalised by their span so mW and mA contribute comparably. Mirrors the
    frontend's ``interpolateTaGain`` (rayTrace.ts). Returns None for an empty
    table, so the caller falls back to the closed-form saturated gain.
    """
    if not samples:
        return None
    inputs = [float(s.get("inputPowerMw", 0.0)) for s in samples]
    drives = [float(s.get("driveCurrentMa", 0.0)) for s in samples]
    input_scale = max(max(inputs) - min(inputs), 1.0)
    drive_scale = max(max(drives) - min(drives), 1.0)
    weighted = []
    for s, p_in, cur in zip(samples, inputs, drives):
        di = (input_power_mw - p_in) / input_scale
        dc = (drive_current_ma - cur) / drive_scale
        weighted.append((1.0 / max(di * di + dc * dc, 1e-9), s))
    weighted.sort(key=lambda w: w[0], reverse=True)
    top = weighted[:4]
    w_sum = sum(w for w, _s in top)
    if w_sum <= 0.0:
        return None
    return (
        sum(w * float(s.get("forwardPowerMw", 0.0)) for w, s in top) / w_sum,
        sum(w * float(s.get("backwardPowerMw", 0.0)) for w, s in top) / w_sum,
    )


def ta_forward_power_mw(p_coupled_mw: float, params: dict) -> float:
    """Amplified forward power for a coupled seed. Prefers the measured
    ``gainSamples`` table (interpolated at ``driveCurrentMa``) and falls back
    to the closed-form saturated gain when no table is configured."""
    table = ta_gain_table_mw(
        _samples(params, "gainSamples"),
        p_coupled_mw,
        float(params.get("driveCurrentMa", 0.0)),
    )
    if table is not None:
        return max(0.0, table[0])
    return ta_saturated_power_mw(p_coupled_mw, params)


def ta_backward_power_mw(p_coupled_mw: float, params: dict) -> float:
    """Backward (input-facet) power a SEEDED TA radiates back toward the seed
    source. Prefers the measured ``gainSamples`` backward column (interpolated
    at the coupled seed power and ``driveCurrentMa``); with no gain table it
    falls back to the unseeded backward-ASE power so the input facet still
    radiates — flat ``aseBackwardMw`` → ``aseSamples`` @ driveCurrentMa →
    nested ``ase.powerMw``, the same ladder ``emit_ta_ase_rays`` uses for the
    backward facet. Returns 0.0 when nothing configures a backward power."""
    table = ta_gain_table_mw(
        _samples(params, "gainSamples"),
        p_coupled_mw,
        float(params.get("driveCurrentMa", 0.0)),
    )
    if table is not None:
        return max(0.0, table[1])
    if isinstance(params.get("aseBackwardMw"), (int, float)):
        return max(0.0, float(params["aseBackwardMw"]))
    ase_table = ta_ase_table_mw(
        _samples(params, "aseSamples"), float(params.get("driveCurrentMa", 0.0)),
    )
    if ase_table is not None:
        return max(0.0, ase_table[1])
    ase = params.get("ase") if isinstance(params.get("ase"), dict) else {}
    return max(0.0, float(ase.get("powerMw", 0.0) or 0.0))


def _gaussian_waist_mm(q: complex, wavelength_nm: float) -> float:
    """Beam radius w at the facet from the complex q-parameter:
    1/q = 1/R − iλ/(πw²)  ⇒  w² = λ·|q|² / (π·Im q). Returns +inf when the
    mode is ill-defined (Im q ≤ 0) so a degenerate seed couples nothing."""
    im = q.imag
    if im <= 0.0 or wavelength_nm <= 0.0:
        return math.inf
    lam_mm = wavelength_nm * 1e-6
    return math.sqrt(lam_mm * (q.real * q.real + im * im) / (math.pi * im))


def _overlap_1d(w_seed: float, w_mode: float, offset_mm: float) -> float:
    """Power coupling between two 1-D Gaussians of waists ``w_seed`` /
    ``w_mode`` with a transverse ``offset``:
        η = [2·w1·w2/(w1²+w2²)] · exp(−2·d²/(w1²+w2²)).
    Captures waist mismatch (focus / divergence) and lateral misalignment —
    the two dominant terms in the TA-input overlap integral."""
    if not math.isfinite(w_seed) or w_seed <= 0.0 or w_mode <= 0.0:
        return 0.0
    sum_sq = w_seed * w_seed + w_mode * w_mode
    match = 2.0 * w_seed * w_mode / sum_sq
    return match * math.exp(-2.0 * offset_mm * offset_mm / sum_sq)


def _mode_match_eta(ray_in: BeamRay, ctx: AnchorOpContext) -> float:
    """Overlap integral η between the seed beam and the TA input waveguide
    mode (≈1 µm × 3 µm ridge). Computed as the separable product of the two
    transverse 1-D overlaps — seed waist (from qx/qy) vs the kind's
    ``inputSpatialModeX/Y.waistUm``, with the lateral offset taken from the
    anchor hit. Returns η ∈ [0, 1]; uncoupled field becomes radiation modes
    (lost).

    FRAME (Step 2b): the waveguide mode and the hit offsets live in the
    anchor's (axisY, axisZ) basis while the ray carries Q in the beam-local
    (s, p) one, so the seed is rotated into the anchor basis before the
    overlap. Before 2b the two were silently identified — the "seed-X ↔
    mode-X" approximation this docstring used to claim — which is wrong by
    the roll angle between the emitter and the amplifier.

    Remaining approximation: a seed whose astigmatism axes are rotated
    relative to the mode (``q_seed.xy != 0``) is not separable, and only the
    anchor-frame diagonal is used. Likewise ``m2x``/``m2y`` are scalar
    per-axis and do not rotate (see the Step 2c note in optics.md); harmless
    while the two axes share an M²."""
    p = ctx.params
    wl = float(p.get("centerWavelengthNm", ray_in.wavelength_nm or 780.0))
    mode_x = (p.get("inputSpatialModeX") or {})
    mode_y = (p.get("inputSpatialModeY") or {})
    wm_x = float(mode_x.get("waistUm", 0.0)) / 1000.0
    wm_y = float(mode_y.get("waistUm", 0.0)) / 1000.0
    if wm_x <= 0.0 or wm_y <= 0.0:
        return 1.0  # mode unspecified — skip the penalty rather than zero out

    # Real seed waist = non-paraxial fundamental width × transverse-mode
    # factor (mode_factor = width_mult / √M²). Non-paraxial so a high-NA seed
    # (tight TA facet / fiber-fed) couples with the correct, bounded spot.
    # Rotate the WHOLE transverse state (Q + both readout tensors) into the
    # anchor basis in one call, so the multipliers cannot end up scaling a
    # different axis than the q they belong to.
    seed = ray_in.rotated_frame(
        q_frame_angle_to_axis(ctx.anchor.axis_y_body, ray_in.direction),
    )
    mode_fac_x = seed.width_mult_x / math.sqrt(seed.m2x) if seed.m2x > 0 else seed.width_mult_x
    mode_fac_y = seed.width_mult_y / math.sqrt(seed.m2y) if seed.m2y > 0 else seed.width_mult_y
    w_seed_x = nonparaxial_fundamental_waist_mm(seed.qx.real, seed.qx.imag, seed.m2x, wl)[0] * mode_fac_x
    w_seed_y = nonparaxial_fundamental_waist_mm(seed.qy.real, seed.qy.imag, seed.m2y, wl)[0] * mode_fac_y
    _, off_y, _, off_z = beam_state_from_anchor_hit(ray_in, ctx.hit)
    eta = _overlap_1d(w_seed_x, wm_x, off_y) * _overlap_1d(w_seed_y, wm_y, off_z)
    return max(0.0, min(1.0, eta))


def _jones_in_axis_basis(
    ray_in: BeamRay, axis_y: Vec3, dir_body: Vec3,
) -> tuple[complex, complex]:
    """Re-express the incoming Jones vector (stored in the beam-local s/p
    frame) in the anchor's (axisY, axisZ) basis, so component [0] is the TE
    (gain-axis) field and [1] is the TM field."""
    s_current, _ = beam_local_sp(dir_body)
    phi = jones_rotation_angle(s_current, axis_y, dir_body)
    return rotate_jones(ray_in.jones, phi)


def _q_at_waist_mm(
    w0_um: float, wavelength_nm: float, m2: float = 1.0, z_offset_mm: float = 0.0,
) -> complex:
    """Embedded-Gaussian q, same contract as ``emit_laser_source._q_at_waist_mm``.

    z_R is reduced by M² (``zR = pi*w0^2/(M2*lam)``) so the EMBEDDED fundamental
    Gaussian carried in q diverges at the real, M²-enhanced rate; the real width
    is recovered at readout via ``BeamRay.width_mult_*``. ``Re(q) = -z_offset``
    puts the waist ``z_offset`` mm downstream of the emit point, so a negative
    offset describes a beam already past its (possibly virtual) waist.
    """
    if w0_um <= 0.0 or wavelength_nm <= 0.0:
        return complex(0.0, 0.0)
    w0_mm = w0_um / 1000.0
    lam_mm = wavelength_nm * 1e-6
    m2_eff = m2 if (m2 and m2 > 0.0) else 1.0
    return complex(-z_offset_mm, math.pi * w0_mm * w0_mm / (m2_eff * lam_mm))


def tapered_amplifier_anchor_op(
    ray_in: BeamRay, ctx: AnchorOpContext,
) -> list[BeamRay]:
    """Seeded forward amplification (A→B). The amount of amplification depends
    on four physical factors (see docs/tapered-amplifier-model.md):

    1. Polarization — TE selection by the quantum-well strain. Only the seed
       component along the gain axis (anchor **axisY** = TE) is amplified; the
       orthogonal (TM) component sees ~no gain. ``frac_te`` is computed by
       re-expressing the seed Jones in the anchor (axisY, axisZ) basis.
    2. Seed intensity — gain saturation ``P_out = P_sat·ln(1+(P_c/P_sat)(G0−1))``.
       Weak seed → linear, poor extraction, high ASE; strong seed → saturated,
       max output, ASE suppressed.
    3. Mode matching — overlap integral ``η`` between the seed beam and the
       input-facet waveguide mode (waist mismatch + lateral offset).
    4. Current-driver quality — a steady-state extraction-efficiency factor
       ``driverQualityFactor`` ∈ [0,1]. NOTE: the *dynamic* driver effects
       (α-parameter AM→PM noise, self-focusing / filamentation, M² collapse)
       are time-/M²-domain phenomena not representable in this steady-state
       Gaussian trace — they belong to the §9 time-domain module.

    Coupled seed power = ``P_in · frac_te · η``. The output is linearly
    polarized along the gain axis (axisY) with a finite extinction leak, and
    its transverse mode is reshaped to ``outputSpatialModeX/Y``.

    A seeded TA ALSO re-emits from its INPUT facet, back along the seed path
    (``_backward_reemission``, tagged ``emission_key="backward"``): power from
    the measured ``gainSamples`` backward column at the coupled seed power,
    profile from ``inputSpatialModeX/Y`` — the same facet mode the unseeded
    backward ASE carries. The *unseeded* both-facet ASE is still injected
    separately by ``emit_ta_ase_rays`` (decision 6b), and remains suppressed
    for a seeded chip, so exactly one backward beam exists either way.

    GEOMETRY: the amplified beam leaves from the ``intercept_out`` anchor
    along that anchor's outward normal (axisX) — the chip's waveguide sets the
    output direction, so the seed's incidence does NOT steer it and the two
    facets need not be collinear (side-output / shaped TAs). Assets with no
    ``intercept_out`` fall back to the old slab passthrough at ``intercept_in``.
    """
    if ctx.anchor.id != "intercept_in":
        return [ray_in]

    p = ctx.params
    out_anchor = next(
        (a for a in ctx.asset.anchors if a.id == "intercept_out"), None,
    )
    if out_anchor is None:
        out_ray = _slab_passthrough(ray_in, ctx)
        gain_anchor = ctx.anchor
    else:
        # On-axis at the output facet: the amplified beam takes the
        # waveguide's mode, so the seed's transverse offset is not carried
        # through. origin is the anchor position VERBATIM, which makes the
        # self-intersection t exactly 0.0 and therefore rejected by
        # intersect_anchor's t_min — no epsilon nudge needed.
        out_ray = ray_in.replaced(
            origin=out_anchor.position_body,
            direction=out_anchor.axis_x_body,
            path_length_mm=ray_in.path_length_mm + vec3_distance(
                out_anchor.position_body, ctx.anchor.position_body,
            ),
        )
        gain_anchor = out_anchor

    # (1) Polarization: TE = axisY component of the seed.
    jones_local = _jones_in_axis_basis(ray_in, ctx.anchor.axis_y_body, ray_in.direction)
    mag_in = _jones_mag2(ray_in.jones)
    e_te = jones_local[0]
    frac_te = (
        (e_te.real * e_te.real + e_te.imag * e_te.imag) / mag_in
        if mag_in > 1e-30 else 0.0
    )

    # (3) Mode matching: seed↔waveguide overlap integral.
    eta_mode = _mode_match_eta(ray_in, ctx)

    # (2) Gain saturation on the coupled seed power — from the measured
    #     gainSamples table when the asset carries one, else closed-form.
    p_coupled = ray_in.power_mw * frac_te * eta_mode
    p_out = ta_forward_power_mw(p_coupled, p)

    # (4) Current-driver quality: steady-state extraction-efficiency penalty.
    driver_q = float(p.get("driverQualityFactor", 1.0))
    p_out *= max(0.0, min(1.0, driver_q))

    # Output: linearly polarized along the gain axis (axisY) with extinction
    # leak, re-expressed in the OUTPUT ray's beam-local s/p frame.
    leak = math.sqrt(10.0 ** (-float(p.get("polarizationExtinctionDb", 20.0)) / 10.0))
    s_out, _ = beam_local_sp(out_ray.direction)
    phi_out = jones_rotation_angle(gain_anchor.axis_y_body, s_out, out_ray.direction)
    out_jones = rotate_jones((complex(1.0, 0.0), complex(leak, 0.0)), phi_out)

    # Reshape the transverse mode to the chip's output facet (the input beam's
    # q is discarded — the amplified beam takes the waveguide's output mode).
    wl = float(p.get("centerWavelengthNm", ray_in.wavelength_nm or 780.0))
    out_mode_x = (p.get("outputSpatialModeX") or {})
    out_mode_y = (p.get("outputSpatialModeY") or {})
    # All three GaussianMode fields matter: waistUm sizes the mode,
    # waistZOffsetMm places the waist relative to intercept_out (a TA
    # collimated on one axis only leaves the other with a VIRTUAL waist far
    # off the facet), and mSquared sets both the divergence (via q's reduced
    # z_R) and the readout width (via width_mult = sqrt(M2)). Dropping the
    # latter two pinned every TA output to an M2=1 waist sitting exactly on
    # the facet.
    qx_out, qy_out = out_ray.qx, out_ray.qy
    m2x_out, m2y_out = ray_in.m2x, ray_in.m2y
    wmx_out, wmy_out = ray_in.width_mult_x, ray_in.width_mult_y
    if float(out_mode_x.get("waistUm", 0.0)) > 0.0:
        m2x_out = float(out_mode_x.get("mSquared", 1.0) or 1.0)
        qx_out = _q_at_waist_mm(
            float(out_mode_x["waistUm"]), wl, m2x_out,
            float(out_mode_x.get("waistZOffsetMm", 0.0)),
        )
        # TEM00 output facet: mode_factor = 1, so width_mult = sqrt(M2).
        wmx_out = math.sqrt(m2x_out)
    if float(out_mode_y.get("waistUm", 0.0)) > 0.0:
        m2y_out = float(out_mode_y.get("mSquared", 1.0) or 1.0)
        qy_out = _q_at_waist_mm(
            float(out_mode_y["waistUm"]), wl, m2y_out,
            float(out_mode_y.get("waistZOffsetMm", 0.0)),
        )
        wmy_out = math.sqrt(m2y_out)

    # outputSpatialModeX/Y are defined in the OUT anchor's (axisY, axisZ)
    # basis -- and for e.g. the Sacher TA that anchor is perpendicular to the
    # input one, so this is not academic. Build the whole transverse state
    # there, then turn Q and both readout tensors together (Step 2c).
    built = out_ray.replaced(
        jones=out_jones, power_mw=p_out,
        qx=qx_out, qy=qy_out, qxy=0j,
        m2x=m2x_out, m2y=m2y_out, m2xy=0.0,
        width_mult_x=wmx_out, width_mult_y=wmy_out, width_mult_xy=0.0,
    )
    # anchor basis -> the OUTGOING beam frame ...
    built = built.rotated_frame(
        -q_frame_angle_to_axis(gain_anchor.axis_y_body, out_ray.direction),
    )
    # ... then pre-undo the single bend rotation anchor_tracer applies to every
    # op's output, so that pass lands the state exactly where it was built.
    out = [built.rotated_frame(
        sp_rotation_between_directions(out_ray.direction, ray_in.direction),
    )]

    back = _backward_reemission(ray_in, ctx, p_coupled, wl)
    if back is not None:
        out.append(back)
    return out


def _backward_reemission(
    ray_in: BeamRay, ctx: AnchorOpContext, p_coupled_mw: float, wl: float,
) -> BeamRay | None:
    """The seeded TA's INPUT-facet emission, radiated back along the seed path.

    Power comes from the measured ``gainSamples`` backward column at the
    coupled seed power (``ta_backward_power_mw``), so it tracks the seed and
    the drive current. Everything else matches the UNSEEDED backward ASE the
    same facet emits (``emit_ta_ase_rays``): it leaves ``intercept_in`` along
    that anchor's outward axisX, is linearly polarized along the gain axis
    (axisY), and carries the INPUT-facet mode ``inputSpatialModeX/Y`` — so
    downstream mode-matching sees one backward profile whether the chip is
    seeded or not. Returns None when no backward power is configured.
    """
    p_back = ta_backward_power_mw(p_coupled_mw, ctx.params)
    if p_back <= 0.0:
        return None

    in_anchor = ctx.anchor
    back_dir = in_anchor.axis_x_body        # outward normal, back toward the seed
    p = ctx.params
    in_mode_x = (p.get("inputSpatialModeX") or {})
    in_mode_y = (p.get("inputSpatialModeY") or {})

    # Same fallback ladder as ``emit_laser_source._facet_beam``: an axis with no
    # usable waist drops back to the legacy circular guess, so the seeded and
    # unseeded backward beams stay identical for assets declaring neither.
    fallback_w0_um = float((p.get("spatialModeX") or {}).get("waistUm", 250.0))

    def _axis(mode: dict) -> tuple[complex, float, float]:
        w0 = float(mode.get("waistUm", 0.0) or 0.0)
        if w0 <= 0.0:
            return _q_at_waist_mm(fallback_w0_um, wl), 1.0, 1.0
        m2 = float(mode.get("mSquared", 1.0) or 1.0)
        q = _q_at_waist_mm(
            w0, wl, m2, float(mode.get("waistZOffsetMm", 0.0) or 0.0),
        )
        return q, m2, math.sqrt(m2)

    qx_b, m2x_b, wmx_b = _axis(in_mode_x)
    qy_b, m2y_b, wmy_b = _axis(in_mode_y)

    # Linearly polarized along the gain axis with the same extinction leak as
    # the forward output, expressed in the BACKWARD ray's beam-local s/p frame.
    leak = math.sqrt(10.0 ** (-float(p.get("polarizationExtinctionDb", 20.0)) / 10.0))
    s_back, _ = beam_local_sp(back_dir)
    phi_back = jones_rotation_angle(in_anchor.axis_y_body, s_back, back_dir)
    back_jones = rotate_jones((complex(1.0, 0.0), complex(leak, 0.0)), phi_back)

    built = ray_in.replaced(
        origin=in_anchor.position_body,
        direction=back_dir,
        power_mw=p_back,
        jones=back_jones,
        qx=qx_b, qy=qy_b, qxy=0j,
        m2x=m2x_b, m2y=m2y_b, m2xy=0.0,
        width_mult_x=wmx_b, width_mult_y=wmy_b, width_mult_xy=0.0,
        # Tag this one ray so the tracer attributes it to the TA's BACKWARD
        # emission (the forward output keeps "forward"), matching the unseeded
        # ASE facet keys — that is what lets the frontend colour and hide the
        # two independently.
        emission_key="backward",
    )
    # anchor basis -> the backward beam frame, then pre-undo the bend rotation
    # anchor_tracer applies to every op output (same two-step as the forward
    # beam above).
    built = built.rotated_frame(
        -q_frame_angle_to_axis(in_anchor.axis_y_body, back_dir),
    )
    return built.rotated_frame(
        sp_rotation_between_directions(back_dir, ray_in.direction),
    )


register_anchor_op("tapered_amplifier", tapered_amplifier_anchor_op)


# ── Terminal sinks ─────────────────────────────────────────────────────────

def _terminal_sink_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
    """Absorb the beam — no output."""
    return []


register_anchor_op("beam_dump", _terminal_sink_op)
register_anchor_op("detector", _terminal_sink_op)
register_anchor_op("camera", _terminal_sink_op)
register_anchor_op("spectrometer", _terminal_sink_op)
register_anchor_op("wavemeter", _terminal_sink_op)


# ── Nonlinear crystal / saturable absorber (Phase 9.4+; v1 stubs) ──────────

def nonlinear_crystal_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
    """SHG / OPO stub: passthrough, no wavelength conversion in v1."""
    if ctx.anchor.id != "intercept_in":
        return [ray_in]
    return [_slab_passthrough(ray_in, ctx)]


register_anchor_op("nonlinear_crystal", nonlinear_crystal_op)


def saturable_absorber_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
    """Intensity-dependent transmission T(I) = T0 + (Tsat-T0)·I/(I+Isat).
    v1 approximation — beam treated as having intensity = power / (π·w₀²)."""
    if ctx.anchor.id != "intercept_in":
        return [ray_in]
    out_ray = _slab_passthrough(ray_in, ctx)
    T0 = float(ctx.params.get("smallSignalTransmittance", 0.5))
    Tsat = float(ctx.params.get("saturatedTransmittance", 0.95))
    I_sat = float(ctx.params.get("saturationIntensityMwMm2", 100.0))
    # Crude intensity estimate
    I = ray_in.power_mw  # mW (assume unit beam area for v1)
    T = T0 + (Tsat - T0) * I / (I + I_sat)
    return [out_ray.replaced(power_mw=ray_in.power_mw * T)]


register_anchor_op("saturable_absorber", saturable_absorber_op)
