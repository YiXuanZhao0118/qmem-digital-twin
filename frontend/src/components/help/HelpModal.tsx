/**
 * Full-screen Help overlay — "how do I use this" + "how is this built".
 *
 * Two halves, one renderer:
 *   - 使用指南 — hand-written operating instructions (`usageGuide.ts`).
 *   - 架構文件 — the repo's own `docs/introduce/*.md`, bundled verbatim
 *     (`helpDocs.ts`), so the in-app architecture docs can't drift.
 *
 * Portaled to <body>: `.top-bar-toolbar` clips overflow (same reason the
 * initial-setup popover portals), and the overlay must cover the viewer.
 */
import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { HELP_DOC_GROUPS, getHelpDoc } from "./helpDocs";
import { USAGE_PAGES } from "./usageGuide";

/** Nav key: `usage:<page id>` or `doc:<file name>`. */
type PageKey = string;

const FIRST_PAGE: PageKey = `usage:${USAGE_PAGES[0].id}`;

function bodyFor(key: PageKey): string {
  if (key.startsWith("usage:")) {
    const id = key.slice("usage:".length);
    return USAGE_PAGES.find((p) => p.id === id)?.body ?? "";
  }
  return getHelpDoc(key.slice("doc:".length))?.body ?? "";
}

export function HelpModal({ onClose }: { onClose: () => void }) {
  const [page, setPage] = useState<PageKey>(FIRST_PAGE);
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    // Capture phase so Escape closes the modal instead of reaching the
    // global scene handler (which un-hides every hidden object).
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Every page starts at the top, not at the previous page's scroll offset.
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [page]);

  const components = useMemo<Components>(
    () => ({
      a({ href, children }) {
        const target = href ?? "";
        if (/^https?:/i.test(target)) {
          return (
            <a href={target} target="_blank" rel="noreferrer">
              {children}
            </a>
          );
        }
        if (target.startsWith("#")) return <a href={target}>{children}</a>;
        // Doc-internal link ([anchors.md](anchors.md), [← 文件索引](README.md)):
        // navigate inside the modal instead of leaving the app.
        const file = target.split("/").pop() ?? "";
        if (getHelpDoc(file)) {
          return (
            <button
              type="button"
              className="help-inline-link"
              onClick={() => setPage(`doc:${file}`)}
            >
              {children}
            </button>
          );
        }
        // Anything else the docs point at (source files, ../objectives.md, …)
        // isn't bundled — show the path instead of a dead link.
        return (
          <code className="help-dead-link" title={target}>
            {children}
          </code>
        );
      },
    }),
    [],
  );

  return createPortal(
    <div
      className="help-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="help-modal" role="dialog" aria-modal="true" aria-label="Help">
        <header className="help-modal-header">
          <strong>Help</strong>
          <span className="help-modal-subtitle">How to use the app · System architecture</span>
          <button
            type="button"
            className="icon-button"
            title="Close (Esc)"
            aria-label="Close help"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>

        <div className="help-modal-body">
          <nav className="help-modal-nav" aria-label="Help contents">
            <div className="help-nav-section">User guide</div>
            {USAGE_PAGES.map((usagePage) => {
              const key = `usage:${usagePage.id}`;
              return (
                <button
                  key={key}
                  type="button"
                  className={`help-nav-item${page === key ? " is-active" : ""}`}
                  onClick={() => setPage(key)}
                >
                  {usagePage.title}
                </button>
              );
            })}

            {HELP_DOC_GROUPS.map((group) => (
              <div key={group.label}>
                <div className="help-nav-section">Architecture · {group.label}</div>
                {group.docs.map((doc) => {
                  const key = `doc:${doc.file}`;
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`help-nav-item${page === key ? " is-active" : ""}`}
                      title={doc.file}
                      onClick={() => setPage(key)}
                    >
                      {doc.title}
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>

          <div className="help-modal-content" ref={contentRef}>
            <article className="help-doc">
              <Markdown remarkPlugins={[remarkGfm]} components={components}>
                {bodyFor(page)}
              </Markdown>
            </article>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
