"""The ``kinds`` table must not drift from the plugin manifest.

Alembic 0086 backfilled ``kinds`` from ``backend/data/kinds.json`` once and
nothing re-ran it. By the time anyone diffed the two, 29 of the 31
plugin-backed rows were out of sync — 25 drifted, 4 missing entirely, and
only ``dichroic_mirror`` and ``mirror`` clean. Among them: swapped
``laser_source`` fast/slow axes, a ``beam_splitter`` that had stopped being
polarising, an ``aom`` still carrying the ``acousticVelocityMPerS`` key
alembic 0101 renamed everywhere else, and 18 stale ``anchor_template``
blobs (one of which is why the only AOM asset in the catalog had no
``acoustic_axis`` anchor — alembic 0127 backfilled it). Alembic 0126
resynced the table; this file is what stops it happening a third time.

The invariant: for every row whose ``name`` matches a physics plugin,
``kinds_manifest.MANIFEST_OWNED_KIND_COLUMNS`` equal the manifest exactly.

That means the Kinds editor is NOT the place to change a built-in kind's
defaults or anchor template — edit ``frontend/src/kinds/<kind>/index.ts``,
re-run ``npm run export:kinds``, then add a resync migration. The editor
stays free for user-created variants, which have no plugin of their own and
are skipped here.

The existing ``scripts/audit_kind_drift.py`` only compares the *set* of kind
names across the registry tables; it never looked at a single param value.
``scripts/audit_kind_param_drift.py`` is the report form of this test.

Run via:
    cd backend && .venv/Scripts/python.exe -m pytest tests/test_kind_manifest_sync.py -v
"""

from __future__ import annotations

import json

import pytest
from sqlalchemy import select

from app.db import AsyncSessionLocal
from app.kinds_manifest import (
    MANIFEST_OWNED_KIND_COLUMNS,
    kind_rows_from_manifest,
    load_manifest,
)
from app.models import Kind, KindDeletion


@pytest.fixture(autouse=True)
async def _reset_engine_pool():
    from app.db import engine

    await engine.dispose()
    yield


async def _kind_rows() -> dict[str, Kind]:
    async with AsyncSessionLocal() as session:
        return {row.name: row for row in (await session.scalars(select(Kind))).all()}


async def _tombstoned() -> set[str]:
    """Kind names the user deleted on purpose (alembic 0138).

    A tombstoned kind is absent by intent, not by drift — the trigger on
    ``kinds`` skips any migration that tries to insert it — so the
    "every plugin has a row" invariant has to exclude them or it reports
    a gap that nothing is allowed to close.
    """
    async with AsyncSessionLocal() as session:
        return {row.name for row in (await session.scalars(select(KindDeletion))).all()}


def _unbacked(rows: dict[str, Kind]) -> set[str]:
    """Kind names with neither a physics plugin nor a passive plugin."""
    passive = {p["id"] for p in load_manifest().get("passive_plugins", [])}
    return set(rows) - set(kind_rows_from_manifest()) - passive


def _normalize(value):
    """Numeric-tolerant deep compare — 2 and 2.0 are the same default."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, dict):
        return {k: _normalize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_normalize(v) for v in value]
    return value


class TestKindsTableMatchesManifest:
    async def test_every_plugin_has_a_row(self) -> None:
        """A plugin with no row is invisible: the Asset3D editor's kind
        dropdown is built from this table, so the kind cannot be assigned
        to an asset at all. ``fiber`` / ``fiber_coupler`` /
        ``glan_polarizer`` / ``rf_cable`` were in this state until 0126."""
        rows = await _kind_rows()
        missing = sorted(set(kind_rows_from_manifest()) - set(rows) - await _tombstoned())
        assert not missing, (
            f"physics plugins with no kinds row: {missing}. "
            "Add them in a resync migration, or — if their absence is "
            "deliberate — delete them through the Kinds editor so they get "
            "a kind_deletions tombstone."
        )

    @pytest.mark.parametrize("column", MANIFEST_OWNED_KIND_COLUMNS)
    async def test_column_matches_manifest(self, column: str) -> None:
        rows = await _kind_rows()
        want = kind_rows_from_manifest()

        drifted: list[str] = []
        for name, target in sorted(want.items()):
            row = rows.get(name)
            if row is None:
                continue  # reported by test_every_plugin_has_a_row
            got = getattr(row, column)
            if _normalize(got) != _normalize(target[column]):
                drifted.append(
                    f"\n  {name}.{column}"
                    f"\n    db       = {json.dumps(got, default=str)}"
                    f"\n    manifest = {json.dumps(target[column], default=str)}"
                )

        assert not drifted, (
            f"{len(drifted)} kinds row(s) drifted from backend/data/kinds.json:"
            + "".join(drifted)
            + "\n\nThe manifest owns this column. If the manifest is the stale "
            "side, re-run `npm run export:kinds`; if the DB is, add a resync "
            "migration (see 0126_kinds_manifest_resync)."
        )

    async def test_default_params_carry_no_undeclared_keys(self) -> None:
        """Sharper failure message for the most common drift shape: a key
        the plugin dropped that the row kept. Leftovers of
        ``routers/components.py::DEFAULT_KIND_PARAMS`` (line 143) accounted for
        68 of these before 0126 (``aom.figureOfMeritM2``,
        ``aom.deflectionPerMhzUrad``, the whole ``rf_switch`` datasheet
        blob, …), none of which any solver reads."""
        rows = await _kind_rows()
        want = kind_rows_from_manifest()

        stray: list[str] = []
        for name, target in sorted(want.items()):
            row = rows.get(name)
            if row is None:
                continue
            extra = sorted(set(row.default_params or {}) - set(target["default_params"]))
            if extra:
                stray.append(f"\n  {name}: {extra}")

        assert not stray, (
            "kinds rows carry default_params keys their plugin does not "
            "declare:" + "".join(stray)
        )

    async def test_unbacked_rows_are_the_known_placeholders(self) -> None:
        """A row with no plugin is not automatically wrong — but each one
        needs a reason on record, because the failure mode it shares a shape
        with (a kind stranded by a plugin rename, still holding assets) is
        invisible otherwise.

        The three that exist, and why:

        ``unclassified`` (0110) / ``mechanical`` (0121)
            NOT NULL placeholders ``assets_3d.kind_id`` falls back to.
            ``op_set_name='none'``; the tracer runs no op for them.

        ``isolator``
            Hand-authored through the Kinds editor — it is in no migration
            and no commit. ``locked``, ``domains=['mechanical']``,
            ``op_set_name='none'``, and its own description: "Composite
            isolator housing — sub-components (faraday + polarizers) carry
            the physics. This kind is a mechanical wrapper; no anchors
            needed." That is accurate: the isolator IS a Component
            composition (a Glan prism asset on ``beam_splitter`` plus a rod
            on ``faraday_rotator``), and this kind exists to label the four
            leftover housing shells with something better than the generic
            ``mechanical``. ``devices.behavioral_kind='isolator'`` on those
            four is what writes the kind onto the assets, so the row is
            load-bearing — deleting it would strand them.
        """
        rows = await _kind_rows()
        unbacked = _unbacked(rows)

        assert unbacked == {"isolator", "mechanical", "unclassified"}, (
            f"unexpected kinds rows with no plugin: {sorted(unbacked)}. "
            "Either add the plugin, or add the name here with a note on why "
            "the row exists."
        )

    async def test_unbacked_rows_run_no_physics(self) -> None:
        """The check that makes the list above safe to keep extending.

        A row with no plugin has no ops to dispatch to, so it must not
        claim otherwise: ``op_set_name`` has to be the ``'none'`` sentinel.
        A row that named a real op set without a plugin behind it would
        pass the membership test above and then fail at trace time.
        """
        rows = await _kind_rows()
        unbacked = _unbacked(rows)

        claiming = {n: rows[n].op_set_name for n in unbacked if rows[n].op_set_name != "none"}
        assert not claiming, (
            f"kinds rows with no plugin but a non-'none' op_set_name: {claiming}. "
            "The tracer would dispatch and fail."
        )
