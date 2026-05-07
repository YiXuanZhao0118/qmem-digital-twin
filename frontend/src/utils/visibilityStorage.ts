import { DEFAULT_OVERLAY_FLAGS, type OverlayFlags } from "../types/visibility";

const OVERLAY_KEY = "qmem.overlayFlags.v1";
const ACTIVE_VIEW_KEY = "qmem.activeViewId.v1";

export function loadOverlayFlagsFromStorage(): OverlayFlags {
  try {
    const raw = localStorage.getItem(OVERLAY_KEY);
    if (!raw) return { ...DEFAULT_OVERLAY_FLAGS };
    const parsed = JSON.parse(raw) as Partial<OverlayFlags>;
    return { ...DEFAULT_OVERLAY_FLAGS, ...parsed };
  } catch {
    return { ...DEFAULT_OVERLAY_FLAGS };
  }
}

export function saveOverlayFlagsToStorage(flags: OverlayFlags): void {
  try {
    localStorage.setItem(OVERLAY_KEY, JSON.stringify(flags));
  } catch {
    // localStorage 滿了或 Safari private mode
  }
}

export function loadActiveViewId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_VIEW_KEY);
  } catch {
    return null;
  }
}

export function saveActiveViewId(viewId: string | null): void {
  try {
    if (viewId) localStorage.setItem(ACTIVE_VIEW_KEY, viewId);
    else localStorage.removeItem(ACTIVE_VIEW_KEY);
  } catch {
    // ignore
  }
}
