"""Phase 2.1 — Kind becomes multi-domain

Revision ID: 0092_kind_multi_domain
Revises: 0091_body_frame_position_to_body_frame

A single ``domain`` column forced every Kind into exactly one PHY domain,
but some parts span more than one: an AOM has an optical beam path *and*
an RF drive port; an EOM is optical + RF. This migration replaces the
scalar ``domain`` (CHECK ``domain IN (...)``) with a non-empty
``domains text[]`` so a part surfaces under every matching PHY Editor
filter instead of being arbitrarily bucketed.

Backfill is two-pass:

1. ``domains = ARRAY[domain]`` for every existing row (lossless for the
   single-domain majority, and the only source for user-created kinds
   that aren't in the manifest).
2. Manifest-derived override for the built-in physics kinds: union of
   ``primary_domain`` + ``default_physics`` + ``port_domains`` values,
   filtered to the valid set and order-stable. This promotes ``aom`` and
   ``eom`` to ``["optical", "rf"]`` (and stays a no-op for everything
   that is genuinely single-domain).

Downgrade collapses back to the first domain (lossy for multi-domain
rows) so alembic linearity is preserved.
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY

from alembic import op


revision = "0092_kind_multi_domain"
down_revision = "0091_body_frame_position"
branch_labels = None
depends_on = None


VALID_DOMAINS = ("optical", "rf", "mechanical")


def upgrade() -> None:
    # 1. Add the array column (default '{}' so the ADD COLUMN succeeds on
    #    existing rows) — the non-empty CHECK is added only after backfill.
    op.add_column(
        "kinds",
        sa.Column(
            "domains",
            ARRAY(sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::text[]"),
        ),
    )

    conn = op.get_bind()

    # 2a. Lossless backfill: wrap the scalar domain in a 1-element array.
    conn.execute(sa.text("UPDATE kinds SET domains = ARRAY[domain]"))

    # 2b. Manifest-derived multi-domain override for built-in kinds.
    #     Import inside upgrade() so alembic offline mode doesn't load the
    #     manifest during SQL generation (mirrors 0086).
    from app.kinds_manifest import load_manifest

    update_stmt = sa.text(
        "UPDATE kinds SET domains = :domains WHERE name = :name"
    ).bindparams(
        sa.bindparam("domains", type_=ARRAY(sa.Text())),
        sa.bindparam("name"),
    )
    for plugin in load_manifest().get("physics_plugins", []):
        physics = plugin.get("physics", {}) or {}
        ordered: list[str] = []

        def _add(value: str | None) -> None:
            if value in VALID_DOMAINS and value not in ordered:
                ordered.append(value)  # type: ignore[arg-type]

        _add(physics.get("primary_domain"))
        for d in physics.get("default_physics") or []:
            _add(d)
        for d in (physics.get("port_domains") or {}).values():
            _add(d)

        if not ordered:
            continue  # keep the ARRAY[domain] backfill value
        conn.execute(update_stmt, {"domains": ordered, "name": plugin["id"]})

    # 3. Retire the scalar column + its CHECK, add the array invariants.
    op.drop_constraint("kind_domain_check", "kinds", type_="check")
    op.drop_column("kinds", "domain")
    op.create_check_constraint(
        "kind_domains_subset_check",
        "kinds",
        "domains <@ ARRAY['optical', 'rf', 'mechanical']::text[]",
    )
    op.create_check_constraint(
        "kind_domains_nonempty_check",
        "kinds",
        "cardinality(domains) >= 1",
    )


def downgrade() -> None:
    op.drop_constraint("kind_domains_nonempty_check", "kinds", type_="check")
    op.drop_constraint("kind_domains_subset_check", "kinds", type_="check")

    # Re-add the scalar column nullable, collapse to the first domain,
    # then enforce NOT NULL + the original CHECK.
    op.add_column("kinds", sa.Column("domain", sa.Text(), nullable=True))
    conn = op.get_bind()
    conn.execute(sa.text("UPDATE kinds SET domain = domains[1]"))
    op.alter_column("kinds", "domain", nullable=False)
    op.create_check_constraint(
        "kind_domain_check",
        "kinds",
        "domain IN ('optical', 'rf', 'mechanical')",
    )
    op.drop_column("kinds", "domains")
