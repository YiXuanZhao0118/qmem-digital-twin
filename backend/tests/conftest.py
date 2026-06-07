import os
import sys
from pathlib import Path

# Make `app` importable when running pytest from the repo root or backend/
BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# Default to the local dev postgres (port 55432) that the DB-integration tests
# are written against. ``setdefault`` writes os.environ, which outranks the
# repo-root .env in pydantic-settings precedence, so the value here must match
# the real dev DB — a placeholder ``test:test@localhost/test`` made every
# DB-backed test fail auth. An explicit DATABASE_URL in the environment still
# wins (e.g. CI pointing at a throwaway DB).
os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://qmem:qmem_password@localhost:55432/qmem_twin",
)
