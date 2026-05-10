"""All diffraction orders out of the AOM after Bragg-aligned input.

Setup:
  Input beam enters with beam.D2 = +sin(theta_B)  (Bragg-tilted).
  Each order m's output = input rotated by m*2*theta_B around D3.
  beam.D3 is preserved through every order.

Orders shown: 0, +-1, +-2 (the panel can show up to maxDiffractionOrder).

Two views:
  Left  : 3D — body, input, all orders, with D3 axis emphasised.
  Right : 2D top-down (looking along +D3) — clean angular spacing.

theta exaggerated to ~10 deg for visualization.
"""
import numpy as np
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection
from matplotlib.patches import Rectangle, Arc


THETA_DEG = 10.0
theta = np.deg2rad(THETA_DEG)
HALF_D1 = 1.4
HALF_D2 = 0.45
HALF_D3 = 0.30


def order_color(m):
    return {
        0: "#888888",
        +1: "#0b8a3a",
        -1: "#7a4ad6",
        +2: "#0099cc",
        -2: "#d97706",
        +3: "#005f99",
        -3: "#aa3300",
    }.get(m, "#444")


def order_label(m):
    return ("+" if m > 0 else ("" if m == 0 else "-")) + str(abs(m))


# Input direction: Bragg-correct geometry for user-selected m=+1.
# rayTrace.ts rotates output by +m*2*theta_B around D3, so for m=+1 to land
# on the Bragg-mirror image of the input (the physical "+1 reflected" order),
# the INPUT must enter at -theta_B (toward -D2). After +2*theta_B rotation,
# the m=+1 output is at +theta_B (mirror). With existing align convention
# (expectedSinTheta = +sin(theta_B)) the input is on the WRONG side, so
# m=+1 lands at +3*theta_B (off-Bragg) -- this is the user's reported bug.
input_dir = np.array([np.cos(theta), -np.sin(theta), 0.0])

# Each order m: output = input rotated by m*2*theta around D3 axis (= +z body).
def rotate_about_d3(v, ang):
    c, s = np.cos(ang), np.sin(ang)
    return np.array([c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]])


orders = [-2, -1, 0, +1, +2]

# === Figure ===
fig = plt.figure(figsize=(15, 7.5))
fig.suptitle(
    "AOM diffraction orders — output = input rotated by $m\\cdot 2\\theta_B$ about $D_3$\n"
    "($\\hat{\\mathbf{k}}\\cdot D_3$ preserved for every order)",
    fontsize=12,
)

# --- Panel A: 3D body + orders ---
ax = fig.add_subplot(1, 2, 1, projection="3d")
R = 2.6
ax.set_xlim(-R, R); ax.set_ylim(-R, R); ax.set_zlim(-R * 0.6, R * 0.6)
ax.set_box_aspect((1, 1, 0.55))
ax.view_init(elev=25, azim=-58)
ax.set_xticks([]); ax.set_yticks([]); ax.set_zticks([])
for pane in (ax.xaxis.pane, ax.yaxis.pane, ax.zaxis.pane):
    pane.fill = False; pane.set_edgecolor("#e0e0e0")
ax.set_title("3D view — body in canonical pose, orders fan out in $D_1$-$D_2$ plane",
             fontsize=10, pad=4)

# Body box (axes aligned to plot axes since body is in canonical pose):
hx, hy, hz = HALF_D1, HALF_D2, HALF_D3
faces = [
    [(-hx, -hy, -hz), (+hx, -hy, -hz), (+hx, +hy, -hz), (-hx, +hy, -hz)],
    [(-hx, -hy, +hz), (+hx, -hy, +hz), (+hx, +hy, +hz), (-hx, +hy, +hz)],
    [(-hx, -hy, -hz), (+hx, -hy, -hz), (+hx, -hy, +hz), (-hx, -hy, +hz)],
    [(-hx, +hy, -hz), (+hx, +hy, -hz), (+hx, +hy, +hz), (-hx, +hy, +hz)],
    [(-hx, -hy, -hz), (-hx, +hy, -hz), (-hx, +hy, +hz), (-hx, -hy, +hz)],
    [(+hx, -hy, -hz), (+hx, +hy, -hz), (+hx, +hy, +hz), (+hx, -hy, +hz)],
]
ax.add_collection3d(Poly3DCollection(faces, alpha=0.18, facecolor="#7aa6e0",
                                     edgecolor="#234"))
ax.scatter(-HALF_D1, 0, 0, s=60, c="#1c64f2")
ax.scatter(+HALF_D1, 0, 0, s=60, c="#1c64f2")
ax.scatter(0, +HALF_D2, 0, s=60, c="#d9480f", marker="s")
ax.text(-HALF_D1 - 0.15, 0, -0.25, "in", color="#1c64f2", fontsize=10, fontweight="bold")
ax.text(+HALF_D1 + 0.05, 0, -0.25, "out", color="#1c64f2", fontsize=10, fontweight="bold")
ax.text(0, HALF_D2 + 0.10, 0.05, "RFin", color="#d9480f", fontsize=9)

# Body axes
ax.quiver(0, 0, 0, 1.0, 0, 0, color="#0b6a3a", lw=2.0, arrow_length_ratio=0.13)
ax.quiver(0, 0, 0, 0, 0.7, 0, color="#9c1c8e", lw=2.0, arrow_length_ratio=0.18)
ax.quiver(0, 0, 0, 0, 0, 0.6, color="#444", lw=2.0, arrow_length_ratio=0.18)
ax.text(1.05, 0, 0.05, "$D_1$", color="#0b6a3a", fontsize=10)
ax.text(0, 0.75, 0.05, "$D_2$", color="#9c1c8e", fontsize=10)
ax.text(0, 0, 0.65, "$D_3$ (rotation axis)", color="#444", fontsize=9)

# Input beam (red): from upstream tail to body centre.
L_in = 2.2
tail = -input_dir * L_in
ax.quiver(*tail, *(input_dir * L_in), color="#cc2b1f", lw=2.4,
          arrow_length_ratio=0.06)
ax.text(*(tail + np.array([-0.05, -0.1, 0.10])),
        "input  ($\\hat{\\mathbf{k}}\\cdot \\hat{D}_2 = \\sin\\theta_B$)",
        color="#cc2b1f", fontsize=9, fontweight="bold")

# Each order: output = input rotated by m*2*theta about D3.
L_out = 2.4
for m in orders:
    out = rotate_about_d3(input_dir, m * 2 * theta)
    head = out * L_out
    col = order_color(m)
    ls = "--" if m == 0 else "-"
    ax.quiver(0, 0, 0, *head, color=col, lw=1.7, arrow_length_ratio=0.07,
              linestyle=ls)
    lbl = order_label(m)
    ax.text(head[0] * 1.05, head[1] * 1.05, head[2] + 0.08, lbl,
            color=col, fontsize=10, fontweight="bold")

# Highlight the D1-D2 plane (where all orders fan out).
plane_pts = np.array([
    [-2.5, -2.5, 0], [+2.5, -2.5, 0], [+2.5, +2.5, 0], [-2.5, +2.5, 0],
])
ax.add_collection3d(Poly3DCollection([plane_pts.tolist()],
                                     alpha=0.05, facecolor="#444",
                                     edgecolor="none"))

# --- Panel B: 2D top-down view (look along +D3) ---
ax2 = fig.add_subplot(1, 2, 2)
ax2.set_aspect("equal")
ax2.set_xlim(-3.5, 3.5)
ax2.set_ylim(-2.5, 2.5)
ax2.axis("off")
ax2.set_title("Top-down (look along $+D_3$) — fan of orders in the $D_1$-$D_2$ plane",
              fontsize=10, pad=4)

# Body rectangle
ax2.add_patch(Rectangle((-HALF_D1, -HALF_D2), 2 * HALF_D1, 2 * HALF_D2,
                        facecolor="#dde6f5", edgecolor="#234", lw=1.2, zorder=2))
ax2.plot(-HALF_D1, 0, "o", color="#1c64f2", markersize=8)
ax2.plot(+HALF_D1, 0, "o", color="#1c64f2", markersize=8)
ax2.plot(0, +HALF_D2, "s", color="#d9480f", markersize=9)
ax2.text(-HALF_D1, -HALF_D2 - 0.20, "in", color="#1c64f2",
         fontsize=10, fontweight="bold", ha="center")
ax2.text(+HALF_D1, -HALF_D2 - 0.20, "out", color="#1c64f2",
         fontsize=10, fontweight="bold", ha="center")
ax2.text(0.20, HALF_D2 + 0.10, "RFin", color="#d9480f", fontsize=9)

# Body axes (D1, D2). D3 is out of page (shown as circle-dot).
ax2.annotate("", xy=(0.95, 0), xytext=(0, 0),
             arrowprops=dict(arrowstyle="->", color="#0b6a3a", lw=1.8))
ax2.text(0.97, 0.06, "$D_1$", color="#0b6a3a", fontsize=10)
ax2.annotate("", xy=(0, 0.40), xytext=(0, 0),
             arrowprops=dict(arrowstyle="->", color="#9c1c8e", lw=1.8))
ax2.text(0.05, 0.42, "$D_2$", color="#9c1c8e", fontsize=10)
# D3 marker (out of page)
from matplotlib.patches import Circle
ax2.add_patch(Circle((-0.95, 0.30), 0.07, facecolor="white", edgecolor="#444", lw=1.0))
ax2.add_patch(Circle((-0.95, 0.30), 0.018, facecolor="#444"))
ax2.text(-0.85, 0.28, "$D_3$ (out)", color="#444", fontsize=8)

# Input
L_in2 = 2.6
in2 = input_dir[:2]
tail2 = -in2 * L_in2
ax2.annotate("", xy=(0, 0), xytext=tail2,
             arrowprops=dict(arrowstyle="->", color="#cc2b1f", lw=2.2))
ax2.text(tail2[0] + 0.05, tail2[1] + 0.12,
         f"input  ($-\\theta_B={-THETA_DEG:.0f}^\\circ$ from $D_1$)\n"
         f"(Bragg-correct for $m=+1$)",
         color="#cc2b1f", fontsize=9, fontweight="bold")

# Mark theta_B between input and D1 (input is below D1 axis now)
ax2.add_patch(Arc((0, 0), 1.4, 1.4, angle=0,
                  theta1=180 - THETA_DEG, theta2=180,
                  color="#cc2b1f", lw=1.4))
ax2.text(-0.85, 0.10, "$\\theta_B$", color="#cc2b1f", fontsize=11)

# Orders
L_out2 = 2.8
for m in orders:
    out = rotate_about_d3(input_dir, m * 2 * theta)[:2]
    head = out * L_out2
    col = order_color(m)
    ls = "--" if m == 0 else "-"
    ax2.annotate("", xy=head, xytext=(0, 0),
                 arrowprops=dict(arrowstyle="->", color=col, lw=1.6,
                                 linestyle=ls))
    # input at -theta_B; deflection = m*2*theta_B; output = -theta_B + m*2*theta_B
    deflection_deg = (-THETA_DEG + m * 2 * THETA_DEG)
    lbl = (f"$m={order_label(m)}$\n($\\theta_{{out}}={deflection_deg:+.0f}^\\circ$)")
    ax2.text(head[0] * 1.05, head[1] * 1.05 + (0.18 if m >= 0 else -0.18),
             lbl, color=col, fontsize=9, fontweight="bold",
             ha="left" if head[0] >= 0 else "right",
             va="bottom" if head[1] >= 0 else "top")

# Equation reference
ax2.text(0.5, -0.02,
         r"$\theta_{\rm out}^{(m)} = -\theta_B + 2m\,\theta_B$  (input at $-\theta_B$, deflect $+2m\theta_B$ about $D_3$)"
         "    " r"$\sin\theta_B = \lambda f_a / (2 V_a)$",
         transform=ax2.transAxes, fontsize=10, ha="center",
         bbox=dict(boxstyle="round,pad=0.3", facecolor="#fff8d6",
                   edgecolor="#b08900"))
# Highlight Bragg-mirror condition for m=+1
ax2.text(0.5, 0.96,
         "Bragg-mirror geometry: input at $-\\theta_B$, $m\\!=\\!+1$ output at $+\\theta_B$ (symmetric across $D_1$-$D_3$ plane)",
         transform=ax2.transAxes, fontsize=10, ha="center",
         color="#0b6a3a", fontweight="bold")

plt.tight_layout(rect=[0, 0.03, 1, 0.94])
out_path = r"C:\Users\admin\OneDrive\桌面\YX\QMsimulation\qmem-digital-twin\docs\aom_orders.png"
plt.savefig(out_path, dpi=140, bbox_inches="tight")
print(f"Saved: {out_path}")
