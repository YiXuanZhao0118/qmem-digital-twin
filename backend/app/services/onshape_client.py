from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from app.config import settings


@dataclass(frozen=True)
class OnshapeDocumentMetadata:
    document_id: str
    name: str | None
    source_url: str
    raw: dict[str, Any]


class OnshapeClient:
    """Phase-2 placeholder for Onshape metadata sync.

    Geometry sync is intentionally left out of the MVP. First import GLB/glTF/STEP
    assets manually, then map Onshape metadata once the digital twin loop is stable.
    """

    def __init__(self) -> None:
        self.base_url = settings.onshape_base_url.rstrip("/")
        self.access_key = settings.onshape_access_key
        self.secret_key = settings.onshape_secret_key

    async def get_document_metadata(self, document_id: str) -> OnshapeDocumentMetadata:
        if not self.access_key or not self.secret_key:
            raise RuntimeError("ONSHAPE_ACCESS_KEY and ONSHAPE_SECRET_KEY are not configured")

        async with httpx.AsyncClient(base_url=self.base_url, timeout=20) as client:
            response = await client.get(f"/api/documents/{document_id}")
            response.raise_for_status()
            data = response.json()

        return OnshapeDocumentMetadata(
            document_id=document_id,
            name=data.get("name"),
            source_url=f"{self.base_url}/documents/{document_id}",
            raw=data,
        )

