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
import { Edit3, Save, Trash2, X } from "lucide-react";

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
import {
  ASIDE_STYLE,
  asideItemStyle,
  ERROR_BANNER,
  ICON_BUTTON,
  INPUT,
  MAIN_BODY_STYLE,
  MAIN_HEADER_STYLE,
  MAIN_STYLE,
  PRIMARY_BUTTON,
  SECTION_LABEL,
  SHELL_STYLE,
  TD,
  TH,
} from "./phyEditorTheme";

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

  // aside (list) state — which kind row the user is inspecting + free-text
  // filter. Mirrors Asset3DV3Editor / ComponentsV2Editor's shell pattern.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterText, setFilterText] = useState<string>("");

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

  const filtered = useMemo(() => {
    const needle = filterText.trim().toLowerCase();
    return needle
      ? rows.filter((r) =>
          `${r.displayName} ${r.name} ${r.opSetName}`.toLowerCase().includes(needle),
        )
      : rows;
  }, [rows, filterText]);

  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedId) ?? null,
    [rows, selectedId],
  );

  // Auto-select the first row once data lands — matches Asset3DV3Editor's
  // landing behavior so the main pane is never empty by accident.
  useEffect(() => {
    if (!selectedId && filtered.length > 0) {
      setSelectedId(filtered[0].id);
    }
  }, [filtered, selectedId]);

  // Selecting a different kind drops any in-flight edit / create so the
  // user can't accidentally save a stale draft against the new row.
  const handleSelect = (id: string) => {
    if (id === selectedId) return;
    if (editingId) cancelEdit();
    if (createOpen) setCreateOpen(false);
    setSelectedId(id);
  };

  const startCreate = () => {
    if (editingId) cancelEdit();
    setCreateOpen(true);
  };

  const cancelCreate = () => {
    setCreateOpen(false);
    setCreateError(null);
    setCreateStatus("idle");
  };

  // Header buttons depend on which "mode" the main pane is in:
  //   - create open       → Save (create) + Cancel
  //   - editing existing  → Save (update) + Cancel
  //   - viewing existing  → Edit + Delete (suppressed in read-only)
  const isEditing = !!editingId && !!editDraft;
  const headerTitle = createOpen
    ? `+ New kind (${domainLabel})`
    : selectedRow?.displayName ?? `Select a kind`;
  const headerSubtitle = createOpen
    ? "draft"
    : selectedRow
      ? selectedRow.name
      : `${rows.length} ${domain}-element kind${rows.length === 1 ? "" : "s"} (DB)`;
  const delStatus = selectedRow ? deleteStatus[selectedRow.id] ?? "idle" : "idle";

  return (
    <div className="kinds-editor" style={SHELL_STYLE}>
      {/* LEFT: kind list — mirrors Asset3DV3Editor / ComponentsV2Editor's
          aside (filter input + scrollable list of name + slug). */}
      <aside style={ASIDE_STYLE}>
        {!readOnly && (
          <button
            type="button"
            onClick={startCreate}
            style={{ ...PRIMARY_BUTTON, width: "100%", marginBottom: 6 }}
          >
            + New kind
          </button>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 6, marginBottom: 8 }}>
          <input
            type="text"
            placeholder="filter by id / name / op_set"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            style={INPUT}
          />
          <button
            type="button"
            onClick={() => void reload()}
            disabled={loadStatus === "loading"}
            style={{ ...ICON_BUTTON, padding: "0 8px", width: "auto" }}
            title="Refresh"
          >
            ↻
          </button>
        </div>
        <div style={{ fontSize: 10, color: "#4b5563", marginBottom: 6 }}>
          {filtered.length} of {rows.length} kinds
          {readOnly && <> · read-only</>}
        </div>
        {loadError && (
          <div style={{ color: "#b91c1c", fontSize: 11, marginBottom: 6 }}>{loadError}</div>
        )}
        {filtered.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => handleSelect(row.id)}
            style={asideItemStyle(row.id === selectedId)}
          >
            <div style={{ fontWeight: 700 }}>{row.displayName}</div>
            <div style={{ fontSize: 10, color: "#6b7280" }}>{row.name}</div>
          </button>
        ))}
      </aside>

      {/* RIGHT: detail / edit / create form */}
      <main style={MAIN_STYLE}>
        <div style={MAIN_HEADER_STYLE}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {headerTitle}
            </div>
            <div style={{ fontSize: 11, color: "#6b7280" }}>
              {headerSubtitle}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {/* View mode: Edit + Delete */}
            {!createOpen && !isEditing && selectedRow && !readOnly && (
              <>
                <button
                  type="button"
                  onClick={() => startEdit(selectedRow)}
                  style={ICON_BUTTON}
                  title="Edit kind"
                >
                  <Edit3 size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(selectedRow)}
                  disabled={delStatus === "deleting"}
                  style={ICON_BUTTON}
                  title={delStatus === "error" ? "Delete failed — click to retry" : "Delete kind"}
                >
                  <Trash2 size={14} />
                </button>
              </>
            )}
            {/* Edit mode: Save + Cancel */}
            {isEditing && (
              <>
                <button
                  type="button"
                  onClick={() => void submitEdit()}
                  disabled={editStatus === "saving"}
                  style={ICON_BUTTON}
                  title={editStatus === "saving" ? "Saving…" : "Save changes"}
                >
                  <Save size={14} />
                </button>
                <button
                  type="button"
                  onClick={cancelEdit}
                  style={ICON_BUTTON}
                  title="Cancel editing"
                >
                  <X size={15} />
                </button>
              </>
            )}
            {/* Create mode: Save + Cancel */}
            {createOpen && (
              <>
                <button
                  type="button"
                  onClick={() => void submitCreate()}
                  disabled={createStatus === "saving"}
                  style={ICON_BUTTON}
                  title={createStatus === "saving" ? "Creating…" : "Create kind"}
                >
                  <Save size={14} />
                </button>
                <button
                  type="button"
                  onClick={cancelCreate}
                  style={ICON_BUTTON}
                  title="Cancel"
                >
                  <X size={15} />
                </button>
              </>
            )}
          </div>
        </div>

        <div style={MAIN_BODY_STYLE}>
          {!createOpen && !selectedRow && (
            <div style={{ color: "#4b5563" }}>
              Select a kind from the list, or click "+ New kind".
            </div>
          )}

          {/* Edit form — replaces the read view for the selected kind. */}
          {isEditing && editDraft && (
            <>
              <div style={SECTION_LABEL}>Identity</div>
              <FieldGrid>
                <Field label="name (display)">
                  <input
                    value={editDraft.displayName}
                    onChange={(e) => setEditDraft({ ...editDraft, displayName: e.target.value })}
                    style={INPUT}
                  />
                </Field>
                <Field label="needsAperture">
                  <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#6b7280" }}>
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
                    style={INPUT}
                  />
                </Field>
              </FieldGrid>

              <div style={SECTION_LABEL}>defaultParams (JSON)</div>
              <textarea
                value={editDraft.defaultParams}
                onChange={(e) => setEditDraft({ ...editDraft, defaultParams: e.target.value })}
                style={{ ...INPUT, minHeight: 100, fontFamily: "ui-monospace, monospace", resize: "vertical" }}
              />

              <div style={SECTION_LABEL}>faceTemplate (JSON)</div>
              <textarea
                value={editDraft.faceTemplate}
                onChange={(e) => setEditDraft({ ...editDraft, faceTemplate: e.target.value })}
                style={{ ...INPUT, minHeight: 80, fontFamily: "ui-monospace, monospace", resize: "vertical" }}
              />

              <div style={SECTION_LABEL}>Description</div>
              <textarea
                value={editDraft.description}
                onChange={(e) => setEditDraft({ ...editDraft, description: e.target.value })}
                style={{ ...INPUT, minHeight: 60, resize: "vertical" }}
              />

              {editError && (
                <div style={{ ...ERROR_BANNER, marginTop: 12 }}>
                  <span>{editError}</span>
                </div>
              )}
            </>
          )}

          {/* Read view — selected kind detail (matches Asset3DV3Editor's
              AssetReadOnly two-column metadata table). */}
          {!createOpen && !isEditing && selectedRow && (
            <>
              <div style={SECTION_LABEL}>Identity</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "ui-monospace, monospace", fontSize: 11 }}>
                <tbody>
                  <tr>
                    <td style={{ ...TD, color: "#6b7280", width: "30%" }}>kind_id</td>
                    <td style={{ ...TD, fontWeight: 700 }}>{selectedRow.name}</td>
                  </tr>
                  <tr>
                    <td style={{ ...TD, color: "#6b7280" }}>name</td>
                    <td style={TD}>{selectedRow.displayName}</td>
                  </tr>
                  <tr>
                    <td style={{ ...TD, color: "#6b7280" }}>op_set</td>
                    <td style={{ ...TD, color: "#4ec9b0" }}>{selectedRow.opSetName}</td>
                  </tr>
                  <tr>
                    <td style={{ ...TD, color: "#6b7280" }}>needsAperture</td>
                    <td style={TD}>{selectedRow.needsAperture ? "yes" : "no"}</td>
                  </tr>
                  {selectedRow.wavelengthRangeNm && (
                    <tr>
                      <td style={{ ...TD, color: "#6b7280" }}>lambda range nm</td>
                      <td style={TD}>{selectedRow.wavelengthRangeNm[0]} – {selectedRow.wavelengthRangeNm[1]}</td>
                    </tr>
                  )}
                </tbody>
              </table>

              {selectedRow.description && (
                <>
                  <div style={SECTION_LABEL}>Description</div>
                  <div style={{ fontSize: 11, color: "#1f2937", whiteSpace: "pre-wrap", lineHeight: 1.4 }}>
                    {selectedRow.description}
                  </div>
                </>
              )}

              <div style={SECTION_LABEL}>defaultParams</div>
              <pre style={{ ...INPUT, fontFamily: "ui-monospace, monospace", whiteSpace: "pre-wrap", margin: 0, minHeight: 40 }}>
                {JSON.stringify(selectedRow.defaultParams ?? {}, null, 2)}
              </pre>

              <div style={SECTION_LABEL}>faceTemplate</div>
              <pre style={{ ...INPUT, fontFamily: "ui-monospace, monospace", whiteSpace: "pre-wrap", margin: 0, minHeight: 40 }}>
                {JSON.stringify(selectedRow.faceTemplate ?? {}, null, 2)}
              </pre>
            </>
          )}

          {/* Create form — same layout as the edit form for consistency. */}
          {createOpen && (
            <>
              <div style={SECTION_LABEL}>Identity</div>
              <FieldGrid>
                <Field label="kind_id (unique slug)">
                  <input
                    value={createDraft.name}
                    onChange={(e) => setCreateDraft({ ...createDraft, name: e.target.value })}
                    placeholder="e.g. my_custom_lens"
                    style={INPUT}
                  />
                </Field>
                <Field label="name (display)">
                  <input
                    value={createDraft.displayName}
                    onChange={(e) => setCreateDraft({ ...createDraft, displayName: e.target.value })}
                    placeholder="e.g. My Custom Lens"
                    style={INPUT}
                  />
                </Field>
                <Field label="opSetName">
                  <select
                    value={createDraft.opSetName}
                    onChange={(e) => setCreateDraft({ ...createDraft, opSetName: e.target.value })}
                    style={INPUT}
                  >
                    <option value="">— pick an op set —</option>
                    {opSetOptions.map((opt) => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                </Field>
                <Field label="needsAperture">
                  <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#6b7280" }}>
                    <input
                      type="checkbox"
                      checked={createDraft.needsAperture ?? false}
                      onChange={(e) => setCreateDraft({ ...createDraft, needsAperture: e.target.checked })}
                    />
                    checked = required
                  </label>
                </Field>
                <Field label="wavelengthRangeNm (optional)">
                  <input
                    value={createJsonDrafts.wavelengthRangeNm}
                    onChange={(e) => setCreateJsonDrafts({ ...createJsonDrafts, wavelengthRangeNm: e.target.value })}
                    placeholder="e.g. 350, 700"
                    style={INPUT}
                  />
                </Field>
              </FieldGrid>

              <div style={SECTION_LABEL}>defaultParams (JSON)</div>
              <textarea
                value={createJsonDrafts.defaultParams}
                onChange={(e) => setCreateJsonDrafts({ ...createJsonDrafts, defaultParams: e.target.value })}
                style={{ ...INPUT, minHeight: 100, fontFamily: "ui-monospace, monospace", resize: "vertical" }}
              />

              <div style={SECTION_LABEL}>faceTemplate (JSON — anchors block)</div>
              <textarea
                value={createJsonDrafts.faceTemplate}
                onChange={(e) => setCreateJsonDrafts({ ...createJsonDrafts, faceTemplate: e.target.value })}
                style={{ ...INPUT, minHeight: 80, fontFamily: "ui-monospace, monospace", resize: "vertical" }}
              />

              <div style={SECTION_LABEL}>Description (optional)</div>
              <textarea
                value={createDraft.description ?? ""}
                onChange={(e) => setCreateDraft({ ...createDraft, description: e.target.value })}
                style={{ ...INPUT, minHeight: 60, resize: "vertical" }}
              />

              {createError && (
                <div style={{ ...ERROR_BANNER, marginTop: 12 }}>
                  <span>{createError}</span>
                </div>
              )}
            </>
          )}
        </div>
      </main>
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
