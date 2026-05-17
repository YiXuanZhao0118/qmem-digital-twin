/**
 * AI Binding Panel — drives a Claude conversation against the
 * agent_orchestrator (alembic 0057 + alembic 0058).
 *
 * Three lifecycle states map to agent_sessions.status:
 *   - idle:     no session loaded — show "Start session" form
 *   - running:  active session — chat input + transcript + draft review
 *               + Approve / Cancel / Undo controls. A 30s heartbeat
 *               keeps the backend sweeper from auto-abandoning.
 *   - terminal: committed / cancelled / abandoned — show summary +
 *               offer to start a new session.
 *
 * Chat events arrive via SSE from POST /messages and accumulate into a
 * local transcript. The persisted source of truth for "what got
 * created" is the mutations list returned by GET /{id} — the chat
 * transcript is for human readability.
 */
import { Check, Lock, Paperclip, Send, Trash2, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  cancelAgentSessionApi,
  commitAgentSessionApi,
  createAgentSessionApi,
  getAgentSessionApi,
  heartbeatAgentSessionApi,
  streamAgentMessage,
  undoLastMutationApi,
  uploadAgentFileApi,
  type AgentStreamEvent,
} from "../api/client";
import type {
  AgentSession,
  AgentUpload,
  CommitResult,
  SessionMutation,
} from "../types/digitalTwin";
import { FloatingPanel } from "./workspace/FloatingPanel";

const HEARTBEAT_INTERVAL_MS = 30_000;

type ChatBubble =
  | {
      id: string;
      kind: "user";
      text: string;
      attachmentLabels?: string[];
    }
  | { id: string; kind: "assistant"; text: string }
  | {
      id: string;
      kind: "tool";
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
      result?: unknown;
      isError?: boolean;
    }
  | { id: string; kind: "error"; text: string };

type PanelState =
  | { kind: "idle" }
  | {
      kind: "running";
      session: AgentSession;
      mutations: SessionMutation[];
    }
  | {
      kind: "terminal";
      session: AgentSession;
      mutations: SessionMutation[];
      commitResult: CommitResult | null;
    };

function bubbleId(): string {
  return `bub_${Math.random().toString(36).slice(2)}`;
}

export function AIBindingPanel() {
  const [state, setState] = useState<PanelState>({ kind: "idle" });
  const [instruction, setInstruction] = useState("");
  const [chat, setChat] = useState<ChatBubble[]>([]);
  const [draftInput, setDraftInput] = useState("");
  const [attachments, setAttachments] = useState<AgentUpload[]>([]);
  const [uploading, setUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Auto-scroll to bottom when new messages arrive.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat]);

  // Heartbeat while session is running. Polling mutations after each
  // user turn is enough; we don't poll continuously — the SSE stream
  // already gives us tool_result events for in-flight work.
  const sessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (state.kind !== "running") {
      sessionIdRef.current = null;
      return;
    }
    sessionIdRef.current = state.session.id;

    const heartbeat = window.setInterval(async () => {
      const id = sessionIdRef.current;
      if (id === null) return;
      try {
        await heartbeatAgentSessionApi(id);
      } catch (e) {
        console.warn("[AIBindingPanel] heartbeat failed", e);
      }
    }, HEARTBEAT_INTERVAL_MS);

    return () => window.clearInterval(heartbeat);
  }, [state]);

  const handleStart = useCallback(async () => {
    setBusy(true);
    setErrorMsg(null);
    try {
      const session = await createAgentSessionApi({
        instruction: instruction.trim(),
      });
      setState({ kind: "running", session, mutations: [] });
      setChat([]);
      setInstruction("");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to start session.");
    } finally {
      setBusy(false);
    }
  }, [instruction]);

  const refreshSession = useCallback(async (sessionId: string) => {
    const latest = await getAgentSessionApi(sessionId);
    setState((prev) => {
      if (prev.kind !== "running") return prev;
      return {
        kind: "running",
        session: latest.session,
        mutations: latest.mutations,
      };
    });
  }, []);

  const handleSend = useCallback(async () => {
    if (state.kind !== "running") return;
    // Allow send when there's text OR at least one attachment.
    if (!draftInput.trim() && attachments.length === 0) return;
    const sessionId = state.session.id;
    const userText = draftInput.trim();
    const turnAttachments = attachments;
    setDraftInput("");
    setAttachments([]);
    setStreaming(true);
    setErrorMsg(null);

    // Append the user bubble + a fresh assistant bubble that will
    // accumulate text deltas. Attached files appear inline so the
    // transcript shows what the agent actually saw.
    const assistantBubbleId = bubbleId();
    setChat((prev) => [
      ...prev,
      {
        id: bubbleId(),
        kind: "user",
        text: userText,
        attachmentLabels: turnAttachments.map((a) => a.filename),
      },
      { id: assistantBubbleId, kind: "assistant", text: "" },
    ]);

    try {
      await streamAgentMessage(
        sessionId,
        userText,
        (event) => handleStreamEvent(event, assistantBubbleId, setChat),
        {
          attachments: turnAttachments.map((a) => ({
            storedName: a.storedName,
            filename: a.filename,
            filePath: a.filePath,
            kind: a.kind,
            mediaType: a.mediaType,
          })),
        },
      );
      await refreshSession(sessionId);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Stream failed.");
      setChat((prev) => [
        ...prev,
        {
          id: bubbleId(),
          kind: "error",
          text: e instanceof Error ? e.message : String(e),
        },
      ]);
    } finally {
      setStreaming(false);
    }
  }, [state, draftInput, attachments, refreshSession]);

  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFilesChosen = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      if (state.kind !== "running" || !event.target.files) return;
      const files = Array.from(event.target.files);
      // Reset input so the same filename can be re-picked later.
      event.target.value = "";
      if (files.length === 0) return;
      setUploading(true);
      setErrorMsg(null);
      try {
        const uploaded: AgentUpload[] = [];
        for (const file of files) {
          const up = await uploadAgentFileApi(state.session.id, file);
          uploaded.push(up);
        }
        setAttachments((prev) => [...prev, ...uploaded]);
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : "Upload failed.");
      } finally {
        setUploading(false);
      }
    },
    [state],
  );

  const removeAttachment = useCallback((storedName: string) => {
    setAttachments((prev) => prev.filter((a) => a.storedName !== storedName));
  }, []);

  const handleCommit = useCallback(async () => {
    if (state.kind !== "running") return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const result = await commitAgentSessionApi(state.session.id);
      const refreshed = await getAgentSessionApi(state.session.id);
      setState({
        kind: "terminal",
        session: refreshed.session,
        mutations: refreshed.mutations,
        commitResult: result,
      });
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Approve failed.");
    } finally {
      setBusy(false);
    }
  }, [state]);

  const handleCancel = useCallback(async () => {
    if (state.kind !== "running") return;
    setBusy(true);
    setErrorMsg(null);
    try {
      await cancelAgentSessionApi(state.session.id);
      const refreshed = await getAgentSessionApi(state.session.id);
      setState({
        kind: "terminal",
        session: refreshed.session,
        mutations: refreshed.mutations,
        commitResult: null,
      });
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Cancel failed.");
    } finally {
      setBusy(false);
    }
  }, [state]);

  const handleUndo = useCallback(async () => {
    if (state.kind !== "running") return;
    setBusy(true);
    setErrorMsg(null);
    try {
      await undoLastMutationApi(state.session.id);
      await refreshSession(state.session.id);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Undo failed.");
    } finally {
      setBusy(false);
    }
  }, [state, refreshSession]);

  const handleReset = useCallback(() => {
    setState({ kind: "idle" });
    setChat([]);
    setErrorMsg(null);
  }, []);

  const liveMutations = useMemo(() => {
    if (state.kind === "idle") return [];
    return state.mutations.filter((m) => m.undoneAt === null);
  }, [state]);

  return (
    <FloatingPanel id="ai-binding" title="AI Binding" icon={<Lock size={14} />}>
      <div className="ai-binding-panel">
        {state.kind === "idle" && (
          <div className="ai-binding-idle">
            <p className="ai-binding-hint">
              Describe what to bind. The agent will create draft Assets &
              Components for you to review.
            </p>
            <textarea
              className="ai-binding-input"
              placeholder="e.g. Register the AOM-MT80 GLB and bind it as an aom kind."
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={3}
              disabled={busy}
            />
            <button
              type="button"
              className="ai-binding-primary"
              onClick={handleStart}
              disabled={busy}
            >
              <Send size={14} />
              Start session
            </button>
          </div>
        )}

        {state.kind === "running" && (
          <>
            <div className="ai-binding-header">
              <span className="ai-binding-status">running</span>
              <span
                className="ai-binding-instruction"
                title={state.session.instruction}
              >
                {state.session.instruction || "(no instruction)"}
              </span>
            </div>

            <div className="ai-binding-chat" ref={transcriptRef}>
              {chat.length === 0 ? (
                <p className="ai-binding-placeholder">
                  Type below to start a turn. The agent can list kinds,
                  list existing assets/components, and create drafts.
                </p>
              ) : (
                chat.map((bubble) => <ChatBubbleView key={bubble.id} bubble={bubble} />)
              )}
              {streaming && (
                <p className="ai-binding-streaming-indicator">streaming…</p>
              )}
            </div>

            {attachments.length > 0 && (
              <div className="ai-binding-attachments">
                {attachments.map((att) => (
                  <span key={att.storedName} className="ai-binding-attachment-chip">
                    <span className="ai-binding-attachment-kind">
                      {att.kind === "image" ? "img" : "3d"}
                    </span>
                    <span className="ai-binding-attachment-name" title={att.filename}>
                      {att.filename}
                    </span>
                    <button
                      type="button"
                      className="ai-binding-attachment-remove"
                      onClick={() => removeAttachment(att.storedName)}
                      title="Remove attachment"
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
                {uploading && (
                  <span className="ai-binding-attachment-uploading">uploading…</span>
                )}
              </div>
            )}

            <div className="ai-binding-compose">
              <input
                ref={fileInputRef}
                type="file"
                accept=".glb,.gltf,.obj,.stl,.step,.stp,.sldprt,.dxf,.png,.jpg,.jpeg,.webp,.gif"
                multiple
                style={{ display: "none" }}
                onChange={handleFilesChosen}
              />
              <button
                type="button"
                className="ai-binding-secondary ai-binding-attach-button"
                onClick={handleAttachClick}
                disabled={streaming || busy || uploading}
                title="Attach 3D file or image"
              >
                <Paperclip size={14} />
              </button>
              <textarea
                className="ai-binding-input"
                placeholder="Tell the agent what to bind…"
                value={draftInput}
                onChange={(e) => setDraftInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                rows={2}
                disabled={streaming || busy}
              />
              <button
                type="button"
                className="ai-binding-primary"
                onClick={handleSend}
                disabled={
                  streaming ||
                  busy ||
                  uploading ||
                  (!draftInput.trim() && attachments.length === 0)
                }
                title="Send (Ctrl/Cmd + Enter)"
              >
                <Send size={14} />
              </button>
            </div>

            <div className="ai-binding-review">
              <h4 className="ai-binding-section-title">
                Pending changes ({liveMutations.length})
              </h4>
              {liveMutations.length === 0 ? (
                <p className="ai-binding-empty">No drafts yet.</p>
              ) : (
                <ul className="ai-binding-mutation-list">
                  {liveMutations.map((m) => (
                    <MutationRow key={m.id} mutation={m} />
                  ))}
                </ul>
              )}
            </div>

            <div className="ai-binding-controls">
              <button
                type="button"
                className="ai-binding-secondary"
                onClick={handleUndo}
                disabled={busy || streaming || liveMutations.length === 0}
                title="Undo the most recent change"
              >
                <Undo2 size={14} />
                Undo
              </button>
              <button
                type="button"
                className="ai-binding-danger"
                onClick={handleCancel}
                disabled={busy || streaming}
                title="Discard all changes and end the session"
              >
                <Trash2 size={14} />
                Cancel
              </button>
              <button
                type="button"
                className="ai-binding-primary"
                onClick={handleCommit}
                disabled={busy || streaming || liveMutations.length === 0}
                title="Approve all changes and lock the bindings"
              >
                <Check size={14} />
                Approve
              </button>
            </div>
          </>
        )}

        {state.kind === "terminal" && (
          <div className="ai-binding-terminal">
            <div className="ai-binding-header">
              <span className="ai-binding-status">{state.session.status}</span>
              {state.session.cancellationReason && (
                <span className="ai-binding-instruction">
                  {state.session.cancellationReason}
                </span>
              )}
            </div>
            {state.commitResult && (
              <div className="ai-binding-summary">
                <div>
                  Approved assets: {state.commitResult.approvedAssets.length}
                </div>
                <div>
                  Approved components:{" "}
                  {state.commitResult.approvedComponents.length}
                </div>
              </div>
            )}
            <button
              type="button"
              className="ai-binding-primary"
              onClick={handleReset}
            >
              Start new session
            </button>
          </div>
        )}

        {errorMsg && <p className="ai-binding-error">{errorMsg}</p>}
      </div>
    </FloatingPanel>
  );
}

function handleStreamEvent(
  event: AgentStreamEvent,
  assistantBubbleId: string,
  setChat: React.Dispatch<React.SetStateAction<ChatBubble[]>>,
): void {
  switch (event.event) {
    case "assistant_chunk":
      setChat((prev) =>
        prev.map((b) =>
          b.id === assistantBubbleId && b.kind === "assistant"
            ? { ...b, text: b.text + event.text }
            : b,
        ),
      );
      break;
    case "tool_call":
      setChat((prev) => [
        ...prev,
        {
          id: bubbleId(),
          kind: "tool",
          toolUseId: event.id,
          name: event.name,
          input: event.input,
        },
      ]);
      break;
    case "tool_result":
      setChat((prev) =>
        prev.map((b) =>
          b.kind === "tool" && b.toolUseId === event.toolUseId
            ? { ...b, result: event.content, isError: event.isError }
            : b,
        ),
      );
      break;
    case "error":
      setChat((prev) => [
        ...prev,
        { id: bubbleId(), kind: "error", text: event.message },
      ]);
      break;
    case "done":
      // No-op — the assistant bubble already has its text, refreshSession
      // pulls fresh mutations.
      break;
  }
}

function ChatBubbleView({ bubble }: { bubble: ChatBubble }) {
  if (bubble.kind === "user") {
    return (
      <div className="ai-binding-bubble ai-binding-bubble-user">
        {bubble.attachmentLabels && bubble.attachmentLabels.length > 0 && (
          <div className="ai-binding-bubble-attachments">
            {bubble.attachmentLabels.map((label, i) => (
              <span key={i} className="ai-binding-bubble-attachment">
                📎 {label}
              </span>
            ))}
          </div>
        )}
        {bubble.text}
      </div>
    );
  }
  if (bubble.kind === "assistant") {
    return (
      <div className="ai-binding-bubble ai-binding-bubble-assistant">
        {bubble.text || <span className="ai-binding-placeholder">…</span>}
      </div>
    );
  }
  if (bubble.kind === "tool") {
    return (
      <div className="ai-binding-bubble ai-binding-bubble-tool">
        <strong>{bubble.name}</strong>
        <pre>{JSON.stringify(bubble.input, null, 2)}</pre>
        {bubble.result !== undefined && (
          <>
            <hr />
            <pre className={bubble.isError ? "ai-binding-tool-error" : ""}>
              {typeof bubble.result === "string"
                ? bubble.result
                : JSON.stringify(bubble.result, null, 2)}
            </pre>
          </>
        )}
      </div>
    );
  }
  return (
    <div className="ai-binding-bubble ai-binding-bubble-error">
      {bubble.text}
    </div>
  );
}

function MutationRow({ mutation }: { mutation: SessionMutation }) {
  const after = (mutation.after ?? {}) as Record<string, unknown>;
  const name = typeof after.name === "string" ? after.name : mutation.entityId;
  const subtitle =
    typeof after.component_type === "string"
      ? `component · ${after.component_type}`
      : typeof after.asset_type === "string"
        ? `asset · ${after.asset_type}`
        : mutation.entityType;
  return (
    <li className="ai-binding-mutation-row">
      <span className="ai-binding-mutation-op">{mutation.op}</span>
      <div className="ai-binding-mutation-text">
        <strong>{name}</strong>
        <small>{subtitle}</small>
      </div>
    </li>
  );
}
