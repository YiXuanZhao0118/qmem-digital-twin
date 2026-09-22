"""``aomDrives[*].eta`` (POST /api/v3/rf/propagation) = what the tracer applies.

Two halves:

* the wavelength rule (``aom_readout.scene_emitter_wavelength_nm``) on
  hand-built scenes — the one input a readout has to choose, because the op
  takes it per ray;
* end to end on a real DB scene (laser -> AOM, an RF source cabled into the
  AOM's rf_in): the endpoint's ``eta`` equals, exactly, the on-Bragg
  efficiency the AOM op computes while ``solve_anchor_scene`` traces the same
  scene — observed by spying on ``aom_physics.first_order_efficiency`` as the
  op calls it, not recomputed.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import delete

from app.db import AsyncSessionLocal
from app.models import Asset3D, Component, ComponentBinding, PhysicsElement, SceneObject
from app.optical import anchor_ops  # noqa: F401  (registers every op)
from app.optical.anchor_ops import aom as aom_module
from app.optical.anchor_tracer import (
    V3Anchor,
    V3AnchorBindingSlot,
    V3AnchorScene,
    V3AssetAnchorSnapshot,
)
from app.optical.aom_readout import (
    DEFAULT_READOUT_WAVELENGTH_NM,
    aom_drive_efficiencies,
    scene_emitter_wavelength_nm,
)
from app.optical.beam_ray import Vec3
from app.optical.db_scene_loader import load_anchor_scene_from_db
from app.optical.pose import V3Pose, pose_to_transform
from app.optical.solver import solve_anchor_scene
from app.routers.v3_rf import RfPropagationRequest, rf_propagation


# ─── the wavelength rule ───────────────────────────────────────────────────

def _anchor(aid: str) -> V3Anchor:
    return V3Anchor(id=aid, position_body=Vec3(0, 0, 0), axis_x_body=Vec3(1, 0, 0),
                    axis_y_body=Vec3(0, 1, 0), axis_z_body=Vec3(0, 0, 1), aperture_mm=1.0)


def _slot(oid: str, kind: str, anchors: list[str], params: dict, *, dyn=None, visuals=None):
    return V3AnchorBindingSlot(
        scene_object_id=oid, binding_id="body",
        asset=V3AssetAnchorSnapshot(catalog_id=oid, kind=kind,
                                    anchors=[_anchor(a) for a in anchors], default_params=params),
        effective_transform=pose_to_transform(V3Pose()), dynamic_sources=dyn,
        emission_visuals=visuals,
    )


def _laser(oid: str, nm: float, **kw):
    return _slot(oid, "laser_source", ["intercept_out"], {"centerWavelengthNm": nm}, **kw)


def _ta(oid: str, nm: float):
    return _slot(oid, "tapered_amplifier", ["intercept_in", "intercept_out"],
                 {"centerWavelengthNm": nm, "ase": {"powerMw": 5.0}})


@pytest.mark.parametrize(("slots", "expected"), [
    # The live bench: DBR laser at 852.347 seeding a Sacher TA whose nominal
    # is 852. The tracer's rays stay at 852.347; the web panel's rule, which
    # counts the TA, would see two wavelengths and drop to 780.
    ([_laser("L", 852.347), _ta("TA", 852.0)], 852.347),
    ([_laser("L1", 852.347), _laser("L2", 852.347)], 852.347),
    ([_laser("L1", 852.347), _laser("L2", 780.241)], DEFAULT_READOUT_WAVELENGTH_NM),
    # Resolved as the emitted ray is: dynamic sources over the asset.
    ([_laser("L", 852.347, dyn={"centerWavelengthNm": 795.0})], 795.0),
    # A hidden emission is not emitted — here the TA's ASE is then all there is.
    ([_laser("L", 852.347, visuals={"main": {"visible": False}}), _ta("TA", 852.0)], 852.0),
    ([_ta("TA", 852.0)], 852.0),
    ([], DEFAULT_READOUT_WAVELENGTH_NM),
], ids=["laser+seeded-TA", "two-same", "two-different", "dynamic", "hidden-laser", "TA-only", "empty"])
def test_scene_emitter_wavelength(slots, expected) -> None:
    assert scene_emitter_wavelength_nm(V3AnchorScene(slots=slots)) == expected


def test_efficiencies_only_for_aom_slots_that_exist() -> None:
    aom = _slot("A", "aom", ["intercept_in"], {"baseEfficiency": 0.85},
                dyn={"aomFreqMhz": 80.0, "rfDrivePowerW": 1.0})
    scene = V3AnchorScene(slots=[_laser("L", 852.347), aom])
    etas = aom_drive_efficiencies(scene, ["A", "GONE"])
    assert set(etas) == {"A"}
    assert etas["A"] == aom_module.on_bragg_first_order_efficiency(
        {"baseEfficiency": 0.85, "aomFreqMhz": 80.0, "rfDrivePowerW": 1.0},
        {"aomFreqMhz": 80.0, "rfDrivePowerW": 1.0}, 852.347,
    )


# ─── end to end: endpoint eta == the tracer's ──────────────────────────────

@pytest.fixture(autouse=True)
async def _reset_engine_pool():
    from app.db import engine

    await engine.dispose()
    yield


LASER_NM = 852.347
DRIVE_FREQ_MHZ = 90.0   # off the MT80's 80 MHz centre, so G(f) < 1 matters
DRIVE_VPP = 16.0        # 0.8 x 20 Vpp full scale -> 0.64 W into 50 ohm
Z = -5000.0             # well away from anything else in the DB


def _tri(aid: str, pos, x, y, *, name=None, ap=5.0) -> dict:
    z = (x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0])
    d = {
        "id": aid,
        "positionMmBodyLocal": {"x": pos[0], "y": pos[1], "z": pos[2]},
        "axisXBodyLocal": {"x": x[0], "y": x[1], "z": x[2]},
        "axisYBodyLocal": {"x": y[0], "y": y[1], "z": y[2]},
        "axisZBodyLocal": {"x": z[0], "y": z[1], "z": z[2]},
        "apertureMm": ap,
        "apertureShape": "circle",
    }
    if name is not None:
        d["name"] = name
    return d


@pytest.fixture
async def rf_driven_aom():
    """laser (+x) -> AOM 100 mm downstream; an rf_source CH0 cabled into the
    AOM's rf_in. Yields the row ids; removes every row afterwards."""
    tag = uuid.uuid4().hex[:8]
    ids: dict[str, list] = {"pe": [], "objects": [], "components": [], "assets": []}
    async with AsyncSessionLocal() as db:
        def asset(kind, anchors, params):
            a = Asset3D(name=f"t-eta-{kind}-{tag}", asset_type="optical", file_path="primitive://box",
                        kind_id=kind, default_params=params, tunable_params=[], anchors=anchors)
            db.add(a)
            return a

        laser_a = asset("laser_source", [_tri("intercept_out", (0, 0, 0), (1, 0, 0), (0, 1, 0))],
                        {"centerWavelengthNm": LASER_NM, "nominalPowerMw": 10.0})
        aom_a = asset("aom", [
            _tri("intercept_in", (-11.2, 0, 0), (-1, 0, 0), (0, 1, 0)),
            _tri("intercept_out", (11.2, 0, 0), (1, 0, 0), (0, 1, 0)),
            _tri("acoustic_axis", (0, 0, 0), (0, 1, 0), (0, 0, 1)),
            _tri("rf_in", (0, 0, 20), (0, 0, 1), (1, 0, 0)),
        ], {"baseEfficiency": 0.85, "rfPowerMaxW": 2.0, "centerFreqMhz": 80.0,
            "acousticVelocityMps": 4200.0, "crystalLengthMm": 22.4, "refractiveIndex": 2.26})
        src_a = asset("rf_source", [_tri("rf_out", (0, 0, 0), (0, 0, 1), (1, 0, 0), name="CH0")],
                      {"channels": [{"anchorName": "CH0", "frequencyMhz": DRIVE_FREQ_MHZ,
                                     "amplitudeScale": 0.8}], "fullScaleVpp": 20.0})
        await db.flush()
        ids["assets"] += [laser_a.id, aom_a.id, src_a.id]

        def placed(kind, asset_row, pose, props=None):
            comp = Component(name=f"t-eta-{kind}-{tag}", kind_id=kind)
            db.add(comp)
            return comp, asset_row, pose, props

        specs = [
            placed("laser_source", laser_a, (0, 0, Z)),
            placed("aom", aom_a, (100, 0, Z)),
            placed("rf_source", src_a, (0, 500, Z)),
            placed("rf_cable", None, (0, 250, Z)),
        ]
        await db.flush()
        objs = {}
        for comp, asset_row, pose, _ in specs:
            ids["components"].append(comp.id)
            if asset_row is not None:
                db.add(ComponentBinding(component_id=comp.id, target_kind="asset",
                                        asset_3d_id=asset_row.id, role="body"))
            so = SceneObject(component_id=comp.id, name=f"T_{comp.kind_id}_{tag}",
                             x_mm=pose[0], y_mm=pose[1], z_mm=pose[2])
            db.add(so)
            objs[comp.kind_id] = so
        await db.flush()
        objs["rf_cable"].properties = {"rfCableEndpoints": {
            "A": {"targetObjectId": str(objs["rf_source"].id), "targetAnchorName": "CH0"},
            "B": {"targetObjectId": str(objs["aom"].id), "targetAnchorName": "rf_in"},
        }}
        for kind, so in objs.items():
            ids["objects"].append(so.id)
            pe = PhysicsElement(object_id=so.id, element_kind=kind, kind_params={})
            db.add(pe)
            await db.flush()
            ids["pe"].append(pe.id)
        await db.commit()
        yield {k: str(v.id) for k, v in objs.items()}

    async with AsyncSessionLocal() as db:
        await db.execute(delete(PhysicsElement).where(PhysicsElement.id.in_(ids["pe"])))
        await db.execute(delete(SceneObject).where(SceneObject.id.in_(ids["objects"])))
        await db.execute(delete(ComponentBinding).where(ComponentBinding.component_id.in_(ids["components"])))
        await db.execute(delete(Component).where(Component.id.in_(ids["components"])))
        await db.execute(delete(Asset3D).where(Asset3D.id.in_(ids["assets"])))
        await db.commit()


async def test_endpoint_eta_equals_what_the_tracer_applies(rf_driven_aom, monkeypatch) -> None:
    aom_id = rf_driven_aom["aom"]
    applied: list[dict] = []
    real = aom_module.first_order_efficiency

    def spy(**kw):
        eta = real(**kw)
        applied.append({**kw, "eta": eta})
        return eta

    monkeypatch.setattr(aom_module, "first_order_efficiency", spy)

    async with AsyncSessionLocal() as db:
        out = await rf_propagation(RfPropagationRequest(scrub_time_ns=None), db)
        scene = await load_anchor_scene_from_db(db, scrub_time_ns=None)

    drive = out.aom_drives[aom_id]
    assert drive["aomFreqMhz"] == pytest.approx(DRIVE_FREQ_MHZ)
    assert drive["rfDrivePowerW"] == pytest.approx(DRIVE_VPP ** 2 / 400.0)
    if scene_emitter_wavelength_nm(scene) != LASER_NM:
        pytest.skip("other emitters in this DB make the scene wavelength ambiguous")

    applied.clear()
    result = solve_anchor_scene(scene)
    assert not result.errors
    ours = [c for c in applied if c["freq_mhz"] == DRIVE_FREQ_MHZ]
    assert ours, "the laser never reached the AOM's interaction centre"
    for call in ours:
        assert call["wavelength_nm"] == LASER_NM
        assert call["rf_power_w"] == pytest.approx(drive["rfDrivePowerW"], abs=0)
        # The value the op applied, bit for bit.
        assert drive["eta"] == call["eta"]
    # A real, off-centre, under-driven efficiency — not a default.
    assert 0.1 < drive["eta"] < 0.85
