"""Anchor-based physics ops (Phase 9.3+).

Each module here registers one or more kind → anchor-op mappings on
import. ``from app.optical import anchor_ops`` eagerly loads every op
to populate ``app.optical.anchor_tracer._ANCHOR_OPS``.
"""
# Eager-import each op module so register_anchor_op side-effects run.
from . import mirror  # noqa: F401
from . import lens  # noqa: F401
from . import waveplate  # noqa: F401
from . import polarizer  # noqa: F401
from . import pbs  # noqa: F401
from . import aom  # noqa: F401
from . import fiber  # noqa: F401
from . import misc_ops  # noqa: F401 (Faraday, EOM, TA, sinks, nonlinear, saturable)
from . import emit_laser_source  # noqa: F401 (not an op — emitter helper)
