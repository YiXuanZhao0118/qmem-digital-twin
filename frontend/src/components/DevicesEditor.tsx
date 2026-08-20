/**
 * DevicesEditor — CRUD UI for the devices DB table (alembic 0123).
 *
 * A *device* is one concrete instrument: a mesh + a named-anchor layout +
 * its default params, pinned to ONE behavioural kind. Until 0123 a device
 * was a TypeScript file under `src/devices/`, so adding the 40th instrument
 * meant editing two files, re-running `npm run export:kinds` and restarting
 * the backend — the PHY Editor could only ever *pick* a device. This editor
 * is the write path that closes that gap.
 *
 * The IRON RULE still holds: `device → behavioural kind`, never the reverse.
 * `behavioralKind` must be an ElementKind the solver already dispatches on
 * (the picker is fed by `/api/devices/behavioral-kinds`, the same set the
 * API validates against), or empty for a render-only mechanical fixture.
 *
 * An anchor's `role` is what becomes the seeded anchor's `id`, and `name`
 * disambiguates a role that repeats (AD9959 CH0..CH3, rf_switch RF1/RF2).
 * Position / direction may be left blank: the asset then seeds the anchor at
 * the body origin and the user drags it onto the real mesh feature.
 *
 * Backed by /api/devices (see ../api/client.ts → listDevicesApi etc.).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Edit3, Lock, Plus, Save, Trash2, Unlock, X } from "lucide-react";

import {
  createDeviceApi,
  deleteDeviceApi,
  listDeviceBehavioralKindsApi,
  listDevicesApi,
  updateDeviceApi,
  type DeviceAnchorTemplate,
  type DeviceCreatePayload,
  type DevicePatchPayload,
  type DeviceRow,
  type DeviceVec3,
  type KindDomain,
} from "../api/client";
import { useDevicesStore } from "../store/devicesStore";
import { LOCK_FILTER_OPTIONS, matchesLockFilter, type LockFilter } from "./lockFilter";
import { useKindsStore } from "../store/kindsStore";
import {
  ASIDE_STYLE,
  asideItemStyle,
  ERROR_BANNER,
  ICON_BUTTON,
  INPUT,
  MAIN_BODY_STYLE,
  MAIN_HEADER_STYLE,
  MAIN_STYLE,
  MUTED,
  PRIMARY_BUTTON,
  SECTION_LABEL,
  SHELL_STYLE,
  TD,
  TH,
} from "./phyEditorTheme";

/** Editable form of one anchor template. Vectors are kept as strings so a
 *  half-typed "-" or "0." doesn't get coerced to NaN mid-keystroke, and an
 *  empty triple means "omit this vector" (seed at the body origin). */
type AnchorDraft = {
  role: string;
  name: string;
  position: [string, string, string];
  direction: [string, string, string];
  axisY: [string, string, string];
  connectorType: string;
  apertureMm: string;
  apertureShape: "" | "rectangle" | "ellipse" | "circle";
  apertureWidthMm: string;
  apertureHeightMm: string;
};

type DeviceDraft = {
  slug: string;
  displayName: string;
  behavioralKind: string;
  componentType: string;
  mesh: string;
  anchors: AnchorDraft[];
  defaultParams: string;
};

const EMPTY_TRIPLE: [string, string, string] = ["", "", ""];

function vecToTriple(v: DeviceVec3 | null | undefined): [string, string, string] {
  if (!v) return [...EMPTY_TRIPLE];
  return [String(v.x), String(v.y), String(v.z)];
}

/** A triple is either fully blank (omit the vector) or fully numeric.
 *  A partially filled one is a typo, not an intent — reject it loudly
 *  rather than silently seeding a 0 on the axis the user forgot. */
function tripleToVec(
  triple: [string, string, string],
  label: string,
): DeviceVec3 | undefined {
  const trimmed = triple.map((t) => t.trim());
  if (trimmed.every((t) => t === "")) return undefined;
  const nums = trimmed.map(Number);
  if (trimmed.some((t) => t === "") || nums.some((n) => !Number.isFinite(n))) {
    throw new Error(`${label}: needs all three components as numbers, or none`);
  }
  return { x: nums[0], y: nums[1], z: nums[2] };
}

function optionalNumber(value: string, label: string): number | undefined {
  const t = value.trim();
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${label}: must be a non-negative number`);
  }
  return n;
}

function anchorToDraft(a: DeviceAnchorTemplate): AnchorDraft {
  return {
    role: a.role,
    name: a.name ?? "",
    position: vecToTriple(a.positionMmBodyLocal),
    direction: vecToTriple(a.directionBodyLocal),
    axisY: vecToTriple(a.axisYBodyLocal),
    connectorType: a.connectorType ?? "",
    apertureMm: a.apertureMm === null || a.apertureMm === undefined ? "" : String(a.apertureMm),
    apertureShape: a.apertureShape ?? "",
    apertureWidthMm:
      a.apertureWidthMm === null || a.apertureWidthMm === undefined
        ? ""
        : String(a.apertureWidthMm),
    apertureHeightMm:
      a.apertureHeightMm === null || a.apertureHeightMm === undefined
        ? ""
        : String(a.apertureHeightMm),
  };
}

function emptyAnchorDraft(): AnchorDraft {
  return {
    role: "",
    name: "",
    position: [...EMPTY_TRIPLE],
    direction: [...EMPTY_TRIPLE],
    axisY: [...EMPTY_TRIPLE],
    connectorType: "",
    apertureMm: "",
    apertureShape: "",
    apertureWidthMm: "",
    apertureHeightMm: "",
  };
}

function draftToAnchor(d: AnchorDraft, index: number): DeviceAnchorTemplate {
  const where = `anchor ${index + 1}`;
  const role = d.role.trim();
  if (!role) throw new Error(`${where}: role is required`);
  const out: DeviceAnchorTemplate = { role };
  if (d.name.trim()) out.name = d.name.trim();
  const position = tripleToVec(d.position, `${where} position`);
  if (position) out.positionMmBodyLocal = position;
  const direction = tripleToVec(d.direction, `${where} direction`);
  if (direction) out.directionBodyLocal = direction;
  const axisY = tripleToVec(d.axisY, `${where} axisY`);
  if (axisY) out.axisYBodyLocal = axisY;
  if (d.connectorType.trim()) out.connectorType = d.connectorType.trim();
  const apertureMm = optionalNumber(d.apertureMm, `${where} apertureMm`);
  if (apertureMm !== undefined) out.apertureMm = apertureMm;
  if (d.apertureShape) out.apertureShape = d.apertureShape;
  const w = optionalNumber(d.apertureWidthMm, `${where} apertureWidthMm`);
  if (w !== undefined) out.apertureWidthMm = w;
  const h = optionalNumber(d.apertureHeightMm, `${where} apertureHeightMm`);
  if (h !== undefined) out.apertureHeightMm = h;
  return out;
}

function rowToDraft(row: DeviceRow): DeviceDraft {
  return {
    slug: row.slug,
    displayName: row.displayName,
    behavioralKind: row.behavioralKind ?? "",
    componentType: row.componentType,
    mesh: row.mesh,
    anchors: (row.anchors ?? []).map(anchorToDraft),
    defaultParams: JSON.stringify(row.defaultParams ?? {}, null, 2),
  };
}

function emptyDraft(): DeviceDraft {
  return {
    slug: "",
    displayName: "",
    behavioralKind: "",
    componentType: "",
    mesh: "",
    anchors: [],
    defaultParams: "{}",
  };
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

export function DevicesEditor({
  domain = "all",
  readOnly = false,
}: { domain?: "all" | KindDomain; readOnly?: boolean } = {}) {
  const [rows, setRows] = useState<DeviceRow[]>([]);
  const [loadStatus, setLoadStatus] = useState<"idle" | "loading" | "error">("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [behavioralKinds, setBehavioralKinds] = useState<string[]>([]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterText, setFilterText] = useState<string>("");
  const [lockFilter, setLockFilter] = useState<LockFilter>("all");

  // One draft buffer for both modes: `mode` says whether Save creates or
  // patches. Keeping them separate (as KindsEditor does) would mean two
  // copies of the anchor-table UI, which is the bulk of this component.
  const [mode, setMode] = useState<"view" | "edit" | "create">("view");
  const [draft, setDraft] = useState<DeviceDraft | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteStatus, setDeleteStatus] = useState<Record<string, "idle" | "deleting" | "error">>({});
  const [lockBusy, setLockBusy] = useState<Record<string, boolean>>({});

  const kinds = useKindsStore((s) => s.kinds);
  const fetchKinds = useKindsStore((s) => s.fetchAll);
  const refreshDeviceStore = useDevicesStore((s) => s.refresh);

  const reload = useCallback(async () => {
    setLoadStatus("loading");
    setLoadError(null);
    try {
      setRows(await listDevicesApi());
      setLoadStatus("idle");
    } catch (e) {
      setLoadStatus("error");
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
    void fetchKinds();
  }, [reload, fetchKinds]);

  useEffect(() => {
    let cancelled = false;
    void listDeviceBehavioralKindsApi()
      .then((names) => {
        if (!cancelled) setBehavioralKinds(names);
      })
      .catch(() => {
        // Non-fatal: the picker falls back to the kinds already in use.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Domain is a cross-cutting filter, not a device field: a device inherits
  // it from the kind it pins. Render-only devices (behavioralKind null) are
  // mechanical by definition.
  const domainOf = useCallback(
    (row: DeviceRow): KindDomain[] => {
      if (!row.behavioralKind) return ["mechanical"];
      return kinds.find((k) => k.name === row.behavioralKind)?.domains ?? [];
    },
    [kinds],
  );

  const inDomain = useMemo(
    () => (domain === "all" ? rows : rows.filter((r) => domainOf(r).includes(domain))),
    [rows, domain, domainOf],
  );

  const filtered = useMemo(() => {
    const needle = filterText.trim().toLowerCase();
    return inDomain.filter((r) => {
      if (!matchesLockFilter(r.locked, lockFilter)) return false;
      if (!needle) return true;
      return `${r.displayName} ${r.slug} ${r.behavioralKind ?? ""} ${r.componentType}`
        .toLowerCase()
        .includes(needle);
    });
  }, [inDomain, filterText, lockFilter]);

  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedId) ?? null,
    [rows, selectedId],
  );

  useEffect(() => {
    if (!selectedId && filtered.length > 0) setSelectedId(filtered[0].id);
  }, [filtered, selectedId]);

  const kindOptions = useMemo(() => {
    const set = new Set<string>([
      ...behavioralKinds,
      ...rows.map((r) => r.behavioralKind).filter((k): k is string => !!k),
    ]);
    return [...set].sort();
  }, [behavioralKinds, rows]);

  const cancel = () => {
    setMode("view");
    setDraft(null);
    setSaveStatus("idle");
    setSaveError(null);
  };

  const handleSelect = (id: string) => {
    if (mode !== "view" && !window.confirm("Discard the unsaved device draft?")) return;
    cancel();
    setSelectedId(id);
  };

  const startCreate = () => {
    setDraft(emptyDraft());
    setMode("create");
    setSaveStatus("idle");
    setSaveError(null);
  };

  const startEdit = (row: DeviceRow) => {
    setDraft(rowToDraft(row));
    setMode("edit");
    setSaveStatus("idle");
    setSaveError(null);
  };

  const submit = async () => {
    if (!draft) return;
    setSaveStatus("saving");
    setSaveError(null);
    let anchors: DeviceAnchorTemplate[];
    let defaultParams: Record<string, unknown>;
    try {
      if (!draft.displayName.trim()) throw new Error("displayName is required");
      if (!draft.componentType.trim()) throw new Error("componentType is required");
      if (mode === "create") {
        if (!/^[a-z0-9_]+$/.test(draft.slug)) {
          throw new Error("slug is required — lower-case letters, digits and _ only");
        }
      }
      anchors = draft.anchors.map(draftToAnchor);
      defaultParams = parseJsonObject(draft.defaultParams, "defaultParams");
    } catch (e) {
      setSaveStatus("error");
      setSaveError((e as Error).message);
      return;
    }
    try {
      if (mode === "create") {
        const payload: DeviceCreatePayload = {
          slug: draft.slug,
          displayName: draft.displayName.trim(),
          behavioralKind: draft.behavioralKind || null,
          componentType: draft.componentType.trim(),
          mesh: draft.mesh.trim(),
          anchors,
          defaultParams,
        };
        const created = await createDeviceApi(payload);
        setSelectedId(created.id);
      } else if (selectedRow) {
        const patch: DevicePatchPayload = {
          displayName: draft.displayName.trim(),
          behavioralKind: draft.behavioralKind || null,
          componentType: draft.componentType.trim(),
          mesh: draft.mesh.trim(),
          anchors,
          defaultParams,
        };
        await updateDeviceApi(selectedRow.id, patch);
      }
      await reload();
      // The Asset3D editor's device picker reads the shared store.
      await refreshDeviceStore();
      cancel();
    } catch (e) {
      setSaveStatus("error");
      setSaveError((e as Error).message);
    }
  };

  const handleDelete = async (row: DeviceRow) => {
    if (row.usageCount > 0) {
      window.alert(
        `"${row.slug}" is still used by ${row.usageCount} Asset3D row(s). `
        + "Repoint or clear those assets first.",
      );
      return;
    }
    if (!window.confirm(`Delete device "${row.slug}"? This cannot be undone.`)) return;
    setDeleteStatus((prev) => ({ ...prev, [row.id]: "deleting" }));
    try {
      await deleteDeviceApi(row.id);
      setSelectedId(null);
      await reload();
      await refreshDeviceStore();
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

  const toggleLock = async (row: DeviceRow) => {
    if (mode !== "view" && selectedRow?.id === row.id && !row.locked) cancel();
    setLockBusy((prev) => ({ ...prev, [row.id]: true }));
    try {
      const updated = await updateDeviceApi(row.id, { locked: !row.locked });
      setRows((prev) => prev.map((r) => (r.id === row.id ? updated : r)));
      await refreshDeviceStore();
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

  const patchAnchor = (index: number, patch: Partial<AnchorDraft>) => {
    if (!draft) return;
    setDraft({
      ...draft,
      anchors: draft.anchors.map((a, i) => (i === index ? { ...a, ...patch } : a)),
    });
  };

  const domainLabel =
    domain === "all"
      ? "All domains"
      : domain === "rf"
        ? "RF"
        : domain === "mechanical"
          ? "Mechanical"
          : "Optical";

  const headerTitle =
    mode === "create"
      ? "+ New device"
      : mode === "edit"
        ? `Editing ${selectedRow?.slug ?? ""}`
        : selectedRow?.displayName ?? "Select a device";
  const headerSubtitle =
    mode === "create"
      ? "draft"
      : selectedRow
        ? `${selectedRow.slug}${
            selectedRow.usageCount ? ` · used by ${selectedRow.usageCount} asset(s)` : ""
          }`
        : `${inDomain.length} device${inDomain.length === 1 ? "" : "s"}${
            domain === "all" ? "" : ` · ${domainLabel}`
          } (DB)`;
  const delStatus = selectedRow ? deleteStatus[selectedRow.id] ?? "idle" : "idle";

  return (
    <div className="devices-editor" style={SHELL_STYLE}>
      <aside style={ASIDE_STYLE}>
        {!readOnly && (
          <button
            type="button"
            onClick={startCreate}
            style={{ ...PRIMARY_BUTTON, width: "100%", marginBottom: 6 }}
          >
            + New device
          </button>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 6, marginBottom: 8 }}>
          <input
            type="text"
            placeholder="filter by slug / name / kind"
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
        </div>
        <div style={{ fontSize: 10, color: "#4b5563", marginBottom: 6 }}>
          {filtered.length} of {inDomain.length} devices
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
              <div style={{ fontSize: 10, color: MUTED }}>
                <span style={{ color: "#9ca3af" }}>slug:</span> {row.slug}
              </div>
              <div style={{ fontSize: 10, color: MUTED }}>
                {row.behavioralKind ?? "render-only"} · {row.anchors.length} anchor
                {row.anchors.length === 1 ? "" : "s"}
              </div>
            </button>
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

      <main style={MAIN_STYLE}>
        <div style={MAIN_HEADER_STYLE}>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 700,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {headerTitle}
            </div>
            <div style={{ fontSize: 11, color: MUTED }}>{headerSubtitle}</div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {mode === "view" && selectedRow && !readOnly && (
              <>
                <button
                  type="button"
                  onClick={() => startEdit(selectedRow)}
                  disabled={selectedRow.locked}
                  style={ICON_BUTTON}
                  title={selectedRow.locked ? "Locked — unlock to edit" : "Edit device"}
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
                      : selectedRow.usageCount > 0
                        ? `Used by ${selectedRow.usageCount} asset(s) — cannot delete`
                        : "Delete device"
                  }
                >
                  <Trash2 size={14} />
                </button>
              </>
            )}
            {mode !== "view" && (
              <>
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={saveStatus === "saving"}
                  style={ICON_BUTTON}
                  title={saveStatus === "saving" ? "Saving…" : "Save"}
                >
                  <Save size={14} />
                </button>
                <button type="button" onClick={cancel} style={ICON_BUTTON} title="Cancel">
                  <X size={14} />
                </button>
              </>
            )}
          </div>
        </div>

        <div style={MAIN_BODY_STYLE}>
          {saveError && <div style={ERROR_BANNER}>{saveError}</div>}

          {mode === "view" && !selectedRow && (
            <div style={{ fontSize: 11, color: MUTED }}>
              Pick a device on the left, or create one. A device seeds an
              Asset3D's anchors and writes its kind through — see the ASSET3D
              tab's <em>device</em> picker.
            </div>
          )}

          {mode === "view" && selectedRow && (
            <>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <tbody>
                  <tr>
                    <td style={{ ...TD, color: MUTED, width: 140 }}>slug</td>
                    <td style={{ ...TD, color: "#4ec9b0" }}>{selectedRow.slug}</td>
                  </tr>
                  <tr>
                    <td style={{ ...TD, color: MUTED }}>behavioralKind</td>
                    <td style={TD}>
                      {selectedRow.behavioralKind ?? (
                        <span style={{ color: MUTED }}>null (render-only)</span>
                      )}
                    </td>
                  </tr>
                  <tr>
                    <td style={{ ...TD, color: MUTED }}>componentType</td>
                    <td style={TD}>{selectedRow.componentType}</td>
                  </tr>
                  <tr>
                    <td style={{ ...TD, color: MUTED }}>mesh</td>
                    <td style={TD}>{selectedRow.mesh || <span style={{ color: MUTED }}>—</span>}</td>
                  </tr>
                  <tr>
                    <td style={{ ...TD, color: MUTED }}>used by</td>
                    <td style={TD}>{selectedRow.usageCount} Asset3D row(s)</td>
                  </tr>
                </tbody>
              </table>

              <div style={SECTION_LABEL}>anchors ({selectedRow.anchors.length})</div>
              {selectedRow.anchors.length === 0 ? (
                <div style={{ fontSize: 11, color: MUTED }}>
                  None — a render-only fixture, or the layout is still to be authored.
                </div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={TH}>role</th>
                      <th style={TH}>name</th>
                      <th style={TH}>position (mm)</th>
                      <th style={TH}>direction</th>
                      <th style={TH}>connector</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedRow.anchors.map((a, i) => (
                      <tr key={`${a.role}-${a.name ?? i}`}>
                        <td style={TD}>{a.role}</td>
                        <td style={TD}>{a.name ?? "—"}</td>
                        <td style={TD}>
                          {a.positionMmBodyLocal
                            ? `${a.positionMmBodyLocal.x}, ${a.positionMmBodyLocal.y}, ${a.positionMmBodyLocal.z}`
                            : "origin"}
                        </td>
                        <td style={TD}>
                          {a.directionBodyLocal
                            ? `${a.directionBodyLocal.x}, ${a.directionBodyLocal.y}, ${a.directionBodyLocal.z}`
                            : "—"}
                        </td>
                        <td style={TD}>{a.connectorType ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <div style={SECTION_LABEL}>defaultParams</div>
              <pre
                style={{
                  ...INPUT,
                  fontFamily: "ui-monospace, monospace",
                  whiteSpace: "pre-wrap",
                  margin: 0,
                  minHeight: 40,
                }}
              >
                {JSON.stringify(selectedRow.defaultParams ?? {}, null, 2)}
              </pre>
            </>
          )}

          {mode !== "view" && draft && (
            <>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                  gap: 8,
                }}
              >
                <Field label={mode === "create" ? "slug (immutable once saved)" : "slug"}>
                  <input
                    value={draft.slug}
                    disabled={mode === "edit"}
                    onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
                    placeholder="e.g. thorlabs_pf10_03_p01"
                    style={INPUT}
                  />
                </Field>
                <Field label="displayName">
                  <input
                    value={draft.displayName}
                    onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                    placeholder="e.g. Thorlabs PF10-03-P01"
                    style={INPUT}
                  />
                </Field>
                <Field label="behavioralKind">
                  <select
                    value={draft.behavioralKind}
                    onChange={(e) => setDraft({ ...draft, behavioralKind: e.target.value })}
                    style={INPUT}
                  >
                    <option value="">— none (render-only) —</option>
                    {kindOptions.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="componentType">
                  <input
                    value={draft.componentType}
                    onChange={(e) => setDraft({ ...draft, componentType: e.target.value })}
                    placeholder="e.g. mirror"
                    style={INPUT}
                  />
                </Field>
                <Field label="mesh">
                  <input
                    value={draft.mesh}
                    onChange={(e) => setDraft({ ...draft, mesh: e.target.value })}
                    placeholder="e.g. pf10_03_p01.stl"
                    style={INPUT}
                  />
                </Field>
              </div>

              <div style={SECTION_LABEL}>
                anchors — role becomes the seeded anchor id; blank position seeds at
                the body origin
              </div>
              {draft.anchors.map((a, i) => (
                <div
                  key={i}
                  style={{
                    border: "1px solid #d8ded8",
                    padding: 8,
                    marginBottom: 6,
                    background: "#ffffff",
                  }}
                >
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                      gap: 6,
                    }}
                  >
                    <Field label="role">
                      <input
                        value={a.role}
                        onChange={(e) => patchAnchor(i, { role: e.target.value })}
                        placeholder="rf_out / intercept_in"
                        style={INPUT}
                      />
                    </Field>
                    <Field label="name (repeat disambiguator)">
                      <input
                        value={a.name}
                        onChange={(e) => patchAnchor(i, { name: e.target.value })}
                        placeholder="CH0"
                        style={INPUT}
                      />
                    </Field>
                    <Field label="connectorType">
                      <input
                        value={a.connectorType}
                        onChange={(e) => patchAnchor(i, { connectorType: e.target.value })}
                        placeholder="sma_female"
                        style={INPUT}
                      />
                    </Field>
                  </div>
                  <VectorField
                    label="positionMmBodyLocal"
                    value={a.position}
                    onChange={(position) => patchAnchor(i, { position })}
                  />
                  <VectorField
                    label="directionBodyLocal (seeds axisX)"
                    value={a.direction}
                    onChange={(direction) => patchAnchor(i, { direction })}
                  />
                  <VectorField
                    label="axisYBodyLocal (polarisation-sensitive optics only)"
                    value={a.axisY}
                    onChange={(axisY) => patchAnchor(i, { axisY })}
                  />
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
                      gap: 6,
                      marginTop: 6,
                    }}
                  >
                    <Field label="apertureMm">
                      <input
                        value={a.apertureMm}
                        onChange={(e) => patchAnchor(i, { apertureMm: e.target.value })}
                        style={INPUT}
                      />
                    </Field>
                    <Field label="apertureShape">
                      <select
                        value={a.apertureShape}
                        onChange={(e) =>
                          patchAnchor(i, {
                            apertureShape: e.target.value as AnchorDraft["apertureShape"],
                          })
                        }
                        style={INPUT}
                      >
                        <option value="">—</option>
                        <option value="circle">circle</option>
                        <option value="ellipse">ellipse</option>
                        <option value="rectangle">rectangle</option>
                      </select>
                    </Field>
                    <Field label="apertureWidthMm">
                      <input
                        value={a.apertureWidthMm}
                        onChange={(e) => patchAnchor(i, { apertureWidthMm: e.target.value })}
                        style={INPUT}
                      />
                    </Field>
                    <Field label="apertureHeightMm">
                      <input
                        value={a.apertureHeightMm}
                        onChange={(e) => patchAnchor(i, { apertureHeightMm: e.target.value })}
                        style={INPUT}
                      />
                    </Field>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        anchors: draft.anchors.filter((_, j) => j !== i),
                      })
                    }
                    style={{ ...ICON_BUTTON, marginTop: 6, width: "auto", padding: "0 8px" }}
                    title="Remove this anchor"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setDraft({ ...draft, anchors: [...draft.anchors, emptyAnchorDraft()] })
                }
                style={{ ...ICON_BUTTON, width: "auto", padding: "0 8px" }}
                title="Add an anchor"
              >
                <Plus size={13} /> anchor
              </button>

              <div style={SECTION_LABEL}>defaultParams (JSON)</div>
              <textarea
                value={draft.defaultParams}
                onChange={(e) => setDraft({ ...draft, defaultParams: e.target.value })}
                style={{
                  ...INPUT,
                  minHeight: 90,
                  fontFamily: "ui-monospace, monospace",
                  resize: "vertical",
                }}
              />
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", fontSize: 11, color: MUTED }}>
      {label}
      {children}
    </label>
  );
}

function VectorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: [string, string, string];
  onChange: (next: [string, string, string]) => void;
}) {
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 11, color: MUTED }}>{label}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
        {(["x", "y", "z"] as const).map((axis, i) => (
          <input
            key={axis}
            value={value[i]}
            placeholder={axis}
            onChange={(e) => {
              const next: [string, string, string] = [...value];
              next[i] = e.target.value;
              onChange(next);
            }}
            style={INPUT}
          />
        ))}
      </div>
    </div>
  );
}
