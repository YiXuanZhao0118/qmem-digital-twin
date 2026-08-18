/** Lock-state filter shared by the ASSET3D list and the BUILD asset pickers.
 *
 *  `Asset3D.locked` marks a row a human reviewed and froze as complete —
 *  the API rejects every edit but unlocking (backend/app/lock_guard.py), so
 *  filtering on it is how you separate "done" rows from the ones still
 *  being authored.
 */
export type LockFilter = "all" | "locked" | "unlocked";

export const LOCK_FILTER_OPTIONS: ReadonlyArray<{ value: LockFilter; label: string }> = [
  { value: "all", label: "lock: all" },
  { value: "locked", label: "lock: 🔒 locked" },
  { value: "unlocked", label: "lock: 🔓 unlocked" },
];

export function matchesLockFilter(locked: boolean | undefined, filter: LockFilter): boolean {
  if (filter === "all") return true;
  return filter === "locked" ? Boolean(locked) : !locked;
}
