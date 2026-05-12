/**
 * SPICE netlist editor — Phase B.5.
 *
 * Wraps ``@monaco-editor/react`` with a small custom language registration
 * that gives SPICE netlists the usual editor affordances (line numbers,
 * find/replace, brace matching) plus simple syntax highlighting for:
 *
 *   - line comments starting with ``*`` or ``;``
 *   - dot-directives (``.AC``, ``.DC``, ``.TRAN``, ``.END``, ``.control``,
 *     ``.endc``, ``.options``, ``.model``, ``.subckt``, ``.ends``, etc.)
 *   - component prefixes at the start of a line (V/I source, R/L/C
 *     passive, D/Q/M/J semiconductor, X subckt instance, K coupling).
 *   - SPICE engineering-suffix numbers (1m, 1u, 1k, 4.7n, 1e-9, etc.).
 *
 * Replaces the plain ``<textarea>`` shipped in Phase B.4. Behaviour is
 * functionally equivalent: ``value`` / ``onChange`` mirror the textarea
 * props so the host component (ElectronicsWorkspace) needs no changes
 * beyond swapping the element.
 */
import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import { useRef } from "react";

const LANGUAGE_ID = "spice-netlist";

// Module-level guard — Monaco's language registry is global so we must
// only register the tokenizer once across mounts/HMR reloads.
let languageRegistered = false;

function registerSpiceLanguage(monaco: Monaco): void {
  if (languageRegistered) return;
  languageRegistered = true;

  monaco.languages.register({ id: LANGUAGE_ID });

  monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, {
    defaultToken: "",
    ignoreCase: true,
    tokenizer: {
      root: [
        // Line comments. SPICE allows '*' only at column 0; ';' anywhere.
        [/^\*.*$/, "comment"],
        [/;.*$/, "comment"],

        // Dot directives ('.ac', '.tran', '.control' ... '.endc', '.end').
        [/^\s*\.[a-zA-Z]+\b/, "keyword"],
        [/\.[a-zA-Z]+\b/, "keyword"],

        // Component instance prefix at line start (V1, R_load, etc.).
        // Letters that name a passive/active SPICE element.
        [/^[VIRLCBDEFGHJKLMNQRSTUVWXYZ][\w]*/i, "type.identifier"],

        // Engineering-suffix numbers: 1.5m, 4.7n, 1u, 100k, 1e6, 2.5e-9
        [/[+-]?\d+(\.\d+)?([eE][+-]?\d+)?(meg|t|g|m|u|n|p|f|k)?\b/, "number"],

        // Quoted strings inside .control blocks.
        [/"[^"]*"/, "string"],

        // Whitespace + everything else falls through as default.
        [/\s+/, "white"],
      ],
    },
  });

  monaco.languages.setLanguageConfiguration(LANGUAGE_ID, {
    comments: {
      lineComment: "*",
    },
    brackets: [
      ["(", ")"],
      ["[", "]"],
      ["{", "}"],
    ],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: "{", close: "}" },
      { open: '"', close: '"' },
    ],
  });
}

type Props = {
  value: string;
  onChange: (next: string) => void;
};

export function NetlistEditor({ value, onChange }: Props) {
  const editorRef = useRef<unknown>(null);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    registerSpiceLanguage(monaco);
    // Re-tag the model so the just-registered tokenizer applies.
    const model = editor.getModel();
    if (model) {
      monaco.editor.setModelLanguage(model, LANGUAGE_ID);
    }
  };

  return (
    <Editor
      language={LANGUAGE_ID}
      value={value}
      onChange={(next) => onChange(next ?? "")}
      onMount={handleMount}
      theme="vs"
      options={{
        fontSize: 12.5,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        lineNumbers: "on",
        minimap: { enabled: false },
        wordWrap: "off",
        scrollBeyondLastLine: false,
        renderWhitespace: "selection",
        tabSize: 4,
        insertSpaces: true,
        automaticLayout: true,
      }}
    />
  );
}
