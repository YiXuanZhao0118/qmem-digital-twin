from __future__ import annotations

import asyncio
from pathlib import Path
import sys

from sqlalchemy import select, text

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.db import AsyncSessionLocal, engine  # noqa: E402
from app.models import Asset3D, Base, BeamPath, Component, Connection, DeviceState, Placement  # noqa: E402


ASSETS = [
    {
        "name": "primitive_table",
        "asset_type": "primitive",
        "file_path": "primitive://table",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "primitive_box",
        "asset_type": "primitive",
        "file_path": "primitive://box",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "primitive_mirror",
        "asset_type": "primitive",
        "file_path": "primitive://mirror",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "primitive_lens",
        "asset_type": "primitive",
        "file_path": "primitive://lens",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "primitive_chamber",
        "asset_type": "primitive",
        "file_path": "primitive://vacuum_chamber",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "primitive_thorlabs_post_holder",
        "asset_type": "primitive",
        "file_path": "primitive://thorlabs_post_holder",
        "source": "https://www.thorlabs.com/half-inch-post-holders",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "primitive_thorlabs_post",
        "asset_type": "primitive",
        "file_path": "primitive://thorlabs_post",
        "source": "https://www.thorlabs.com/optical-posts-half-inch-and-12-mm",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "primitive_thorlabs_clamping_fork",
        "asset_type": "primitive",
        "file_path": "primitive://thorlabs_clamping_fork",
        "source": "https://www.thorlabs.com/clamping-forks-for-pedestal-posts?pn=CF038C%2FM-P5",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "thorlabs_cf175cm_p5_edrawing",
        "asset_type": "edrawing_html",
        "file_path": "cf175c_m_edrawing.html",
        "source": "Thorlabs eDrawing",
        "source_url": "https://media.thorlabs.com/globalassets/items/c/cf/cf1/cf175c_m/ttn026566-e0w.html?v=0116105356",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "thorlabs_cf175cm_p5_stl",
        "asset_type": "stl",
        "file_path": "uploads/cf175c_m-p5.stl",
        "source": "FreeCAD STEP export",
        "source_url": "https://www.thorlabs.com/item/CF175C_M-P5?aID=4063768eebb43d2e49d40f1ce64ce7a8&aC=2",
        "unit": "mm",
        "scale_factor": 1.0,
    },
]


COMPONENTS = [
    {
        "name": "optical_table_1",
        "component_type": "optical_table",
        "brand": "Newport",
        "model": "RS4000 1200x3600x457 + S-2000A",
        "asset": "primitive_table",
        "properties": {
            "geometry": "newport_rs4000_table",
            "dimensionsMm": [3600, 1200, 457],
            "topHeightMm": 860,
            "holeGrid": [144, 48],
            "thread": "M6",
            "isolatorModel": "S-2000A",
            "isolatorCount": 6,
        },
        "placement": {
            "object_name": "optical_table_1_object_1",
            "x_mm": 0,
            "y_mm": 0,
            "z_mm": 0,
            "visible": True,
            "locked": False,
        },
    },
    {
        "name": "vacuum_chamber_1",
        "component_type": "vacuum_chamber",
        "brand": "QMEM",
        "model": "Rb-memory-cell",
        "asset": "primitive_chamber",
        "properties": {"geometry": "vacuum_chamber", "radiusMm": 150, "heightMm": 220},
        "placement": {"x_mm": 500, "y_mm": 220, "z_mm": 110, "rz_deg": 0},
        "state": {"pressurePa": 0.00002, "temperatureC": 24.2},
    },
    {
        "name": "laser_852nm_1",
        "component_type": "laser",
        "brand": "Toptica",
        "model": "DL pro 852",
        "asset": "primitive_box",
        "properties": {"geometry": "laser", "wavelengthNm": 852, "dimensionsMm": [260, 90, 80]},
        "placement": {"x_mm": -650, "y_mm": -220, "z_mm": 55, "rz_deg": 0},
        "state": {"enabled": True, "powerMw": 18.5, "wavelengthNm": 852},
    },
    {
        "name": "laser_894nm_1",
        "component_type": "laser",
        "brand": "Toptica",
        "model": "DL pro 894",
        "asset": "primitive_box",
        "properties": {"geometry": "laser", "wavelengthNm": 894, "dimensionsMm": [260, 90, 80]},
        "placement": {"x_mm": -650, "y_mm": 180, "z_mm": 55, "rz_deg": 0},
        "state": {"enabled": True, "powerMw": 12.0, "wavelengthNm": 894},
    },
    {
        "name": "mirror_001",
        "component_type": "mirror",
        "brand": "Thorlabs",
        "model": "PF10-03-P01",
        "asset": "primitive_mirror",
        "properties": {"geometry": "mirror", "diameterMm": 25.4},
        "placement": {"x_mm": -220, "y_mm": -220, "z_mm": 90, "rz_deg": 45},
    },
    {
        "name": "mirror_002",
        "component_type": "mirror",
        "brand": "Thorlabs",
        "model": "PF10-03-P01",
        "asset": "primitive_mirror",
        "properties": {"geometry": "mirror", "diameterMm": 25.4},
        "placement": {"x_mm": 120, "y_mm": 180, "z_mm": 90, "rz_deg": -45},
    },
    {
        "name": "lens_001",
        "component_type": "lens",
        "brand": "Edmund Optics",
        "model": "AC254-150-B",
        "asset": "primitive_lens",
        "properties": {"geometry": "lens", "focalLengthMm": 150, "diameterMm": 25.4},
        "placement": {"x_mm": 180, "y_mm": -220, "z_mm": 95, "rz_deg": 0},
    },
    {
        "name": "aom_001",
        "component_type": "aom",
        "brand": "Gooch & Housego",
        "model": "AOMO 3080",
        "asset": "primitive_box",
        "properties": {"geometry": "aom", "frequencyMHz": 80, "dimensionsMm": [110, 70, 70]},
        "placement": {"x_mm": -20, "y_mm": -220, "z_mm": 65, "rz_deg": 0},
        "state": {"enabled": True, "rfPowerDbm": 24.0},
    },
    {
        "name": "eom_9ghz_001",
        "component_type": "eom",
        "brand": "Qubig",
        "model": "PM-C9G",
        "asset": "primitive_box",
        "properties": {"geometry": "eom", "frequencyGHz": 9.192, "dimensionsMm": [140, 80, 70]},
        "placement": {"x_mm": 330, "y_mm": -220, "z_mm": 65, "rz_deg": 0},
        "state": {"enabled": True, "rfPowerDbm": 19.8},
    },
    {
        "name": "rf_generator_001",
        "component_type": "rf_generator",
        "brand": "Rohde & Schwarz",
        "model": "SMB100A",
        "asset": "primitive_box",
        "properties": {"geometry": "rf_generator", "dimensionsMm": [280, 220, 100]},
        "placement": {"x_mm": -610, "y_mm": 500, "z_mm": 60, "rz_deg": 0},
        "state": {"enabled": True, "frequencyGHz": 9.192, "powerDbm": 5.0},
    },
    {
        "name": "rf_amp_001",
        "component_type": "rf_amplifier",
        "brand": "Mini-Circuits",
        "model": "ZHL-42W+",
        "asset": "primitive_box",
        "properties": {"geometry": "rf_amplifier", "dimensionsMm": [180, 140, 70]},
        "placement": {"x_mm": -250, "y_mm": 500, "z_mm": 50, "rz_deg": 0},
        "state": {"enabled": True, "temperatureC": 33.5, "rfPowerDbm": 28.2},
    },
    {
        "name": "thorlabs_post_holder_ph50em",
        "component_type": "post_holder",
        "brand": "Thorlabs",
        "model": "PH50E/M",
        "asset": "primitive_thorlabs_post_holder",
        "properties": {
            "geometry": "thorlabs_post_holder",
            "series": "Half-inch pedestal post holder",
            "diameterMm": 12.7,
            "heightMm": 54.7,
            "baseDiameterMm": 31.8,
            "thumbscrew": "5 mm spring-loaded hex-locking thumbscrew",
            "sourceUrl": "https://www.thorlabs.com/half-inch-post-holders?aID=4063768eebb43d2e49d40f1ce64ce7a8&aC=2",
        },
        "placement": {"x_mm": 680, "y_mm": -280, "z_mm": 0, "rz_deg": 0},
    },
    {
        "name": "thorlabs_post_tr50m",
        "component_type": "optical_post",
        "brand": "Thorlabs",
        "model": "TR50/M",
        "asset": "primitive_thorlabs_post",
        "properties": {
            "geometry": "thorlabs_post",
            "diameterMm": 12.7,
            "heightMm": 50,
            "material": "303 stainless steel",
            "topThread": "M4",
            "bottomThread": "M6",
            "sourceUrl": "https://www.thorlabs.com/optical-posts-half-inch-and-12-mm?tabName=Overview",
        },
        "placement": {"x_mm": 760, "y_mm": -280, "z_mm": 0, "rz_deg": 0},
    },
    {
        "name": "thorlabs_clamping_fork_cf038cm_p5",
        "component_type": "clamping_fork",
        "brand": "Thorlabs",
        "model": "CF038C/M-P5",
        "asset": "primitive_thorlabs_clamping_fork",
        "properties": {
            "geometry": "thorlabs_clamping_fork",
            "slotLengthMm": 10.2,
            "slotWidthMm": 10.2,
            "screw": "M6 x 1.0 captive screw",
            "package": "5 pack",
            "material": "303 stainless steel",
            "sourceUrl": "https://www.thorlabs.com/clamping-forks-for-pedestal-posts?pn=CF038C%2FM-P5&tabName=Overview",
        },
        "placement": {"x_mm": 840, "y_mm": -280, "z_mm": 0, "rz_deg": 0},
    },
    {
        "name": "thorlabs_clamping_fork_cf175cm_p5_edrawing",
        "component_type": "clamping_fork_3d_model",
        "brand": "Thorlabs",
        "model": "CF175C/M-P5",
        "asset": "thorlabs_cf175cm_p5_edrawing",
        "properties": {
            "geometry": "edrawing_html",
            "slotLengthMm": 44.4,
            "screw": "M6 x 1.0 captive screw",
            "package": "5 pack",
            "modelViewer": "eDrawing HTML",
            "sourceUrl": "https://media.thorlabs.com/globalassets/items/c/cf/cf1/cf175c_m/ttn026566-e0w.html?v=0116105356",
        },
        "placement": {"x_mm": 930, "y_mm": -280, "z_mm": 0, "rz_deg": 0},
    },
    {
        "name": "thorlabs_clamping_fork_cf175cm_p5",
        "component_type": "clamping_fork",
        "brand": "Thorlabs",
        "model": "CF175C/M-P5",
        "asset": "thorlabs_cf175cm_p5_stl",
        "properties": {
            "geometry": "stl_mesh",
            "slotLengthMm": 44.4,
            "screw": "M6 x 1.0 captive screw",
            "package": "5 pack",
            "sourceStep": "uploads/603e2c4d-fe81-497d-9953-9440f722f102_cf175c_m-p5-step.step",
            "sourceUrl": "https://www.thorlabs.com/item/CF175C_M-P5?aID=4063768eebb43d2e49d40f1ce64ce7a8&aC=2",
            "edrawingUrl": "https://media.thorlabs.com/globalassets/items/c/cf/cf1/cf175c_m/ttn026566-e0w.html?v=0116105356",
        },
        "placement": {"x_mm": 1040, "y_mm": -280, "z_mm": 0, "rz_deg": 0},
    },
]


BEAM_PATHS = [
    {
        "name": "852 nm cooling/control beam",
        "wavelength_nm": 852,
        "color": "#22d3ee",
        "source": "laser_852nm_1",
        "target": "vacuum_chamber_1",
        "points": [
            [-650, -220, 95],
            [-220, -220, 95],
            [180, -220, 95],
            [330, -220, 95],
            [500, 0, 110],
            [500, 220, 110],
        ],
        "properties": {"role": "control"},
        "visible": True,
    },
    {
        "name": "894 nm signal beam",
        "wavelength_nm": 894,
        "color": "#facc15",
        "source": "laser_894nm_1",
        "target": "vacuum_chamber_1",
        "points": [
            [-650, 180, 95],
            [120, 180, 95],
            [500, 180, 110],
            [500, 220, 110],
        ],
        "properties": {"role": "signal"},
        "visible": True,
    },
]


CONNECTIONS = [
    {
        "connection_type": "rf",
        "from": "rf_generator_001",
        "from_port": "RF OUT",
        "to": "rf_amp_001",
        "to_port": "RF IN",
        "label": "9.192 GHz drive",
        "properties": {"cable": "SMA"},
    },
    {
        "connection_type": "rf",
        "from": "rf_amp_001",
        "from_port": "RF OUT",
        "to": "eom_9ghz_001",
        "to_port": "RF IN",
        "label": "EOM high power RF",
        "properties": {"cable": "SMA"},
    },
]


async def upsert_asset(session, asset_data: dict[str, object]) -> Asset3D:
    result = await session.scalars(select(Asset3D).where(Asset3D.name == asset_data["name"]))
    asset = result.first()
    if asset is None:
        asset = Asset3D(**asset_data)
        session.add(asset)
    else:
        for key, value in asset_data.items():
            setattr(asset, key, value)
    return asset


async def upsert_component(
    session,
    component_data: dict[str, object],
    assets_by_name: dict[str, Asset3D],
) -> Component:
    result = await session.scalars(select(Component).where(Component.name == component_data["name"]))
    component = result.first()
    asset_name = component_data.pop("asset")
    placement_data = component_data.pop("placement")
    state_data = component_data.pop("state", None)
    component_data["asset_3d_id"] = assets_by_name[asset_name].id

    if component is None:
        component = Component(**component_data)
        session.add(component)
        await session.flush()
    else:
        for key, value in component_data.items():
            setattr(component, key, value)

    result = await session.scalars(select(Placement).where(Placement.component_id == component.id))
    placement = result.first()
    if placement is None:
        placement = Placement(component_id=component.id)
        session.add(placement)
    for key, value in placement_data.items():
        setattr(placement, key, value)

    if state_data is not None:
        state = await session.get(DeviceState, component.id)
        if state is None:
            state = DeviceState(component_id=component.id)
            session.add(state)
        state.state = state_data

    return component


async def upsert_beam_path(
    session,
    beam_data: dict[str, object],
    components_by_name: dict[str, Component],
) -> None:
    result = await session.scalars(select(BeamPath).where(BeamPath.name == beam_data["name"]))
    beam_path = result.first()
    source_name = beam_data.pop("source")
    target_name = beam_data.pop("target")
    beam_data["source_component_id"] = components_by_name[source_name].id
    beam_data["target_component_id"] = components_by_name[target_name].id

    if beam_path is None:
        session.add(BeamPath(**beam_data))
    else:
        for key, value in beam_data.items():
            setattr(beam_path, key, value)


async def upsert_connection(
    session,
    connection_data: dict[str, object],
    components_by_name: dict[str, Component],
) -> None:
    result = await session.scalars(select(Connection).where(Connection.label == connection_data["label"]))
    connection = result.first()
    connection_data = connection_data.copy()
    connection_data["from_component_id"] = components_by_name[connection_data.pop("from")].id
    connection_data["to_component_id"] = components_by_name[connection_data.pop("to")].id

    if connection is None:
        session.add(Connection(**connection_data))
    else:
        for key, value in connection_data.items():
            setattr(connection, key, value)


async def seed() -> None:
    async with engine.begin() as connection:
        await connection.execute(text("CREATE EXTENSION IF NOT EXISTS pgcrypto"))
        await connection.run_sync(Base.metadata.create_all)

    async with AsyncSessionLocal() as session:
        assets_by_name: dict[str, Asset3D] = {}
        for asset_data in ASSETS:
            asset = await upsert_asset(session, asset_data.copy())
            await session.flush()
            assets_by_name[asset.name] = asset

        components_by_name: dict[str, Component] = {}
        for component_data in COMPONENTS:
            component = await upsert_component(session, component_data.copy(), assets_by_name)
            await session.flush()
            components_by_name[component.name] = component

        for beam_data in BEAM_PATHS:
            await upsert_beam_path(session, beam_data.copy(), components_by_name)

        for connection_data in CONNECTIONS:
            await upsert_connection(session, connection_data.copy(), components_by_name)

        await session.commit()

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(seed())
    print("Seeded qmem digital twin scene.")
