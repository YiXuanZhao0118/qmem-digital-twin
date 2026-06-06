import { DEFAULT_OVERLAY_FLAGS, type OverlayFlags } from "../types/visibility";

const OVERLAY_KEY = "qmem.overlayFlags.v1";

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
    // localStorage full or Safari private mode
  }
}
