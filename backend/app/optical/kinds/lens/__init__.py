"""Lens PhysicsOp. Importing registers the op in the global registry."""

from . import physics  # noqa: F401  side-effect: register_kind("lens", ...)
