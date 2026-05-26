"""DB-backed kind → op_set_name resolution cache (Phase 5).

The code-side ``_REGISTRY`` only knows about ops registered by name
(e.g. ``lens_biconvex``, ``aom``, ``mirror``). When a user creates a
new kind via the UI — say ``my_custom_lens`` with
``op_set_name = "lens_biconvex"`` — its physics ops live in the
``lens_biconvex`` entry of ``_REGISTRY``, but the tracer dispatches
on ``Asset3D.kind_id == "my_custom_lens"`` which isn't a
``_REGISTRY`` key directly.

This module bridges the gap: it maintains an in-process cache of
``{kind_name: op_set_name}`` hydrated from the ``kinds`` table at
FastAPI startup and refreshed by the Kind CRUD endpoints. The tracer
uses :func:`get_op_set_for_kind` as a fallback in ``get_op``.

Kept separate from ``app.optical.registry`` because that file is a
pure-Python module mirrored as a TypeScript file on the frontend; we
don't want DB / SQLAlchemy imports leaking into the parity contract.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


_KIND_TO_OP_SET: dict[str, str] = {}


def get_op_set_for_kind(kind_name: str) -> str | None:
    """Resolve a DB-backed kind to its op_set_name.

    Returns ``None`` for kinds not in the cache. The tracer treats that
    as "this kind isn't recognised" and raises KeyError, same as before
    Phase 5 — the cache strictly widens what ``get_op`` accepts, never
    narrows it.
    """
    return _KIND_TO_OP_SET.get(kind_name)


async def hydrate_kind_cache(session: AsyncSession) -> None:
    """Reload the cache from the kinds table.

    Called once at FastAPI startup (see ``app.main``). Safe to call
    again to recover from drift if cache invalidation ever misses a
    write.
    """
    # Local import to avoid pulling SQLAlchemy models at module-import
    # time of ``app.optical.registry`` callers that don't need DB.
    from app.models import Kind

    rows = (await session.scalars(select(Kind))).all()
    _KIND_TO_OP_SET.clear()
    for row in rows:
        _KIND_TO_OP_SET[row.name] = row.op_set_name


def set_kind_cache_entry(name: str, op_set_name: str) -> None:
    """Insert / replace one entry.

    Called by the Kind router after a successful POST or PATCH so
    subsequent tracer calls see the new mapping without a full
    rehydrate.
    """
    _KIND_TO_OP_SET[name] = op_set_name


def remove_kind_cache_entry(name: str) -> None:
    """Drop one entry.

    Called by the Kind router after a successful DELETE. No-op if the
    name isn't cached.
    """
    _KIND_TO_OP_SET.pop(name, None)


def _snapshot_for_tests() -> dict[str, str]:
    """Read-only snapshot used by unit tests. Not part of the public API."""
    return dict(_KIND_TO_OP_SET)
