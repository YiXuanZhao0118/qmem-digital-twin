/**
 * Top-bar "說明" button. Owns its own open state so it can be dropped into
 * both the Lab top bar (`workspace/TopBar.tsx`) and the PHY Editor's own top
 * bar (`PhyEditor.tsx`) without threading state through the store.
 */
import { HelpCircle } from "lucide-react";
import { useState } from "react";

import { HelpModal } from "./HelpModal";

export function HelpButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`icon-button${open ? " active" : ""}`}
        title="Help — how to use the app and how it's built"
        aria-label="Help"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <HelpCircle size={18} />
      </button>
      {open && <HelpModal onClose={() => setOpen(false)} />}
    </>
  );
}
