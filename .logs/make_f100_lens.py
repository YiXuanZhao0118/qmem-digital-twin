"""Create a new f=100 plano-convex lens (Thorlabs LA1509-B) asset+component+
binding+object at LENS_PLANO_CONVEX0's pose, then move the old f=15 lens
off-beam. Mirrors the existing LA1540-B / LA1614-B records exactly."""
import json, urllib.request

BASE = "http://localhost:8010/api"
F75_ASSET = "95b95c54-af8d-44d1-99cf-cc316e8cd2b2"   # LA1614-B clone template
OLD_OBJ = "586134ad-86d2-44f1-921a-8c93fb46ae1c"      # LENS_PLANO_CONVEX0
OLD_POS = dict(xMm=-150.0, yMm=751.4418985217825, zMm=2088.910749099467,
               rxDeg=0.0, ryDeg=90.0, rzDeg=0.0)


def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=15) as resp:
        txt = resp.read().decode()
        return resp.status, (json.loads(txt) if txt else None)


# 1) Asset — clone f=75 template, retarget to LA1509-B f=100 -------------------
_, t = req("GET", f"/assets/{F75_ASSET}")
asset = {k: t[k] for k in (
    "name", "assetType", "filePath", "source", "sourceUrl", "unit",
    "scaleFactor", "anchors", "properties", "catalogId", "kindId", "faces",
    "transitions", "defaultParams", "wavelengthRangeNm") if k in t}
asset["name"] = "Plano-Convex Lens f=100mm AR(650-1050nm)"
asset["catalogId"] = "thorlabs_la1509_b"
asset["defaultParams"] = {**t["defaultParams"],
                          "focalLengthMm": 100, "radiusOfCurvatureMm": 51.5,
                          "centerThicknessMm": 3.6, "refractiveIndex": 1.5168}
props = dict(t.get("properties") or {})
props["vendorPart"] = "LA1509-B"
props["displayName"] = asset["name"]
props["notes"] = {
    "spec": "Thorlabs LA1509-B: f=100mm, 1-inch plano-convex, AR-B 650-1050nm, "
            "N-BK7, center thickness 3.6mm, R=51.5mm. f=R/(n-1)=99.6mm.",
    "geometryRefNote": "Reusing thorlabs_la1540_b.stl as placeholder geometry.",
    "calibrationStatus": "Same recipe as LA1540-B/LA1614-B; only R changes -> 51.5mm.",
}
asset["properties"] = props
st, new_asset = req("POST", "/assets", asset)
print("asset:", st, new_asset["id"], "f=", new_asset["defaultParams"]["focalLengthMm"])
aid = new_asset["id"]

# 2) Component -----------------------------------------------------------------
comp = {"name": "LA1509-B", "kindId": "lens_plano_convex", "brand": "Thorlabs",
        "model": "LA1509-B", "asset3dId": aid,
        "properties": {"geometry": "stl_mesh", "material": "N-BK7",
                       "diameterMm": 25.4, "focalLengthMm": 100,
                       "arCoatingRangeNm": [650, 1050]},
        "physicsCapabilities": ["optical"]}
st, new_comp = req("POST", "/components", comp)
print("component:", st, new_comp["id"], new_comp["name"])
cid = new_comp["id"]

# 3) ComponentBinding (asset, identity pose, role=body) ------------------------
binding = {"targetKind": "asset", "asset3dId": aid, "subComponentId": None,
           "parentBindingId": None, "role": "body",
           "localXMm": 0.0, "localYMm": 0.0, "localZMm": 0.0,
           "localRxDeg": 0.0, "localRyDeg": 0.0, "localRzDeg": 0.0,
           "tunableAxes": {}, "sortOrder": 0, "properties": {}}
st, new_bind = req("POST", f"/components/{cid}/bindings", binding)
print("binding:", st, new_bind["id"])

# 4) SceneObject at old lens pose (auto-creates PhysicsElement) ----------------
obj = {"componentId": cid, "name": "LENS_PLANO_CONVEX_F100", "visible": True,
       "locked": False, **OLD_POS}
st, new_obj = req("POST", "/objects", obj)
print("object:", st, new_obj["id"], new_obj["name"], "@",
      new_obj["xMm"], new_obj["yMm"], new_obj["zMm"])

# 5) Move old f=15 lens off-beam (+300mm in y), keep it -----------------------
st, moved = req("PUT", f"/objects/{OLD_OBJ}",
                {"yMm": OLD_POS["yMm"] + 300.0})
print("old lens moved:", st, "yMm ->", moved["yMm"])
