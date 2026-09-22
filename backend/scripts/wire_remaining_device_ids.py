"""One-shot: point the last 7 ``assets_3d.device_id`` rows at their devices.

Companion to ``docs/device-id-backfill-questions.md``. The 7 device rows this
script targets were already created (2026-09-08); all that is left is the
asset-side pointer, which needs the unlock -> write -> relock dance because
every one of these assets is ``locked = true``.

The user authorised that dance in the questions doc (Q0 = yes) together with
the per-row answers Q1c / Q3a-d / Q4a that this script encodes. Nothing here
is a guess -- if you are re-reading this later, the provenance for every
value is the corresponding Q section of that doc.

Anchors are ALWAYS sent back explicitly. Setting ``device_id`` alone makes
``update_asset3d_by_catalog_id`` re-materialize anchors from the device
template (``v3_catalog.py`` ~line 566), which would round-trip the stored
tri-axis frame through Gram-Schmidt and drift it. Sending the existing list
suppresses that branch.

Usage (backend must be up on :8010):
    python backend/scripts/wire_remaining_device_ids.py            # dry run
    python backend/scripts/wire_remaining_device_ids.py --apply
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

BASE = "http://localhost:8010"

ASSET_TO_DEVICE = {
    "ch1a_down_step": "ch1a_down",
    "ch1a_up_step": "ch1a_up",
    "er1_step": "er1",
    "er1_5_step": "er1_5",
    "rs2m_step": "rs2m",
    "pda36a_step": "pda36a",
    "30126a9_step": "sm_apc_30126a9",
}

# Fields written alongside deviceId, keyed by the questions-doc answer.
ASSET_EXTRA: dict[str, dict] = {
    # Q1c: er1_step is the only cage/post part still on the "unclassified"
    # placeholder kind; its siblings are all `mechanical`.
    "er1_step": {"kindId": "mechanical"},
    # Q3a 30 dB gain tier / Q3b 50 ohm column / Q3c manufacturer 350-1100 nm.
    # The four spec keys live in default_params; the wavelength range lives in
    # the column, matching rxm15ef_step.
    "pda36a_step": {
        "defaultParams": {
            "bandwidthHz": 785000.0,
            "nepWPerRtHz": 1.7e-12,
            "responsivityAPerW": 0.5,
            "conversionGainVPerW": 11900.0,
        },
        "wavelengthRangeNm": [350.0, 1100.0],
    },
    # Q4 option (a): 30126A9 is an FC/APC single-mode connector, so the
    # PC / 0 deg / 40 dB values currently on the row contradict the part
    # number. Corrected here together with the anchor patch below.
    "30126a9_step": {
        "defaultParams": {
            "na": 0.13,
            "mfdUm": 5.3,
            "polish": "APC",
            "fiberType": "single_mode",
            "returnLossDb": 60,
            "slowAxisKeyed": False,
            "polishAngleDeg": 8,
        },
    },
}

# Edits applied to the asset's EXISTING anchors before they are written back.
ANCHOR_PATCH: dict[str, dict[str, dict]] = {
    "pda36a_step": {"rf_out": {"connectorType": "bnc_female"}},  # Q3d
    "30126a9_step": {"fiber_out": {"connectorType": "fc_apc_male"}},  # Q4a
}


def call(method: str, path: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode(errors="replace")


def main() -> int:
    apply = "--apply" in sys.argv

    status, devices = call("GET", "/api/devices")
    if status != 200:
        print(f"cannot reach backend: {status} {devices}")
        return 1
    slugs = {d["slug"] for d in devices}
    missing = sorted(set(ASSET_TO_DEVICE.values()) - slugs)
    if missing:
        print(f"device rows missing, create them first: {missing}")
        return 1

    for catalog_id, slug in ASSET_TO_DEVICE.items():
        status, row = call("GET", f"/api/v3/assets3d/{catalog_id}")
        if status != 200:
            print(f"{catalog_id}: GET -> {status} {row}")
            return 1
        if row["deviceId"] == slug:
            print(f"  {catalog_id:20s} already points at {slug}, skip")
            continue

        anchors = json.loads(json.dumps(row["anchors"]))
        for anchor_id, patch in ANCHOR_PATCH.get(catalog_id, {}).items():
            for anchor in anchors:
                if anchor["id"] == anchor_id:
                    anchor.update(patch)

        payload = {"deviceId": slug, "anchors": anchors}
        payload.update(ASSET_EXTRA.get(catalog_id, {}))

        if not apply:
            print(f"  {catalog_id:20s} -> {slug}  (locked={row['locked']})")
            continue

        was_locked = row["locked"]
        if was_locked:
            status, body = call(
                "PUT", f"/api/v3/assets3d/{catalog_id}", {"locked": False}
            )
            if status != 200:
                print(f"{catalog_id}: unlock -> {status} {body}")
                return 1

        status, body = call("PUT", f"/api/v3/assets3d/{catalog_id}", payload)
        if status != 200:
            # Leave the row unlocked rather than relocking a half-written row:
            # a stray unlocked asset is visible in the PHY Editor, a relocked
            # wrong one is not.
            print(f"{catalog_id}: write -> {status} {body}")
            return 1

        if was_locked:
            status, body = call(
                "PUT", f"/api/v3/assets3d/{catalog_id}", {"locked": True}
            )
            if status != 200:
                print(f"{catalog_id}: RELOCK FAILED -> {status} {body}")
                return 1
        print(f"  {catalog_id:20s} -> {slug}  ok")

    if not apply:
        print("dry run; pass --apply to write")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
