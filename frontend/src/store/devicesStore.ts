/**
 * Devices store — cached list of device registry rows from /api/devices.
 *
 * Replaces the compile-time `devices/_registry.ts` barrel: devices became DB
 * rows in alembic 0123, so `DEVICES` / `deviceById` / `devicesForBehavioralKind`
 * are now derived from fetched state rather than a static tuple. Mirrors
 * `kindsStore` — loaded once on first read, `refresh()` after an edit.
 *
 * Consumers: Asset3DEditor's device picker + anchor authoring-grade check,
 * and DevicesEditor (the PHY Editor's DEVICE section).
 */

import { create } from "zustand";

import { listDevicesApi, type DeviceRow } from "../api/client";

type Status = "idle" | "loading" | "ready" | "error";

type DevicesState = {
  devices: DeviceRow[];
  status: Status;
  error: string | null;

  fetchAll: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Resolve by `slug` — the value stored in `Asset3D.deviceId`. */
  bySlug: (slug: string | null | undefined) => DeviceRow | null;
  /** Devices that materialise a given behavioural kind. The PHY Editor
   *  lists these when an asset's kind is fixed and the user picks a part. */
  forBehavioralKind: (kind: string) => DeviceRow[];
};

export const useDevicesStore = create<DevicesState>((set, get) => ({
  devices: [],
  status: "idle",
  error: null,

  fetchAll: async () => {
    if (get().status === "loading" || get().status === "ready") return;
    set({ status: "loading", error: null });
    try {
      const rows = await listDevicesApi();
      set({ devices: rows, status: "ready", error: null });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ status: "error", error: msg });
    }
  },

  refresh: async () => {
    set({ status: "idle" });
    await get().fetchAll();
  },

  bySlug: (slug) => {
    if (!slug) return null;
    return get().devices.find((d) => d.slug === slug) ?? null;
  },

  forBehavioralKind: (kind) =>
    get().devices.filter((d) => d.behavioralKind === kind),
}));
