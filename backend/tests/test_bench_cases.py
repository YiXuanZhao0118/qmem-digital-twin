"""Structural gate for the bench dataset behind O-4 / F-2.

`docs/objectives.md` targets "simulated within 5 % of measured" for the
optical (O-4) and RF (F-2) chains. That needs a set of pinned laboratory
measurements, which does not exist yet — see `docs/bench-dataset.md` for what
has to be measured and `tests/fixtures/bench/README.md` for the file shape.

This module does NOT compare against the solver. Comparators are deliberately
unwritten: the shape of the first real measurement decides which solver output
a case reads, and guessing that before the data exists means guessing wrong.

What it does instead:

  * validates every fixture, so the format cannot rot while it sits unused;
  * enforces the uncertainty rule — a measurement too imprecise to verify its
    own tolerance is rejected rather than counted as coverage;
  * FAILS the moment a fixture carries real data with no comparator, which is
    what turns "someone measured something" into "build the comparator now".

So while the dataset is empty this is cheap and green; the first bench run
turns it red on purpose.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "bench"

# Keep in lockstep with the table in fixtures/bench/README.md.
KNOWN_QUANTITIES = {
    "power_mw",
    "power_ratio",
    "extinction_db",
    "waist_um",
    "voltage_vpp",
    "loss_db",
}

REQUIRED_KEYS = {"id", "spec", "quantity", "description", "tolerance_pct", "measured"}
REQUIRED_MEASURED_KEYS = {
    "value",
    "unit",
    "uncertainty",
    "date",
    "instrument",
    "operator",
    "conditions",
}

# quantity -> callable(case) -> simulated value. Empty until real data lands.
COMPARATORS: dict[str, object] = {}


def _cases() -> list[tuple[str, dict]]:
    return [(p.stem, json.loads(p.read_text(encoding="utf-8"))) for p in sorted(FIXTURE_DIR.glob("*.json"))]


def test_fixture_dir_exists() -> None:
    assert FIXTURE_DIR.is_dir(), f"missing {FIXTURE_DIR}"
    assert (FIXTURE_DIR / "_template.json").is_file(), "the template case must stay present and parseable"


@pytest.mark.parametrize("stem,case", _cases())
def test_case_is_well_formed(stem: str, case: dict) -> None:
    missing = REQUIRED_KEYS - case.keys()
    assert not missing, f"{stem}: missing keys {sorted(missing)}"
    assert case["id"] == stem, f"{stem}: `id` must equal the filename stem, got {case['id']!r}"
    assert case["quantity"] in KNOWN_QUANTITIES, (
        f"{stem}: unknown quantity {case['quantity']!r}. Add it to the table in "
        f"fixtures/bench/README.md and to KNOWN_QUANTITIES before using it."
    )
    assert isinstance(case["tolerance_pct"], (int, float)) and case["tolerance_pct"] > 0


@pytest.mark.parametrize("stem,case", _cases())
def test_measured_block_is_complete_and_precise_enough(stem: str, case: dict) -> None:
    measured = case["measured"]
    if measured is None:
        pytest.skip(f"{stem}: not measured yet")

    missing = REQUIRED_MEASURED_KEYS - measured.keys()
    assert not missing, (
        f"{stem}: measured block missing {sorted(missing)}. Every field is load-bearing — "
        f"see docs/bench-dataset.md §1 for why."
    )
    assert measured["conditions"], f"{stem}: `conditions` must record what the model reads"

    value = abs(float(measured["value"]))
    unc = float(measured["uncertainty"])
    assert value > 0, f"{stem}: value must be non-zero to form a relative comparison"
    rel_pct = 100.0 * unc / value
    limit = case["tolerance_pct"] / 2.0
    assert rel_pct <= limit, (
        f"{stem}: measurement uncertainty is {rel_pct:.1f} % against a {case['tolerance_pct']} % "
        f"tolerance. A measurement this imprecise cannot verify that target — tighten it or "
        f"leave the case pending rather than booking it as coverage."
    )


@pytest.mark.parametrize("stem,case", _cases())
def test_measured_case_has_a_comparator(stem: str, case: dict) -> None:
    if case["measured"] is None:
        pytest.skip(f"{stem}: not measured yet")
    assert case["quantity"] in COMPARATORS, (
        f"{stem} now carries real measured data but no comparator exists for quantity "
        f"{case['quantity']!r}, so nothing is actually being verified. Implement it in "
        f"COMPARATORS (this module) — see docs/bench-dataset.md §3."
    )


def test_report_coverage() -> None:
    """Not an assertion so much as a standing reminder in the CI log.

    O-4 and F-2 stay unverifiable until this reads non-zero, and a silent
    empty dataset is exactly how a target quietly stops meaning anything.
    """
    cases = [c for stem, c in _cases() if stem != "_template"]
    ready = [c for c in cases if c["measured"] is not None]
    print(
        f"\nbench dataset: {len(ready)}/{len(cases)} cases measured "
        f"({len(COMPARATORS)} comparators implemented). "
        f"O-4/F-2 remain unverifiable while this is 0 — see docs/bench-dataset.md §5."
    )
