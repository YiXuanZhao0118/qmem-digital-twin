import {
  Bookmark,
  Check,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  Pencil,
  Pin,
  Plus,
  RotateCcw,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useSceneStore } from "../store/sceneStore";
import type { PhysicsCapability } from "../types/digitalTwin";
import {
  DEFAULT_OVERLAY_FLAGS,
  OVERLAY_GROUPS,
  OVERLAY_LABELS,
  type OverlayFlags,
  type OverlayKind,
  type SceneView,
  type SceneViewCreatePayload,
  type ViewFilterExpr,
} from "../types/visibility";
import {
  componentHasAnyVisibleObject,
  makeRenderableContext,
} from "../utils/visibility";

const PHYSICS_CAPABILITIES: PhysicsCapability[] = [
  "stress",
  "optical",
  "rf",
  "em",
  "thermal",
  "fluid",
  "quantum",
];

// =============================================================================
// L1 — Display popover
// =============================================================================

export function DisplayPopover({ open, onClose }: { open: boolean; onClose: () => void }) {
  const overlayFlags = useSceneStore((s) => s.overlayFlags);
  const setOverlayFlag = useSceneStore((s) => s.setOverlayFlag);
  const resetOverlayFlags = useSceneStore((s) => s.resetOverlayFlags);
  const showAllHidden = useSceneStore((s) => s.showAllHidden);
  const session = useSceneStore((s) => s.session);
  const activeViewId = useSceneStore((s) => s.activeViewId);

  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const sessionHiddenCount =
    session.hiddenObjectIds.size +
    session.hiddenBeamPathIds.size +
    session.hiddenLinkIds.size +
    session.hiddenRelationIds.size +
    session.forceVisibleObjectIds.size +
    session.forceVisibleCollectionIds.size +
    (session.soloObjectIds?.size ?? 0);

  return (
    <div className="display-popover" ref={popoverRef}>
      {OVERLAY_GROUPS.map((group) => (
        <div className="display-group" key={group.label}>
          <div className="display-group-title">{group.label}</div>
          <div className="display-group-grid">
            {group.kinds.map((kind) => {
              const value = overlayFlags[kind];
              return (
                <button
                  key={kind}
                  className={`overlay-toggle${value ? " active" : ""}`}
                  onClick={() => setOverlayFlag(kind, !value)}
                  title={`Toggle ${OVERLAY_LABELS[kind]}`}
                >
                  {value ? <Eye size={14} /> : <EyeOff size={14} />}
                  <span>{OVERLAY_LABELS[kind]}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <div className="display-actions">
        <button className="secondary-button" onClick={resetOverlayFlags}>
          <RotateCcw size={14} />
          Reset overlays
        </button>
        <button
          className="secondary-button"
          disabled={sessionHiddenCount === 0 && !activeViewId}
          onClick={showAllHidden}
        >
          <Eye size={14} />
          Show all hidden
        </button>
      </div>

      <div className="display-hint">
        Shortcuts: <kbd>1</kbd>–<kbd>6</kbd> toggle overlays · <kbd>0</kbd> reset · <kbd>Esc</kbd> show all
      </div>
    </div>
  );
}

// =============================================================================
// L3 — Saved views picker
// =============================================================================

export function SceneViewPicker({ onOpenEditor }: { onOpenEditor: (view: SceneView | null) => void }) {
  const sceneViews = useSceneStore((s) => s.scene.sceneViews ?? []);
  const activeViewId = useSceneStore((s) => s.activeViewId);
  const setActiveView = useSceneStore((s) => s.setActiveView);
  const deleteSceneView = useSceneStore((s) => s.deleteSceneView);
  const updateSceneView = useSceneStore((s) => s.updateSceneView);
  const duplicateSceneView = useSceneStore((s) => s.duplicateSceneView);
  const createViewFromCurrentVisibility = useSceneStore(
    (s) => s.createViewFromCurrentVisibility,
  );
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  const activeView = sceneViews.find((v) => v.id === activeViewId) ?? null;
  const pinnedViews = sceneViews.filter((v) => v.isPinned);
  const otherViews = sceneViews.filter((v) => !v.isPinned);

  const onCreateFromCurrent = async () => {
    const name = window.prompt("Name for new view from current visibility?");
    if (!name) return;
    try {
      const view = await createViewFromCurrentVisibility(name);
      setActiveView(view.id);
      setOpen(false);
    } catch (error) {
      window.alert(`Failed to create view: ${(error as Error).message}`);
    }
  };

  return (
    <div className="view-picker" ref={ref}>
      <button
        className="view-picker-button"
        title="Active scene view"
        onClick={() => setOpen((v) => !v)}
      >
        <Bookmark size={15} />
        <span className="view-picker-label">{activeView ? activeView.name : "All"}</span>
        <ChevronDown size={14} />
      </button>

      {open && (
        <div className="view-picker-menu">
          <button
            className={`view-picker-item${activeViewId === null ? " active" : ""}`}
            onClick={() => {
              setActiveView(null);
              setOpen(false);
            }}
          >
            <Star size={14} />
            <span>All Components</span>
            <small>{activeViewId === null ? "(active)" : ""}</small>
          </button>

          {pinnedViews.length > 0 && <div className="view-picker-divider" />}
          {pinnedViews.map((view) => (
            <SceneViewRow
              key={view.id}
              view={view}
              active={view.id === activeViewId}
              onActivate={() => {
                setActiveView(view.id);
                setOpen(false);
              }}
              onEdit={() => {
                onOpenEditor(view);
                setOpen(false);
              }}
              onDelete={async () => {
                if (window.confirm(`Delete view "${view.name}"?`)) {
                  await deleteSceneView(view.id);
                }
              }}
              onDuplicate={async () => {
                await duplicateSceneView(view.id);
              }}
              onTogglePin={async () => {
                await updateSceneView(view.id, { isPinned: !view.isPinned });
              }}
            />
          ))}

          {otherViews.length > 0 && <div className="view-picker-divider" />}
          {otherViews.map((view) => (
            <SceneViewRow
              key={view.id}
              view={view}
              active={view.id === activeViewId}
              onActivate={() => {
                setActiveView(view.id);
                setOpen(false);
              }}
              onEdit={() => {
                onOpenEditor(view);
                setOpen(false);
              }}
              onDelete={async () => {
                if (window.confirm(`Delete view "${view.name}"?`)) {
                  await deleteSceneView(view.id);
                }
              }}
              onDuplicate={async () => {
                await duplicateSceneView(view.id);
              }}
              onTogglePin={async () => {
                await updateSceneView(view.id, { isPinned: !view.isPinned });
              }}
            />
          ))}

          <div className="view-picker-divider" />
          <button
            className="view-picker-item action"
            onClick={() => {
              onOpenEditor(null);
              setOpen(false);
            }}
          >
            <Plus size={14} />
            <span>Create new view…</span>
          </button>
          <button className="view-picker-item action" onClick={() => void onCreateFromCurrent()}>
            <Plus size={14} />
            <span>Create from current visibility…</span>
          </button>
        </div>
      )}
    </div>
  );
}

function SceneViewRow({
  view,
  active,
  onActivate,
  onEdit,
  onDelete,
  onDuplicate,
  onTogglePin,
}: {
  view: SceneView;
  active: boolean;
  onActivate: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onTogglePin: () => void;
}) {
  return (
    <div className={`view-picker-item${active ? " active" : ""}`}>
      <button
        className="view-picker-row-label"
        onClick={onActivate}
        title={view.description ?? view.name}
      >
        <span
          className="view-picker-color"
          style={{ background: view.color }}
          aria-hidden="true"
        />
        <span>
          {view.icon ? `${view.icon} ` : ""}
          {view.name}
          {view.isDefault ? " ★" : ""}
        </span>
      </button>
      <button
        className="view-picker-icon"
        title={view.isPinned ? "Unpin" : "Pin to toolbar"}
        onClick={onTogglePin}
      >
        <Pin size={12} />
      </button>
      <button className="view-picker-icon" title="Duplicate" onClick={onDuplicate}>
        <Copy size={12} />
      </button>
      <button className="view-picker-icon" title="Edit" onClick={onEdit}>
        <Pencil size={12} />
      </button>
      <button className="view-picker-icon danger" title="Delete" onClick={onDelete}>
        <Trash2 size={12} />
      </button>
    </div>
  );
}

// =============================================================================
// L3 — Scene view editor modal
// =============================================================================

type ConditionLeaf = Exclude<ViewFilterExpr, { type: "and" } | { type: "or" } | { type: "not" }>;

function defaultLeaf(): ConditionLeaf {
  return { type: "component_type", values: [] };
}

function exprToLeaves(expr: ViewFilterExpr): { combinator: "and" | "or"; leaves: ConditionLeaf[] } {
  if (expr.type === "all") return { combinator: "and", leaves: [] };
  if (expr.type === "and" || expr.type === "or") {
    const leaves: ConditionLeaf[] = [];
    for (const clause of expr.clauses) {
      if (clause.type === "and" || clause.type === "or" || clause.type === "not") continue;
      leaves.push(clause as ConditionLeaf);
    }
    return { combinator: expr.type, leaves };
  }
  if (expr.type === "not") return { combinator: "and", leaves: [] };
  return { combinator: "and", leaves: [expr as ConditionLeaf] };
}

function leavesToExpr(combinator: "and" | "or", leaves: ConditionLeaf[]): ViewFilterExpr {
  if (leaves.length === 0) return { type: "all" };
  if (leaves.length === 1) return leaves[0];
  return { type: combinator, clauses: leaves };
}

export function SceneViewEditor({
  initial,
  onClose,
}: {
  initial: SceneView | null;
  onClose: () => void;
}) {
  const scene = useSceneStore((s) => s.scene);
  const overlayFlags = useSceneStore((s) => s.overlayFlags);
  const session = useSceneStore((s) => s.session);
  const createSceneView = useSceneStore((s) => s.createSceneView);
  const updateSceneView = useSceneStore((s) => s.updateSceneView);

  const [name, setName] = useState(initial?.name ?? "New view");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [icon, setIcon] = useState(initial?.icon ?? "");
  const [color, setColor] = useState(initial?.color ?? "#0f766e");
  const [isDefault, setIsDefault] = useState(initial?.isDefault ?? false);
  const [isPinned, setIsPinned] = useState(initial?.isPinned ?? false);
  const [overlayOverrides, setOverlayOverrides] = useState<Partial<OverlayFlags>>(
    initial?.overlayOverrides ?? {},
  );
  const [useOverlayOverrides, setUseOverlayOverrides] = useState(
    Object.keys(initial?.overlayOverrides ?? {}).length > 0,
  );

  const initialExpr = useMemo(() => {
    if (!initial) return { combinator: "and" as const, leaves: [] };
    return exprToLeaves(initial.filterExpr);
  }, [initial]);
  const [combinator, setCombinator] = useState<"and" | "or">(initialExpr.combinator);
  const [leaves, setLeaves] = useState<ConditionLeaf[]>(initialExpr.leaves);
  const [error, setError] = useState("");

  const finalExpr = useMemo(() => leavesToExpr(combinator, leaves), [combinator, leaves]);
  const filterKind: "all" | "any" | "leaf" =
    leaves.length === 0 ? "all" : leaves.length === 1 ? "leaf" : combinator === "and" ? "all" : "any";
  const previewMatchCount = useMemo(() => {
    const tempView: SceneView = {
      id: initial?.id ?? "preview",
      name,
      description: description || null,
      icon: icon || null,
      color,
      filterKind,
      filterExpr: finalExpr,
      overlayOverrides: useOverlayOverrides ? overlayOverrides : {},
      isDefault,
      isPinned,
      sortOrder: initial?.sortOrder ?? 0,
    };
    const ctx = makeRenderableContext(overlayFlags, session, tempView, scene);
    let count = 0;
    for (const c of scene.components) if (componentHasAnyVisibleObject(c.id, ctx)) count += 1;
    return count;
  }, [
    finalExpr,
    name,
    description,
    icon,
    color,
    overlayOverrides,
    useOverlayOverrides,
    isDefault,
    isPinned,
    filterKind,
    initial?.id,
    initial?.sortOrder,
    overlayFlags,
    session,
    scene,
  ]);

  const componentTypeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of scene.components) set.add(c.componentType);
    return [...set].sort();
  }, [scene.components]);

  const onSave = async () => {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    const payload: SceneViewCreatePayload = {
      name: name.trim(),
      description: description || null,
      icon: icon || null,
      color,
      filterKind,
      filterExpr: finalExpr,
      overlayOverrides: useOverlayOverrides ? overlayOverrides : {},
      isDefault,
      isPinned,
    };
    try {
      if (initial) await updateSceneView(initial.id, payload);
      else await createSceneView(payload);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{initial ? "Edit View" : "Create View"}</h2>
          <button className="icon-button" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div className="form-row">
            <label className="form-field grow">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="form-field">
              <span>Color</span>
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
            </label>
            <label className="form-field">
              <span>Icon</span>
              <input
                value={icon}
                placeholder="emoji"
                onChange={(e) => setIcon(e.target.value)}
                style={{ width: 60 }}
              />
            </label>
          </div>

          <label className="form-field">
            <span>Description</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </label>

          <div className="form-section">
            <div className="form-section-header">
              <strong>Filter</strong>
              <div className="combinator">
                <button
                  className={combinator === "and" ? "pill active" : "pill"}
                  onClick={() => setCombinator("and")}
                  disabled={leaves.length < 2}
                >
                  AND
                </button>
                <button
                  className={combinator === "or" ? "pill active" : "pill"}
                  onClick={() => setCombinator("or")}
                  disabled={leaves.length < 2}
                >
                  OR
                </button>
              </div>
            </div>

            <div className="condition-list">
              {leaves.map((leaf, index) => (
                <ConditionRow
                  key={index}
                  leaf={leaf}
                  scene={scene}
                  componentTypes={componentTypeOptions}
                  onChange={(next) =>
                    setLeaves((prev) => prev.map((l, i) => (i === index ? next : l)))
                  }
                  onRemove={() => setLeaves((prev) => prev.filter((_, i) => i !== index))}
                />
              ))}
              <button
                className="secondary-button"
                onClick={() => setLeaves((prev) => [...prev, defaultLeaf()])}
              >
                <Plus size={14} />
                Add condition
              </button>
              {leaves.length === 0 && (
                <p className="muted-hint">No conditions: this view will include every component.</p>
              )}
            </div>
          </div>

          <div className="form-section">
            <label className="form-check">
              <input
                type="checkbox"
                checked={useOverlayOverrides}
                onChange={(e) => setUseOverlayOverrides(e.target.checked)}
              />
              Override overlays when this view is active
            </label>
            {useOverlayOverrides && (
              <div className="overlay-override-grid">
                {OVERLAY_GROUPS.flatMap((g) => g.kinds).map((kind) => {
                  const checked = overlayOverrides[kind];
                  const fallback = DEFAULT_OVERLAY_FLAGS[kind];
                  return (
                    <label key={kind} className="form-check inline">
                      <input
                        type="checkbox"
                        checked={checked ?? fallback}
                        onChange={(e) =>
                          setOverlayOverrides((prev) => ({
                            ...prev,
                            [kind]: e.target.checked,
                          }))
                        }
                      />
                      <span>{OVERLAY_LABELS[kind]}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          <div className="form-section">
            <label className="form-check">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
              />
              Set as project default
            </label>
            <label className="form-check">
              <input
                type="checkbox"
                checked={isPinned}
                onChange={(e) => setIsPinned(e.target.checked)}
              />
              Pin to toolbar
            </label>
          </div>

          <div className="muted-hint">
            Preview: {previewMatchCount} components match (excluding session/overlay filters).
          </div>
          {error && <p className="form-error">{error}</p>}
        </div>

        <div className="modal-footer">
          <button className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" onClick={() => void onSave()}>
            <Check size={15} />
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function ConditionRow({
  leaf,
  scene,
  componentTypes,
  onChange,
  onRemove,
}: {
  leaf: ConditionLeaf;
  scene: ReturnType<typeof useSceneStore.getState>["scene"];
  componentTypes: string[];
  onChange: (next: ConditionLeaf) => void;
  onRemove: () => void;
}) {
  const setType = (type: ConditionLeaf["type"]) => {
    switch (type) {
      case "component_type":
        return onChange({ type, values: [] });
      case "physics_capability":
        return onChange({ type, values: [] });
      case "wavelength_range":
        return onChange({ type, lowNm: 400, highNm: 1100 });
      case "tag":
        return onChange({ type, values: [] });
      case "reachable_from":
        return onChange({
          type,
          sourceComponentId: scene.components[0]?.id ?? "",
          via: ["optical"],
          maxHops: 50,
        });
      case "in_region":
        return onChange({ type, regionId: "" });
      case "in_stage":
        return onChange({ type, stageId: "" });
      case "component_ids":
        return onChange({ type, values: [] });
    }
  };

  return (
    <div className="condition-row">
      <select value={leaf.type} onChange={(e) => setType(e.target.value as ConditionLeaf["type"])}>
        <option value="component_type">Component type</option>
        <option value="physics_capability">Physics capability</option>
        <option value="wavelength_range">Wavelength range</option>
        <option value="tag">Tag</option>
        <option value="reachable_from">Reachable from</option>
        <option value="component_ids">Component IDs</option>
        <option value="in_region">In region (Phase 3)</option>
        <option value="in_stage">In stage (Phase 2)</option>
      </select>

      {leaf.type === "component_type" && (
        <select
          multiple
          value={leaf.values}
          onChange={(e) =>
            onChange({
              ...leaf,
              values: [...e.target.selectedOptions].map((o) => o.value),
            })
          }
        >
          {componentTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      )}

      {leaf.type === "physics_capability" && (
        <select
          multiple
          value={leaf.values}
          onChange={(e) =>
            onChange({
              ...leaf,
              values: [...e.target.selectedOptions].map(
                (o) => o.value as PhysicsCapability,
              ),
            })
          }
        >
          {PHYSICS_CAPABILITIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )}

      {leaf.type === "wavelength_range" && (
        <>
          <input
            type="number"
            value={leaf.lowNm}
            onChange={(e) => onChange({ ...leaf, lowNm: Number(e.target.value) || 0 })}
            style={{ width: 80 }}
          />
          <span>–</span>
          <input
            type="number"
            value={leaf.highNm}
            onChange={(e) => onChange({ ...leaf, highNm: Number(e.target.value) || 0 })}
            style={{ width: 80 }}
          />
          <span>nm</span>
        </>
      )}

      {leaf.type === "tag" && (
        <input
          value={leaf.values.join(",")}
          placeholder="tag1, tag2"
          onChange={(e) =>
            onChange({
              ...leaf,
              values: e.target.value
                .split(",")
                .map((v) => v.trim())
                .filter(Boolean),
            })
          }
        />
      )}

      {leaf.type === "reachable_from" && (
        <>
          <select
            value={leaf.sourceComponentId}
            onChange={(e) => onChange({ ...leaf, sourceComponentId: e.target.value })}
          >
            <option value="">— component —</option>
            {scene.components.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input
            type="number"
            value={leaf.maxHops}
            onChange={(e) =>
              onChange({ ...leaf, maxHops: Math.max(0, Number(e.target.value) || 0) })
            }
            style={{ width: 60 }}
          />
          <span>hops</span>
          <select
            multiple
            value={leaf.via}
            onChange={(e) =>
              onChange({
                ...leaf,
                via: [...e.target.selectedOptions].map(
                  (o) => o.value as "optical" | "connection" | "rf",
                ),
              })
            }
            style={{ width: 100 }}
          >
            <option value="optical">optical</option>
            <option value="connection">connection</option>
            <option value="rf">rf</option>
          </select>
        </>
      )}

      {leaf.type === "component_ids" && (
        <select
          multiple
          value={leaf.values}
          onChange={(e) =>
            onChange({ ...leaf, values: [...e.target.selectedOptions].map((o) => o.value) })
          }
          style={{ minWidth: 220, height: 100 }}
        >
          {scene.components.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      )}

      {(leaf.type === "in_region" || leaf.type === "in_stage") && (
        <input
          value={leaf.type === "in_region" ? leaf.regionId : leaf.stageId}
          placeholder="ID"
          onChange={(e) =>
            onChange(
              leaf.type === "in_region"
                ? { ...leaf, regionId: e.target.value }
                : { ...leaf, stageId: e.target.value },
            )
          }
        />
      )}

      <button className="icon-button danger" onClick={onRemove} title="Remove condition">
        <Trash2 size={14} />
      </button>
    </div>
  );
}
