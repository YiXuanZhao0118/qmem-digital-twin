"""One-shot audit: are all 8 ElementKind tables aligned?

Diff source-of-truth (digitalTwin.ts ElementKind union) against:
 - KIND_REGISTRY keys
 - COMPONENT_TYPE_TO_KIND values
 - KIND_LABELS keys
 - DEFAULT_KIND_PARAMS keys
 - KIND_GROUPS members
 - RF_DOMAIN_KINDS members
 - backend OPTICAL_COMPONENT_TYPE_TO_KIND values

Output is a report; no files modified. Run before P2 refactor to
quantify the drift this refactor is supposed to eliminate.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load(p: str) -> str:
    return (ROOT / p).read_text(encoding="utf-8")


# 1. ElementKind union (the canonical source)
dt = load("frontend/src/types/digitalTwin.ts")
m = re.search(r"export type ElementKind\s*=([^;]+);", dt, re.S)
assert m, "ElementKind union not found"
union = set(re.findall(r'"([a-z_]+)"', m.group(1)))

# 2. KIND_REGISTRY keys
reg = load("frontend/src/kinds/_registry.ts")
registry_keys = set(re.findall(r"^  ([a-z_]+):\s*\{", reg, re.M))

# 3-7. elementDefaults tables
ed = load("frontend/src/utils/elementDefaults.ts")
c2k = re.search(r"COMPONENT_TYPE_TO_KIND[^{]*\{([^}]+)\}", ed, re.S).group(1)
c2k_values = set(re.findall(r':\s*"([a-z_]+)"', c2k))

labels_m = re.search(r"KIND_LABELS[^{]*\{([^}]+)\}", ed, re.S)
labels = set(re.findall(r'^\s*([a-z_]+):\s*"', labels_m.group(1), re.M))

# DEFAULT_KIND_PARAMS is multi-line — match until balanced closing
params_m = re.search(r"DEFAULT_KIND_PARAMS[^=]*=\s*\{(.+?)\n\};", ed, re.S)
params = set(re.findall(r"^  ([a-z_]+):\s*\{", params_m.group(1), re.M))

groups_m = re.search(r"KIND_GROUPS[^=]*=\s*\[(.+?)\];", ed, re.S)
groups_kinds = set(re.findall(r'"([a-z_]+)"', groups_m.group(1)))

rf_m = re.search(r"RF_DOMAIN_KINDS[^=]*=\s*new Set[^(]*\(\[([^\]]+)\]", ed)
rf_kinds = set(re.findall(r'"([a-z_]+)"', rf_m.group(1)))

# 8. backend
be = load("backend/app/routers/components.py")
be_m = re.search(r"OPTICAL_COMPONENT_TYPE_TO_KIND[^{]*\{(.+?)\n\}", be, re.S)
be_values = set(re.findall(r':\s*"([a-z_]+)"', be_m.group(1)))

print("=" * 64)
print(f"REFERENCE: ElementKind union has {len(union)} kinds")
print("=" * 64)


def report(name: str, s: set[str], reference: set[str] = union) -> None:
    missing = reference - s
    extra = s - reference
    status = "OK" if not (missing or extra) else "DRIFT"
    print(f"\n[{status}] {name}  ({len(s)} entries)")
    if missing:
        print(f"    MISSING : {sorted(missing)}")
    if extra:
        print(f"    EXTRA   : {sorted(extra)}")


report("KIND_REGISTRY (kinds/_registry.ts)", registry_keys)
report("COMPONENT_TYPE_TO_KIND values (elementDefaults.ts)", c2k_values)
report("KIND_LABELS keys (elementDefaults.ts)", labels)
report("DEFAULT_KIND_PARAMS keys (elementDefaults.ts)", params)
report("KIND_GROUPS members (elementDefaults.ts)", groups_kinds)
report("backend OPTICAL_COMPONENT_TYPE_TO_KIND values", be_values)

print(f"\nRF_DOMAIN_KINDS ({len(rf_kinds)} entries) — subset check:")
print(f"    All members in union: {rf_kinds.issubset(union)}")
if not rf_kinds.issubset(union):
    print(f"    Invalid members: {sorted(rf_kinds - union)}")

# Cross-check: backend vs frontend componentType-to-kind map
print("\nbackend vs frontend componentType-to-kind map:")
ck = re.search(r"COMPONENT_TYPE_TO_KIND[^{]*\{([^}]+)\}", ed, re.S).group(1)
fe_ct_keys = set(re.findall(r'^\s*([a-z_]+):\s*"', ck, re.M))
be_ct_keys = set(re.findall(r'^\s*"([a-z_]+)":\s*"', be_m.group(1), re.M))
fe_only = fe_ct_keys - be_ct_keys
be_only = be_ct_keys - fe_ct_keys
if fe_only:
    print(f"    componentType in frontend only: {sorted(fe_only)}")
if be_only:
    print(f"    componentType in backend only:  {sorted(be_only)}")
if not fe_only and not be_only:
    print("    componentType keys match on both sides")
