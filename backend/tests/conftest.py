import os
import sys
from pathlib import Path

# Make `app` importable when running pytest from the repo root or backend/
BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# pydantic_settings reads .env on import; provide a harmless default so the
# unit tests don't require the dev .env file to be present.
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/test")
