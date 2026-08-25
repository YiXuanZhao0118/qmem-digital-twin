/**
 * The `docs/introduce/` architecture docs, bundled into the app.
 *
 * CLAUDE.md makes those files the authoritative map of the system, so the Help
 * modal renders them verbatim rather than keeping a second, hand-copied version
 * in the UI — the in-app architecture docs then cannot drift from the repo's.
 *
 * They live OUTSIDE the Vite root (`frontend/`), so the dev server needs
 * `server.fs.allow` widened to the repo root — see `frontend/vite.config.ts`.
 */

const RAW_DOCS = import.meta.glob(
  // `docs/*.md` are the standalone topic docs the index links out to
  // (objectives, bench-dataset, …) — bundling them too keeps those links live.
  ["../../../../docs/introduce/*.md", "../../../../docs/*.md"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

export type HelpDoc = {
  /** File name, e.g. "optics.md". Doubles as the id in-doc links resolve to. */
  file: string;
  /** First `# ` heading, or the file name when a doc has none. */
  title: string;
  body: string;
};

export type HelpDocGroup = { label: string; docs: HelpDoc[] };

/** Reading order, mirroring the grouping in `docs/introduce/README.md`. */
const GROUP_ORDER: { label: string; files: string[] }[] = [
  { label: "Start here", files: ["README.md", "overview.md"] },
  {
    label: "Data model",
    files: ["data-model.md", "asset.md", "build.md", "component.md", "object.md", "anchors.md"],
  },
  { label: "Rendering & optics", files: ["rendering.md", "kinds.md", "optics.md", "fiber.md"] },
  {
    label: "Multiphysics & time",
    files: [
      "multiphysics.md", "timing.md", "rf.md", "cable.md",
      "placement.md", "mirror-coupling.md",
    ],
  },
  {
    label: "Ops & reference",
    files: ["api.md", "runbook.md", "migrations.md", "known-issues.md", "todo.md"],
  },
  {
    label: "Topic papers",
    files: [
      "objectives.md",
      "bench-dataset.md",
      "float64-audit.md",
      "aom-model.md",
      "object-sense-kinds.md",
    ],
  },
];

function titleOf(body: string, file: string): string {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : file;
}

const BY_FILE = new Map<string, HelpDoc>();
for (const [path, body] of Object.entries(RAW_DOCS)) {
  const file = path.slice(path.lastIndexOf("/") + 1);
  BY_FILE.set(file, { file, title: titleOf(body, file), body });
}

/** Grouped nav model. A doc that isn't in GROUP_ORDER still shows up (under
 *  "More") so adding a file to `docs/introduce/` never silently drops it. */
export const HELP_DOC_GROUPS: HelpDocGroup[] = (() => {
  const listed = new Set(GROUP_ORDER.flatMap((g) => g.files));
  const groups: HelpDocGroup[] = GROUP_ORDER.map((group) => ({
    label: group.label,
    docs: group.files.map((file) => BY_FILE.get(file)).filter((d): d is HelpDoc => Boolean(d)),
  })).filter((group) => group.docs.length > 0);

  const rest = [...BY_FILE.values()]
    .filter((doc) => !listed.has(doc.file))
    .sort((a, b) => a.file.localeCompare(b.file));
  if (rest.length > 0) groups.push({ label: "More", docs: rest });
  return groups;
})();

export function getHelpDoc(file: string): HelpDoc | undefined {
  return BY_FILE.get(file);
}
