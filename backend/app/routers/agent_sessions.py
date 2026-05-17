"""REST endpoints for the AI binding-agent conversation lifecycle.

State machine (see :mod:`app.services.agent_session`)::

    POST   /                       start    running
    POST   /{id}/heartbeat         (running only)
    POST   /{id}/undo-last         (running only)
    POST   /{id}/commit            running → committed
    POST   /{id}/cancel            running → cancelled
    GET    /{id}                   any state — review UI

Sessions in terminal states (committed / cancelled / abandoned) are
immutable; the router maps :class:`SessionNotRunningError` to HTTP 409
so the frontend can prompt the user to start a new session instead.

The actual Claude Agent SDK integration lives outside this router —
agent writes go through :mod:`app.services.agent_tools`. These
endpoints are the user-facing controls.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import schemas
from app.config import settings
from app.db import get_session
from app.models import AgentSession, SessionMutation
from app.routers.assets import safe_upload_name
from app.services import agent_orchestrator
from app.services import agent_session as agent_session_svc
from app.services.agent_session import (
    NothingToUndoError,
    SessionNotFoundError,
    SessionNotRunningError,
    UndoBlockedError,
)


# File-classification rules for the /uploads endpoint.
_ASSET_EXTENSIONS = {".glb", ".gltf", ".obj", ".stl", ".step", ".stp", ".sldprt", ".dxf"}
_IMAGE_EXTENSIONS_TO_MEDIA = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}
# Cap uploads to keep disk + base64 payloads sane. Assets are bigger
# (real CAD files reach 30-40MB); images are capped tighter because they
# get base64-encoded into the model context on every turn they appear.
_MAX_ASSET_BYTES = 50 * 1024 * 1024
_MAX_IMAGE_BYTES = 10 * 1024 * 1024


router = APIRouter()


# Cap on how long a session can sit idle. The user can request up to
# this much in AgentSessionCreate.heartbeat_timeout_sec — anything
# higher is clamped (rather than rejected) so a clumsy client doesn't
# fail. One hour is enough for the longest legitimate session and
# short enough that crashed agents don't squat on drafts indefinitely.
_MAX_HEARTBEAT_TIMEOUT_SEC = 3600


def _session_not_found(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)


def _session_locked(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


@router.post(
    "",
    response_model=schemas.AgentSessionOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_agent_session(
    payload: schemas.AgentSessionCreate,
    session: AsyncSession = Depends(get_session),
) -> object:
    timeout = max(60, min(payload.heartbeat_timeout_sec, _MAX_HEARTBEAT_TIMEOUT_SEC))
    return await agent_session_svc.start_session(
        session,
        instruction=payload.instruction,
        heartbeat_timeout_sec=timeout,
    )


@router.get("/{session_id}", response_model=schemas.AgentSessionStateOut)
async def get_agent_session(
    session_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> object:
    from app.models import AgentSession

    sess = await session.get(AgentSession, session_id)
    if sess is None:
        raise _session_not_found(f"Agent session {session_id} not found")

    # Mutations in creation order so the UI can render the agent's
    # actions as a timeline. Undone mutations are included with their
    # undone_at marker so the UI can show them struck-through.
    mutations_result = await session.scalars(
        select(SessionMutation)
        .where(SessionMutation.session_id == session_id)
        .order_by(SessionMutation.created_at.asc())
    )
    mutations = list(mutations_result.all())

    return {"session": sess, "mutations": mutations}


@router.post("/{session_id}/heartbeat", response_model=schemas.AgentSessionOut)
async def heartbeat(
    session_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> object:
    try:
        return await agent_session_svc.heartbeat(session, session_id)
    except SessionNotFoundError as e:
        raise _session_not_found(str(e)) from e
    except SessionNotRunningError as e:
        raise _session_locked(str(e)) from e


@router.post("/{session_id}/commit", response_model=schemas.CommitResult)
async def commit_session(
    session_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> object:
    try:
        return await agent_session_svc.commit_session(session, session_id)
    except SessionNotFoundError as e:
        raise _session_not_found(str(e)) from e
    except SessionNotRunningError as e:
        raise _session_locked(str(e)) from e


@router.post("/{session_id}/cancel", response_model=schemas.CancelResult)
async def cancel_session(
    session_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> object:
    try:
        return await agent_session_svc.cancel_session(
            session, session_id, reason="user_cancelled"
        )
    except SessionNotFoundError as e:
        raise _session_not_found(str(e)) from e
    except SessionNotRunningError as e:
        raise _session_locked(str(e)) from e


@router.post("/{session_id}/undo-last", response_model=schemas.SessionMutationOut)
async def undo_last(
    session_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> object:
    try:
        return await agent_session_svc.undo_last_mutation(session, session_id)
    except SessionNotFoundError as e:
        raise _session_not_found(str(e)) from e
    except SessionNotRunningError as e:
        raise _session_locked(str(e)) from e
    except NothingToUndoError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Nothing to undo in this session.",
        ) from e
    except UndoBlockedError as e:
        raise _session_locked(str(e)) from e


def _format_sse(event_name: str, payload: dict[str, object]) -> str:
    """Serialise one orchestrator event in standard SSE wire format.
    Each event is `event:` + `data:` + a blank line.
    """
    return f"event: {event_name}\ndata: {json.dumps(payload)}\n\n"


@router.post("/{session_id}/uploads", response_model=schemas.AgentUploadOut)
async def upload_file(
    session_id: uuid.UUID,
    file: UploadFile = File(...),
    session: AsyncSession = Depends(get_session),
) -> object:
    """Attach a 3D asset file or image to the current agent turn.

    Files land under ``settings.asset_root/agent_uploads/<session_id>/``
    with a UUID-prefixed name to avoid collisions. The response carries
    the metadata the client needs to reference the file in the next
    `/messages` POST. We classify on extension only; the agent gets a
    `kind` so it knows whether to treat the file as a 3D source path
    (asset_file) or as a vision attachment (image).
    """
    sess = await session.get(AgentSession, session_id)
    if sess is None:
        raise _session_not_found(f"Agent session {session_id} not found")
    if sess.status != "running":
        raise _session_locked(
            f"Session {session_id} is {sess.status!r}; cannot upload files."
        )

    original = file.filename or ""
    suffix = Path(original).suffix.lower()
    if suffix in _ASSET_EXTENSIONS:
        kind = "asset_file"
        max_bytes = _MAX_ASSET_BYTES
        media_type: str | None = None
    elif suffix in _IMAGE_EXTENSIONS_TO_MEDIA:
        kind = "image"
        max_bytes = _MAX_IMAGE_BYTES
        media_type = _IMAGE_EXTENSIONS_TO_MEDIA[suffix]
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Unsupported file type {suffix!r}. Allowed assets: "
                f"{', '.join(sorted(_ASSET_EXTENSIONS))}; allowed images: "
                f"{', '.join(sorted(_IMAGE_EXTENSIONS_TO_MEDIA))}."
            ),
        )

    content = await file.read()
    if not content:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Uploaded file is empty.",
        )
    if len(content) > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=(
                f"File exceeds {max_bytes // (1024 * 1024)} MB limit for "
                f"{kind} uploads."
            ),
        )

    upload_dir = settings.asset_root / "agent_uploads" / str(session_id)
    upload_dir.mkdir(parents=True, exist_ok=True)
    stored_name = safe_upload_name(original or f"upload{suffix}")
    target = upload_dir / stored_name
    target.write_bytes(content)

    # file_path is relative to settings.asset_root so the StaticFiles
    # mount at /assets/* can serve it back to the frontend if needed.
    file_path = f"agent_uploads/{session_id}/{stored_name}"
    return {
        "file_id": stored_name.rsplit(".", 1)[0],  # uuid prefix from safe_upload_name
        "filename": original or stored_name,
        "stored_name": stored_name,
        "file_path": file_path,
        "kind": kind,
        "media_type": media_type,
        "size_bytes": len(content),
    }


@router.post("/{session_id}/messages")
async def send_message(
    session_id: uuid.UUID,
    payload: schemas.AgentMessageCreate,
    session: AsyncSession = Depends(get_session),
) -> StreamingResponse:
    """Drive one user turn through the agent. Response body is an SSE
    stream of orchestrator events (assistant_chunk, tool_call,
    tool_result, done, error).

    Refuses on terminal sessions; bumps the heartbeat at start of
    turn so a long agent run can't get reaped mid-flight.
    """
    sess = await session.get(AgentSession, session_id)
    if sess is None:
        raise _session_not_found(f"Agent session {session_id} not found")
    if sess.status != "running":
        raise _session_locked(
            f"Session {session_id} is {sess.status!r}; cannot send messages."
        )

    # Bump heartbeat so the sweeper doesn't reap us while the agent works.
    # A long tool-use turn can easily exceed the default 300s timeout.
    sess.last_heartbeat_at = datetime.now(timezone.utc)
    await session.commit()

    # AgentAttachmentRef → plain dict for the orchestrator (which is
    # SDK-agnostic and works in JSON).
    attachments = [a.model_dump(by_alias=False) for a in payload.attachments]

    async def event_stream():
        async for event in agent_orchestrator.run_turn_streaming(
            session, session_id, payload.content, attachments
        ):
            event_name = event.pop("event")
            yield _format_sse(event_name, event)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            # Some proxies (nginx) buffer SSE by default — opt out so
            # the browser receives chunks as they're produced.
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
        },
    )
