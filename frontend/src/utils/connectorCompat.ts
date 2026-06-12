/**
 * Connector mating compatibility matrix (plan 2026-06-12 §4.3).
 *
 * Pure policy layer: given the OUT (feeding) and IN (receiving) connector,
 * decide whether the mate is allowed / allowed-with-warning / rejected.
 * It does NOT compute physics numbers — the PM key PER penalty and the
 * MM→SM mode-mismatch loss live in the coupling op (fiber.py). This module
 * only gates (link validation + Align picker filtering).
 *
 * Mirrored 1:1 by backend `app/optical/connector_compat.py`; the two share
 * `__tests__/connector_compat_cases.json` so they can never drift (same
 * pattern as rfPropagation.ts ↔ rf_resolve.py).
 */

/** PM slow-axis key angle (deg) beyond which a PM↔PM mate is flagged. */
export const PM_KEY_TOLERANCE_DEG = 5.0;

export type ConnectorDomain = "optical" | "rf";

/** Minimal descriptor for a connector, built from its asset default_params
 *  + kind. Only the fields the matrix needs. */
export interface ConnectorDescriptor {
  domain: ConnectorDomain;
  // RF
  family?: string; // "sma" | "bnc"
  gender?: string; // "male" | "female"
  // Fibre
  polish?: string; // "PC" | "APC" | "UPC"
  fiberType?: string; // "single_mode" | "multi_mode" | "polarization_maintaining"
  slowAxisKeyed?: boolean;
}

export type CompatStatus = "allow" | "warn" | "reject";

export interface CompatVerdict {
  status: CompatStatus;
  /** Machine-readable codes (stable; tested). */
  codes: string[];
  /** Human-readable messages (UI nicety; not part of the parity contract). */
  messages: string[];
}

export interface MateOptions {
  /** PM slow-axis angle (deg) between the two ends, if known at call time. */
  keyAngleDeg?: number;
}

/** Build a descriptor from a connector asset's kind + default_params. */
export function connectorDescriptorFromParams(
  kindId: string,
  params: Readonly<Record<string, unknown>>,
): ConnectorDescriptor {
  if (kindId === "rf_cable_connector") {
    return {
      domain: "rf",
      family: typeof params.family === "string" ? params.family : undefined,
      gender: typeof params.gender === "string" ? params.gender : undefined,
    };
  }
  // fiber_connector (optical)
  return {
    domain: "optical",
    polish: typeof params.polish === "string" ? params.polish : undefined,
    fiberType: typeof params.fiberType === "string" ? params.fiberType : undefined,
    slowAxisKeyed: params.slowAxisKeyed === true,
  };
}

/**
 * Decide whether `out` (feeding) can mate into `inn` (receiving).
 * `out`/`inn` are directional: MM→SM is a warning, SM→MM is fine.
 */
export function evaluateConnectorMating(
  out: ConnectorDescriptor,
  inn: ConnectorDescriptor,
  opts: MateOptions = {},
): CompatVerdict {
  const reject: string[] = [];
  const warn: string[] = [];
  const messages: string[] = [];

  if (out.domain !== inn.domain) {
    return {
      status: "reject",
      codes: ["domain_mismatch"],
      messages: [`Cannot mate a ${out.domain} connector to a ${inn.domain} connector.`],
    };
  }

  if (out.domain === "rf") {
    if (out.family !== inn.family) {
      reject.push("rf_family_mismatch");
      messages.push(`RF family must match (${out.family} vs ${inn.family}).`);
    }
    if (out.gender === inn.gender) {
      reject.push("rf_gender_same");
      messages.push(`RF gender must be opposite (both ${out.gender}).`);
    }
  } else {
    // Fibre
    if (out.polish !== inn.polish) {
      reject.push("fiber_polish_mismatch");
      messages.push(`End-face polish must match (${out.polish} vs ${inn.polish}).`);
    }
    if (out.fiberType === "multi_mode" && inn.fiberType === "single_mode") {
      warn.push("fiber_mm_to_sm_loss");
      messages.push("Multi-mode → single-mode: large mode-field mismatch loss.");
    }
    if (
      out.fiberType === "polarization_maintaining" &&
      inn.fiberType === "polarization_maintaining" &&
      out.slowAxisKeyed === true &&
      inn.slowAxisKeyed === true &&
      opts.keyAngleDeg != null &&
      Math.abs(opts.keyAngleDeg) > PM_KEY_TOLERANCE_DEG
    ) {
      warn.push("fiber_pm_key_misaligned");
      messages.push(
        `PM slow-axis keys misaligned by ${opts.keyAngleDeg}° (> ${PM_KEY_TOLERANCE_DEG}°); PER degraded.`,
      );
    }
  }

  const status: CompatStatus = reject.length ? "reject" : warn.length ? "warn" : "allow";
  return { status, codes: [...reject, ...warn], messages };
}
