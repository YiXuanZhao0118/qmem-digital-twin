from __future__ import annotations

import asyncio
from pathlib import Path
import sys
from typing import Any

from sqlalchemy import select

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.components.anchor_contracts import COMPONENT_ANCHOR_CONTRACTS  # noqa: E402
from app.db import AsyncSessionLocal  # noqa: E402
from app.models import Asset3D, Component  # noqa: E402


ASSETS: list[dict[str, object]] = [
    {
        # AD9959/PCBZ — official Analog Devices evaluation board, mesh
        # converted from the manufacturer's STEP (Digikey part 967016,
        # https://www.digikey.tw/en/models/967016?tab=mfr) via
        # `_convert_ad9959_stp_to_stl.py` (gmsh STEP→STL at 1.5 mm) +
        # `_decimate_ad9959_stl.py` (12% quadric edge-collapse) +
        # `_finalize_ad9959_stl.py` (re-centre to body-local frame).
        # Final mesh is 10.9 MB / 218k tris with the real PCB dimensions
        # (165.1 × 114.3 × 19.3 mm) — replaces the prior 100 × 80 × 16 mm
        # primitive box placeholder.
        # Name kept as `primitive_dds_ad9959_pcb` so this row upserts in
        # place over the prior primitive — no orphaned DB rows. Content
        # has been promoted from primitive box → real STL mesh.
        #
        # Anchors are NOT inlined here — they are sourced from
        # `app.components.anchor_contracts.COMPONENT_ANCHOR_CONTRACTS["dds_ad9959_pcb"]`
        # which is the single source of truth shared with the frontend.
        # `upsert_asset` looks up the contract via the component_type that
        # references this asset and merges contract identity (id+name) with
        # any user-edited position/direction already in DB.
        "name": "primitive_dds_ad9959_pcb",
        "asset_type": "stl",
        "file_path": "files/stl/ad9959_pcbz.stl",
        "source": "Analog Devices AD9959/PCBZ STEP (gmsh STEP→STL, decimated)",
        "source_url": "https://www.digikey.tw/en/models/967016?tab=mfr",
        "unit": "mm",
        "scale_factor": 1.0,
        "_anchor_contract_key": "dds_ad9959_pcb",
    },
    {
        "name": "primitive_dds_mcu_board",
        "asset_type": "primitive",
        "file_path": "primitive://dds_mcu_board",
        "source": "Custom USB-SPI x5 controller (STM32 / FT2232H)",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "primitive_dds_tcxo_module",
        "asset_type": "primitive",
        "file_path": "primitive://dds_tcxo_module",
        "source": "20 MHz TCXO + 1:5 fanout buffer module",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "primitive_meanwell_irm30_5",
        "asset_type": "primitive",
        "file_path": "primitive://meanwell_irm30",
        "source": "Mean Well IRM-30-5 enclosed AC-DC converter",
        "source_url": "https://www.meanwell.com/Upload/PDF/IRM-30/IRM-30-SPEC.PDF",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "primitive_sma_short_cable_150",
        "asset_type": "primitive",
        "file_path": "primitive://sma_short_cable",
        "source": "Standard 150 mm SMA-M / SMA-M coaxial jumper",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "primitive_sma_bulkhead_jack",
        "asset_type": "primitive",
        "file_path": "primitive://sma_bulkhead_jack",
        "source": "Generic panel-mount SMA female bulkhead (hex 5/16 in)",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "primitive_usb_b_receptacle",
        "asset_type": "primitive",
        "file_path": "primitive://usb_b_receptacle",
        "source": "Generic USB-B 2.0 panel-mount receptacle",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "primitive_iec_c14_inlet",
        "asset_type": "primitive",
        "file_path": "primitive://iec_c14_inlet",
        "source": "Generic IEC 60320 C14 panel-mount inlet",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "primitive_instrument_chassis_1u",
        "asset_type": "primitive",
        "file_path": "primitive://instrument_chassis_1u",
        "source": "Generic 19-inch 1U rack chassis (482.6 x 246 x 44.45 mm)",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "dds_chassis_1u_glb",
        "asset_type": "gltf",
        "file_path": "files/glb/dds_chassis_1u.glb",
        "source": "Project-supplied DDS 1U chassis enclosure (GLB)",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "dds_chassis_1u_full_stl",
        "asset_type": "stl",
        "file_path": "files/stl/dds_chassis_1u_full.stl",
        "source": "Project-supplied DDS 1U chassis full STL",
        "unit": "mm",
        "scale_factor": 1.0,
    },
]


COMPONENTS: list[dict[str, object]] = [
    {
        "name": "dds_ad9959_pcb_module",
        "component_type": "dds_ad9959_pcb",
        "brand": "Analog Devices",
        "model": "AD9959/PCBZ 4-channel DDS evaluation board",
        # Promoted 2026-05-13: the `primitive_dds_ad9959_pcb` asset row
        # was rewritten from a procedural box (100×80×16 mm,
        # `primitive://dds_ad9959_pcb`) into a real STL mesh from the
        # ADI evaluation-board STEP (165.1×114.3×19.3 mm,
        # `files/stl/ad9959_pcbz.stl`). Asset row name kept stable so this
        # component reference still resolves and no DB rows are orphaned.
        # The frontend `createDdsAd9959Pcb` procedural fallback in
        # loadAsset.ts is now only used if the STL fails to load.
        "asset": "primitive_dds_ad9959_pcb",
        "physics_capabilities": ["rf"],
        "properties": {
            "geometry": "stl_mesh",
            "dimensionsMm": [165.1, 114.3, 19.3],
            "channels": 4,
            "outputConnectors": "4 x SMA female (CH-A..CH-D)",
            "controlInterface": "SPI (3.3 V LVCMOS)",
            "powerInputV": [1.8, 3.3, 5.0],
            "referenceClockMHz": 20,
            "maxOutputMHz": 200,
            "datasheetUrl": "https://www.analog.com/media/en/technical-documentation/data-sheets/AD9959.pdf",
            "sourceStep": "AD9959-PCBZ.stp (Digikey part 967016)",
        },
    },
    {
        "name": "dds_mcu_controller_board",
        "component_type": "mcu_board",
        "brand": "QMEM",
        "model": "USB-SPI x5 controller",
        "asset": "primitive_dds_mcu_board",
        "properties": {
            "geometry": "dds_mcu_board",
            "dimensionsMm": [90, 70, 18],
            "hostInterface": "USB 2.0 Full-Speed (USB-B)",
            "spiPorts": 5,
            "mcuOptions": ["STM32F405", "FTDI FT2232H"],
            "logicLevelV": 3.3,
        },
    },
    {
        "name": "dds_tcxo_fanout_module",
        "component_type": "tcxo_module",
        "brand": "QMEM",
        "model": "20 MHz TCXO + 1:5 fanout",
        "asset": "primitive_dds_tcxo_module",
        "properties": {
            "geometry": "dds_tcxo_module",
            "dimensionsMm": [50, 35, 12],
            "frequencyMHz": 20,
            "stabilityPpm": 0.5,
            "outputs": 5,
            "outputLevel": "LVCMOS 3.3 V",
        },
    },
    {
        "name": "dds_chassis_power_supply",
        "component_type": "power_supply_ac_dc",
        "brand": "Mean Well",
        "model": "IRM-30-5",
        "asset": "primitive_meanwell_irm30_5",
        "properties": {
            "geometry": "meanwell_irm30",
            "dimensionsMm": [88, 52.4, 28.8],
            "inputVoltageAcRangeV": [85, 264],
            "outputVoltageDcV": 5,
            "outputCurrentMaxA": 6.0,
            "outputPowerW": 30,
            "datasheetUrl": "https://www.meanwell.com/Upload/PDF/IRM-30/IRM-30-SPEC.PDF",
        },
    },
    # dds_sma_short_jumper_150mm removed 2026-05-13: superseded by
    # thorlabs_ca2906_sma_cable (Thorlabs CA2906, 152 mm, same RG-316
    # SMA-M-SMA-M spec). The archived row + the migrated SceneObject
    # both point at the Thorlabs entry now; this catalog stub is gone
    # so re-running the upsert won't re-create the duplicate.
    {
        "name": "dds_sma_bulkhead_jack",
        "component_type": "sma_jack",
        "brand": "Amphenol RF",
        "model": "132357 (panel-mount SMA-F)",
        "asset": "primitive_sma_bulkhead_jack",
        "properties": {
            "geometry": "sma_bulkhead_jack",
            "impedanceOhm": 50,
            "hexAcrossFlatsMm": 7.94,
            "panelThicknessMaxMm": 2.0,
        },
    },
    {
        "name": "dds_chassis_usb_b_jack",
        "component_type": "usb_b_jack",
        "brand": "Generic",
        "model": "USB-B panel jack",
        "asset": "primitive_usb_b_receptacle",
        "properties": {
            "geometry": "usb_b_receptacle",
            "spec": "USB 2.0",
            "dimensionsMm": [12, 11, 16],
        },
    },
    {
        "name": "dds_chassis_iec_c14_inlet",
        "component_type": "iec_c14_inlet",
        "brand": "Schurter",
        "model": "GST series C14 inlet",
        "asset": "primitive_iec_c14_inlet",
        "properties": {
            "geometry": "iec_c14_inlet",
            "ratedCurrentA": 10,
            "spec": "IEC 60320 C14",
            "dimensionsMm": [30, 22.5, 27],
        },
    },
    {
        "name": "dds_chassis_1u_enclosure",
        "component_type": "instrument_chassis",
        "brand": "QMEM",
        "model": "DDS 5xAD9959 1U enclosure",
        "asset": "dds_chassis_1u_glb",
        "properties": {
            "geometry": "dds_chassis_1u",
            "rackUnits": 1,
            "dimensionsMm": [482.6, 246, 44.45],
            "internalUsableMm": [478, 246, 44.45],
            "frontPanelPorts": "20 x SMA female (CH1..CH20)",
            "rearPanelPorts": ["USB-B", "IEC C14"],
        },
    },
    {
        "name": "dds_chassis_1u_enclosure_primitive",
        "component_type": "instrument_chassis",
        "brand": "QMEM",
        "model": "DDS 1U enclosure (primitive fallback)",
        "asset": "primitive_instrument_chassis_1u",
        "properties": {
            "geometry": "instrument_chassis_1u",
            "rackUnits": 1,
            "dimensionsMm": [482.6, 246, 44.45],
        },
    },
]


def _merge_anchors_with_contract(
    existing: list[dict[str, Any]] | None,
    contract: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Identity from contract, position/direction preserved from `existing`.

    For each (id, name) tuple in `contract`: if a matching anchor already
    exists in DB, keep its positionMmBodyLocal / directionBodyLocal so user
    edits in the PHY Editor survive a re-run. If missing, seed with contract
    defaults. Anchors present in DB but absent from the contract are dropped
    (hard-lock semantics)."""

    by_key: dict[tuple[str, str | None], dict[str, Any]] = {
        (a.get("id"), a.get("name")): a for a in (existing or [])
    }
    merged: list[dict[str, Any]] = []
    for tpl in contract:
        key = (tpl.get("id"), tpl.get("name"))
        prev = by_key.get(key)
        if prev is not None:
            merged.append(
                {
                    "id": tpl["id"],
                    "name": tpl.get("name"),
                    "positionMmBodyLocal": prev.get(
                        "positionMmBodyLocal", tpl.get("positionMmBodyLocal")
                    ),
                    "directionBodyLocal": prev.get(
                        "directionBodyLocal", tpl.get("directionBodyLocal")
                    ),
                }
            )
        else:
            merged.append(dict(tpl))
    return merged


async def upsert_asset(session, data: dict[str, object]) -> Asset3D:
    contract_key = data.pop("_anchor_contract_key", None)
    asset = await session.scalar(select(Asset3D).where(Asset3D.name == data["name"]))
    if contract_key is not None:
        contract = COMPONENT_ANCHOR_CONTRACTS.get(str(contract_key))
        if contract is None:
            raise KeyError(
                f"_anchor_contract_key={contract_key!r} not in COMPONENT_ANCHOR_CONTRACTS"
            )
        existing_anchors = list(asset.anchors) if asset is not None else []
        data["anchors"] = _merge_anchors_with_contract(existing_anchors, list(contract))
    if asset is None:
        asset = Asset3D(**data)
        session.add(asset)
        await session.flush()
    else:
        for key, value in data.items():
            setattr(asset, key, value)
        await session.flush()
    return asset


async def upsert_component(
    session,
    data: dict[str, object],
    assets_by_name: dict[str, Asset3D],
) -> Component | None:
    payload = data.copy()
    asset_name = payload.pop("asset")
    payload["asset_3d_id"] = assets_by_name[asset_name].id

    component = await session.scalar(select(Component).where(Component.name == payload["name"]))
    if component is not None and component.archived_at is not None:
        return None

    if component is None:
        component = Component(**payload)
        session.add(component)
        await session.flush()
    else:
        for key, value in payload.items():
            setattr(component, key, value)
        await session.flush()
    return component


async def main() -> None:
    async with AsyncSessionLocal() as session:
        assets_by_name: dict[str, Asset3D] = {}
        for asset_data in ASSETS:
            asset = await upsert_asset(session, asset_data.copy())
            assets_by_name[asset.name] = asset

        for component_data in COMPONENTS:
            await upsert_component(session, component_data, assets_by_name)

        await session.commit()
        print(
            f"Upserted {len(ASSETS)} assets and {len(COMPONENTS)} catalog components "
            "(no SceneObjects created)."
        )


if __name__ == "__main__":
    asyncio.run(main())
