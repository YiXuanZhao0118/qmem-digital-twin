import type { ComponentItem } from "../types/digitalTwin";

export function getComponentName(component: ComponentItem): string {
  return component.componentName ?? component.name;
}

/** Compact label for tree rows: prefer the human-friendly `model` if set
 * (e.g. "CF175C/M-P5"), else strip the noisy "thorlabs_<type>_" prefix
 * from the full name, else fall back to the full name. */
export function getComponentDisplayLabel(component: ComponentItem): string {
  if (component.model && component.model.trim()) return component.model;
  const full = getComponentName(component);
  if (full.startsWith("thorlabs_")) {
    const tail = full.slice("thorlabs_".length);
    const typePrefix = `${component.kindId ?? ""}_`;
    if (tail.startsWith(typePrefix)) {
      return tail.slice(typePrefix.length).toUpperCase();
    }
    return tail.toUpperCase();
  }
  return full;
}

export function isOpticalTableComponent(component: ComponentItem): boolean {
  return (
    component.kindId === "optical_table" ||
    getComponentName(component).toLowerCase().includes("optical_table")
  );
}

/** Is this Component frozen as human-confirmed complete?
 *
 *  Reads the real `Component.locked` column (alembic 0128). Until then the
 *  flag lived in `properties.locked`, guarded delete only, and three files
 *  each carried their own copy of this predicate — 0128 moved the value
 *  into the column and stripped the key, so every reader has to come here.
 *  The API refuses any write but unlocking with 422 (`app/lock_guard.py`).
 */
export function isComponentLocked(component?: ComponentItem | null): boolean {
  return component?.locked === true;
}
