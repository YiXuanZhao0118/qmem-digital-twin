/**
 * Kinds store — cached list of Kind registry rows from /api/kinds.
 *
 * Used by ComponentsV2Editor + Asset3DV3Editor to populate the kind_id
 * <select>. Loaded once on first read, refreshed manually via
 * `refresh()` when the user edits the Kinds catalog.
 */

import { create } from "zustand";

import { listKindsApi, type KindRow } from "../api/client";

type Status = "idle" | "loading" | "ready" | "error";

type KindsState = {
  kinds: KindRow[];
  status: Status;
  error: string | null;

  fetchAll: () => Promise<void>;
  refresh: () => Promise<void>;
  byDomain: (domain: "optical" | "rf" | "mechanical") => KindRow[];
};

export const useKindsStore = create<KindsState>((set, get) => ({
  kinds: [],
  status: "idle",
  error: null,

  fetchAll: async () => {
    if (get().status === "loading" || get().status === "ready") return;
    set({ status: "loading", error: null });
    try {
      const rows = await listKindsApi();
      set({ kinds: rows, status: "ready", error: null });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ status: "error", error: msg });
    }
  },

  refresh: async () => {
    set({ status: "idle" });
    await get().fetchAll();
  },

  byDomain: (domain) => get().kinds.filter((k) => k.domains.includes(domain)),
}));
