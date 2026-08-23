"""Build the GLB for an Active Technologies Arb Rider AWG-7172 (2-ch AWG).

No CAD source exists for this instrument, so the mesh is generated from the
datasheet envelope plus the front-panel photographs in
``AWG7000Series_datasheet_260325.pdf`` (the photos are of the 4-channel
AWG-7204; the 7172 shares the panel with CH3/CH4, MOD3/4, Marker Out3/4 and
Trigger In3/In4 left unpopulated, which is how they are modelled here).

Body frame (raw mm, Z-up, same convention as ``step_to_glb.py``):

    +X  out of the FRONT PANEL  -> the rf_out anchors' axisX, matching
                                  zhl_1_2w_plus / zyswa_2_50dr where RF
                                  leaves the body along +X
    +Y  the viewer's RIGHT when facing the panel
    +Z  up; z = 0 is the bottom of the feet, so the box sits ON the bench
        (the 3U chassis itself spans z = 10 .. 145)

Datasheet: W 445 x H 135 x D 320 mm (3U 19" rackmount), 12 kg, front panel
all SMA. Panel features are placed in (u, v) = (mm right of panel centre,
mm above the chassis bottom), measured off the product photo at
1.928 px/mm.

    backend/.venv/Scripts/python.exe scripts/build_awg7172_glb.py out.glb
"""
from __future__ import annotations

import json
import struct
import sys

import numpy as np
import trimesh

# ---------------------------------------------------------------- envelope
WIDTH_MM = 445.0
HALF_W = WIDTH_MM / 2.0
HEIGHT_MM = 135.0
DEPTH_MM = 320.0
FOOT_H_MM = 10.0

X_FRONT = DEPTH_MM / 2.0            # 160.0 — front panel plane
Z_BOT = FOOT_H_MM                   # chassis underside
PANEL_T = 1.5                       # front plate stands proud of the chassis
SUBPLATE_T = 0.8                    # connector sub-panels stand proud again

X_PANEL = X_FRONT + PANEL_T         # 161.5 — black front plate face
X_SUB = X_PANEL + SUBPLATE_T        # 162.3 — connector sub-panel face

# SMA panel jack: hex body then the threaded barrel; the mating plane (where
# a cable's connect_in lands) is the barrel tip.
SMA_HEX_D = 9.5
SMA_HEX_L = 4.0
SMA_BARREL_D = 6.4
SMA_BARREL_L = 4.0
SMA_TIP_X = X_SUB + SMA_HEX_L + SMA_BARREL_L    # 170.3

# ------------------------------------------------------------ panel layout
# (u, v) in mm. u = +Y, v = height above the chassis bottom (z = Z_BOT + v).
LCD_C = (-105.3, 71.1)
LCD_BEZEL = (167.0, 94.4)
LCD_GLASS = (154.2, 85.9)           # 7", 1024x600 active area

KNOB_C = (17.6, 93.9)
KNOB_RING_D = 38.0
KNOB_D = 26.0

SOFT_BTN = (16.0, 9.0)              # TRIGGER / RUN / arrows
FUNC_BTN = (15.6, 7.8)              # the 3x3 AMPL / FREQ / ... block
FUNC_U = (-4.1, 17.1, 37.9)
FUNC_V = (47.2, 31.6, 16.1)

KEYPAD_U = (62.2, 73.7, 85.6, 97.5)
KEYPAD_V = (62.8, 51.3, 39.9, 28.5)
KEYPAD_D = 8.8

CHAN_U = (93.4, 122.4, 152.0, 181.0)   # CH1..CH4 column centres
CH_V = 110.2                           # CH n OUT row
MOD_V = 84.5                           # MOD n IN row
CHMOD_PLATE_U = (69.9, 193.1)
CHMOD_PLATE_V = (77.0, 130.8)

MARK_PLATE_U = (108.1, 172.9)
MARK_PLATE_V = (8.3, 75.1)
MARKER = ((121.4, 59.4), (135.9, 59.4))          # Out 1 / Out 2
MARKER_BLANK = ((121.4, 38.7), (135.9, 38.7))    # Out 3 / Out 4
TRIG = ((120.3, 16.4), (134.9, 16.4))            # In 1 / In 2
TRIG_BLANK = ((149.4, 16.4), (163.9, 16.4))      # In 3 / In 4

USB_U = (180.0, 195.0)
USB_V = 49.3
POWER_C = (185.9, 21.9)

# ------------------------------------------------------------------ colours
# Authored in sRGB; COLOR_0 stores LINEAR RGB (see the TEC-400 asset note).
# The enclosure is BLACK (the datasheet photo shows a silver-shelled unit; the
# real instrument this asset stands for is the black one). SHELL is kept a step
# darker than PANEL so the inset front plate still reads against the bezel.
SHELL = (0.07, 0.07, 0.08)
PANEL = (0.15, 0.16, 0.18)
LABEL = (0.87, 0.88, 0.89)          # silk-screened wordmark on the panel
SUBPANEL = (0.08, 0.08, 0.09)
GLASS = (0.05, 0.06, 0.08)
BUTTON = (0.80, 0.80, 0.79)
DARK = (0.10, 0.10, 0.11)
GOLD = (0.83, 0.68, 0.24)
BLANK = (0.42, 0.43, 0.44)
CH1_YELLOW = (0.95, 0.85, 0.10)
CH2_BLUE = (0.10, 0.60, 0.90)
USB_BLUE = (0.10, 0.25, 0.70)
ACCENT = (0.85, 0.10, 0.35)         # the ARB RIDER chevrons
VENT = (0.04, 0.04, 0.05)          # perforated side grille, read as a dark patch
REAR = (0.20, 0.21, 0.22)          # rear panel, lighter only to read as a face


def srgb_to_linear(c: tuple[float, float, float]) -> np.ndarray:
    a = np.asarray(c, dtype=float)
    return np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)


class Parts:
    """Accumulates (mesh, colour) pairs and welds them into one body."""

    def __init__(self) -> None:
        self._meshes: list[trimesh.Trimesh] = []

    def add(self, mesh: trimesh.Trimesh, color: tuple[float, float, float]) -> None:
        rgb = np.round(srgb_to_linear(color) * 255).astype(np.uint8)
        faces = np.empty((len(mesh.faces), 4), dtype=np.uint8)
        faces[:, :3] = rgb
        faces[:, 3] = 255
        mesh.visual.face_colors = faces
        self._meshes.append(mesh)

    def box(self, size, center, color) -> None:
        m = trimesh.creation.box(extents=size)
        m.apply_translation(center)
        self.add(m, color)

    def cyl(self, diameter, length, center, color, sections: int = 24) -> None:
        """Cylinder with its axis along +X."""
        m = trimesh.creation.cylinder(
            radius=diameter / 2.0, height=length, sections=sections
        )
        m.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [0, 1, 0]))
        m.apply_translation(center)
        self.add(m, color)

    def ring(self, d_in, d_out, length, center, color, sections: int = 32) -> None:
        m = trimesh.creation.annulus(
            r_min=d_in / 2.0, r_max=d_out / 2.0, height=length, sections=sections
        )
        m.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [0, 1, 0]))
        m.apply_translation(center)
        self.add(m, color)

    def result(self) -> trimesh.Trimesh:
        return trimesh.util.concatenate(self._meshes)


def _at(u: float, v: float, x: float) -> list[float]:
    """Panel (u, v) + a body-X depth -> a body-local centre."""
    return [x, u, Z_BOT + v]


def _plate(parts: Parts, u_span, v_span, x0: float, thickness: float, color) -> None:
    u0, u1 = u_span
    v0, v1 = v_span
    parts.box(
        (thickness, u1 - u0, v1 - v0),
        _at((u0 + u1) / 2.0, (v0 + v1) / 2.0, x0 + thickness / 2.0),
        color,
    )


def _sma(parts: Parts, u: float, v: float, ring_color=None) -> None:
    """A panel-mount SMA jack: hex body, threaded barrel, PTFE + centre pin."""
    if ring_color is not None:
        parts.ring(9.8, 13.4, 1.0, _at(u, v, X_SUB + 0.5), ring_color)
    parts.cyl(SMA_HEX_D, SMA_HEX_L, _at(u, v, X_SUB + SMA_HEX_L / 2.0), GOLD, sections=6)
    parts.cyl(
        SMA_BARREL_D,
        SMA_BARREL_L,
        _at(u, v, X_SUB + SMA_HEX_L + SMA_BARREL_L / 2.0),
        GOLD,
    )
    parts.cyl(4.1, 0.6, _at(u, v, SMA_TIP_X - 0.3), DARK, sections=16)
    parts.cyl(1.3, 1.0, _at(u, v, SMA_TIP_X - 0.2), GOLD, sections=12)


def _blank(parts: Parts, u: float, v: float) -> None:
    """An unpopulated channel position on the shared panel."""
    parts.cyl(SMA_HEX_D, 0.8, _at(u, v, X_SUB + 0.4), BLANK, sections=16)


def build() -> trimesh.Trimesh:
    p = Parts()

    # --- chassis, rear plate, feet -------------------------------------
    p.box(
        (DEPTH_MM, WIDTH_MM, HEIGHT_MM),
        [0.0, 0.0, Z_BOT + HEIGHT_MM / 2.0],
        SHELL,
    )
    p.box(
        (1.2, WIDTH_MM - 10.0, HEIGHT_MM - 10.0),
        [-X_FRONT - 0.6, 0.0, Z_BOT + HEIGHT_MM / 2.0],
        REAR,
    )
    for fx in (110.0, -110.0):
        for fy in (185.0, -185.0):
            p.box((44.0, 26.0, FOOT_H_MM), [fx, fy, FOOT_H_MM / 2.0], DARK)

    # --- right-side carry handle and vent grille ------------------------
    # The handle is bolted to the +Y side and puts the widest point of the
    # mesh at y = 254, past the datasheet's 445 mm W (which is the chassis
    # only). Keep that in mind for clearances.
    zc = Z_BOT + 67.0
    p.box((155.0, 14.0, 34.0), [-7.5, 247.0, zc], DARK)
    for hx in (-75.0, 60.0):
        p.box((20.0, 21.5, 30.0), [hx, 233.25, zc], DARK)
    p.box((0.6, 55.0, 95.0), [122.5, HALF_W + 0.3, Z_BOT + 67.5], VENT)

    # --- front bezel + plate --------------------------------------------
    # The shell is black, but the front face carries a white/silver bezel:
    # a full-face plate with the black panel sitting 0.5 mm proud of it, so
    # what shows is a ~3.5 mm frame down the sides and ~2.5 mm top/bottom.
    _plate(p, (-HALF_W, HALF_W), (0.0, HEIGHT_MM), X_FRONT, PANEL_T - 0.5, LABEL)
    _plate(p, (-HALF_W + 3.5, HALF_W - 3.5), (2.5, 132.5), X_FRONT, PANEL_T, PANEL)

    # --- 7" touch display ----------------------------------------------
    _plate(
        p,
        (LCD_C[0] - LCD_BEZEL[0] / 2, LCD_C[0] + LCD_BEZEL[0] / 2),
        (LCD_C[1] - LCD_BEZEL[1] / 2, LCD_C[1] + LCD_BEZEL[1] / 2),
        X_PANEL,
        0.6,
        SUBPANEL,
    )
    _plate(
        p,
        (LCD_C[0] - LCD_GLASS[0] / 2, LCD_C[0] + LCD_GLASS[0] / 2),
        (LCD_C[1] - LCD_GLASS[1] / 2, LCD_C[1] + LCD_GLASS[1] / 2),
        X_PANEL + 0.6,
        0.4,
        GLASS,
    )

    # --- branding hints (geometry only; the GLB carries no textures) ----
    p.box((0.6, 26.0, 3.0), _at(-150.0, 122.0, X_PANEL + 0.3), LABEL)
    p.box((0.6, 6.0, 6.0), _at(-186.0, 122.0, X_PANEL + 0.3), ACCENT)
    p.box((0.6, 52.0, 1.2), _at(-52.0, 118.0, X_PANEL + 0.3), CH2_BLUE)
    p.box((0.6, 10.0, 3.0), _at(-140.0, 13.0, X_PANEL + 0.3), ACCENT)

    # --- jog wheel, soft keys, keypad ----------------------------------
    p.ring(KNOB_D, KNOB_RING_D, 1.4, _at(*KNOB_C, X_PANEL + 0.7), CH2_BLUE)
    p.cyl(KNOB_D, 11.0, _at(*KNOB_C, X_PANEL + 5.5), DARK, sections=32)
    p.cyl(KNOB_D - 7.0, 2.0, _at(*KNOB_C, X_PANEL + 11.5), DARK, sections=32)

    for u, v in ((-5.2, 121.4), (39.4, 121.4), (-5.2, 69.5), (39.4, 69.5)):
        p.box((2.0, *SOFT_BTN), _at(u, v, X_PANEL + 1.0), BUTTON)
    p.cyl(7.0, 2.0, _at(17.6, 121.9, X_PANEL + 1.0), BUTTON, sections=16)

    for v in FUNC_V:
        for u in FUNC_U:
            p.box((2.0, *FUNC_BTN), _at(u, v, X_PANEL + 1.0), BUTTON)

    for v in KEYPAD_V:
        for u in KEYPAD_U:
            p.cyl(KEYPAD_D, 2.0, _at(u, v, X_PANEL + 1.0), BUTTON, sections=16)
    for u in (64.0, 80.0, 96.0):
        p.cyl(10.0, 2.0, _at(u, 17.1, X_PANEL + 1.0), BUTTON, sections=16)

    # --- CH n OUT / MOD n IN sub-panel ---------------------------------
    _plate(p, CHMOD_PLATE_U, CHMOD_PLATE_V, X_PANEL, SUBPLATE_T, SUBPANEL)
    _sma(p, CHAN_U[0], CH_V, CH1_YELLOW)
    _sma(p, CHAN_U[1], CH_V, CH2_BLUE)
    _sma(p, CHAN_U[0], MOD_V, CH1_YELLOW)
    _sma(p, CHAN_U[1], MOD_V, CH2_BLUE)
    for u in CHAN_U[2:]:
        _blank(p, u, CH_V)
        _blank(p, u, MOD_V)

    # --- MARKER OUTPUTS / TRIGGER INPUTS sub-panel ---------------------
    _plate(p, MARK_PLATE_U, MARK_PLATE_V, X_PANEL, SUBPLATE_T, SUBPANEL)
    for u, v in MARKER + TRIG:
        _sma(p, u, v)
    for u, v in MARKER_BLANK + TRIG_BLANK:
        _blank(p, u, v)

    # --- USB 3.0 ports and the power button ----------------------------
    for u in USB_U:
        p.box((1.6, 14.0, 7.0), _at(u, USB_V, X_PANEL + 0.8), DARK)
        p.box((0.8, 12.0, 3.0), _at(u, USB_V - 1.0, X_PANEL + 0.6), USB_BLUE)
    p.cyl(13.0, 1.2, _at(*POWER_C, X_PANEL + 0.6), SUBPANEL, sections=24)
    p.cyl(11.0, 4.0, _at(*POWER_C, X_PANEL + 2.6), DARK, sections=24)

    return p.result()


def set_material(path: str, metallic: float = 0.15, roughness: float = 0.55) -> None:
    """trimesh writes no material, so the viewer falls back to the glTF
    default (metallic 1.0) and the instrument renders dark and dull."""
    blob = open(path, "rb").read()
    j_len = struct.unpack("<I", blob[12:16])[0]
    doc = json.loads(blob[20:20 + j_len])
    rest = blob[20 + j_len:]
    doc["materials"] = [{"name": "awg7172",
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


if __name__ == "__main__":
    dst = sys.argv[1]
    mesh = build()
    trimesh.Scene(mesh).export(dst)
    set_material(dst)
    lo, hi = mesh.bounds
    print(f"{dst}: tris={len(mesh.faces)} bbox={np.round(hi - lo, 3).tolist()} mm "
          f"min={np.round(lo, 3).tolist()} max={np.round(hi, 3).tolist()}")
    print(f"  rf_out CH1 = ({SMA_TIP_X}, {CHAN_U[0]}, {Z_BOT + CH_V:.1f})")
    print(f"  rf_out CH2 = ({SMA_TIP_X}, {CHAN_U[1]}, {Z_BOT + CH_V:.1f})")
