"""Refractive-index library for surface models (docs/surface-optics.md).

Every entry is a Sellmeier-type dispersion formula in the general form
``n² = A + Σ Bᵢ·λ²/(λ² − Cᵢ)`` with λ in µm:

- ``N-BK7``        — Schott datasheet (A = 1).
- ``fused_silica`` — Malitson 1965 (A = 1).
- ``S-NPH1_MOLD``  — Ohara S-NPH1 as molded by LightPath (the A230TM-B's
  glass), Sellmeier 1 from the ``RPO.AGF`` catalogue inside Thorlabs'
  A230TM-B Zemax archive (A = 1; catalogue n_d = 1.797892).
- ``crystal_quartz`` / ``calcite`` — uniaxial, Ghosh 1999, one formula per
  eigen-index (o, e).

Checked against the published indices near 589 nm (BK7 1.5168, quartz
1.5443 / 1.5534, calcite 1.6584 / 1.4864) and at 1064 nm (fused silica
1.4496) in ``tests/optical/test_surface_materials.py``: all within 1e-4
except calcite n_e, where the Ghosh fit is 2.7e-4 low.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class Sellmeier:
    a: float
    b: tuple[float, ...]
    c: tuple[float, ...]   # µm²

    def n(self, wavelength_nm: float) -> float:
        l2 = (wavelength_nm * 1e-3) ** 2
        return math.sqrt(self.a + sum(b * l2 / (l2 - c) for b, c in zip(self.b, self.c)))


ISOTROPIC: dict[str, Sellmeier] = {
    "N-BK7": Sellmeier(
        1.0,
        (1.03961212, 0.231792344, 1.01046945),
        (0.00600069867, 0.0200179144, 103.560653),
    ),
    "fused_silica": Sellmeier(
        1.0,
        (0.6961663, 0.4079426, 0.8974794),
        (0.0684043 ** 2, 0.1162414 ** 2, 9.896161 ** 2),
    ),
    "S-NPH1_MOLD": Sellmeier(
        1.0,
        (1.72039395, 0.35905958, 1.95245396),
        (0.0137918186, 0.0669088725, 136.641902),
    ),
}

# (ordinary, extraordinary)
UNIAXIAL: dict[str, tuple[Sellmeier, Sellmeier]] = {
    "crystal_quartz": (
        Sellmeier(1.28604141, (1.07044083, 1.10202242), (1.00585997e-2, 100.0)),
        Sellmeier(1.28851804, (1.09509924, 1.15662475), (1.02101864e-2, 100.0)),
    ),
    "calcite": (
        Sellmeier(1.73358749, (0.96464345, 1.82831454), (1.94325203e-2, 120.0)),
        Sellmeier(1.35859695, (0.82427830, 0.14429128), (1.06689543e-2, 120.0)),
    ),
}

MATERIALS = frozenset(ISOTROPIC) | frozenset(UNIAXIAL)
