"""Per-kind PhysicsOp implementations. Each sub-package registers its
ops on import. Importing this package eagerly imports all kinds so
the registry is fully populated."""

# Eager-import each kind module so registerKind side-effects run.
from . import lens  # noqa: F401
from . import mirror  # noqa: F401
from . import polarizer  # noqa: F401
from . import glan_laser  # noqa: F401  must come AFTER polarizer
from . import faraday_rotator  # noqa: F401
from . import pbs  # noqa: F401
from . import waveplate  # noqa: F401
from . import aom  # noqa: F401
from . import dichroic_mirror  # noqa: F401
from . import laser_source  # noqa: F401
# Stub physics (passthrough) — real implementations TODO.
# fiber_end is intentionally NOT a kind here: alembic 0056 collapsed fiber
# ends back into the parent fiber SceneObject (End A / End B are now
# render-only children, posed via fiber.kindParams.endA / endB).
from . import eom  # noqa: F401
from . import fiber  # noqa: F401
from . import tapered_amplifier  # noqa: F401
