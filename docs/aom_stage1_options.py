"""Visual comparison of three Stage 1 rotation choices for the AOM align.

Setup:
  - Lab axes: X right, Y depth, Z up.
  - Beam is tilted out of the horizontal plane (has both lab+x and lab+z
    components) so the three options give visibly different body poses.
  - Initial body pose: D1=lab+y, D2=lab-x, D3=lab+z (canonical MT80 pose).

Three Stage 1 options:
  (a) Minimum-angle rotation: axis = D1_init x beam_unit, angle = acos(...).
      Applies the same rotation to D2 and D3 -- the absolute least
      disturbance from current pose.

  (b) Keep D3 closest to lab+z (AOM "upright"):
      D3 = normalize(lab_z - (lab_z . D1_new) D1_new),  D2 = D3 x D1_new.
      Keeps the AOM body rolling-stable on the table even when the beam
      is not perfectly horizontal.

  (c) Keep D2 closest to current D2 in lab:
      D2 = normalize(D2_init - (D2_init . D1_new) D1_new), D3 = D1_new x D2.
      Preserves where the RFin port faces in lab.
"""
import numpy as np
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection


def setup(ax, title):
    R = 1.4
    ax.set_xlim(-R, R); ax.set_ylim(-R, R); ax.set_zlim(-R, R)
    ax.set_box_aspect((1, 1, 1))
    ax.view_init(elev=18, azim=-50)
    ax.set_xticks([]); ax.set_yticks([]); ax.set_zticks([])
    for pane in (ax.xaxis.pane, ax.yaxis.pane, ax.zaxis.pane):
        pane.fill = False; pane.set_edgecolor("#dddddd")
    ax.set_title(title, fontsize=10, pad=4)


def draw_lab_axes(ax):
    L = 1.1
    ax.quiver(0, 0, 0, L, 0, 0, color="#888", lw=1.0, arrow_length_ratio=0.08, alpha=0.6)
    ax.quiver(0, 0, 0, 0, L, 0, color="#888", lw=1.0, arrow_length_ratio=0.08, alpha=0.6)
    ax.quiver(0, 0, 0, 0, 0, L, color="#888", lw=1.0, arrow_length_ratio=0.08, alpha=0.6)
    ax.text(L + 0.04, 0, 0, "lab X", color="#888", fontsize=8)
    ax.text(0, L + 0.04, 0, "lab Y", color="#888", fontsize=8)
    ax.text(0, 0, L + 0.06, "lab Z", color="#888", fontsize=8)


def draw_body(ax, D1, D2, D3, label_prefix=""):
    """Draw body box and D1/D2/D3 axes given orthonormal columns."""
    hx, hy, hz = 1.0, 0.30, 0.25
    pts = []
    for sx in (-1, +1):
        for sy in (-1, +1):
            for sz in (-1, +1):
                p = sx * hx * D1 + sy * hy * D2 + sz * hz * D3
                pts.append(p)
    pts = np.array(pts)
    faces_idx = [
        [0, 1, 3, 2], [4, 5, 7, 6],
        [0, 1, 5, 4], [2, 3, 7, 6],
        [0, 2, 6, 4], [1, 3, 7, 5],
    ]
    verts = [[pts[i] for i in face] for face in faces_idx]
    box = Poly3DCollection(verts, alpha=0.20, facecolor="#7aa6e0", edgecolor="#234")
    ax.add_collection3d(box)
    L = 0.95
    ax.quiver(0, 0, 0, *(L * D1), color="#0b6a3a", lw=2.0, arrow_length_ratio=0.13)
    ax.quiver(0, 0, 0, *(L * 0.65 * D2), color="#9c1c8e", lw=2.0, arrow_length_ratio=0.18)
    ax.quiver(0, 0, 0, *(L * 0.85 * D3), color="#222", lw=2.0, arrow_length_ratio=0.16)
    ax.text(*(L * D1 * 1.05), f"{label_prefix}$D_1$", color="#0b6a3a", fontsize=10)
    ax.text(*(L * 0.7 * D2 * 1.05), f"{label_prefix}$D_2$", color="#9c1c8e", fontsize=10)
    ax.text(*(L * 0.9 * D3 * 1.05), f"{label_prefix}$D_3$", color="#222", fontsize=10)


def draw_beam(ax, beam, length=1.3):
    tail = -beam * length
    head = +beam * length
    ax.quiver(*tail, *(head - tail), color="#cc2b1f", lw=2.4, arrow_length_ratio=0.06)
    ax.text(*(tail + np.array([-0.05, -0.05, -0.18])), "beam",
            color="#cc2b1f", fontsize=10, fontweight="bold")


def normalize(v):
    return v / np.linalg.norm(v)


# ------------ Setup ------------
# Beam: tilted in lab so neither lab+y aligned nor purely horizontal.
#   45 deg yaw around lab z, then 20 deg pitch up.
yaw = np.deg2rad(35.0)
pitch = np.deg2rad(20.0)
beam = np.array([
    np.cos(pitch) * np.sin(yaw),
    np.cos(pitch) * np.cos(yaw),
    np.sin(pitch),
])
beam = normalize(beam)

# Initial body pose: D1=lab+y, D2=lab-x, D3=lab+z (canonical MT80 spec).
D1_init = np.array([0.0, 1.0, 0.0])
D2_init = np.array([-1.0, 0.0, 0.0])
D3_init = np.array([0.0, 0.0, 1.0])

# Option (a): minimum rotation that takes D1_init -> beam.
def option_a(D1, D2, D3, beam):
    cos_t = np.clip(np.dot(D1, beam), -1, 1)
    angle = np.arccos(cos_t)
    axis = np.cross(D1, beam)
    if np.linalg.norm(axis) < 1e-9:
        return D1.copy(), D2.copy(), D3.copy()
    axis = normalize(axis)
    K = np.array([
        [0, -axis[2], axis[1]],
        [axis[2], 0, -axis[0]],
        [-axis[1], axis[0], 0],
    ])
    R = np.eye(3) + np.sin(angle) * K + (1 - np.cos(angle)) * (K @ K)
    return R @ D1, R @ D2, R @ D3


def option_b(D1, D2, D3, beam):
    """Stage 1 with D3 closest to lab+z."""
    D1_new = beam.copy()
    z_lab = np.array([0.0, 0.0, 1.0])
    D3_new = z_lab - np.dot(z_lab, D1_new) * D1_new
    D3_new = normalize(D3_new)
    D2_new = np.cross(D3_new, D1_new)
    return D1_new, D2_new, D3_new


def option_c(D1, D2, D3, beam):
    """Stage 1 with D2 closest to current D2 in lab."""
    D1_new = beam.copy()
    D2_new = D2 - np.dot(D2, D1_new) * D1_new
    if np.linalg.norm(D2_new) < 1e-9:
        # Fallback: any vector perpendicular to D1
        D2_new = np.cross(D1_new, np.array([0, 0, 1]))
    D2_new = normalize(D2_new)
    D3_new = np.cross(D1_new, D2_new)
    return D1_new, D2_new, D3_new


D1a, D2a, D3a = option_a(D1_init, D2_init, D3_init, beam)
D1b, D2b, D3b = option_b(D1_init, D2_init, D3_init, beam)
D1c, D2c, D3c = option_c(D1_init, D2_init, D3_init, beam)

fig = plt.figure(figsize=(16, 5.2))
fig.suptitle(
    "Stage 1 rotation choices — same initial pose, same tilted beam, different resulting body orientation\n"
    r"(D1 ends up parallel to beam in all three; D2/D3 differ — affects the lab pose of RFin axis and roll)",
    fontsize=11,
)

panels = [
    ("(a) minimum-angle rotation", D1a, D2a, D3a),
    ("(b) keep $D_3$ closest to lab+Z (upright)", D1b, D2b, D3b),
    ("(c) keep $D_2$ closest to current $D_2$ in lab", D1c, D2c, D3c),
]
for i, (title, D1, D2, D3) in enumerate(panels):
    ax = fig.add_subplot(1, 3, i + 1, projection="3d")
    setup(ax, title)
    draw_lab_axes(ax)
    draw_beam(ax, beam)
    draw_body(ax, D1, D2, D3)
    # Show lab z reference line for option (b) clarity.
    ax.plot([0, 0], [0, 0], [-1.2, 1.2], color="#888", ls=":", lw=1.0, alpha=0.5)
    # Annotate D3 deviation from lab z.
    z_lab = np.array([0, 0, 1])
    cosD3z = np.clip(np.dot(D3, z_lab), -1, 1)
    angD3z = np.degrees(np.arccos(abs(cosD3z)))
    cosD2x = np.clip(np.dot(D2, np.array([-1, 0, 0])), -1, 1)
    angD2x = np.degrees(np.arccos(abs(cosD2x)))
    ax.text2D(0.02, 0.98,
              f"$\\angle(D_3, \\mathrm{{lab}}\\,Z)={angD3z:.1f}^\\circ$\n"
              f"$\\angle(D_2, \\mathrm{{lab}}-X)={angD2x:.1f}^\\circ$",
              transform=ax.transAxes, fontsize=8, va="top",
              bbox=dict(boxstyle="round,pad=0.25",
                        facecolor="#fff8d6", edgecolor="#b08900"))

plt.tight_layout(rect=[0, 0, 1, 0.93])
out_path = r"C:\Users\admin\OneDrive\桌面\YX\QMsimulation\qmem-digital-twin\docs\aom_stage1_options.png"
plt.savefig(out_path, dpi=140, bbox_inches="tight")
print(f"Saved: {out_path}")
