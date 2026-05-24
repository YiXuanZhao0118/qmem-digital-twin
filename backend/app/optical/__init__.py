"""Asset-Physics-Model v3 — Python mirror of `frontend/src/optical/`.

This package contains the Phase 1+ BeamRay struct, Kind Registry, and
per-kind PhysicsOp implementations. Each op is the Python twin of its
TypeScript counterpart and must produce numerically identical results
within parity-test tolerance (1e-6 default).

See [docs/asset-physics-model.md](../../../docs/asset-physics-model.md)
and [docs/asset-physics-implementation.md](../../../docs/asset-physics-implementation.md)
for design, schema, and phase plan.
"""
