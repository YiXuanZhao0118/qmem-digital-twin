/**
 * Typed parameter-schema DSL — declares HOW each kind param is edited so ONE
 * generic editor renders every asset's params (number → input, enum → dropdown,
 * list → repeated blocks) instead of per-asset bespoke UI.
 *
 * The schema lives on the behavioral KIND (`physics.paramSchema`); the
 * asset/device supply concrete VALUES, and anchors supply list CARDINALITY
 * (rf_out count → channel-block count). See docs/introduce/data-model.md.
 *
 * Coefficient kinds (per the design): `number` (typed input) and `enum`
 * (dropdown). `boolean` (checkbox) + `record`/`list` (nesting) round out the
 * structures the existing params actually use.
 */

interface ParamSpecBase {
  /** Human label; defaults to the key. */
  readonly label?: string;
  /** Seeds Asset.tunableParams (per-instance adjustable). Top-level only. */
  readonly tunable?: boolean;
}

export interface NumberSpec extends ParamSpecBase {
  readonly type: "number";
  readonly unit?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

export interface EnumSpec extends ParamSpecBase {
  readonly type: "enum";
  readonly options: ReadonlyArray<{ value: string | number; label?: string }>;
}

export interface BoolSpec extends ParamSpecBase {
  readonly type: "boolean";
}

export interface RecordSpec extends ParamSpecBase {
  readonly type: "record";
  readonly fields: Readonly<Record<string, ParamSpec>>;
}

export interface ListSpec extends ParamSpecBase {
  readonly type: "list";
  readonly item: ParamSpec;
  /** Anchor role whose count fixes the list length (rf_out → 4 channels on
   *  ad9959, 2 on dg4202). When set + a count is supplied, the editor renders
   *  exactly that many blocks; otherwise it renders the items in the value. */
  readonly cardinalityFromRole?: string;
  /** Per-item heading, e.g. `(i) => \`CH${i}\``. */
  readonly itemLabel?: (index: number) => string;
}

export type ParamSpec = NumberSpec | EnumSpec | BoolSpec | RecordSpec | ListSpec;

/** Top-level kind param schema: param key → spec. */
export type ParamSchema = Readonly<Record<string, ParamSpec>>;

/** A reasonable empty value for a spec — used to seed new list items / missing
 *  leaves so the editor always has something to render and write. */
export function defaultForSpec(spec: ParamSpec): unknown {
  switch (spec.type) {
    case "number":
      return spec.min ?? 0;
    case "enum":
      return spec.options[0]?.value ?? "";
    case "boolean":
      return false;
    case "record":
      return Object.fromEntries(
        Object.entries(spec.fields).map(([k, s]) => [k, defaultForSpec(s)]),
      );
    case "list":
      return [];
  }
}
