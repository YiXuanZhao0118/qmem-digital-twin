"""STEP (with XCAF colours) -> vertex-coloured GLB, raw mm, Z-up.

Walks the XCAF assembly tree (following instance -> prototype references and
accumulating component locations) so colours set on nested sub-assemblies --
the label groups -- survive instead of falling back to grey.

usage: python step_to_glb.py in.step out.glb [dx dy dz]
"""
import sys
import numpy as np
import trimesh

from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TDocStd import TDocStd_Document
from OCP.XCAFApp import XCAFApp_Application
from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ColorType, XCAFDoc_ColorTool, XCAFDoc_ShapeTool
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDF import TDF_LabelSequence, TDF_Label
from OCP.TopLoc import TopLoc_Location
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID, TopAbs_REVERSED
from OCP.TopoDS import TopoDS
from OCP.TopTools import TopTools_IndexedMapOfShape
from OCP.BRep import BRep_Tool
from OCP.Quantity import Quantity_Color

LIN_DEFL = 0.05
ANG_DEFL = 0.3
FALLBACK = np.array([0.8, 0.8, 0.8])   # same grey the previous asset used

src, dst = sys.argv[1], sys.argv[2]
shift = np.array([float(v) for v in sys.argv[3:6]]) if len(sys.argv) > 5 else np.zeros(3)

app = XCAFApp_Application.GetApplication_s()
doc = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
app.NewDocument(TCollection_ExtendedString("MDTV-XCAF"), doc)

reader = STEPCAFControl_Reader()
reader.SetColorMode(True)
reader.SetNameMode(True)
if reader.ReadFile(src) != 1:
    raise SystemExit(f"cannot read {src}")
reader.Transfer(doc)

shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
color_tool = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())

# OCC returns linear RGB; the asset already in the app stores linear in COLOR_0
# (glTF's own convention), so no sRGB conversion here.
def label_colour(lab):
    c = Quantity_Color()
    for ct in (XCAFDoc_ColorType.XCAFDoc_ColorSurf, XCAFDoc_ColorType.XCAFDoc_ColorGen):
        if XCAFDoc_ColorTool.GetColor_s(lab, ct, c):
            return np.array([c.Red(), c.Green(), c.Blue()])
    return None


def face_colour(face):
    c = Quantity_Color()
    for ct in (XCAFDoc_ColorType.XCAFDoc_ColorSurf, XCAFDoc_ColorType.XCAFDoc_ColorGen):
        if color_tool.GetColor(face, ct, c):
            return np.array([c.Red(), c.Green(), c.Blue()])
    return None


verts, faces, fcols = [], [], []
offset = 0
leaves = []
face_map = TopTools_IndexedMapOfShape()   # coloured faces, keyed by OCC identity
face_cols = []                            # parallel to face_map indices


def shape_colour(shape):
    c = Quantity_Color()
    for ct in (XCAFDoc_ColorType.XCAFDoc_ColorSurf, XCAFDoc_ColorType.XCAFDoc_ColorGen):
        if color_tool.GetColor(shape, ct, c):
            return np.array([c.Red(), c.Green(), c.Blue()])
    return None


def as_matrix(trsf):
    m = np.eye(4)
    for r in range(3):
        for c in range(4):
            m[r, c] = trsf.Value(r + 1, c + 1)
    return m


def mesh_shape(shape, mat, rgb, name):
    """Tessellate one leaf. Colours are stored per SOLID in the STEP (679
    styled items), so resolve them there and only fall back to the label's."""
    global offset
    n_tri = 0
    exp_f = TopExp_Explorer(shape, TopAbs_FACE)
    faces_seen = set()
    while exp_f.More():
        face = TopoDS.Face_s(exp_f.Current())
        exp_f.Next()
        key = face.TShape().__hash__(), face.Orientation()
        if key in faces_seen:
            continue
        faces_seen.add(key)
        idx = face_map.FindIndex(face)
        col = face_cols[idx - 1] if idx else None
        if col is None:
            col = shape_colour(face)
        if col is None:
            col = rgb
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face, loc)
        if tri is None:
            continue
        m = mat @ as_matrix(loc.Transformation())
        v = np.empty((tri.NbNodes(), 3))
        for i in range(1, tri.NbNodes() + 1):
            p = tri.Node(i)
            v[i - 1] = (p.X(), p.Y(), p.Z())
        v = v @ m[:3, :3].T + m[:3, 3]
        f = np.empty((tri.NbTriangles(), 3), dtype=np.int64)
        for i in range(1, tri.NbTriangles() + 1):
            a, b, c = tri.Triangle(i).Get()
            f[i - 1] = (a - 1, b - 1, c - 1)
        if face.Orientation() == TopAbs_REVERSED:
            f = f[:, ::-1]
        verts.append(v)
        faces.append(f + offset)
        fcols.append(np.tile(col, (len(f), 1)))
        offset += len(v)
        n_tri += len(f)
    leaves.append((name, n_tri, tuple(np.round(rgb, 3))))


def index_colours():
    """Colours of the label groups sit on SUBSHAPE labels (one per solid),
    not on the leaf label itself. Index every face of every coloured
    subshape up front so the tessellation can look them up."""
    labs = TDF_LabelSequence()
    shape_tool.GetShapes(labs)
    for i in range(1, labs.Length() + 1):
        subs = TDF_LabelSequence()
        XCAFDoc_ShapeTool.GetSubShapes_s(labs.Value(i), subs)
        for k in range(1, subs.Length() + 1):
            sub = subs.Value(k)
            col = label_colour(sub)
            if col is None:
                continue
            shp = XCAFDoc_ShapeTool.GetShape_s(sub)
            if shp.IsNull():
                continue
            exp = TopExp_Explorer(shp, TopAbs_FACE)
            while exp.More():
                f = exp.Current()
                exp.Next()
                if face_map.FindIndex(f):
                    continue
                face_map.Add(f)
                face_cols.append(col)


def emit(shape, mat, rgb, name):
    BRepMesh_IncrementalMesh(shape, LIN_DEFL, False, ANG_DEFL, True)
    mesh_shape(shape, mat, rgb, name)


def walk(lab, loc, rgb):
    """lab may be a component (reference) or a plain shape label."""
    col = label_colour(lab)
    if col is not None:
        rgb = col
    ref = TDF_Label()
    if XCAFDoc_ShapeTool.GetReferredShape_s(lab, ref):
        loc = loc.Multiplied(XCAFDoc_ShapeTool.GetLocation_s(lab))
        col = label_colour(ref)
        if col is not None:
            rgb = col
        lab = ref
    children = TDF_LabelSequence()
    XCAFDoc_ShapeTool.GetComponents_s(lab, children)
    if children.Length():
        for i in range(1, children.Length() + 1):
            walk(children.Value(i), loc, rgb)
        return
    shape = XCAFDoc_ShapeTool.GetShape_s(lab)
    if shape.IsNull():
        return
    total = loc.Multiplied(shape.Location())
    emit(shape, as_matrix(total.Transformation()), rgb, lab.Tag())


index_colours()

roots = TDF_LabelSequence()
shape_tool.GetFreeShapes(roots)
for i in range(1, roots.Length() + 1):
    walk(roots.Value(i), TopLoc_Location(), FALLBACK)

V = np.vstack(verts) + shift
F = np.vstack(faces)
C = np.clip(np.vstack(fcols), 0, 1)
C = np.hstack([(C * 255).round().astype(np.uint8),
               np.full((len(C), 1), 255, dtype=np.uint8)])

mesh = trimesh.Trimesh(vertices=V, faces=F, face_colors=C, process=False)
trimesh.Scene(mesh).export(dst)

# trimesh writes no material, so the viewer falls back to the glTF default
# (metallic 1.0 / rough 1.0) and the whole model renders dark and dull.
# Stamp on the same near-dielectric material the previous asset used.
def set_material(path, metallic=0.1, roughness=0.7):
    import json, struct
    blob = open(path, "rb").read()
    j_len = struct.unpack("<I", blob[12:16])[0]
    doc = json.loads(blob[20:20 + j_len])
    rest = blob[20 + j_len:]
    doc["materials"] = [{"name": "body",
                         "pbrMetallicRoughness": {"metallicFactor": metallic,
                                                  "roughnessFactor": roughness}}]
    for m in doc["meshes"]:
        for prim in m["primitives"]:
            prim["material"] = 0
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    out = b"glTF" + struct.pack("<II", 2, 12 + 8 + len(js) + len(rest))
    out += struct.pack("<I", len(js)) + b"JSON" + js + rest
    open(path, "wb").write(out)

set_material(dst)

print(f"leaves={len(leaves)} tris={len(F)} verts={len(V)}")
cols, counts = np.unique(C[:, :3], axis=0, return_counts=True)
for i in np.argsort(-counts):
    print(f"  colour {tuple(cols[i])} : {counts[i]} tris")
for nm, nt, cc in leaves:
    print(f"  leaf {nm}: {nt} tris colour {cc}")
print("bounds", np.round(mesh.bounds, 3).tolist())
print("size  ", np.round(mesh.bounds[1] - mesh.bounds[0], 3).tolist())
