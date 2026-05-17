from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://qmem:qmem_password@localhost:5432/qmem_twin"
    cors_origins: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["http://localhost:5173", "http://localhost:3000"]
    )
    asset_root: Path = REPO_ROOT / "assets"
    sql_echo: bool = False

    onshape_access_key: str | None = None
    onshape_secret_key: str | None = None
    onshape_base_url: str = "https://cad.onshape.com"

    # Phase B: ngspice binary path. Falls back to PATH lookup
    # (`shutil.which("ngspice")`) when None. Set NGSPICE_PATH env var to
    # override (e.g. C:\ProgramData\chocolatey\bin\ngspice.exe).
    ngspice_path: str | None = None

    # Phase C: EM module — palace via Docker on a WSL2 / lab workstation
    # over SSH.
    mesh_max_bytes: int = 100 * 1024 * 1024  # 100 MB upload cap
    mesh_storage_dir: Path = REPO_ROOT / ".meshes"
    em_solver_timeout_sec: int = 60 * 60  # 60 minutes
    workstation_host: str | None = None  # e.g. "QM" — resolved via ~/.ssh/config
    workstation_key_path: str | None = None
    workstation_palace_image: str = "awslabs/palace:latest"

    # AI binding agent (alembic 0057, agent_orchestrator). Empty key disables
    # the orchestrator gracefully — sessions still start and accept
    # heartbeats, but POST /messages returns a friendly error so the panel
    # can show "API key not configured" instead of crashing.
    anthropic_api_key: str | None = None
    # Sonnet 4.6 is the right balance for the tool-use loop (cheaper +
    # faster than Opus 4.7, plenty smart enough for create_asset /
    # create_component dispatch). Override per-deploy via env if you
    # specifically want Opus for harder binding tasks.
    anthropic_model: str = "claude-sonnet-4-6"
    # Cap on a single agent turn — protects against runaway tool loops.
    # 8192 is enough for "create 10 things and explain" without truncating.
    anthropic_max_tokens: int = 8192

    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @field_validator("cors_origins", mode="before")
    @classmethod
    def parse_cors_origins(cls, value: Any) -> list[str]:
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    @field_validator("asset_root", mode="after")
    @classmethod
    def resolve_asset_root(cls, value: Path) -> Path:
        if value.is_absolute():
            return value
        return REPO_ROOT / value


settings = Settings()
