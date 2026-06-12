"""Connector mating compatibility matrix (plan 2026-06-12 §4.3).

Pure policy layer mirrored 1:1 by frontend ``utils/connectorCompat.ts``;
both share ``frontend/src/utils/__tests__/connector_compat_cases.json`` so
the two can never drift (same pattern as ``rf_resolve.py`` ↔
``rfPropagation.ts``).

Given the OUT (feeding) and IN (receiving) connector, decide allow / warn /
reject. It does NOT compute physics numbers — the PM key PER penalty and the
MM→SM mode-mismatch loss live in the coupling op (``anchor_ops/fiber.py``).
This only gates link validation + the Align picker.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# PM slow-axis key angle (deg) beyond which a PM↔PM mate is flagged.
PM_KEY_TOLERANCE_DEG = 5.0


@dataclass(frozen=True)
class ConnectorDescriptor:
    domain: str  # "optical" | "rf"
    # RF
    family: str | None = None
    gender: str | None = None
    # Fibre
    polish: str | None = None
    fiber_type: str | None = None
    slow_axis_keyed: bool = False


@dataclass(frozen=True)
class CompatVerdict:
    status: str  # "allow" | "warn" | "reject"
    codes: list[str] = field(default_factory=list)
    messages: list[str] = field(default_factory=list)


def connector_descriptor_from_params(
    kind_id: str, params: dict
) -> ConnectorDescriptor:
    """Build a descriptor from a connector asset's kind + default_params."""
    if kind_id == "rf_cable_connector":
        return ConnectorDescriptor(
            domain="rf",
            family=params.get("family"),
            gender=params.get("gender"),
        )
    # fiber_connector (optical)
    return ConnectorDescriptor(
        domain="optical",
        polish=params.get("polish"),
        fiber_type=params.get("fiberType"),
        slow_axis_keyed=params.get("slowAxisKeyed") is True,
    )


def evaluate_connector_mating(
    out: ConnectorDescriptor,
    inn: ConnectorDescriptor,
    key_angle_deg: float | None = None,
) -> CompatVerdict:
    """Decide whether ``out`` (feeding) can mate into ``inn`` (receiving).

    Directional: MM→SM is a warning, SM→MM is fine.
    """
    if out.domain != inn.domain:
        return CompatVerdict(
            status="reject",
            codes=["domain_mismatch"],
            messages=[
                f"Cannot mate a {out.domain} connector to a {inn.domain} connector."
            ],
        )

    reject: list[str] = []
    warn: list[str] = []
    messages: list[str] = []

    if out.domain == "rf":
        if out.family != inn.family:
            reject.append("rf_family_mismatch")
            messages.append(f"RF family must match ({out.family} vs {inn.family}).")
        if out.gender == inn.gender:
            reject.append("rf_gender_same")
            messages.append(f"RF gender must be opposite (both {out.gender}).")
    else:
        if out.polish != inn.polish:
            reject.append("fiber_polish_mismatch")
            messages.append(
                f"End-face polish must match ({out.polish} vs {inn.polish})."
            )
        if out.fiber_type == "multi_mode" and inn.fiber_type == "single_mode":
            warn.append("fiber_mm_to_sm_loss")
            messages.append(
                "Multi-mode → single-mode: large mode-field mismatch loss."
            )
        if (
            out.fiber_type == "polarization_maintaining"
            and inn.fiber_type == "polarization_maintaining"
            and out.slow_axis_keyed
            and inn.slow_axis_keyed
            and key_angle_deg is not None
            and abs(key_angle_deg) > PM_KEY_TOLERANCE_DEG
        ):
            warn.append("fiber_pm_key_misaligned")
            messages.append(
                f"PM slow-axis keys misaligned by {key_angle_deg}° "
                f"(> {PM_KEY_TOLERANCE_DEG}°); PER degraded."
            )

    status = "reject" if reject else "warn" if warn else "allow"
    return CompatVerdict(status=status, codes=[*reject, *warn], messages=messages)
