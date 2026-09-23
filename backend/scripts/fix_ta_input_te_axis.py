"""One-shot: give the Sacher TA's ``intercept_in`` the chip's TE axis.

Found 2026-09-23, once BeamScope's TA readout started rendering (wave 3b):
the seed arriving at ``TAPERED_AMPLIFIER0`` couples **1.0e-5** of its power,
so the TA amplifies nothing (forward output 0.008 mW = ASE only) while the
real bench amplifies happily.

Cause — one anchor axis doing two jobs, set for the wrong one:

* ``ta_seed_coupling`` (``anchor_ops/misc_ops.py``) takes ``axisY`` as the
  **TE gain axis**: only ``|E·axisY|²`` is amplified.
* ``mode_match`` takes the same ``axisY`` as the **Mode X reference**
  (docs/introduce/mode-matching.md), and the 2026-09-02 input-mode fit was
  recorded with Mode X = the *vertical* (fast) axis.

So ``intercept_in`` was authored ``axisY = body +z`` (vertical = fast axis).
That is right for the mode labelling and wrong for polarization: the seed on
the live bench is horizontal, i.e. 89.8° off the declared gain axis.

The same asset's ``intercept_out`` already uses the other, self-consistent
convention: ``axisY = body +y`` is horizontal for a beam leaving along +x
(TE, in the junction plane), and ``outputSpatialModeX`` (229.6 µm) is the
horizontal mode while ``outputSpatialModeY`` (3.96 µm) is the vertical one.
Both ports sit on one chip, so the input anchor was simply the odd one out;
``toptica_boosta_pro`` likewise shares one ``axisY`` across both anchors.

This script makes the input match the output:

* ``intercept_in.axisY`` = body **−x** — horizontal, in the junction plane
  that contains both ports' propagation directions (+y in, +x out). Sign
  chosen so ``axisZ = axisX × axisY = (+y) × (−x) = +z`` stays vertical.
* ``inputSpatialModeX`` ⇄ ``inputSpatialModeY``, so each block stays on its
  physical axis: Mode X (= axisY) horizontal 440.98 µm @ 1283 mm, Mode Y
  (= axisZ) vertical 80.52 µm @ 266.5 mm. The FIT is unchanged — only its
  labels follow the axes.

Everything else — the other anchor, every other param — is sent back exactly
as read. The device template (``devices.sacher_tec400_852nm_ta``) gets the
same axisY, or the next "seed anchors from device" would undo the fix.

Both rows are unlocked, so no unlock dance is needed. Expected effect on the
live scene: polarization overlap 1.0e-5 → ~1.0, coupled seed 2.6e-5 mW →
~2.5 mW (11.9 mW × the mode overlap), and the TA's forward output stops
being ASE-only. ``etaMode`` may also move: it was comparing the seed against
a target whose axes were swapped.

Usage (backend must be up on :8010):
    python backend/scripts/fix_ta_input_te_axis.py            # dry run
    python backend/scripts/fix_ta_input_te_axis.py --apply
"""

from __future__ import annotations

import json
import sys
import urllib.request

BASE = "http://127.0.0.1:8010"
SLUG = "sacher_tec400_852nm_ta"
NEW_AXIS_Y = {"x": -1.0, "y": 0.0, "z": 0.0}
NEW_AXIS_Z = {"x": 0.0, "y": 0.0, "z": 1.0}


def call(method: str, path: str, body=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=180) as response:
        return json.loads(response.read())


def ta_seed_coupling() -> dict | None:
    """What the tracer reports for the seed at the TA right now."""
    trace = call("POST", "/api/v3/solver/run-from-db", {})
    for segment in trace.get("labSegments") or []:
        if segment.get("taSeedCoupling"):
            return segment["taSeedCoupling"]
    return None


def main() -> int:
    apply = "--apply" in sys.argv

    asset = next(a for a in call("GET", "/api/v3/assets3d") if a["catalogId"] == SLUG)
    device = next(d for d in call("GET", "/api/devices") if d["slug"] == SLUG)
    for row, what in ((asset, "asset"), (device, "device")):
        if row.get("locked"):
            print(f"{what} {SLUG} is locked — a human must unlock it first; nothing written.")
            return 1

    anchors = json.loads(json.dumps(asset["anchors"]))
    anchor = next(a for a in anchors if a["id"] == "intercept_in")
    if anchor["axisYBodyLocal"] == NEW_AXIS_Y:
        print("already fixed — nothing to do.")
        return 0
    print(f"asset  intercept_in axisY {anchor['axisYBodyLocal']} -> {NEW_AXIS_Y}")
    print(f"       intercept_in axisZ {anchor['axisZBodyLocal']} -> {NEW_AXIS_Z}")
    anchor["axisYBodyLocal"], anchor["axisZBodyLocal"] = NEW_AXIS_Y, NEW_AXIS_Z

    params = json.loads(json.dumps(asset["defaultParams"]))
    params["inputSpatialModeX"], params["inputSpatialModeY"] = (
        params["inputSpatialModeY"], params["inputSpatialModeX"],
    )
    print(f"       inputSpatialModeX -> {params['inputSpatialModeX']}  (horizontal, = axisY)")
    print(f"       inputSpatialModeY -> {params['inputSpatialModeY']}  (vertical, = axisZ)")

    dev_anchors = json.loads(json.dumps(device["anchors"]))
    dev_anchor = next(a for a in dev_anchors if a["role"] == "intercept_in")
    print(f"device intercept_in axisYBodyLocal {dev_anchor.get('axisYBodyLocal')} -> {NEW_AXIS_Y}")
    dev_anchor["axisYBodyLocal"] = NEW_AXIS_Y

    before = ta_seed_coupling()
    if before:
        print(f"\nnow:   pol {before['polarizationOverlap']:.3e} x mode {before['etaMode']:.4f} "
              f"-> coupled {before['coupledPowerMw']:.3e} mW of {before['seedPowerMw']:.4f} mW")

    if not apply:
        print("\ndry run — pass --apply to write")
        return 0

    call("PUT", f"/api/v3/assets3d/{SLUG}", {"anchors": anchors, "defaultParams": params})
    call("PATCH", f"/api/devices/{SLUG}", {"anchors": dev_anchors})

    check = next(a for a in call("GET", "/api/v3/assets3d") if a["catalogId"] == SLUG)
    got = next(a for a in check["anchors"] if a["id"] == "intercept_in")
    out_before = next(a for a in asset["anchors"] if a["id"] == "intercept_out")
    out_after = next(a for a in check["anchors"] if a["id"] == "intercept_out")
    print("\nwritten. readback:")
    print(f"  axisY {got['axisYBodyLocal']}  axisZ {got['axisZBodyLocal']}")
    print(f"  modeX {check['defaultParams']['inputSpatialModeX']}")
    print(f"  modeY {check['defaultParams']['inputSpatialModeY']}")
    print(f"  intercept_out untouched: {out_before == out_after}")

    after = ta_seed_coupling()
    if after:
        print(f"  pol {after['polarizationOverlap']:.4f} x mode {after['etaMode']:.4f} "
              f"-> coupled {after['coupledPowerMw']:.4f} mW of {after['seedPowerMw']:.4f} mW")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
