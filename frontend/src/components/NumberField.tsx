// Expression-aware numeric input. Renders like a normal `<input
// type="number">` but supports the small expression DSL in `utils/exprInput`.
// On blur or Enter, parses the text; if parse succeeds, calls `onChange`
// with the resolved number and rewrites the input to that number.

import { useEffect, useState } from "react";

import { parseExpression, type ExprContext } from "../utils/exprInput";

type Props = {
  value: number;
  onChange: (next: number) => void;
  step?: number;
  disabled?: boolean;
  title?: string;
  /** For "mid(A, B)" — caller injects axis context. */
  midOnAxis?: (nameA: string, nameB: string) => number | null;
  className?: string;
  placeholder?: string;
};

export function NumberField({
  value,
  onChange,
  step,
  disabled,
  title,
  midOnAxis,
  className,
  placeholder,
}: Props) {
  const [text, setText] = useState<string>(String(value));
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = () => {
    const ctx: ExprContext = { current: value, midOnAxis };
    const result = parseExpression(text, ctx);
    if (result === null || !Number.isFinite(result)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (result !== value) onChange(result);
    setText(String(result));
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      disabled={disabled}
      title={title ?? "Numeric value. Supports plain numbers (-30.5, +200), *2, /2, @200, mid(A,B)"}
      step={step}
      value={text}
      placeholder={placeholder}
      className={`${className ?? ""}${invalid ? " number-field-invalid" : ""}`}
      onChange={(e) => {
        setText(e.target.value);
        setInvalid(false);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          setText(String(value));
          setInvalid(false);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
