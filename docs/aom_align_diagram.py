"""Generate a sketch of the proposed AOM alignment logic for user confirmation.

Component frame (MT80-A1.5-IR):
  D1 = in -> out direction         (component +y)
  D2 = RFin direction              (component -x)
  D3 = D1 x D2                     (component +z, into page in 2D view)

Two states based on whether the incoming beam roughly co-flows or counter-flows
with D1:

  State A:  (in->out) . beam > 0   ->  align "in" port onto beam
  State B:  (in->out) . beam < 0   ->  align "out" port onto beam

Bragg condition (1D rotation about D3, in the D1-D2 plane):
  sin(theta_B) = m * lambda / (2 * Lambda) = m * lambda * f_a / (2 * V_a)

This script draws both states with a deliberately exaggerated theta (~10 deg)
so the geometry is readable; a real AOM has theta_B of a few mrad.
"""
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, Rectangle, Circle
from matplotlib.lines import Line2D

# Exaggerated Bragg angle for visualization
THETA_DEG = 10.0
theta = np.deg2rad(THETA_DEG)

fig, axes = plt.subplots(1, 2, figsize=(14, 7))
fig.suptitle(
    "AOM (MT80-A1.5-IR) Bragg Alignment — proposed logic\n"
    r"D1 = in$\rightarrow$out (+y),  D2 = RFin ($-$x),  D3 = D1$\times$D2 (+z, out of page)",
    fontsize=13,
)

def draw_aom_body(ax, x0=0.0, y0=0.0, label_in="in", label_out="out"):
    """Draw the AOM crystal body and its in/out anchors.

    The body is drawn as a rectangle in the D1-D2 plane (D3 out of page).
    in -> out is along +D1 (rightward in the rotated panel view).
    RFin (acoustic source) is along D2 (upward).
    """
    half_d1 = 1.5
    half_d2 = 0.6
    rect = Rectangle(
        (x0 - half_d1, y0 - half_d2),
        2 * half_d1,
        2 * half_d2,
        linewidth=1.2,
        edgecolor="#444",
        facecolor="#dde6f5",
        zorder=2,
    )
    ax.add_patch(rect)

    in_pt = (x0 - half_d1, y0)
    out_pt = (x0 + half_d1, y0)
    rf_pt = (x0, y0 + half_d2)

    ax.plot(*in_pt, "o", color="#1c64f2", markersize=8, zorder=4)
    ax.plot(*out_pt, "o", color="#1c64f2", markersize=8, zorder=4)
    ax.plot(*rf_pt, "s", color="#d9480f", markersize=10, zorder=4)

    ax.annotate(label_in, in_pt, xytext=(-12, -18), textcoords="offset points",
                fontsize=11, fontweight="bold", color="#1c64f2")
    ax.annotate(label_out, out_pt, xytext=(4, -18), textcoords="offset points",
                fontsize=11, fontweight="bold", color="#1c64f2")
    ax.annotate("RFin", rf_pt, xytext=(6, 4), textcoords="offset points",
                fontsize=10, color="#d9480f")

    # D1 (in -> out) arrow inside body
    ax.annotate(
        "", xy=(x0 + 0.7, y0), xytext=(x0 - 0.7, y0),
        arrowprops=dict(arrowstyle="->", color="#0b6a3a", lw=2),
    )
    ax.text(x0 + 0.05, y0 + 0.08, r"$D_1$ (in$\rightarrow$out)",
            color="#0b6a3a", fontsize=10)

    # D2 (RFin) arrow inside body
    ax.annotate(
        "", xy=(x0, y0 + 0.45), xytext=(x0, y0 - 0.05),
        arrowprops=dict(arrowstyle="->", color="#9c1c8e", lw=2),
    )
    ax.text(x0 + 0.05, y0 + 0.4, r"$D_2$ (RFin)", color="#9c1c8e", fontsize=10)

    # D3 (out of page) marker
    circ = Circle((x0 - 1.2, y0 + 0.42), 0.07,
                  facecolor="white", edgecolor="#444", lw=1.0, zorder=5)
    ax.add_patch(circ)
    dot = Circle((x0 - 1.2, y0 + 0.42), 0.018,
                 facecolor="#444", edgecolor="#444", zorder=6)
    ax.add_patch(dot)
    ax.text(x0 - 1.05, y0 + 0.42, r"$D_3$ (out)", fontsize=9, va="center")

    return in_pt, out_pt


def draw_beam(ax, port_xy, beam_dir, color, label, length=2.6, order_label=None,
              order_dir=None):
    """Draw incoming beam centered on the entry port and the diffracted output.

    port_xy: (x, y) of the entry anchor (already on the beam line).
    beam_dir: unit vector of beam propagation in panel coords.
    """
    bx, by = beam_dir
    # Incoming beam segment (upstream tail -> entry)
    tail = (port_xy[0] - bx * length, port_xy[1] - by * length)
    ax.annotate(
        "", xy=port_xy, xytext=tail,
        arrowprops=dict(arrowstyle="->", color=color, lw=2.2, alpha=0.9),
    )
    ax.text(tail[0] + 0.05, tail[1] + 0.1, label, color=color, fontsize=10,
            fontweight="bold")

    # Diffracted output beam from "exit" side, if order_dir given.
    if order_dir is not None and order_label is not None:
        ox, oy = order_dir
        # Place exit at the opposite anchor on the body axis (approx).
        exit_pt = (port_xy[0] + bx * 3.0, port_xy[1] + by * 3.0)
        # Better: pick the other anchor's position — passed implicitly via beam
        # length. For clarity here, draw output starting at entry+through_body.

def draw_panel(ax, state):
    """state in {'A', 'B'}."""
    ax.set_aspect("equal")
    ax.set_xlim(-5, 5)
    ax.set_ylim(-3, 3)
    ax.axis("off")

    in_pt, out_pt = draw_aom_body(ax)

    # Determine entry, exit, beam unit vector
    if state == "A":
        entry = in_pt
        exit_ = out_pt
        # Beam roughly along +D1 (+x in panel); rotate by +theta around D3 so
        # angle(in->out, beam) = theta.
        beam = np.array([np.cos(theta), np.sin(theta)])
        title = (
            r"State A:  $(\mathrm{in}\!\rightarrow\!\mathrm{out})\cdot\hat{\mathbf{k}}_{\mathrm{beam}} > 0$"
            "\nentry = in   |   "
            r"angle$(D_1, \hat{\mathbf{k}}_{\mathrm{beam}}) = \theta_B$"
        )
    else:
        entry = out_pt
        exit_ = in_pt
        # Beam roughly along -D1 (-x in panel); rotate by +theta around D3 so
        # angle(out->in, beam) = theta  <=>  angle(in->out, beam) = pi - theta.
        beam = np.array([-np.cos(theta), np.sin(theta)])
        title = (
            r"State B:  $(\mathrm{in}\!\rightarrow\!\mathrm{out})\cdot\hat{\mathbf{k}}_{\mathrm{beam}} < 0$"
            "\nentry = out   |   "
            r"angle$(-D_1, \hat{\mathbf{k}}_{\mathrm{beam}}) = \theta_B$"
        )

    # Incoming beam: from upstream tail to entry anchor
    L_in = 3.2
    tail = (entry[0] - beam[0] * L_in, entry[1] - beam[1] * L_in)
    ax.annotate(
        "", xy=entry, xytext=tail,
        arrowprops=dict(arrowstyle="->", color="#cc2b1f", lw=2.4),
    )
    ax.text(tail[0] + 0.05, tail[1] - 0.25, "incoming beam",
            color="#cc2b1f", fontsize=10, fontweight="bold")

    # Through-body 0th order: same direction, exit on the other side.
    L_thru = 3.4
    head = (entry[0] + beam[0] * L_thru, entry[1] + beam[1] * L_thru)
    ax.plot([entry[0], head[0]], [entry[1], head[1]],
            color="#888", lw=1.2, ls="--", zorder=1)
    ax.text(head[0] + 0.1, head[1] - 0.1, "0th",
            color="#888", fontsize=9)

    # +1 order: deflected by +2 theta_B from the incoming beam direction.
    R_plus = np.array([[np.cos(2 * theta), -np.sin(2 * theta)],
                       [np.sin(2 * theta),  np.cos(2 * theta)]])
    R_minus = np.array([[np.cos(-2 * theta), -np.sin(-2 * theta)],
                        [np.sin(-2 * theta),  np.cos(-2 * theta)]])
    plus_dir = R_plus @ beam
    minus_dir = R_minus @ beam
    head_plus = (entry[0] + plus_dir[0] * L_thru,
                 entry[1] + plus_dir[1] * L_thru)
    head_minus = (entry[0] + minus_dir[0] * L_thru,
                  entry[1] + minus_dir[1] * L_thru)
    ax.annotate(
        "", xy=head_plus, xytext=entry,
        arrowprops=dict(arrowstyle="->", color="#0b8a3a", lw=1.8),
    )
    ax.text(head_plus[0] + 0.1, head_plus[1], "+1",
            color="#0b8a3a", fontsize=10, fontweight="bold")
    ax.annotate(
        "", xy=head_minus, xytext=entry,
        arrowprops=dict(arrowstyle="->", color="#7a4ad6", lw=1.8),
    )
    ax.text(head_minus[0] + 0.1, head_minus[1], "-1",
            color="#7a4ad6", fontsize=10, fontweight="bold")

    # Angle marker between beam and D1 (or -D1 for state B).
    if state == "A":
        # Arc from D1 (positive x) to beam.
        from matplotlib.patches import Arc
        ax.add_patch(Arc(entry, 1.4, 1.4, angle=0,
                         theta1=0, theta2=THETA_DEG,
                         color="#cc2b1f", lw=1.5))
        # theta_B label
        mid = THETA_DEG / 2
        rad = 0.85
        ax.text(entry[0] + rad * np.cos(np.deg2rad(mid)),
                entry[1] + rad * np.sin(np.deg2rad(mid)) + 0.05,
                r"$\theta_B$", color="#cc2b1f", fontsize=12)
    else:
        from matplotlib.patches import Arc
        ax.add_patch(Arc(entry, 1.4, 1.4, angle=0,
                         theta1=180 - THETA_DEG, theta2=180,
                         color="#cc2b1f", lw=1.5))
        mid = 180 - THETA_DEG / 2
        rad = 0.85
        ax.text(entry[0] + rad * np.cos(np.deg2rad(mid)) - 0.4,
                entry[1] + rad * np.sin(np.deg2rad(mid)) + 0.05,
                r"$\theta_B$", color="#cc2b1f", fontsize=12)

    ax.set_title(title, fontsize=11, pad=14)


draw_panel(axes[0], "A")
draw_panel(axes[1], "B")

# Equation box
fig.text(
    0.5, 0.02,
    r"$\sin\theta_B = \dfrac{m\lambda}{2\Lambda} = \dfrac{m\lambda f_a}{2V_a}$"
    "      (rotate body about $D_3$ to satisfy this)",
    ha="center", fontsize=12,
    bbox=dict(boxstyle="round,pad=0.4", facecolor="#fff8d6", edgecolor="#b08900"),
)

plt.tight_layout(rect=[0, 0.05, 1, 0.93])
out_path = r"C:\Users\admin\OneDrive\桌面\YX\QMsimulation\qmem-digital-twin\docs\aom_align_diagram.png"
plt.savefig(out_path, dpi=130, bbox_inches="tight")
print(f"Saved: {out_path}")
