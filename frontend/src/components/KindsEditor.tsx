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
import { Edit3, Lock, Save, Trash2, Unlock, X } from "lucide-react";

import {
  createKindApi,
  deleteKindApi,
  listKindOpSetsApi,
  listKindsApi,
  updateKindApi,
  type KindCreatePayload,
  type KindDomain,
  type KindPatchPayload,
  type KindRow,
} from "../api/client";
import { useV3Catalog } from "../store/catalogStore";
import { LOCK_FILTER_OPTIONS, matchesLockFilter, type LockFilter } from "./lockFilter";
import { USAGE_FILTER_OPTIONS, matchesUsageFilter, type UsageFilter } from "./usageFilter";
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
  domains: KindDomain[];
  defaultParams: string;
  anchorTemplate: string;
  needsAperture: boolean;
  wavelengthRangeNm: string;
  frequencyRangeMhz: string;
  description: string;
};

const ALL_DOMAINS: KindDomain[] = ["optical", "rf", "mechanical"];

const DOMAIN_BADGE_BG: Record<KindDomain, string> = {
  optical: "#2563eb",
  rf: "#d97706",
  mechanical: "#6b7280",
};

function rowToDraft(row: KindRow): EditDraft {
  return {
    displayName: row.displayName,
    domains: row.domains,
    defaultParams: JSON.stringify(row.defaultParams ?? {}, null, 2),
    anchorTemplate: JSON.stringify(row.anchorTemplate ?? {}, null, 2),
    needsAperture: row.needsAperture,
    wavelengthRangeNm: row.wavelengthRangeNm
      ? row.wavelengthRangeNm.join(", ")
      : "",
    frequencyRangeMhz: row.frequencyRangeMhz
      ? row.frequencyRangeMhz.join(", ")
      : "",
    description: row.description ?? "",
  };
}

/** Parse a "min, max" range field. Shared by wavelengthRangeNm and
 *  frequencyRangeMhz - same shape, same validation, different label. */
function parseRange(s: string, fieldLabel: string, example: string): number[] | null {
  const t = s.trim();
  if (!t) return null;
  const parts = t.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`${fieldLabel} must be two comma-separated numbers, e.g. "${example}"`);
  }
  if (parts[0] > parts[1]) {
    throw new Error(`${fieldLabel}: min must not exceed max`);
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
  domain = "all",
  readOnly = false,
}: { domain?: "all" | KindDomain; readOnly?: boolean } = {}) {
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
    domains: domain === "all" ? ["optical"] : [domain],
    opSetName: "",
    defaultParams: {},
    anchorTemplate: {},
    needsAperture: false,
    wavelengthRangeNm: null,
    frequencyRangeMhz: null,
    description: "",
  });
  const [createJsonDrafts, setCreateJsonDrafts] = useState({
    defaultParams: "{}",
    anchorTemplate: "{}",
    wavelengthRangeNm: "",
    frequencyRangeMhz: "",
  });
  const [createStatus, setCreateStatus] = useState<"idle" | "saving" | "error">("idle");
  const [createError, setCreateError] = useState<string | null>(null);

  // Delete confirmation tracking.
  const [deleteStatus, setDeleteStatus] = useState<Record<string, "idle" | "deleting" | "error">>({});
  // Per-row lock toggle in-flight tracking.
  const [lockBusy, setLockBusy] = useState<Record<string, boolean>>({});

  // aside (list) state — which kind row the user is inspecting + free-text
  // filter. Mirrors Asset3DEditor / ComponentsEditor's shell pattern.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterText, setFilterText] = useState<string>("");
  const [lockFilter, setLockFilter] = useState<LockFilter>("all");
  const [usageFilter, setUsageFilter] = useState<UsageFilter>("all");

  const reload = useCallback(async () => {
    setLoadStatus("loading");
    setLoadError(null);
    try {
      const data = await listKindsApi(domain === "all" ? undefined : domain);
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

  // op_set_name dropdown options. `GET /api/kinds/op-sets` returns the
  // exact set `POST /api/kinds` validates against, so every code-side op
  // set is offered — including the ones with no Kind row yet, which the
  // old "derive from the existing rows" version silently hid (the user
  // had to guess the name and only found out from the 400). Union with
  // the row values so the list still renders if the fetch fails.
  const [codeOpSets, setCodeOpSets] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void listKindOpSetsApi()
      .then((names) => {
        if (!cancelled) setCodeOpSets(names);
      })
      .catch(() => {
        // Non-fatal: fall back to the names already on screen.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const opSetOptions = useMemo(() => {
    const set = new Set<string>([...codeOpSets, ...rows.map((r) => r.opSetName)]);
    return [...set].sort();
  }, [codeOpSets, rows]);

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
      if (editDraft.domains.length === 0) {
        throw new Error("at least one domain is required");
      }
      patch = {
        displayName: editDraft.displayName,
        domains: editDraft.domains,
        defaultParams: parseJsonObject(editDraft.defaultParams, "defaultParams"),
        anchorTemplate: parseJsonObject(editDraft.anchorTemplate, "anchorTemplate"),
        needsAperture: editDraft.needsAperture,
        wavelengthRangeNm: parseRange(editDraft.wavelengthRangeNm, "wavelengthRangeNm", "350, 700"),
        frequencyRangeMhz: parseRange(editDraft.frequencyRangeMhz, "frequencyRangeMhz", "10, 6000"),
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
        anchorTemplate: parseJsonObject(createJsonDrafts.anchorTemplate, "anchorTemplate"),
        wavelengthRangeNm: parseRange(createJsonDrafts.wavelengthRangeNm, "wavelengthRangeNm", "350, 700"),
        frequencyRangeMhz: parseRange(createJsonDrafts.frequencyRangeMhz, "frequencyRangeMhz", "10, 6000"),
        description: createDraft.description || null,
      };
      if (!payload.name) throw new Error("name is required");
      if (!payload.displayName) throw new Error("displayName is required");
      if (!payload.opSetName) throw new Error("opSetName is required");
      if (!payload.domains || payload.domains.length === 0) {
        throw new Error("at least one domain is required");
      }
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
        domains: domain === "all" ? ["optical"] : [domain],
        opSetName: "",
        defaultParams: {},
        anchorTemplate: {},
        needsAperture: false,
        wavelengthRangeNm: null,
        frequencyRangeMhz: null,
        description: "",
      });
      setCreateJsonDrafts({
        defaultParams: "{}",
        anchorTemplate: "{}",
        wavelengthRangeNm: "",
        frequencyRangeMhz: "",
      });
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

  // Toggle a kind's locked flag. Locked = human-confirmed complete: the
  // backend then rejects every edit but this toggle, so the only legal
  // mutation while locked is unlocking it. PATCHing only `locked` is the
  // exception the API allows in both directions.
  const toggleLock = async (row: KindRow) => {
    if (editingId === row.id && !row.locked) cancelEdit();
    setLockBusy((prev) => ({ ...prev, [row.id]: true }));
    try {
      const updated = await updateKindApi(row.id, { locked: !row.locked });
      setRows((prev) => prev.map((r) => (r.id === row.id ? updated : r)));
    } catch (e) {
      window.alert(`Lock toggle failed: ${(e as Error).message}`);
    } finally {
      setLockBusy((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
    }
  };

  const domainLabel =
    domain === "all"
      ? "All domains"
      : domain === "rf"
        ? "RF"
        : domain === "mechanical"
          ? "Mechanical"
          : "Optical";

  // How many Asset3D rows point at each kind. Domain is kind-authoritative
  // (`Asset3D.kind_id` -> `kind.domains`), so this is the honest "is anyone
  // using this kind" number — it is what the usage filter reads, and it is
  // shown per row so a 0 is visible rather than inferred.
  const assets = useV3Catalog((state) => state.assets);
  const assetCountByKind = useMemo(() => {
    const counts = new Map<string, number>();
    for (const asset of assets) {
      if (!asset.kindId) continue;
      counts.set(asset.kindId, (counts.get(asset.kindId) ?? 0) + 1);
    }
    return counts;
  }, [assets]);

  const filtered = useMemo(() => {
    const needle = filterText.trim().toLowerCase();
    return rows.filter((r) => {
      if (!matchesLockFilter(r.locked, lockFilter)) return false;
      if (!matchesUsageFilter(assetCountByKind.get(r.name) ?? 0, usageFilter)) return false;
      if (!needle) return true;
      return `${r.displayName} ${r.name} ${r.opSetName}`.toLowerCase().includes(needle);
    });
  }, [rows, filterText, lockFilter, usageFilter, assetCountByKind]);

  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedId) ?? null,
    [rows, selectedId],
  );

  // Auto-select the first row once data lands — matches Asset3DEditor's
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
    // Seed the new kind's domains from the active filter so creating
    // from a domain-scoped view pre-checks that domain.
    setCreateDraft((d) => ({
      ...d,
      domains: domain === "all" ? ["optical"] : [domain],
    }));
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
    ? domain === "all"
      ? "+ New kind"
      : `+ New kind (${domainLabel})`
    : selectedRow?.displayName ?? `Select a kind`;
  const headerSubtitle = createOpen
    ? "draft"
    : selectedRow
      ? selectedRow.name
      : `${rows.length} kind${rows.length === 1 ? "" : "s"}${
          domain === "all" ? "" : ` · ${domainLabel}`
        } (DB)`;
  const delStatus = selectedRow ? deleteStatus[selectedRow.id] ?? "idle" : "idle";

  return (
    <div className="kinds-editor" style={SHELL_STYLE}>
      {/* LEFT: kind list — mirrors Asset3DEditor / ComponentsEditor's
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
          {/* View-only filters — same shape as the ASSET3D list's lock
              dropdown. Neither writes a row: the kinds table is a catalog
              of what the twin CAN model, so a kind with no assets yet is
              hidden here, never deleted (see usageFilter.ts). */}
          <select
            value={lockFilter}
            onChange={(e) => setLockFilter(e.target.value as LockFilter)}
            title="Filter by lock state (locked = human-confirmed complete, read-only)."
            style={{ ...INPUT, gridColumn: "1 / span 2" }}
          >
            {LOCK_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <select
            value={usageFilter}
            onChange={(e) => setUsageFilter(e.target.value as UsageFilter)}
            title="Filter by whether any Asset3D points at this kind. View only — a kind with no assets is still fully usable, it just has no hardware modelled yet."
            style={{ ...INPUT, gridColumn: "1 / span 2" }}
          >
            {USAGE_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div style={{ fontSize: 10, color: "#4b5563", marginBottom: 6 }}>
          {filtered.length} of {rows.length} kinds
          {readOnly && <> · read-only</>}
        </div>
        {loadError && (
          <div style={{ color: "#b91c1c", fontSize: 11, marginBottom: 6 }}>{loadError}</div>
        )}
        {filtered.map((row) => (
          <div key={row.id} style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => handleSelect(row.id)}
              style={{ ...asideItemStyle(row.id === selectedId), paddingRight: 30 }}
            >
              <div style={{ fontWeight: 700 }}>{row.displayName}</div>
              <div style={{ fontSize: 10, color: "#6b7280" }}>
                <span style={{ color: "#9ca3af" }}>id:</span> {row.name}
                {(() => {
                  const n = assetCountByKind.get(row.name) ?? 0;
                  return (
                    <span style={{ color: n > 0 ? "#6b7280" : "#9ca3af", marginLeft: 6 }}>
                      · {n === 0 ? "no assets" : `${n} asset${n === 1 ? "" : "s"}`}
                    </span>
                  );
                })()}
              </div>
              <div style={{ marginTop: 3 }}>
                <DomainBadges domains={row.domains} />
              </div>
            </button>
            {/* Per-row lock toggle. Locked = human-confirmed complete:
                read-only in the editor + the API rejects all edits but
                unlocking. Hidden in read-only viewer mode. */}
            {!readOnly && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void toggleLock(row);
                }}
                disabled={lockBusy[row.id]}
                title={
                  row.locked
                    ? "Locked — confirmed complete. Click to unlock for editing."
                    : "Unlocked. Click to lock (freeze as confirmed complete)."
                }
                style={{
                  position: "absolute",
                  top: 6,
                  right: 6,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 22,
                  height: 22,
                  padding: 0,
                  border: "none",
                  background: "transparent",
                  cursor: lockBusy[row.id] ? "default" : "pointer",
                  color: row.locked ? "#b45309" : "#9ca3af",
                }}
              >
                {row.locked ? <Lock size={13} /> : <Unlock size={13} />}
              </button>
            )}
          </div>
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
            {/* View mode: Edit + Delete. Both disabled when the row is
                locked (confirmed complete) — unlock via the list-row lock
                button first. The API rejects edits/deletes either way. */}
            {!createOpen && !isEditing && selectedRow && !readOnly && (
              <>
                <button
                  type="button"
                  onClick={() => startEdit(selectedRow)}
                  disabled={selectedRow.locked}
                  style={ICON_BUTTON}
                  title={selectedRow.locked ? "Locked — unlock to edit" : "Edit kind"}
                >
                  <Edit3 size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(selectedRow)}
                  disabled={delStatus === "deleting" || selectedRow.locked}
                  style={ICON_BUTTON}
                  title={
                    selectedRow.locked
                      ? "Locked — unlock to delete"
                      : delStatus === "error"
                        ? "Delete failed — click to retry"
                        : "Delete kind"
                  }
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
                <Field label="frequencyRangeMhz">
                  <input
                    value={editDraft.frequencyRangeMhz}
                    onChange={(e) => setEditDraft({ ...editDraft, frequencyRangeMhz: e.target.value })}
                    placeholder="10, 6000"
                    style={INPUT}
                  />
                </Field>
              </FieldGrid>

              <div style={SECTION_LABEL}>domains</div>
              <DomainCheckboxes
                value={editDraft.domains}
                onChange={(domains) => setEditDraft({ ...editDraft, domains })}
              />

              <div style={SECTION_LABEL}>defaultParams (JSON)</div>
              <textarea
                value={editDraft.defaultParams}
                onChange={(e) => setEditDraft({ ...editDraft, defaultParams: e.target.value })}
                style={{ ...INPUT, minHeight: 100, fontFamily: "ui-monospace, monospace", resize: "vertical" }}
              />

              <div style={SECTION_LABEL}>anchorTemplate (JSON)</div>
              <textarea
                value={editDraft.anchorTemplate}
                onChange={(e) => setEditDraft({ ...editDraft, anchorTemplate: e.target.value })}
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

          {/* Read view — selected kind detail (matches Asset3DEditor's
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
                    <td style={{ ...TD, color: "#6b7280" }}>domains</td>
                    <td style={TD}>
                      <DomainBadges domains={selectedRow.domains} />
                    </td>
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
                  {selectedRow.frequencyRangeMhz && (
                    <tr>
                      <td style={{ ...TD, color: "#6b7280" }}>freq range MHz</td>
                      <td style={TD}>{selectedRow.frequencyRangeMhz[0]} – {selectedRow.frequencyRangeMhz[1]}</td>
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

              <div style={SECTION_LABEL}>anchorTemplate</div>
              <pre style={{ ...INPUT, fontFamily: "ui-monospace, monospace", whiteSpace: "pre-wrap", margin: 0, minHeight: 40 }}>
                {JSON.stringify(selectedRow.anchorTemplate ?? {}, null, 2)}
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
                <Field label="frequencyRangeMhz (optional)">
                  <input
                    value={createJsonDrafts.frequencyRangeMhz}
                    onChange={(e) => setCreateJsonDrafts({ ...createJsonDrafts, frequencyRangeMhz: e.target.value })}
                    placeholder="e.g. 10, 6000"
                    style={INPUT}
                  />
                </Field>
              </FieldGrid>

              <div style={SECTION_LABEL}>domains</div>
              <DomainCheckboxes
                value={createDraft.domains}
                onChange={(domains) => setCreateDraft({ ...createDraft, domains })}
              />

              <div style={SECTION_LABEL}>defaultParams (JSON)</div>
              <textarea
                value={createJsonDrafts.defaultParams}
                onChange={(e) => setCreateJsonDrafts({ ...createJsonDrafts, defaultParams: e.target.value })}
                style={{ ...INPUT, minHeight: 100, fontFamily: "ui-monospace, monospace", resize: "vertical" }}
              />

              <div style={SECTION_LABEL}>anchorTemplate (JSON — anchors block)</div>
              <textarea
                value={createJsonDrafts.anchorTemplate}
                onChange={(e) => setCreateJsonDrafts({ ...createJsonDrafts, anchorTemplate: e.target.value })}
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

function DomainBadges({ domains }: { domains: KindDomain[] }) {
  return (
    <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
      {domains.map((d) => (
        <span
          key={d}
          style={{
            fontSize: 9,
            padding: "1px 5px",
            borderRadius: 3,
            background: DOMAIN_BADGE_BG[d],
            color: "#fff",
            textTransform: "uppercase",
            letterSpacing: "0.03em",
          }}
        >
          {d}
        </span>
      ))}
    </span>
  );
}

function DomainCheckboxes({
  value,
  onChange,
}: {
  value: KindDomain[];
  onChange: (next: KindDomain[]) => void;
}) {
  const toggle = (d: KindDomain) =>
    onChange(value.includes(d) ? value.filter((x) => x !== d) : [...value, d]);
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      {ALL_DOMAINS.map((d) => (
        <label
          key={d}
          style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#6b7280" }}
        >
          <input
            type="checkbox"
            checked={value.includes(d)}
            onChange={() => toggle(d)}
          />
          {d}
        </label>
      ))}
    </div>
  );
}
