"""3D sketch of the proposed AOM (MT80-A1.5-IR) Bragg alignment.

Component-local frame (matches user spec):
  D1 = in -> out          (component +y)
  D2 = RFin               (component -x)
  D3 = D1 x D2            (component +z)

Two states based on dot product of (in->out) with the incoming beam:
  State A: (in->out).beam > 0   ->  entry = "in",  align "in" anchor onto beam
  State B: (in->out).beam < 0   ->  entry = "out", align "out" anchor onto beam

Bragg condition (1-D rotation about D3, in the D1-D2 plane):
  sin(theta_B) = m*lambda*f_a / (2*V_a)

theta is exaggerated for visualization.
"""
import numpy as np
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D  # noqa: F401
from mpl_toolkits.mplot3d.art3d import Poly3DCollection

THETA_DEG = 12.0
theta = np.deg2rad(THETA_DEG)


def draw_state(ax, state):
    """Draw one state on a given 3D axis."""
    # Body box: half-extents along (D1, D2, D3) = (1.6, 0.5, 0.4)
    hx, hy, hz = 1.6, 0.5, 0.4

    # In component-local axes:
    #   D1 (in->out)  = +y  -> we draw it along world-x for visibility
    #   D2 (RFin)     = -x  -> we draw it along world-y
    #   D3 (D1 x D2)  = +z  -> we draw it along world-z
    # So in this plot:
    #   plot-x = D1 axis (in->out direction)
    #   plot-y = D2 axis (RFin direction)
    #   plot-z = D3 axis (D1 x D2)
    verts_box = [
        [(-hx, -hy, -hz), (+hx, -hy, -hz), (+hx, +hy, -hz), (-hx, +hy, -hz)],
        [(-hx, -hy, +hz), (+hx, -hy, +hz), (+hx, +hy, +hz), (-hx, +hy, +hz)],
        [(-hx, -hy, -hz), (+hx, -hy, -hz), (+hx, -hy, +hz), (-hx, -hy, +hz)],
        [(-hx, +hy, -hz), (+hx, +hy, -hz), (+hx, +hy, +hz), (-hx, +hy, +hz)],
        [(-hx, -hy, -hz), (-hx, +hy, -hz), (-hx, +hy, +hz), (-hx, -hy, +hz)],
        [(+hx, -hy, -hz), (+hx, +hy, -hz), (+hx, +hy, +hz), (+hx, -hy, +hz)],
    ]
    box = Poly3DCollection(verts_box, alpha=0.18, facecolor="#7aa6e0",
                           edgecolor="#234")
    ax.add_collection3d(box)

    # Anchor positions (in plot frame):
    in_anchor  = np.array([-hx, 0.0, 0.0])
    out_anchor = np.array([+hx, 0.0, 0.0])
    rf_anchor  = np.array([0.0, +hy, 0.0])
    ax.scatter(*in_anchor,  s=70, c="#1c64f2", depthshade=False, zorder=5)
    ax.scatter(*out_anchor, s=70, c="#1c64f2", depthshade=False, zorder=5)
    ax.scatter(*rf_anchor,  s=70, c="#d9480f", marker="s",
               depthshade=False, zorder=5)
    ax.text(*(in_anchor + [-0.25, -0.05, -0.35]),  "in",
            color="#1c64f2", fontsize=11, fontweight="bold")
    ax.text(*(out_anchor + [0.10, -0.05, -0.35]), "out",
            color="#1c64f2", fontsize=11, fontweight="bold")
    ax.text(*(rf_anchor + [0.05, 0.20, 0.05]), "RFin",
            color="#d9480f", fontsize=10)

    # Body axes (D1, D2, D3) drawn from the body centre.
    L = 1.0
    # D1 (in->out): plot +x
    ax.quiver(0, 0, 0, L, 0, 0, color="#0b6a3a", lw=2.2, arrow_length_ratio=0.15)
    ax.text(L + 0.05, -0.05, 0.05, r"$D_1$ (in$\to$out)", color="#0b6a3a", fontsize=10)
    # D2 (RFin): plot +y
    ax.quiver(0, 0, 0, 0, L * 0.7, 0, color="#9c1c8e", lw=2.2, arrow_length_ratio=0.18)
    ax.text(0.05, L * 0.72, 0.05, r"$D_2$ (RFin)", color="#9c1c8e", fontsize=10)
    # D3 (D1 x D2): plot +z
    ax.quiver(0, 0, 0, 0, 0, L * 0.6, color="#444", lw=2.2, arrow_length_ratio=0.2)
    ax.text(0.05, 0.05, L * 0.62, r"$D_3 = D_1\times D_2$", color="#444", fontsize=10)

    # Configure beam direction in the D1-D2 plane (no D3 component).
    if state == "A":
        # Beam roughly along +D1, tilted by +theta toward +D2
        # For order +1 we'd pick +theta; for -1 we'd pick -theta.
        beam = np.array([np.cos(theta), np.sin(theta), 0.0])
        entry = in_anchor
        title = (
            "State A: " + r"$(\mathrm{in}\!\to\!\mathrm{out})\cdot\hat{\mathbf{k}}>0$"
            + "\nentry = in   |   "
            + r"$\angle(D_1,\hat{\mathbf{k}})=\theta_B$"
        )
    else:
        # Beam roughly along -D1, tilted by +theta toward +D2.
        beam = np.array([-np.cos(theta), np.sin(theta), 0.0])
        entry = out_anchor
        title = (
            "State B: " + r"$(\mathrm{in}\!\to\!\mathrm{out})\cdot\hat{\mathbf{k}}<0$"
            + "\nentry = out   |   "
            + r"$\angle(-D_1,\hat{\mathbf{k}})=\theta_B$"
        )

    # Incoming beam: tail (upstream) -> entry anchor
    L_in = 2.5
    tail = entry - beam * L_in
    ax.quiver(*tail, *(entry - tail), color="#cc2b1f", lw=2.4,
              arrow_length_ratio=0.06)
    ax.text(*(tail + np.array([0.05, -0.15, 0.05])), "incoming beam",
            color="#cc2b1f", fontsize=10, fontweight="bold")

    # Through-body 0th order (dashed, same direction)
    L_thru = 2.6
    head_0 = entry + beam * L_thru
    ax.plot([entry[0], head_0[0]], [entry[1], head_0[1]],
            [entry[2], head_0[2]], color="#888", lw=1.0, ls="--")
    ax.text(*(head_0 + np.array([0.05, 0.0, 0.10])), "0th",
            color="#888", fontsize=9)

    # +1 order (rotate beam by +2*theta around D3)
    R_plus = np.array([
        [np.cos(2 * theta), -np.sin(2 * theta), 0],
        [np.sin(2 * theta),  np.cos(2 * theta), 0],
        [0, 0, 1],
    ])
    R_minus = np.array([
        [np.cos(-2 * theta), -np.sin(-2 * theta), 0],
        [np.sin(-2 * theta),  np.cos(-2 * theta), 0],
        [0, 0, 1],
    ])
    plus_dir  = R_plus  @ beam
    minus_dir = R_minus @ beam
    head_p = entry + plus_dir  * L_thru
    head_m = entry + minus_dir * L_thru
    ax.quiver(*entry, *(head_p - entry), color="#0b8a3a", lw=1.8,
              arrow_length_ratio=0.07)
    ax.text(*(head_p + np.array([0.05, 0.05, 0.10])), "+1 order",
            color="#0b8a3a", fontsize=10, fontweight="bold")
    ax.quiver(*entry, *(head_m - entry), color="#7a4ad6", lw=1.8,
              arrow_length_ratio=0.07)
    ax.text(*(head_m + np.array([0.05, -0.05, -0.20])), "-1 order",
            color="#7a4ad6", fontsize=10, fontweight="bold")

    # Highlight that the rotation axis is D3 (out of D1-D2 plane).
    # Draw a small curved arrow segment around D3 to indicate rotation freedom.
    th = np.linspace(np.pi * 0.1, np.pi * 0.9, 30)
    rad = 0.55
    arc_x = rad * np.cos(th)
    arc_y = rad * np.sin(th)
    arc_z = np.full_like(th, hz + 0.05)
    ax.plot(arc_x, arc_y, arc_z, color="#444", lw=1.0, alpha=0.6)
    ax.text(0, 0.62, hz + 0.18, r"rotate about $D_3$",
            color="#444", fontsize=9, alpha=0.8)

    # Equal aspect, viewing angle, limits.
    R = 3.0
    ax.set_xlim(-R, R); ax.set_ylim(-R, R); ax.set_zlim(-R * 0.6, R * 0.6)
    ax.set_box_aspect((1, 1, 0.6))
    ax.view_init(elev=22, azim=-55)
    ax.set_xticks([]); ax.set_yticks([]); ax.set_zticks([])
    ax.set_xlabel(""); ax.set_ylabel(""); ax.set_zlabel("")
    ax.set_title(title, fontsize=11, pad=10)
    # Hide axis panes for cleanliness
    for pane in (ax.xaxis.pane, ax.yaxis.pane, ax.zaxis.pane):
        pane.fill = False
        pane.set_edgecolor("#cccccc")


fig = plt.figure(figsize=(15, 7.5))
ax_a = fig.add_subplot(1, 2, 1, projection="3d")
ax_b = fig.add_subplot(1, 2, 2, projection="3d")
draw_state(ax_a, "A")
draw_state(ax_b, "B")
fig.suptitle(
    "AOM (MT80-A1.5-IR) Bragg alignment — proposed logic   "
    + r"($\sin\theta_B = m\lambda f_a / (2 V_a)$, $\theta$ exaggerated)",
    fontsize=12,
)
plt.tight_layout(rect=[0, 0, 1, 0.95])
out_path = r"C:\Users\admin\OneDrive\桌面\YX\QMsimulation\qmem-digital-twin\docs\aom_align_3d.png"
plt.savefig(out_path, dpi=140, bbox_inches="tight")
print(f"Saved: {out_path}")
