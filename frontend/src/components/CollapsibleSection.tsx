import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

const STORAGE_KEY = "qmem.collapsibleSections";

function loadOpenMap(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, boolean>;
    }
    return {};
  } catch {
    return {};
  }
}

function saveOpenMap(map: Record<string, boolean>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

type Props = {
  id: string;
  title: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
};

export function CollapsibleSection({
  id,
  title,
  icon,
  badge,
  defaultOpen = false,
  className,
  children,
}: Props) {
  const [open, setOpen] = useState<boolean>(() => {
    const map = loadOpenMap();
    return id in map ? map[id] : defaultOpen;
  });

  useEffect(() => {
    const map = loadOpenMap();
    map[id] = open;
    saveOpenMap(map);
  }, [id, open]);

  return (
    <section className={`collapsible-section${className ? ` ${className}` : ""}${open ? " open" : ""}`}>
      <button
        type="button"
        className="collapsible-header"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {icon ? <span className="collapsible-icon">{icon}</span> : null}
        <span className="collapsible-title">{title}</span>
        {badge ? <span className="collapsible-badge">{badge}</span> : null}
      </button>
      {open && <div className="collapsible-body">{children}</div>}
    </section>
  );
}
