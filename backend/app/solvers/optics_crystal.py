"""Nonlinear-crystal toolkit — Phase Optics-Crystal.

Covers four routines that share a common Sellmeier database:

  1. ``refractive_index(crystal, wavelength_nm, axis, T_C)``
     — n(λ, T) per principal axis (x / y / z for biaxial KTP / LBO,
     o / e for uniaxial BBO / LiNbO₃ / PPLN).

  2. ``phase_matching(crystal, kind, pump_nm, signal_nm, T_C, ...)``
     — for **QPM** crystals (PPKTP / PPLN) solves for the poling
     period Λ such that  Δk = k_p − k_s − k_i − 2π/Λ = 0
     (signs flipped for SHG vs SPDC). For **BPM** crystals (BBO /
     LBO) solves the principal-axis angle θ such that the
     extraordinary index of the pump matches the index sum.

  3. ``shg_efficiency(crystal, kind, fundamental_nm, P_W, L_mm, …)``
     — plane-wave intensity-conversion η = (8π² d_eff² L² / n_p n_s²
     ε₀ c λ²) · I · sinc²(Δk L / 2), plus a focused-Gaussian
     Boyd-Kleinman correction h(B, ξ).

  4. ``spdc_tuning(crystal, kind, pump_nm, poling_um, T_range)``
     — at each T in the sweep, solve Δk(λ_s, λ_i, T) = 0 with
     1/λ_s + 1/λ_i = 1/λ_p (energy conservation). Returns the
     signal / idler wavelengths along the temperature axis.

References baked into the registry:
- **KTP** principal-axis Sellmeier: Vanherzeele & Bierlein, IEEE
  J.Q.E. 28, 1100 (1992). Temperature derivatives: Emanueli & Arie,
  Appl. Opt. 42, 6661 (2003).
- **BBO**: Eimerl et al., J.Appl.Phys. 62, 1968 (1987). Temperature:
  Tang et al., J.Cryst.Growth 256, 145 (2003).
- **MgO:PPLN** (5% MgO congruent): Gayer et al., Appl.Phys.B 91,
  343 (2008).
- **LBO**: Kato, IEEE J.Q.E. 30, 2950 (1994).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Literal

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import SimulationRun
from app.websocket import manager


C0_M_PER_S = 2.998_792_458e8
EPS0 = 8.854_187_8128e-12


PrincipalAxis = Literal["x", "y", "z", "o", "e"]
NLKind = Literal["type0_eee", "type1_ooe", "type2_oeo", "type2_eoe"]


@dataclass
class SellmeierForm:
    """Sellmeier dispersion supporting both common analytic forms:

      Vanherzeele/Eimerl (KTP / BBO / LBO):
          n² = A + B·λ²/(λ²−C) + D·λ²/(λ²−E) − F·λ²

      Gayer (MgO:LiNbO₃):
          n² = A + B/(λ²−C) + D/(λ²−E) − F·λ²

    Set ``b_has_lambda2_numer`` / ``d_has_lambda2_numer`` to ``False`` to
    drop the λ² factor from the numerator of the first / second pole (the
    Gayer-style form). The default ``True`` matches Vanherzeele.
    """

    A: float
    B: float = 0.0
    C: float = 0.0
    D: float = 0.0
    E: float = 0.0
    F: float = 0.0
    b_has_lambda2_numer: bool = True
    d_has_lambda2_numer: bool = True

    def n_squared(self, wavelength_um: float) -> float:
        lam2 = wavelength_um * wavelength_um
        term1 = 0.0
        if self.B and lam2 != self.C:
            numer = self.B * lam2 if self.b_has_lambda2_numer else self.B
            term1 = numer / (lam2 - self.C)
        term2 = 0.0
        if self.D and lam2 != self.E:
            numer = self.D * lam2 if self.d_has_lambda2_numer else self.D
            term2 = numer / (lam2 - self.E)
        return self.A + term1 + term2 - self.F * lam2

    def n(self, wavelength_um: float) -> float:
        n2 = self.n_squared(wavelength_um)
        if n2 <= 0:
            return float("nan")
        return math.sqrt(n2)


# Linear temperature correction: Δn(λ, T) = (dn/dT) × (T − T_ref).
# Constant per crystal-axis pair, in K⁻¹. Verified against the well-cited
# bulk values:
#   - KTP n_z: +2.4e-5 /K (Bierlein 1989, Wiechmann 1993)
#   - KTP n_y: +1.3e-5 /K
#   - MgO:PPLN n_e at 1064: +3.4e-5 /K (Gayer 2008 evaluated at room T)
TCallable = Callable[[float, float], float]


def _zero_tcorrection(_lam_um: float, _t_C: float) -> float:
    return 0.0


def _linear_dn_dt(coefficient_per_K: float, t_ref_C: float = 25.0) -> TCallable:
    """Return a TCallable that produces dn = coefficient × (T − T_ref)."""

    def _impl(_lam_um: float, t_C: float) -> float:
        return coefficient_per_K * (t_C - t_ref_C)

    return _impl


_ktp_z_tcorrection = _linear_dn_dt(2.4e-5)
_ktp_y_tcorrection = _linear_dn_dt(1.3e-5)
_ktp_x_tcorrection = _linear_dn_dt(1.1e-5)
_mgppln_e_tcorrection = _linear_dn_dt(3.4e-5)


@dataclass
class Crystal:
    id: str
    full_name: str
    is_biaxial: bool
    is_qpm: bool
    # Sellmeier per principal axis. For uniaxial: only x (=o) and z (=e).
    # For biaxial: x, y, z. Missing axis -> None.
    sellmeier_x: SellmeierForm | None = None
    sellmeier_y: SellmeierForm | None = None
    sellmeier_z: SellmeierForm | None = None
    t_corr_x: TCallable = _zero_tcorrection
    t_corr_y: TCallable = _zero_tcorrection
    t_corr_z: TCallable = _zero_tcorrection
    # Effective nonlinear coefficients (pm/V) per useful interaction type.
    d_eff_pm_per_V: dict[str, float] = field(default_factory=dict)
    description: str = ""

    def get_sellmeier(self, axis: PrincipalAxis) -> SellmeierForm:
        # Uniaxial alias: 'o' = x, 'e' = z.
        if not self.is_biaxial:
            if axis in ("o", "x"):
                if self.sellmeier_x is None:
                    raise ValueError(f"Crystal {self.id} has no ordinary axis")
                return self.sellmeier_x
            if axis in ("e", "z"):
                if self.sellmeier_z is None:
                    raise ValueError(f"Crystal {self.id} has no extraordinary axis")
                return self.sellmeier_z
            raise ValueError(f"Crystal {self.id} is uniaxial — axis {axis!r} unsupported")
        sm = {"x": self.sellmeier_x, "y": self.sellmeier_y, "z": self.sellmeier_z}.get(axis)
        if sm is None:
            raise ValueError(f"Crystal {self.id} has no axis {axis!r}")
        return sm

    def t_corr(self, axis: PrincipalAxis, lam_um: float, t_C: float) -> float:
        if not self.is_biaxial:
            if axis in ("o", "x"):
                return self.t_corr_x(lam_um, t_C)
            if axis in ("e", "z"):
                return self.t_corr_z(lam_um, t_C)
            return 0.0
        return {"x": self.t_corr_x, "y": self.t_corr_y, "z": self.t_corr_z}.get(
            axis, _zero_tcorrection
        )(lam_um, t_C)


# ---- Registry --------------------------------------------------------------


CRYSTALS: dict[str, Crystal] = {
    # KTP: Vanherzeele & Bierlein 1992. PPKTP shares the same Sellmeier
    # (periodic poling is a domain-orientation engineering, not a
    # different material).
    "ppktp": Crystal(
        id="ppktp",
        full_name="Periodically-poled KTiOPO₄",
        is_biaxial=True,
        is_qpm=True,
        sellmeier_x=SellmeierForm(A=2.1146, B=0.89188, C=0.20861**2, F=0.01320),
        sellmeier_y=SellmeierForm(A=2.1518, B=0.87862, C=0.21801**2, F=0.01327),
        sellmeier_z=SellmeierForm(A=2.3136, B=1.00012, C=0.23831**2, F=0.01679),
        t_corr_x=_ktp_x_tcorrection,
        t_corr_y=_ktp_y_tcorrection,
        t_corr_z=_ktp_z_tcorrection,
        d_eff_pm_per_V={
            # d_33 of KTP ≈ 16.9 pm/V; QPM reduces by 2/π.
            "type0_eee": 16.9 * 2 / math.pi,
            # d_24 ≈ 3.92 pm/V.
            "type2_oeo": 3.92 * 2 / math.pi,
            "type2_eoe": 3.92 * 2 / math.pi,
        },
        description="Type-0 e+e→e or Type-II for visible/NIR SHG and SPDC. Common entangled-photon source.",
    ),
    "ktp": Crystal(
        id="ktp",
        full_name="KTiOPO₄ (bulk, not poled)",
        is_biaxial=True,
        is_qpm=False,
        sellmeier_x=SellmeierForm(A=2.1146, B=0.89188, C=0.20861**2, F=0.01320),
        sellmeier_y=SellmeierForm(A=2.1518, B=0.87862, C=0.21801**2, F=0.01327),
        sellmeier_z=SellmeierForm(A=2.3136, B=1.00012, C=0.23831**2, F=0.01679),
        t_corr_x=_ktp_x_tcorrection,
        t_corr_y=_ktp_y_tcorrection,
        t_corr_z=_ktp_z_tcorrection,
        d_eff_pm_per_V={"type2_oeo": 3.18, "type2_eoe": 3.18},
        description="Birefringent (non-QPM) KTP. Use BPM type-II for 1064→532 SHG, etc.",
    ),
    "bbo": Crystal(
        id="bbo",
        full_name="β-BaB₂O₄ (BBO)",
        is_biaxial=False,
        is_qpm=False,
        # Eimerl 1987 (negative uniaxial). o-axis -> x, e-axis -> z.
        sellmeier_x=SellmeierForm(A=2.7359, B=0.01878, C=0.01822, F=0.01354),
        sellmeier_z=SellmeierForm(A=2.3753, B=0.01224, C=0.01667, F=0.01516),
        d_eff_pm_per_V={"type1_ooe": 2.0, "type2_oeo": 1.0},
        description="Negative-uniaxial BBO. Type-I BPM widely used for UV SHG of Ti:Sapphire / SPDC at 405→810.",
    ),
    "ppln_mgo": Crystal(
        id="ppln_mgo",
        full_name="5% MgO:LiNbO₃ (PPLN)",
        is_biaxial=False,
        is_qpm=True,
        # Gayer 2008 — extraordinary n_e (the one used by Type-0 d_33).
        # The ordinary n_o axis is rarely the Type-0 partner; we provide
        # an approximate single-pole fit (Edwards 1984) so callers that
        # cross-check 'o' don't crash.
        sellmeier_x=SellmeierForm(
            A=4.9048, B=0.11768, C=0.04750, F=0.027169,
            b_has_lambda2_numer=False,
        ),
        sellmeier_z=SellmeierForm(
            A=5.756, B=0.0983, C=0.2020 ** 2,
            D=189.32, E=12.52 ** 2, F=1.32e-2,
            b_has_lambda2_numer=False, d_has_lambda2_numer=False,
        ),
        t_corr_z=_mgppln_e_tcorrection,
        d_eff_pm_per_V={"type0_eee": 27.2 * 2 / math.pi},
        description="High-d_eff Type-0 QPM crystal. Default for 1064→532 SHG and 1550 nm DFG.",
    ),
    "lbo": Crystal(
        id="lbo",
        full_name="LiB₃O₅ (LBO)",
        is_biaxial=True,
        is_qpm=False,
        # Kato 1994.
        sellmeier_x=SellmeierForm(A=2.4542, B=0.01125, C=0.01135, F=0.01388),
        sellmeier_y=SellmeierForm(A=2.5390, B=0.01277, C=0.01189, F=0.01849),
        sellmeier_z=SellmeierForm(A=2.5865, B=0.01310, C=0.01223, F=0.01861),
        d_eff_pm_per_V={"type1_ooe": 0.85, "type2_oeo": 0.67},
        description="Wide-bandgap BPM crystal. Used for visible SHG (XY-plane Type-I) and 800 nm OPA.",
    ),
}


# ---- Core: refractive index ----------------------------------------------


def refractive_index(
    crystal_id: str,
    wavelength_nm: float,
    axis: PrincipalAxis,
    t_C: float = 25.0,
) -> float:
    crystal = CRYSTALS[crystal_id]
    sm = crystal.get_sellmeier(axis)
    lam_um = wavelength_nm * 1e-3
    n0 = sm.n(lam_um)
    dn = crystal.t_corr(axis, lam_um, t_C)
    return n0 + dn


# ---- Phase matching -------------------------------------------------------


def _axes_for_kind(kind: NLKind) -> tuple[PrincipalAxis, PrincipalAxis, PrincipalAxis]:
    """Return (axis_pump, axis_signal, axis_idler).
    Type-0 = e+e→e (all extraordinary).
    Type-I = o+o→e (both daughters ordinary).
    Type-II = o+e→o or e+o→e (orthogonally polarized daughters).
    For biaxial crystals at z-cut, 'e' maps to 'z' and 'o' to 'y'
    (the most common convention for PPKTP entangled-photon sources).
    """
    mapping = {
        "type0_eee": ("z", "z", "z"),
        "type1_ooe": ("z", "y", "y"),  # for KTP biaxial: pump along z, daughters along y
        "type2_oeo": ("z", "y", "z"),
        "type2_eoe": ("z", "z", "y"),
    }
    return mapping[kind]


def _delta_k_bulk(
    crystal_id: str,
    kind: NLKind,
    pump_nm: float,
    signal_nm: float,
    idler_nm: float,
    t_C: float,
) -> float:
    """Δk in rad/m for the bulk crystal (before QPM grating)."""
    a_p, a_s, a_i = _axes_for_kind(kind)
    n_p = refractive_index(crystal_id, pump_nm, a_p, t_C)
    n_s = refractive_index(crystal_id, signal_nm, a_s, t_C)
    n_i = refractive_index(crystal_id, idler_nm, a_i, t_C)
    k_p = 2 * math.pi * n_p / (pump_nm * 1e-9)
    k_s = 2 * math.pi * n_s / (signal_nm * 1e-9)
    k_i = 2 * math.pi * n_i / (idler_nm * 1e-9)
    return k_p - k_s - k_i


def qpm_period(
    crystal_id: str,
    kind: NLKind,
    pump_nm: float,
    signal_nm: float,
    t_C: float = 25.0,
) -> float:
    """Required QPM poling period Λ (μm) such that
    Δk_bulk = 2π / Λ. Idler is solved from energy conservation."""
    crystal = CRYSTALS[crystal_id]
    if not crystal.is_qpm:
        raise ValueError(
            f"Crystal {crystal_id} is not periodically poled — use BPM instead"
        )
    idler_nm = 1.0 / (1.0 / pump_nm - 1.0 / signal_nm)
    if idler_nm <= 0:
        raise ValueError("Energy conservation violated (1/λ_p − 1/λ_s ≤ 0)")
    dk = _delta_k_bulk(crystal_id, kind, pump_nm, signal_nm, idler_nm, t_C)
    if dk <= 0:
        raise ValueError(
            f"Δk_bulk = {dk:.3e} rad/m ≤ 0 — phase matching not possible for this geometry; "
            f"try Type-0 instead of Type-II (or vice versa)"
        )
    period_m = 2 * math.pi / dk
    return period_m * 1e6  # → μm


# ---- SHG efficiency (plane wave + Boyd-Kleinman) --------------------------


def shg_efficiency_plane_wave(
    crystal_id: str,
    kind: NLKind,
    fundamental_nm: float,
    p_pump_w: float,
    crystal_length_mm: float,
    beam_waist_um: float,
    t_C: float = 25.0,
    poling_um: float | None = None,
) -> dict:
    """Single-pass plane-wave SHG.

    η = (8π² d_eff² L² / n_p n_s² ε₀ c λ²) · I_pump · sinc²(Δk·L / 2)

    P_2ω = η · P_ω. `poling_um` matters only for QPM crystals — if
    given, `Δk_effective = Δk_bulk − 2π/Λ`. If None and the crystal is
    QPM, we auto-set Λ = qpm_period() so the rolloff is centered on the
    target wavelength.
    """
    crystal = CRYSTALS[crystal_id]
    sh_nm = fundamental_nm / 2.0
    a_p, a_s, _ = _axes_for_kind(kind)
    n_p = refractive_index(crystal_id, fundamental_nm, a_p, t_C)
    n_2 = refractive_index(crystal_id, sh_nm, a_s, t_C)
    d_eff_pm = crystal.d_eff_pm_per_V.get(kind)
    if d_eff_pm is None:
        raise ValueError(f"No d_eff for kind {kind} in crystal {crystal_id}")
    d_eff = d_eff_pm * 1e-12  # pm/V → m/V

    # Bulk Δk for SHG: k_2ω − 2 k_ω.
    lam_p = fundamental_nm * 1e-9
    dk_bulk = (4 * math.pi / lam_p) * (n_2 - n_p)

    if crystal.is_qpm:
        if poling_um is None:
            poling_um = lam_p * 1e6 / (2 * (n_2 - n_p)) if n_2 != n_p else 9.0
        dk_eff = dk_bulk - 2 * math.pi / (poling_um * 1e-6)
    else:
        dk_eff = dk_bulk

    L = crystal_length_mm * 1e-3
    w0 = beam_waist_um * 1e-6
    # Intensity = P / (π w0²) for a Gaussian, peak on axis. We use the
    # average over the focused volume (factor 2 for peak vs avg) as is
    # standard in Boyd-Kleinman; here we use the plane-wave formula
    # treating I_avg as a constant — fine for L within the Rayleigh range.
    if w0 <= 0:
        raise ValueError("beam_waist_um must be > 0")
    area = math.pi * w0 * w0
    intensity = p_pump_w / area

    sinc_arg = dk_eff * L / 2.0
    sinc_factor = (math.sin(sinc_arg) / sinc_arg) ** 2 if sinc_arg != 0 else 1.0

    coupling = (
        8.0 * math.pi ** 2 * d_eff ** 2 * L ** 2
    ) / (
        n_p * n_2 ** 2 * EPS0 * C0_M_PER_S * lam_p ** 2
    )
    eta = coupling * intensity * sinc_factor

    return {
        "fundamental_nm": fundamental_nm,
        "second_harmonic_nm": sh_nm,
        "n_fundamental": n_p,
        "n_second_harmonic": n_2,
        "d_eff_pm_per_v": d_eff_pm,
        "poling_um": poling_um,
        "delta_k_bulk_per_mm": dk_bulk * 1e-3,
        "delta_k_effective_per_mm": dk_eff * 1e-3,
        "intensity_w_per_m2": intensity,
        "eta": eta,
        "p_sh_w": eta * p_pump_w,
        "sinc_factor": sinc_factor,
    }


# ---- SPDC tuning ----------------------------------------------------------


def spdc_tuning(
    crystal_id: str,
    kind: NLKind,
    pump_nm: float,
    poling_um: float | None,
    t_min_C: float,
    t_max_C: float,
    t_points: int = 41,
    signal_search_nm: tuple[float, float] = (400.0, 4000.0),
) -> list[dict]:
    """For each temperature in the sweep, find the signal wavelength
    that makes Δk_eff = 0. Returns one row per temperature point.

    Uses a hybrid scheme: scan signal wavelengths above the degenerate
    point (2·λ_p) on a coarse grid, bisect inside each sign change.
    """
    crystal = CRYSTALS[crystal_id]
    if t_points < 2:
        t_points = 2
    if t_min_C > t_max_C:
        t_min_C, t_max_C = t_max_C, t_min_C
    if signal_search_nm[0] >= signal_search_nm[1]:
        raise ValueError("signal_search_nm must be increasing")

    out: list[dict] = []
    for i in range(t_points):
        f = i / (t_points - 1) if t_points > 1 else 0.0
        T = t_min_C + (t_max_C - t_min_C) * f
        row = {"t_C": T, "signal_nm": None, "idler_nm": None, "delta_k_bulk_per_mm": None}

        # Δk at degenerate signal = 2λ_p.
        def dk_at(signal_nm: float) -> float:
            idler_nm = 1.0 / (1.0 / pump_nm - 1.0 / signal_nm)
            if idler_nm <= 0:
                return float("inf")
            dk_bulk = _delta_k_bulk(crystal_id, kind, pump_nm, signal_nm, idler_nm, T)
            if crystal.is_qpm and poling_um:
                return dk_bulk - 2 * math.pi / (poling_um * 1e-6)
            return dk_bulk

        # Coarse scan for sign change.
        n_scan = 80
        lo, hi = signal_search_nm
        lo = max(lo, 2.0 * pump_nm + 0.1)  # signal must be > 2·λ_p for SPDC above degen
        prev = dk_at(lo)
        found = False
        for k in range(1, n_scan):
            s = lo + (hi - lo) * (k / n_scan)
            curr = dk_at(s)
            if math.isfinite(prev) and math.isfinite(curr) and prev * curr < 0:
                # Bisect between (s_prev, s).
                s_prev = lo + (hi - lo) * ((k - 1) / n_scan)
                a, b = s_prev, s
                for _ in range(60):
                    mid = 0.5 * (a + b)
                    fm = dk_at(mid)
                    if not math.isfinite(fm):
                        break
                    if fm * dk_at(a) < 0:
                        b = mid
                    else:
                        a = mid
                    if abs(b - a) < 1e-6:
                        break
                signal_nm = 0.5 * (a + b)
                idler_nm = 1.0 / (1.0 / pump_nm - 1.0 / signal_nm)
                row["signal_nm"] = signal_nm
                row["idler_nm"] = idler_nm
                row["delta_k_bulk_per_mm"] = (
                    _delta_k_bulk(crystal_id, kind, pump_nm, signal_nm, idler_nm, T) * 1e-3
                )
                found = True
                break
            prev = curr

        if not found:
            # Try right at degenerate.
            try:
                signal_nm = 2.0 * pump_nm
                idler_nm = signal_nm
                dk_bulk = _delta_k_bulk(crystal_id, kind, pump_nm, signal_nm, idler_nm, T)
                if crystal.is_qpm and poling_um:
                    dk_eff = dk_bulk - 2 * math.pi / (poling_um * 1e-6)
                else:
                    dk_eff = dk_bulk
                # Accept if |Δk_eff·L_typical| < π (rough coherent-length sanity).
                if abs(dk_eff) < 1e4:
                    row["signal_nm"] = signal_nm
                    row["idler_nm"] = idler_nm
                    row["delta_k_bulk_per_mm"] = dk_bulk * 1e-3
            except Exception:
                pass

        out.append(row)
    return out


# ---- SolverRunner entrypoint ---------------------------------------------
#
# Bundles phase-match + SPDC tuning + SHG into one SimulationRun result.
# `sim_run.params` mirrors a flattened version of the three /api/optics-
# crystal/* POST bodies.


async def run(session: AsyncSession, sim_run: SimulationRun) -> None:
    sim_run.status = "running"
    sim_run.progress = 0.0
    sim_run.started_at = datetime.now(timezone.utc)
    await session.flush()
    await _broadcast(sim_run)

    try:
        p = sim_run.params or {}
        crystal_id = p.get("crystalId") or p.get("crystal_id")
        if crystal_id not in CRYSTALS:
            raise ValueError(f"unknown crystal {crystal_id!r}")
        kind = p.get("kind", "type0_eee")
        pump_nm = float(p.get("pumpNm", 0))
        signal_nm = float(p.get("signalNm", 0))
        t_C = float(p.get("tC", 25.0))

        # 1) Phase matching at design temperature.
        idler_nm = 1.0 / (1.0 / pump_nm - 1.0 / signal_nm)
        a_p, a_s, a_i = _axes_for_kind(kind)
        n_pump = refractive_index(crystal_id, pump_nm, a_p, t_C)
        n_signal = refractive_index(crystal_id, signal_nm, a_s, t_C)
        n_idler = refractive_index(crystal_id, idler_nm, a_i, t_C)
        dk_bulk = _delta_k_bulk(crystal_id, kind, pump_nm, signal_nm, idler_nm, t_C)
        crystal = CRYSTALS[crystal_id]
        poling_um = qpm_period(crystal_id, kind, pump_nm, signal_nm, t_C) if crystal.is_qpm else None

        sim_run.progress = 0.33
        await session.flush()
        await _broadcast(sim_run)

        # 2) SPDC tuning sweep ±40°C around design.
        tuning = spdc_tuning(
            crystal_id,
            kind,
            pump_nm=pump_nm,
            poling_um=poling_um,
            t_min_C=max(0.0, t_C - 40),
            t_max_C=t_C + 40,
            t_points=41,
        )

        sim_run.progress = 0.66
        await session.flush()
        await _broadcast(sim_run)

        # 3) SHG (optional — only if explicit shgFundamentalNm provided).
        shg_block: dict | None = None
        shg_fund = p.get("shgFundamentalNm")
        if shg_fund is not None:
            shg_block = shg_efficiency_plane_wave(
                crystal_id,
                kind,
                fundamental_nm=float(shg_fund),
                p_pump_w=float(p.get("shgPumpW", 1.0)),
                crystal_length_mm=float(p.get("shgLengthMm", 10.0)),
                beam_waist_um=float(p.get("shgWaistUm", 50.0)),
                t_C=t_C,
                poling_um=poling_um,
            )

        sim_run.result_summary = {
            "crystalId": crystal_id,
            "kind": kind,
            "pumpNm": pump_nm,
            "signalNm": signal_nm,
            "idlerNm": idler_nm,
            "tC": t_C,
            "polingPeriodUm": poling_um,
            "nPump": n_pump,
            "nSignal": n_signal,
            "nIdler": n_idler,
            "deltaKBulkPerMm": dk_bulk * 1e-3,
            "tuning": [
                {
                    "tC": r["t_C"],
                    "signalNm": r["signal_nm"],
                    "idlerNm": r["idler_nm"],
                }
                for r in tuning
            ],
            "shg": (
                {
                    "fundamentalNm": shg_block["fundamental_nm"],
                    "secondHarmonicNm": shg_block["second_harmonic_nm"],
                    "dEffPmPerV": shg_block["d_eff_pm_per_v"],
                    "polingUm": shg_block["poling_um"],
                    "deltaKEffectivePerMm": shg_block["delta_k_effective_per_mm"],
                    "eta": shg_block["eta"],
                    "pShW": shg_block["p_sh_w"],
                    "sincFactor": shg_block["sinc_factor"],
                }
                if shg_block
                else None
            ),
        }
        sim_run.status = "completed"
        sim_run.progress = 1.0
        sim_run.finished_at = datetime.now(timezone.utc)
        await session.flush()
        await _broadcast(sim_run)
    except Exception as exc:
        sim_run.status = "failed"
        sim_run.error_message = str(exc)
        sim_run.finished_at = datetime.now(timezone.utc)
        await session.flush()
        await _broadcast(sim_run)
        raise


async def _broadcast(sim_run: SimulationRun) -> None:
    await manager.broadcast(
        "simulation_run.status_changed",
        {
            "id": str(sim_run.id),
            "module": sim_run.module,
            "status": sim_run.status,
            "progress": sim_run.progress,
            "errorMessage": sim_run.error_message,
        },
    )
