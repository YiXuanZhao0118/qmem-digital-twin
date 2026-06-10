"""Per-physics-module problem-definition tables.

Importing this package as a whole pulls every submodule into the
SQLAlchemy registry so Base.metadata sees them before Alembic
autogenerate runs. (The ``electronics`` submodule — the SPICE
``circuits`` table — was removed on 2026-06-10 with the Electronics tab.)
"""

from app.models.modules import (  # noqa: F401
    em,
    magnetics,
    rf,
)
