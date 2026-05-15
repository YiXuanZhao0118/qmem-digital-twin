"""Phase 4 backend tests — pin the kinds-manifest partition helper so the
``alembic 0049_split_kind_params`` migration (and every future read/write
that fans out from ``kind_params``) is grounded in the same source of
truth as the frontend plugin registry.

These run against the live manifest at ``backend/data/kinds.json``,
which the frontend regenerates via ``npm run export:kinds``. If a Phase-3
plugin migration adds new intrinsic/state declarations, this test
catches drift the moment the manifest is regenerated.
"""

from __future__ import annotations

import pytest

from app.kinds_manifest import (
    intrinsic_keys_by_kind,
    partition_kind_params,
    port_domains_by_kind,
    state_keys_by_kind,
)


def test_aom_partition_matches_plugin_declarations():
    """AOM was migrated in Phase 3a; its intrinsic + state lists must
    show up in the manifest and exclude the derived ``centerFreqMhz`` /
    ``rfDrivePowerW`` fields (those are resolved live from upstream)."""
    intrinsic = intrinsic_keys_by_kind().get("aom") or []
    state = state_keys_by_kind().get("aom") or []
    # Spec-sheet keys
    assert "acousticVelocityMPerS" in intrinsic
    assert "refractiveIndex" in intrinsic
    assert "crystalLengthMm" in intrinsic
    assert "rfPowerMaxW" in intrinsic
    # Knobs
    assert "diffractionOrder" in state
    # No overlap
    assert set(intrinsic).isdisjoint(set(state))
    # The two derived fields are intentionally NOT stored on the AOM
    # post-Phase B; they appear in neither partition.
    for derived in ("centerFreqMhz", "rfDrivePowerW"):
        assert derived not in intrinsic
        assert derived not in state


def test_waveplate_partition_separates_retardance_from_fast_axis():
    intrinsic = set(intrinsic_keys_by_kind().get("waveplate") or [])
    state = set(state_keys_by_kind().get("waveplate") or [])
    assert intrinsic == {"retardanceLambda", "transmission"}
    assert state == {"fastAxisDegBeamLocal"}


def test_rf_amplifier_is_fully_intrinsic_no_state_knobs():
    intrinsic = set(intrinsic_keys_by_kind().get("rf_amplifier") or [])
    state = set(state_keys_by_kind().get("rf_amplifier") or [])
    # ZHL-1-2W has no user knob — every spec is fixed by the part number.
    assert "gainDb" in intrinsic
    assert state == set()


def test_rf_source_separates_pll_strap_from_channel_state():
    intrinsic = set(intrinsic_keys_by_kind().get("rf_source") or [])
    state = set(state_keys_by_kind().get("rf_source") or [])
    # PLL and reference-clock straps are fixed on the AD9959 PCB.
    assert "pllMultiplier" in intrinsic
    assert "referenceClockMhz" in intrinsic
    # The user-facing knobs flow through `channels[]` (per-channel freq /
    # amp / phase / mode).
    assert "channels" in state
    assert intrinsic.isdisjoint(state)


def test_port_domains_for_migrated_kinds():
    """Phase-2/3 anchors-with-domain map. AOM is a bridge (rf + optical);
    rf_amplifier sits entirely in rf."""
    pd = port_domains_by_kind()
    assert pd["aom"]["rf_in"] == "rf"
    assert pd["aom"]["intercept_in"] == "optical"
    assert pd["aom"]["intercept_out"] == "optical"
    assert pd["rf_amplifier"]["rf_in"] == "rf"
    assert pd["rf_amplifier"]["rf_out"] == "rf"


def test_partition_kind_params_for_aom_splits_intrinsic_from_state():
    """Functional spot-check — a representative AOM kindParams blob must
    end up partitioned into the two halves the Phase-4 migration writes."""
    blob = {
        "acousticVelocityMPerS": 4200.0,
        "refractiveIndex": 2.26,
        "crystalLengthMm": 25.0,
        "diffractionOrder": 1,
        "braggTiltAxisDegLab": 0.0,  # currently un-declared key → state by
                                    # defensive default (see partition helper)
    }
    intrinsic, state = partition_kind_params("aom", blob)
    assert intrinsic == {
        "acousticVelocityMPerS": 4200.0,
        "refractiveIndex": 2.26,
        "crystalLengthMm": 25.0,
    }
    # diffractionOrder is explicitly state; braggTiltAxisDegLab is in
    # neither list so it falls through to state (the defensive default).
    assert state == {"diffractionOrder": 1, "braggTiltAxisDegLab": 0.0}


def test_partition_kind_params_for_unmigrated_plugin_returns_everything_as_state():
    """Plugins without intrinsic/state declarations stay legacy: every
    key is treated as state. Use ``rf_cable`` — a plugin that hasn't been
    migrated yet (it's a pure passthrough on the link graph)."""
    blob = {"lengthMm": 200.0}
    intrinsic, state = partition_kind_params("rf_cable", blob)
    assert intrinsic == {}
    assert state == {"lengthMm": 200.0}


def test_no_plugin_has_partition_overlap():
    """Exhaustiveness — every plugin that declared both lists must
    partition its kindParams cleanly (no key appears in both halves).
    Mirrors the frontend ``plugin_partition.test.ts`` invariant so backend
    + frontend can never disagree on a key's classification."""
    i_by_kind = intrinsic_keys_by_kind()
    s_by_kind = state_keys_by_kind()
    for kind in set(i_by_kind) & set(s_by_kind):
        intersection = set(i_by_kind[kind]) & set(s_by_kind[kind])
        assert (
            not intersection
        ), f"[{kind}] keys in both intrinsic AND state: {sorted(intersection)}"
