/**
 * KindsEditor — CRUD UI for the kinds DB table (alembic 0086).
 *
 * Each row is one Kind metadata variant. PhysicsOp implementations live
 * in code; each row references one by ``opSetName``. Creating a new row
 * lets the user curate metadata variants (different defaults / face
 * template / wavelength range) without writing TypeScript. Introducing
 * genuinely new physics behavior still requires a code change to add a
 * new op set.
 *
 * Backed by /api/kinds (see ../api/client.ts → listKindsApi etc.) and
 * docs/asset-physics-model.md §6.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  createKindApi,
  deleteKindApi,
  listKindsApi,
  updateKindApi,
  type KindCreatePayload,
  type KindDomain,
  type KindPatchPayload,
  type KindRow,
} from "../api/client";

type EditDraft = {
  displayName: string;
  defaultParams: string;
  faceTemplate: string;
  needsAperture: boolean;
  wavelengthRangeNm: string;
  description: string;
};

function rowToDraft(row: KindRow): EditDraft {
  return {
    displayName: row.displayName,
    defaultParams: JSON.stringify(row.defaultParams ?? {}, null, 2),
    faceTemplate: JSON.stringify(row.faceTemplate ?? {}, null, 2),
    needsAperture: row.needsAperture,
    wavelengthRangeNm: row.wavelengthRangeNm
      ? row.wavelengthRangeNm.join(", ")
      : "",
    description: row.description ?? "",
  };
}

function parseWavelengthRange(s: string): number[] | null {
  const t = s.trim();
  if (!t) return null;
  const parts = t.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error("wavelengthRangeNm must be two comma-separated numbers, e.g. \"350, 700\"");
  }
  return parts;
}

function parseJsonObject(s: string, fieldLabel: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${fieldLabel}: ${(e as Error).message}`);
  }
}

export function KindsEditor({
  domain = "optical",
  readOnly = false,
}: { domain?: KindDomain; readOnly?: boolean } = {}) {
  const [rows, setRows] = useState<KindRow[]>([]);
  const [loadStatus, setLoadStatus] = useState<"idle" | "loading" | "error">("idle");
  const [loadError, setLoadError] = useState<string | null>(null);

  // Selected row's id for inline edit, plus its draft buffer.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [editStatus, setEditStatus] = useState<"idle" | "saving" | "error">("idle");
  const [editError, setEditError] = useState<string | null>(null);

  // Create form state.
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<KindCreatePayload>({
    name: "",
    displayName: "",
    domain,
    opSetName: "",
    defaultParams: {},
    faceTemplate: {},
    needsAperture: false,
    wavelengthRangeNm: null,
    description: "",
  });
  const [createJsonDrafts, setCreateJsonDrafts] = useState({
    defaultParams: "{}",
    faceTemplate: "{}",
    wavelengthRangeNm: "",
  });
  const [createStatus, setCreateStatus] = useState<"idle" | "saving" | "error">("idle");
  const [createError, setCreateError] = useState<string | null>(null);

  // Delete confirmation tracking.
  const [deleteStatus, setDeleteStatus] = useState<Record<string, "idle" | "deleting" | "error">>({});

  const reload = useCallback(async () => {
    setLoadStatus("loading");
    setLoadError(null);
    try {
      const data = await listKindsApi(domain);
      setRows(data);
      setLoadStatus("idle");
    } catch (e) {
      setLoadStatus("error");
      setLoadError((e as Error).message);
    }
  }, [domain]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // op_set_name dropdown options derived from existing rows. Captures
  // everything currently backfilled from the manifest plus anything the
  // user has created. Doesn't include code-side op-set names not yet
  // surfaced as a kind — that's fine for v1 since the typical "create
  // variant" workflow picks an existing kind to clone behavior from.
  const opSetOptions = useMemo(() => {
    const set = new Set<string>(rows.map((r) => r.opSetName));
    return [...set].sort();
  }, [rows]);

  const startEdit = (row: KindRow) => {
    setEditingId(row.id);
    setEditDraft(rowToDraft(row));
    setEditStatus("idle");
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft(null);
    setEditStatus("idle");
    setEditError(null);
  };

  const submitEdit = async () => {
    if (!editingId || !editDraft) return;
    setEditStatus("saving");
    setEditError(null);
    let patch: KindPatchPayload;
    try {
      patch = {
        displayName: editDraft.displayName,
        defaultParams: parseJsonObject(editDraft.defaultParams, "defaultParams"),
        faceTemplate: parseJsonObject(editDraft.faceTemplate, "faceTemplate"),
        needsAperture: editDraft.needsAperture,
        wavelengthRangeNm: parseWavelengthRange(editDraft.wavelengthRangeNm),
        description: editDraft.description || null,
      };
    } catch (e) {
      setEditStatus("error");
      setEditError((e as Error).message);
      return;
    }
    try {
      await updateKindApi(editingId, patch);
      await reload();
      cancelEdit();
    } catch (e) {
      setEditStatus("error");
      setEditError((e as Error).message);
    }
  };

  const submitCreate = async () => {
    setCreateStatus("saving");
    setCreateError(null);
    let payload: KindCreatePayload;
    try {
      payload = {
        ...createDraft,
        defaultParams: parseJsonObject(createJsonDrafts.defaultParams, "defaultParams"),
        faceTemplate: parseJsonObject(createJsonDrafts.faceTemplate, "faceTemplate"),
        wavelengthRangeNm: parseWavelengthRange(createJsonDrafts.wavelengthRangeNm),
        description: createDraft.description || null,
      };
      if (!payload.name) throw new Error("name is required");
      if (!payload.displayName) throw new Error("displayName is required");
      if (!payload.opSetName) throw new Error("opSetName is required");
    } catch (e) {
      setCreateStatus("error");
      setCreateError((e as Error).message);
      return;
    }
    try {
      await createKindApi(payload);
      await reload();
      setCreateOpen(false);
      setCreateDraft({
        name: "",
        displayName: "",
        domain,
        opSetName: "",
        defaultParams: {},
        faceTemplate: {},
        needsAperture: false,
        wavelengthRangeNm: null,
        description: "",
      });
      setCreateJsonDrafts({ defaultParams: "{}", faceTemplate: "{}", wavelengthRangeNm: "" });
      setCreateStatus("idle");
    } catch (e) {
      setCreateStatus("error");
      setCreateError((e as Error).message);
    }
  };

  const handleDelete = async (row: KindRow) => {
    if (!window.confirm(`Delete kind "${row.name}"? This cannot be undone.`)) return;
    setDeleteStatus((prev) => ({ ...prev, [row.id]: "deleting" }));
    try {
      await deleteKindApi(row.id);
      await reload();
      setDeleteStatus((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
    } catch (e) {
      setDeleteStatus((prev) => ({ ...prev, [row.id]: "error" }));
      window.alert(`Delete failed: ${(e as Error).message}`);
    }
  };

  const domainLabel = domain === "rf" ? "RF" : domain === "mechanical" ? "Mechanical" : "Optical";

  return (
    <div
      className="kinds-editor"
      style={{
        padding: 12,
        // Own the scroll boundary so the grid (24+ cards) doesn't push
        // outside the pane. PhyEditor's .phy-editor-pane gives us a
        // height, so height: 100% + overflow: auto lets us scroll
        // internally.
        height: "100%",
        overflow: "auto",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <strong>{domainLabel} → Kinds</strong>
        <span style={{ opacity: 0.7, fontSize: 12 }}>
          · {rows.length} {domain}-element kind{rows.length === 1 ? "" : "s"} (DB)
        </span>
        {!readOnly && (
          <button
            type="button"
            onClick={() => setCreateOpen((v) => !v)}
            style={{
              fontSize: 12,
              padding: "3px 10px",
              background: createOpen ? "#dcfce7" : "#fde68a",
              border: "1px solid " + (createOpen ? "#16a34a" : "#ca8a04"),
              cursor: "pointer",
            }}
          >
            {createOpen ? "× Cancel" : "+ New kind"}
          </button>
        )}
        {!readOnly && (
          <button
            type="button"
            onClick={() => void reload()}
            disabled={loadStatus === "loading"}
            style={{ fontSize: 11, padding: "2px 8px" }}
          >
            {loadStatus === "loading" ? "Loading…" : "↻ Refresh"}
          </button>
        )}
        {readOnly && (
          <span style={{ fontSize: 10, opacity: 0.55, marginLeft: 4 }}>
            read-only · edit in 🔧 Binding dev
          </span>
        )}
        {loadError && (
          <span style={{ color: "#b91c1c", fontSize: 11 }}>{loadError}</span>
        )}
      </div>

      {createOpen && !readOnly && (
        <div
          style={{
            border: "1px solid #16a34a",
            background: "#f0fdf4",
            padding: 10,
            marginBottom: 12,
            borderRadius: 4,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8 }}>
            + New kind ({domainLabel})
          </div>
          <FieldGrid>
            <Field label="kind_id (unique slug)">
              <input
                value={createDraft.name}
                onChange={(e) => setCreateDraft({ ...createDraft, name: e.target.value })}
                placeholder="e.g. my_custom_lens"
                style={{ width: "100%" }}
              />
            </Field>
            <Field label="name (display)">
              <input
                value={createDraft.displayName}
                onChange={(e) => setCreateDraft({ ...createDraft, displayName: e.target.value })}
                placeholder="e.g. My Custom Lens"
                style={{ width: "100%" }}
              />
            </Field>
            <Field label="opSetName">
              <select
                value={createDraft.opSetName}
                onChange={(e) => setCreateDraft({ ...createDraft, opSetName: e.target.value })}
                style={{ width: "100%" }}
              >
                <option value="">— pick an op set —</option>
                {opSetOptions.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </Field>
            <Field label="needsAperture">
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={createDraft.needsAperture ?? false}
                  onChange={(e) => setCreateDraft({ ...createDraft, needsAperture: e.target.checked })}
                />
                checked = required
              </label>
            </Field>
          </FieldGrid>
          <Field label="defaultParams (JSON)">
            <textarea
              value={createJsonDrafts.defaultParams}
              onChange={(e) => setCreateJsonDrafts({ ...createJsonDrafts, defaultParams: e.target.value })}
              style={{ width: "100%", minHeight: 80, fontFamily: "monospace", fontSize: 11 }}
            />
          </Field>
          <Field label="faceTemplate (JSON — anchors block)">
            <textarea
              value={createJsonDrafts.faceTemplate}
              onChange={(e) => setCreateJsonDrafts({ ...createJsonDrafts, faceTemplate: e.target.value })}
              style={{ width: "100%", minHeight: 60, fontFamily: "monospace", fontSize: 11 }}
            />
          </Field>
          <Field label="wavelengthRangeNm (optional, &quot;350, 700&quot;)">
            <input
              value={createJsonDrafts.wavelengthRangeNm}
              onChange={(e) => setCreateJsonDrafts({ ...createJsonDrafts, wavelengthRangeNm: e.target.value })}
              placeholder="e.g. 350, 700"
              style={{ width: "100%" }}
            />
          </Field>
          <Field label="description (optional)">
            <textarea
              value={createDraft.description ?? ""}
              onChange={(e) => setCreateDraft({ ...createDraft, description: e.target.value })}
              style={{ width: "100%", minHeight: 40, fontSize: 12 }}
            />
          </Field>
          {createError && (
            <div style={{ color: "#b91c1c", fontSize: 11, marginTop: 4 }}>
              {createError}
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              onClick={() => void submitCreate()}
              disabled={createStatus === "saving"}
              style={{
                fontSize: 12,
                padding: "3px 12px",
                background: "#86efac",
                border: "1px solid #16a34a",
              }}
            >
              {createStatus === "saving" ? "Creating…" : "Create"}
            </button>
          </div>
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
          gap: 10,
        }}
      >
        {rows.map((row) => {
          const isEditing = editingId === row.id;
          const delStatus = deleteStatus[row.id] ?? "idle";
          return (
            <div
              key={row.id}
              style={{
                border: "1px solid " + (isEditing ? "#ca8a04" : "#e5e7eb"),
                background: isEditing ? "#fefce8" : "#fff",
                borderRadius: 4,
                padding: 10,
                fontSize: 12,
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
                <strong>{row.displayName}</strong>
                <code style={{ background: "#f3f4f6", padding: "1px 4px", borderRadius: 2, fontSize: 11 }}>
                  {row.name}
                </code>
                <span style={{ marginLeft: "auto", fontSize: 10, opacity: 0.6 }}>
                  op_set: <code>{row.opSetName}</code>
                </span>
              </div>
              {!isEditing && (
                <>
                  {row.description && (
                    <div
                      title={row.description}
                      style={{
                        opacity: 0.75,
                        marginBottom: 6,
                        fontSize: 11,
                        // Clamp long descriptions to 2 lines + ellipsis so
                        // an AOM with a 700-char description doesn't blow
                        // up the card height. Full text on hover.
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {row.description}
                    </div>
                  )}
                  <div style={{ fontSize: 11, opacity: 0.7 }}>
                    needsAperture: {row.needsAperture ? "yes" : "no"}
                    {row.wavelengthRangeNm && (
                      <> · λ: {row.wavelengthRangeNm.join("–")} nm</>
                    )}
                  </div>
                  {!readOnly && (
                    <div style={{ marginTop: 6, display: "flex", gap: 4 }}>
                      <button
                        type="button"
                        onClick={() => startEdit(row)}
                        style={{ fontSize: 11, padding: "1px 8px" }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(row)}
                        disabled={delStatus === "deleting"}
                        style={{
                          fontSize: 11,
                          padding: "1px 8px",
                          color: "#b91c1c",
                          border: "1px solid #fecaca",
                          background: "transparent",
                        }}
                      >
                        {delStatus === "deleting" ? "…" : delStatus === "error" ? "✗ Retry" : "🗑 Delete"}
                      </button>
                    </div>
                  )}
                </>
              )}
              {isEditing && editDraft && (
                <>
                  <Field label="name (display)">
                    <input
                      value={editDraft.displayName}
                      onChange={(e) => setEditDraft({ ...editDraft, displayName: e.target.value })}
                      style={{ width: "100%" }}
                    />
                  </Field>
                  <Field label="defaultParams (JSON)">
                    <textarea
                      value={editDraft.defaultParams}
                      onChange={(e) => setEditDraft({ ...editDraft, defaultParams: e.target.value })}
                      style={{ width: "100%", minHeight: 80, fontFamily: "monospace", fontSize: 11 }}
                    />
                  </Field>
                  <Field label="faceTemplate (JSON)">
                    <textarea
                      value={editDraft.faceTemplate}
                      onChange={(e) => setEditDraft({ ...editDraft, faceTemplate: e.target.value })}
                      style={{ width: "100%", minHeight: 60, fontFamily: "monospace", fontSize: 11 }}
                    />
                  </Field>
                  <Field label="needsAperture">
                    <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
                      <input
                        type="checkbox"
                        checked={editDraft.needsAperture}
                        onChange={(e) => setEditDraft({ ...editDraft, needsAperture: e.target.checked })}
                      />
                      required
                    </label>
                  </Field>
                  <Field label="wavelengthRangeNm">
                    <input
                      value={editDraft.wavelengthRangeNm}
                      onChange={(e) => setEditDraft({ ...editDraft, wavelengthRangeNm: e.target.value })}
                      placeholder="350, 700"
                      style={{ width: "100%" }}
                    />
                  </Field>
                  <Field label="description">
                    <textarea
                      value={editDraft.description}
                      onChange={(e) => setEditDraft({ ...editDraft, description: e.target.value })}
                      style={{ width: "100%", minHeight: 40, fontSize: 11 }}
                    />
                  </Field>
                  {editError && (
                    <div style={{ color: "#b91c1c", fontSize: 11, marginTop: 4 }}>
                      {editError}
                    </div>
                  )}
                  <div style={{ marginTop: 6, display: "flex", gap: 4 }}>
                    <button
                      type="button"
                      onClick={() => void submitEdit()}
                      disabled={editStatus === "saving"}
                      style={{
                        fontSize: 11,
                        padding: "1px 10px",
                        background: "#fde68a",
                        border: "1px solid #ca8a04",
                      }}
                    >
                      {editStatus === "saving" ? "Saving…" : "💾 Save"}
                    </button>
                    <button
                      type="button"
                      onClick={cancelEdit}
                      style={{ fontSize: 11, padding: "1px 10px" }}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 10, opacity: 0.7, marginBottom: 2 }}>{label}</div>
      {children}
    </div>
  );
}

function FieldGrid({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: 8,
        marginBottom: 4,
      }}
    >
      {children}
    </div>
  );
}
