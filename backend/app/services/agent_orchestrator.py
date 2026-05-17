"""Drives a Claude conversation for one agent session.

Public entry point :func:`run_turn_streaming` is an async generator
that yields dict events suitable for SSE encoding:

    {"event": "assistant_chunk", "text": "..."}
    {"event": "tool_call", "id": "...", "name": "...", "input": {...}}
    {"event": "tool_result", "tool_use_id": "...", "content": ...,
                              "is_error": bool}
    {"event": "done", "stop_reason": "end_turn"}
    {"event": "error", "message": "..."}

The orchestrator owns the agentic loop: one user turn in, N model
roundtrips (text + tool_use), tool dispatch to
:mod:`app.services.agent_tools`, results fed back, repeat until
``stop_reason == "end_turn"`` or the safety iteration cap fires.

Session state (the Anthropic ``messages[]`` array) is persisted to
``agent_sessions.messages_json`` after each turn so a backend restart
or browser refresh mid-conversation can resume cleanly.
"""

from __future__ import annotations

import base64
import json
import uuid
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any

from anthropic import AsyncAnthropic, APIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import AgentSession, Asset3D, Component
from app.services import agent_tools
from app.services.agent_tool_schemas import AGENT_TOOL_SCHEMAS, SYSTEM_PROMPT
from app.services.agent_tools import EntityLockedError, ToolValidationError


# Belt-and-suspenders cap on roundtrips per user turn. The model also
# converges via end_turn; this guards against pathological tool-call
# loops chewing through tokens.
_MAX_ITERATIONS = 12


# ---------------------------------------------------------------------------
# Singleton client. AsyncAnthropic is cheap to construct but holds a
# connection pool — keep one per process. Lazily built so the import path
# stays clean when the key isn't set (the panel can still render).
# ---------------------------------------------------------------------------


_client: AsyncAnthropic | None = None


def _get_client() -> AsyncAnthropic | None:
    global _client
    if _client is not None:
        return _client
    if not settings.anthropic_api_key:
        return None
    _client = AsyncAnthropic(api_key=settings.anthropic_api_key)
    return _client


# ---------------------------------------------------------------------------
# Tool dispatch — bridges LLM-facing tool_use blocks to agent_tools fns.
# ---------------------------------------------------------------------------


def _serialize_asset(asset: Asset3D) -> dict[str, Any]:
    return {
        "id": str(asset.id),
        "name": asset.name,
        "asset_type": asset.asset_type,
        "file_path": asset.file_path,
        "unit": asset.unit,
        "scale_factor": asset.scale_factor,
        "status": asset.status,
    }


def _serialize_component(comp: Component) -> dict[str, Any]:
    return {
        "id": str(comp.id),
        "name": comp.name,
        "component_type": comp.component_type,
        "asset_3d_id": str(comp.asset_3d_id) if comp.asset_3d_id else None,
        "brand": comp.brand,
        "model": comp.model,
        "status": comp.status,
    }


async def _dispatch_tool(
    db: AsyncSession,
    session_id: uuid.UUID,
    tool_name: str,
    tool_input: dict[str, Any],
) -> tuple[Any, bool]:
    """Run one tool call. Returns ``(content, is_error)`` — ``content`` is
    already JSON-serialisable (str or list/dict). Errors come back as
    error strings (not raised) so the agent can self-correct on the
    next turn rather than crashing the stream.
    """
    try:
        if tool_name == "list_kinds":
            return agent_tools.list_kinds(), False

        if tool_name == "list_existing_assets":
            assets = await agent_tools.list_existing_assets(db, session_id)
            return [_serialize_asset(a) for a in assets], False

        if tool_name == "list_existing_components":
            comps = await agent_tools.list_existing_components(db, session_id)
            return [_serialize_component(c) for c in comps], False

        if tool_name == "create_asset":
            # asset_3d_id is a UUID in the DB but a str on the wire —
            # agent_tools.create_asset doesn't need conversion here.
            asset = await agent_tools.create_asset(
                db, session_id=session_id, **tool_input
            )
            return _serialize_asset(asset), False

        if tool_name == "create_component":
            # The model sends asset_3d_id as a string; convert to UUID
            # so SQLAlchemy / Pydantic don't choke.
            raw_input = dict(tool_input)
            asset_id_raw = raw_input.pop("asset_3d_id", None)
            asset_id = uuid.UUID(asset_id_raw) if asset_id_raw else None
            comp = await agent_tools.create_component(
                db,
                session_id=session_id,
                asset_3d_id=asset_id,
                **raw_input,
            )
            return _serialize_component(comp), False

        return f"Unknown tool: {tool_name}", True

    except ToolValidationError as e:
        return f"ValidationError: {e}", True
    except EntityLockedError as e:
        return f"EntityLockedError: {e}", True
    except ValueError as e:
        # uuid.UUID(...) on bad input lands here; agent's chance to retry.
        return f"ValueError: {e}", True


# ---------------------------------------------------------------------------
# Conversation history helpers.
# ---------------------------------------------------------------------------


async def _load_history(
    db: AsyncSession, session_id: uuid.UUID
) -> list[dict[str, Any]]:
    sess = await db.get(AgentSession, session_id)
    if sess is None:
        return []
    return list(sess.messages_json or [])


async def _save_history(
    db: AsyncSession,
    session_id: uuid.UUID,
    history: list[dict[str, Any]],
) -> None:
    sess = await db.get(AgentSession, session_id)
    if sess is None:
        return
    sess.messages_json = history
    await db.commit()


# ---------------------------------------------------------------------------
# Public entry point.
# ---------------------------------------------------------------------------


def _build_user_content(
    user_message: str,
    attachments: list[dict[str, Any]] | None,
    session_id: uuid.UUID,
) -> str | list[dict[str, Any]]:
    """Turn `(user_text, attachments)` into the right shape for the
    Anthropic ``messages[].content`` field.

    No attachments → plain string (cheapest).
    Asset files → text-only blocks describing each path, prepended.
    Images → ``image`` content blocks with base64 source, appended.

    Asset paths are recomputed from ``stored_name`` against the
    session's own upload dir, so a malicious client passing
    ``file_path: "../../../etc/passwd"`` lands on disk and 404s
    rather than reading arbitrary files.
    """
    if not attachments:
        return user_message

    blocks: list[dict[str, Any]] = []
    asset_lines: list[str] = []

    for att in attachments:
        stored_name = att.get("stored_name") or ""
        if not stored_name or "/" in stored_name or "\\" in stored_name:
            continue  # path-traversal guard
        kind = att.get("kind")
        on_disk = (
            settings.asset_root / "agent_uploads" / str(session_id) / stored_name
        )
        if not on_disk.is_file():
            # Client referenced an upload that doesn't exist for this
            # session; skip silently so the agent doesn't see a phantom
            # attachment.
            continue

        if kind == "asset_file":
            rel_path = f"agent_uploads/{session_id}/{stored_name}"
            asset_lines.append(
                f"- {att.get('filename', stored_name)} at `{rel_path}`"
            )
        elif kind == "image":
            media_type = att.get("media_type") or "image/png"
            data_b64 = base64.standard_b64encode(on_disk.read_bytes()).decode("ascii")
            blocks.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": data_b64,
                    },
                }
            )

    text_parts: list[str] = []
    if asset_lines:
        text_parts.append(
            "Attached files for this turn (pass these paths to "
            "create_asset.file_path):\n" + "\n".join(asset_lines)
        )
    if user_message.strip():
        text_parts.append(user_message)
    if text_parts:
        blocks.append({"type": "text", "text": "\n\n".join(text_parts)})

    return blocks


async def run_turn_streaming(
    db: AsyncSession,
    session_id: uuid.UUID,
    user_message: str,
    attachments: list[dict[str, Any]] | None = None,
) -> AsyncGenerator[dict[str, Any], None]:
    """One user turn, streaming events out as they arrive.

    Caller is responsible for verifying the session is in 'running'
    state before invoking — this generator assumes it.
    """
    client = _get_client()
    if client is None:
        yield {
            "event": "error",
            "message": (
                "ANTHROPIC_API_KEY is not configured on the backend. "
                "Set it in .env to enable the AI binding agent."
            ),
        }
        return

    history = await _load_history(db, session_id)
    user_content = _build_user_content(user_message, attachments, session_id)
    history.append({"role": "user", "content": user_content})

    for iteration in range(_MAX_ITERATIONS):
        # Per-turn streaming call. AsyncAnthropic.messages.stream() is an
        # async context manager that yields events; we collect text
        # deltas and the final message in one pass.
        try:
            async with client.messages.stream(
                model=settings.anthropic_model,
                max_tokens=settings.anthropic_max_tokens,
                system=[
                    {
                        "type": "text",
                        "text": SYSTEM_PROMPT,
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
                tools=AGENT_TOOL_SCHEMAS,
                messages=history,
                thinking={"type": "disabled"},
            ) as stream:
                async for event in stream:
                    # Stream only the assistant's running text — tool_use
                    # blocks land as content_block_start without
                    # streamable text and are surfaced via the final
                    # message below.
                    if event.type == "content_block_delta":
                        delta = event.delta
                        if getattr(delta, "type", None) == "text_delta":
                            yield {
                                "event": "assistant_chunk",
                                "text": delta.text,
                            }
                final_message = await stream.get_final_message()
        except APIError as e:
            yield {
                "event": "error",
                "message": f"Anthropic API error: {e}",
            }
            # Don't persist the half-written turn — the user msg stays
            # appended but no assistant turn lands, so the next attempt
            # can retry cleanly.
            await _save_history(db, session_id, history)
            return

        # Append the assistant turn verbatim. Pydantic models serialise
        # to dicts cleanly via .model_dump().
        history.append(
            {
                "role": "assistant",
                "content": [
                    block.model_dump(exclude_none=True)
                    for block in final_message.content
                ],
            }
        )

        if final_message.stop_reason == "end_turn":
            await _save_history(db, session_id, history)
            yield {"event": "done", "stop_reason": "end_turn"}
            return

        if final_message.stop_reason != "tool_use":
            # Could be 'max_tokens', 'refusal', 'stop_sequence' — none
            # are recoverable from here. Persist and surface.
            await _save_history(db, session_id, history)
            yield {
                "event": "done",
                "stop_reason": final_message.stop_reason or "unknown",
            }
            return

        # Dispatch every tool_use block in this turn, accumulating
        # tool_result blocks for the next user message.
        tool_results: list[dict[str, Any]] = []
        for block in final_message.content:
            if block.type != "tool_use":
                continue
            yield {
                "event": "tool_call",
                "id": block.id,
                "name": block.name,
                "input": block.input,
            }
            content, is_error = await _dispatch_tool(
                db, session_id, block.name, dict(block.input)
            )
            yield {
                "event": "tool_result",
                "tool_use_id": block.id,
                "content": content,
                "is_error": is_error,
            }
            tool_results.append(
                {
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    # Anthropic accepts str or list[content block]; str
                    # is simplest and what we want for JSON payloads.
                    "content": (
                        content
                        if isinstance(content, str)
                        else json.dumps(content)
                    ),
                    "is_error": is_error,
                }
            )

        history.append({"role": "user", "content": tool_results})
        # Loop back: next iteration starts a fresh stream with the
        # updated history.

    # Hit the iteration cap without converging.
    await _save_history(db, session_id, history)
    yield {
        "event": "error",
        "message": (
            f"Agent exceeded {_MAX_ITERATIONS} tool-use rounds in a single "
            "turn. The conversation is preserved — send another message "
            "to nudge it toward a conclusion."
        ),
    }
