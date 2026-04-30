from __future__ import annotations

from fastapi import APIRouter


router = APIRouter()


@router.get("/status")
async def onshape_status() -> dict[str, str]:
    return {"status": "planned", "message": "Onshape metadata sync is reserved for phase 2."}

