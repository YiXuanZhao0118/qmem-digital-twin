"""Touchstone upload + parse router — Phase B.7.

Stateless: POST a Touchstone file, get back the parsed S-parameter
matrices. No persistence (Phase F may add a touchstones table when
cross-module coupling needs reusable network blocks).
"""

from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, UploadFile, status

from app.services.touchstone import TouchstoneError, parse_touchstone, to_dict


router = APIRouter()

MAX_UPLOAD_BYTES = 4 * 1024 * 1024  # 4 MB — typical .s2p is well under 1 MB


@router.post("/parse", status_code=status.HTTP_200_OK)
async def parse_touchstone_endpoint(file: UploadFile = File(...)) -> dict:
    """Parse an uploaded Touchstone file (.s1p / .s2p / .s3p / .s4p / ...).

    Returns ``{filename, nPorts, z0, freqHz, sParams}`` where ``sParams``
    is a dict keyed by ``"sNM"`` (1-indexed, ``s11`` / ``s12`` / ...) and
    each value is a list of ``[re, im]`` pairs aligned with ``freqHz``.
    """
    if not file.filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="filename is required"
        )

    # Cap upload size — touchstones are tiny ASCII files; anything bigger
    # is suspect.
    content = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"file exceeds {MAX_UPLOAD_BYTES} bytes",
        )

    try:
        result = parse_touchstone(file.filename, content)
    except TouchstoneError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc

    return to_dict(result)
