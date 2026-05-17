/**
 * Full-width fixed top bar.
 *
 * Holds the project logo on the left, the existing SceneToolbar in the middle
 * (unchanged), and a Window menu on the right that lets users re-show panels
 * they closed and reset the layout.
 */
import { LayoutGrid, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ModuleSwitcher } from "./ModuleSwitcher";
import { ProjectLogo } from "./ProjectLogo";
import { useWorkspace, type PanelId } from "./WorkspaceProvider";

// Same feature flag as App.tsx — the AI Binding panel only appears in
// the Window menu when VITE_ENABLE_AI_PANEL is on. Off by default so
// users can't toggle a panel whose mount is feature-gated.
const _viteEnv =
  ((import.meta as unknown) as { env?: Record<string, string> }).env ?? {};
const AI_PANEL_ENABLED = _viteEnv.VITE_ENABLE_AI_PANEL === "true";

type TopBarProps = {
  children?: React.ReactNode; // SceneToolbar gets injected here
};

export function TopBar({ children }: TopBarProps) {
  const { layouts, panelIds, panelTitles, togglePanelVisible, focusPanel, resetLayout } =
    useWorkspace();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [menuOpen]);

  const showPanel = (id: PanelId) => {
    togglePanelVisible(id, true);
    focusPanel(id);
    setMenuOpen(false);
  };

  return (
    <header className="top-bar">
      <div className="top-bar-brand">
        <ProjectLogo />
      </div>
      <ModuleSwitcher />
      <div className="top-bar-toolbar">{children}</div>
      <div className="top-bar-menu" ref={menuRef}>
        <button
          type="button"
          className="icon-button"
          title="Window menu"
          aria-label="Window menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <LayoutGrid size={18} />
        </button>
        {menuOpen && (
          <div className="window-menu" role="menu">
            <div className="window-menu-section">Windows</div>
            {panelIds
              .filter(
                (id) =>
                  id !== "touch-coincidence" &&
                  id !== "beam-scope" &&
                  (id !== "ai-binding" || AI_PANEL_ENABLED),
              )
              .map((id) => {
              const layout = layouts[id];
              return (
                <button
                  key={id}
                  type="button"
                  className={`window-menu-item${layout.visible ? " active" : ""}`}
                  role="menuitemcheckbox"
                  aria-checked={layout.visible}
                  onClick={() => {
                    if (layout.visible) {
                      focusPanel(id);
                      setMenuOpen(false);
                    } else {
                      showPanel(id);
                    }
                  }}
                >
                  <span className="window-menu-check">{layout.visible ? "✓" : ""}</span>
                  <span>{panelTitles[id]}</span>
                </button>
              );
            })}
            <div className="window-menu-divider" />
            <button
              type="button"
              className="window-menu-item"
              role="menuitem"
              onClick={() => {
                resetLayout();
                setMenuOpen(false);
              }}
            >
              <span className="window-menu-check">
                <RotateCcw size={12} />
              </span>
              <span>Reset layout</span>
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
