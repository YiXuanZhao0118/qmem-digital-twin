"""Per-physics-module problem-definition tables.

Each submodule maps to one workspace tab on the frontend
(``frontend/src/modules/<id>/``). Importing this package as a
whole pulls every submodule into the SQLAlchemy registry so
Base.metadata sees them before Alembic autogenerate runs.
"""

from app.models.modules import (  # noqa: F401
    electronics,
    em,
    magnetics,
    rf,
)
