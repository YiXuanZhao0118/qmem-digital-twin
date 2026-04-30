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
