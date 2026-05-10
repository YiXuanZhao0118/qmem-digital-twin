"""3D illustration of the corrected Bragg angle definition for AOM.

User correction:
  theta_B is the angle between beam and the D1-D3 plane,
  equivalently sin(theta_B) = beam . D2 (D2 is the plane normal = RFin axis).

Compared with "angle(beam, D1) = theta_B", this definition:
  * Allows beam to have D3 component (out-of-D1D2-plane).
  * Bragg constraint is purely on the D2 component of the beam direction.
  * Rotating body about D3 does not change beam's D3 component, so the
    1-DoF rotation can always satisfy the constraint as long as the
    beam isn't pure-D2.

Stage 1 of the align (snap optical axis parallel to beam) sets beam to
pure +D1 in body frame, so the two definitions coincide there. After the
stage-2 Bragg rotation by theta_B about D3, beam in body frame =
cos(theta_B)*D1 + sin(theta_B)*D2 (still in the D1-D2 plane, but more
generally beam may pick up D3 component if the body is later rotated by
the user about a non-D3 axis).

theta is exaggerated to ~15 deg for visualization.
"""
import numpy as np
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection


THETA_DEG = 15.0
theta = np.deg2rad(THETA_DEG)


def setup_axes(ax):
    R = 1.6
    ax.set_xlim(-R, R); ax.set_ylim(-R, R); ax.set_zlim(-R, R)
    ax.set_box_aspect((1, 1, 1))
    ax.view_init(elev=18, azim=-52)
    ax.set_xticks([]); ax.set_yticks([]); ax.set_zticks([])
    for pane in (ax.xaxis.pane, ax.yaxis.pane, ax.zaxis.pane):
        pane.fill = False
        pane.set_edgecolor("#cccccc")


fig = plt.figure(figsize=(11, 9))
ax = fig.add_subplot(1, 1, 1, projection="3d")
setup_axes(ax)

# In the plot: D1 = +x, D2 = +y, D3 = +z (matches user's component frame
# under the relabeling D1=in->out, D2=RFin, D3=D1xD2).

# 1. D1-D3 plane (the Bragg plane = plane perpendicular to D2).
plane_size = 1.2
plane_verts = [[
    (-plane_size, 0, -plane_size),
    (+plane_size, 0, -plane_size),
    (+plane_size, 0, +plane_size),
    (-plane_size, 0, +plane_size),
]]
plane = Poly3DCollection(plane_verts, alpha=0.25, facecolor="#ffd6a8",
                         edgecolor="#c97200", lw=1.0)
ax.add_collection3d(plane)
ax.text(plane_size + 0.05, 0, plane_size, r"$D_1$-$D_3$ plane",
        color="#c97200", fontsize=11)

# 2. Body axes
L = 1.1
ax.quiver(0, 0, 0, L, 0, 0, color="#0b6a3a", lw=2.4, arrow_length_ratio=0.12)
ax.text(L + 0.04, -0.05, 0.04, r"$D_1$ (in$\to$out)",
        color="#0b6a3a", fontsize=11)
ax.quiver(0, 0, 0, 0, L * 0.7, 0, color="#9c1c8e", lw=2.4, arrow_length_ratio=0.18)
ax.text(0.05, L * 0.72, 0.05, r"$D_2$ (RFin)  -- plane normal",
        color="#9c1c8e", fontsize=11)
ax.quiver(0, 0, 0, 0, 0, L * 0.85, color="#444", lw=2.4, arrow_length_ratio=0.15)
ax.text(0.05, 0.05, L * 0.88, r"$D_3 = D_1\times D_2$",
        color="#444", fontsize=11)

# 3. Beam direction at angle theta from D1-D3 plane.
#    For visualization we tilt beam toward +D2 by theta; pick D3 component = 0
#    (i.e., beam in D1-D2 plane) so this matches the post-stage-1 case.
beam = np.array([np.cos(theta), np.sin(theta), 0.0])
# Draw beam through origin, full length on both sides.
beam_len = 1.4
tail = -beam * beam_len
head = +beam * beam_len
ax.quiver(*tail, *(head - tail), color="#cc2b1f", lw=2.4, arrow_length_ratio=0.06)
ax.text(*(tail + np.array([-0.10, -0.05, -0.10])), "incoming beam",
        color="#cc2b1f", fontsize=11, fontweight="bold")

# 4. Beam projection onto the D1-D3 plane: drop perpendicular from beam
#    head to the plane (which is y=0 plane). Foot = (beam_x, 0, beam_z) * len.
foot = np.array([beam[0], 0.0, beam[2]]) * beam_len
ax.plot([head[0], foot[0]], [head[1], foot[1]], [head[2], foot[2]],
        color="#9c1c8e", ls="--", lw=1.4)
ax.plot([0, foot[0]], [0, foot[1]], [0, foot[2]],
        color="#c97200", lw=1.5)
ax.text(*(foot + np.array([0.05, -0.02, -0.10])),
        "beam projected on $D_1$-$D_3$ plane",
        color="#c97200", fontsize=9)

# 5. Angle marker for theta_B (between beam and its plane projection).
arc_pts = []
for s in np.linspace(0, 1, 30):
    v = (1 - s) * beam + s * np.array([beam[0], 0.0, beam[2]])
    v = v / np.linalg.norm(v) * 0.5
    arc_pts.append(v)
arc_pts = np.array(arc_pts)
ax.plot(arc_pts[:, 0], arc_pts[:, 1], arc_pts[:, 2],
        color="#cc2b1f", lw=1.6)
mid = arc_pts[len(arc_pts) // 2]
ax.text(mid[0] + 0.05, mid[1] + 0.05, mid[2],
        r"$\theta_B$", color="#cc2b1f", fontsize=14)

# 6. Annotation: equation
ax.text2D(0.02, 0.95,
          r"$\theta_B = \angle(\hat{\mathbf{k}}_{\mathrm{beam}},\ D_1\text{-}D_3\ \mathrm{plane})$"
          + "\n"
          + r"$\Longleftrightarrow\ \hat{\mathbf{k}}_{\mathrm{beam}}\cdot\hat{D}_2 = \sin\theta_B$"
          + "\n\n"
          + r"$\sin\theta_B = m\lambda f_a / (2 V_a)$",
          transform=ax.transAxes, fontsize=12, verticalalignment="top",
          bbox=dict(boxstyle="round,pad=0.4",
                    facecolor="#fff8d6", edgecolor="#b08900"))

ax.set_title("Bragg angle = beam vs $D_1$-$D_3$ plane (not vs $D_1$ alone)",
             fontsize=12, pad=10)

out_path = r"C:\Users\admin\OneDrive\桌面\YX\QMsimulation\qmem-digital-twin\docs\aom_align_theta_def.png"
plt.savefig(out_path, dpi=140, bbox_inches="tight")
print(f"Saved: {out_path}")
