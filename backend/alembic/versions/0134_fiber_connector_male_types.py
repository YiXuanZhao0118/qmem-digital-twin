"""Declare the MALE half of the fibre connector vocabulary on the ferrules

0133 gendered ``Anchor.connector_type`` and gave chassis bulkheads the female
values, but stopped short of the other half: the plug on the end of a patch
cable or a pigtail. So the catalog said what a socket is and never what a plug
is, and ``fc_pc_male`` / ``fc_apc_male`` existed in the Literal with nothing
using them.

This lands them on the ``fiber_connector`` rows — the ferrule that terminates a
cable end. Only ``connect_in`` gets a type: that is the MATING face, the
ferrule end that goes into a socket. ``connect_out`` is the cable/spline
junction buried inside the jacket (origin, −X, where the spline endpoint pins)
and mates with nothing, so it stays null.

The value is derived per row, never hard-coded to a list of names:

* from ``default_params.polish`` (``PC`` / ``APC``) where present — that is the
  declared source of truth for a connector's polish, and every ``assets_3d``
  row has it;
* else from an unambiguous ``_pc`` / ``_apc`` token in the identifier — the
  ``devices`` rows all carry ``polish: null`` but their slugs
  (``pm_apc_780``, ``mm_pc_780``, …) are unambiguous;
* else the row is skipped with a warning rather than guessed at.

Note this changes NO physics. Coupling is computed from the connector params
(``polish`` / ``polishAngleDeg`` / ``mfdUm`` / ``na``) by the cable body's op,
and ``connect_*`` are not in ``PRIMARY_ANCHOR_IDS`` so the tracer never hits
them. What the value does is make the plug/socket relationship legible and
checkable: ``isFiberPortConnectorType`` is female-only, so a male ferrule is
excluded from ``collectFiberPortsLab``'s port list and two patch cables can
never be offered as pluggable into each other.

**This writes four ``locked`` rows** — ``pm_apc_780`` / ``pm_pc_780`` /
``sm_apc_780`` / ``sm_pc_780`` — which the rule in CLAUDE.md forbids. It is
done with the user's explicit authorisation, asked for and given on
2026-08-23 after the lock was surfaced and the change described. Same
situation as 0126 and 0127, and the same caveat applies: ``lock_guard`` is
API-layer only, so a migration bypasses it silently. The ``locked`` flags
themselves are left ON — this migration writes through the lock, it does not
lift it.

Forward-only, matching 0133: the rows carried ``connectorType: null`` before,
which is indistinguishable from "never set" and not worth restoring.

Revision ID: 0134_fiber_connector_male_types
Revises: 0133_fiber_bulkhead_anchor
"""

from __future__ import annotations

import json
import logging

import sqlalchemy as sa

from alembic import op


revision = "0134_fiber_connector_male_types"
down_revision = "0133_fiber_bulkhead_anchor"
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.runtime.migration")

# Only the mating face. `connect_out` is the spline junction and mates with
# nothing — see the module docstring.
MATING_ANCHOR = "connect_in"

_MALE_BY_POLISH = {"PC": "fc_pc_male", "APC": "fc_apc_male"}


def _polish_from_identifier(name: str) -> str | None:
    """`_apc` beats `_pc` because the latter is a substring of neither but the
    check order still matters for names like `sm_apc_780`."""
    lowered = (name or "").lower()
    if "_apc" in lowered:
        return "APC"
    if "_pc" in lowered:
        return "PC"
    return None


def _male_type_for(name: str, params: object) -> str | None:
    polish = None
    if isinstance(params, dict):
        declared = params.get("polish")
        if isinstance(declared, str):
            polish = declared.upper()
    if polish not in _MALE_BY_POLISH:
        polish = _polish_from_identifier(name)
    if polish not in _MALE_BY_POLISH:
        log.warning(
            "0134: %r has no usable polish (params=%r) — leaving connectorType null",
            name, polish,
        )
        return None
    return _MALE_BY_POLISH[polish]


def _as_json(value, default):
    if value is None:
        return default
    return json.loads(value) if isinstance(value, str) else value


def _stamp(conn, *, table: str, key_col: str, anchors_shape: str) -> None:
    """``devices.anchors`` keeps the exporter's snake_case shape (``role`` /
    ``connector_type``); ``assets_3d.anchors`` is the materialised camelCase
    form (``id`` / ``connectorType``). Same walk, two spellings."""
    id_key, conn_key = (
        ("role", "connector_type") if anchors_shape == "snake" else ("id", "connectorType")
    )
    where = (
        "behavioral_kind = 'fiber_connector'"
        if table == "devices"
        else "kind_id = 'fiber_connector'"
    )
    rows = conn.execute(
        sa.text(
            f"SELECT {key_col}, anchors, default_params FROM {table} WHERE {where}"
        )
    ).fetchall()
    for key, anchors, params in rows:
        anchors = _as_json(anchors, [])
        male = _male_type_for(str(key), _as_json(params, {}))
        if male is None:
            continue
        changed = False
        for a in anchors or []:
            if a.get(id_key) != MATING_ANCHOR:
                continue
            if a.get(conn_key) == male:
                continue
            a[conn_key] = male
            changed = True
        if not changed:
            log.info("0134: %s %r already stamped", table, key)
            continue
        conn.execute(
            sa.text(
                f"UPDATE {table} SET anchors = CAST(:anchors AS JSONB) "
                f"WHERE {key_col} = :key"
            ),
            {"key": key, "anchors": json.dumps(anchors)},
        )
        log.info("0134: %s %r %s -> %s", table, key, MATING_ANCHOR, male)


def upgrade() -> None:
    conn = op.get_bind()
    _stamp(conn, table="devices", key_col="slug", anchors_shape="snake")
    _stamp(conn, table="assets_3d", key_col="catalog_id", anchors_shape="camel")


def downgrade() -> None:
    """Forward-only — see the module docstring."""
