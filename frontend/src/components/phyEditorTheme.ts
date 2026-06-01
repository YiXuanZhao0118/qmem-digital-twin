/**
 * Shared design tokens for the three PHY Editor sub-editors
 * (KindsEditor / Asset3DEditor / ComponentsEditor). One source of
 * truth so they look like one editor with three tabs, not three
 * editors. Baseline = Asset3DEditor.
 */
import type { CSSProperties } from "react";

// Shell
export const ASIDE_WIDTH = 280;
export const SHELL_BG = "#fbfbf8";
export const SHELL_COLOR = "#1f2937";
export const ASIDE_PADDING = 8;
export const MAIN_PADDING = 12;
export const BORDER_LIGHT = "#e9ece9";
export const BORDER_STRONG = "#d8ded8";

// Semantic colors
export const SELECTED = "#4ec9b0";
export const PRIMARY_BG = "#fde68a";
export const PRIMARY_BORDER = "#ca8a04";
export const SUCCESS_BG = "#f0fdf4";
export const SUCCESS_BORDER = "#16a34a";
export const ERROR_BG = "#fecaca";
export const ERROR_TEXT = "#7f1d1d";
export const MUTED = "#6b7280";

export const SECTION_LABEL: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: MUTED,
  marginTop: 12,
  marginBottom: 6,
};

export const TABLE: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontFamily: "ui-monospace, monospace",
  fontSize: 11,
};

export const TH: CSSProperties = {
  textAlign: "left",
  padding: "4px 6px",
  borderBottom: `1px solid ${BORDER_STRONG}`,
  color: MUTED,
  fontWeight: 600,
};

export const TD: CSSProperties = {
  padding: "4px 6px",
  borderBottom: `1px solid ${BORDER_LIGHT}`,
  fontFamily: "ui-monospace, monospace",
  fontSize: 11,
  color: SHELL_COLOR,
  verticalAlign: "top",
};

export const INPUT: CSSProperties = {
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  background: "#ffffff",
  color: SHELL_COLOR,
  border: `1px solid ${BORDER_STRONG}`,
  padding: "4px 5px",
  fontFamily: "ui-monospace, monospace",
  fontSize: 11,
};

export const TEXTAREA: CSSProperties = {
  ...INPUT,
  resize: "vertical",
  minHeight: 54,
  lineHeight: 1.35,
};

/** Muted, non-interactive variant of {@link INPUT}. Used in the PHY
 *  Editor anchor table for fields a given anchor kind doesn't use
 *  (e.g. axisY / aperture on an RF port, connector on an optical port)
 *  so the cell reads as "not applicable" rather than empty-but-editable. */
export const INPUT_DISABLED: CSSProperties = {
  ...INPUT,
  background: "#f1f2ef",
  color: "#9aa0a6",
  cursor: "not-allowed",
};

export const ICON_BUTTON: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  border: `1px solid ${BORDER_STRONG}`,
  background: "#ffffff",
  color: SHELL_COLOR,
  cursor: "pointer",
};

// "+ New X" amber button used by all three editors for primary
// create actions. Default is inline-sized; aside usage adds
// `{ width: "100%", marginBottom: 6 }` inline.
export const PRIMARY_BUTTON: CSSProperties = {
  padding: "4px 8px",
  fontSize: 11,
  border: `1px solid ${PRIMARY_BORDER}`,
  background: PRIMARY_BG,
  color: SHELL_COLOR,
  cursor: "pointer",
  fontWeight: 600,
};

// Aside item (list row) — selected gets teal border + cream highlight,
// unselected stays transparent so the aside reads as a flat list.
export const ASIDE_ITEM_BASE: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "6px 8px",
  marginBottom: 3,
  color: SHELL_COLOR,
  cursor: "pointer",
  fontFamily: "ui-monospace, monospace",
  fontSize: 11,
};

export const asideItemStyle = (selected: boolean): CSSProperties => ({
  ...ASIDE_ITEM_BASE,
  background: selected ? "#f3f4f1" : "transparent",
  border: `1px solid ${selected ? SELECTED : "transparent"}`,
});

export const ERROR_BANNER: CSSProperties = {
  background: ERROR_BG,
  color: ERROR_TEXT,
  padding: 8,
  marginBottom: 12,
  fontSize: 12,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

// Shell wrapper — the editor's root <div>. 280px aside grid track +
// flex main, with the cream BG and the dark text color. Each editor
// composes its own aside <aside> and main <main> inside this.
export const SHELL_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: `${ASIDE_WIDTH}px minmax(0, 1fr)`,
  height: "100%",
  minHeight: 0,
  background: SHELL_BG,
  color: SHELL_COLOR,
};

export const ASIDE_STYLE: CSSProperties = {
  borderRight: `1px solid ${BORDER_LIGHT}`,
  padding: ASIDE_PADDING,
  overflowY: "auto",
  minHeight: 0,
};

export const MAIN_STYLE: CSSProperties = {
  overflow: "hidden",
  display: "grid",
  gridTemplateRows: "auto minmax(0, 1fr)",
  minHeight: 0,
  minWidth: 0,
};

// Header bar above the main body — used by Asset3DEditor for the
// selected asset's name + Edit/Save/Delete icons. Shared so KindsEditor
// can adopt the same look.
export const MAIN_HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "8px 12px",
  borderBottom: `1px solid ${BORDER_LIGHT}`,
  background: "#ffffff",
};

export const MAIN_BODY_STYLE: CSSProperties = {
  overflowY: "auto",
  padding: MAIN_PADDING,
  minHeight: 0,
};
