"""Two-stage AOM (MT80-A1.5-IR) Bragg alignment as confirmed by user.

Stage 1 - Initial pose (snap body axis parallel to beam):
  if (in->out) . beam > 0   ->  State A: align in->out parallel to beam,
                                          translate so "in" anchor sits on beam
  else                      ->  State B: align out->in parallel to beam,
                                          translate so "out" anchor sits on beam

Stage 2 - Bragg rotation:
  pivot = (pos_in + pos_out) / 2          (= acousto-optic interaction point)
  axis  = D3 (body-local +z, = D1 x D2)
  angle = theta_B (signed by diffraction order m and state)
        sin(theta_B) = m * lambda * f_a / (2 * V_a)

theta is exaggerated for visualization (real value is a few mrad).
"""
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle, Arc, Circle


THETA_DEG = 12.0
theta = np.deg2rad(THETA_DEG)
HALF_D1 = 1.5     # half-length along in -> out
HALF_D2 = 0.55    # half-length along RFin


def draw_body(ax, R, t, color="#dde6f5"):
    """Draw the body rectangle rotated by R (2x2) and translated by t (2,)."""
    corners = np.array([
        [-HALF_D1, -HALF_D2],
        [+HALF_D1, -HALF_D2],
        [+HALF_D1, +HALF_D2],
        [-HALF_D1, +HALF_D2],
    ])
    rotated = (R @ corners.T).T + t
    poly = plt.Polygon(rotated, closed=True,
                       facecolor=color, edgecolor="#234", lw=1.2, zorder=2)
    ax.add_patch(poly)
    # Anchors
    in_local  = np.array([-HALF_D1, 0.0])
    out_local = np.array([+HALF_D1, 0.0])
    rf_local  = np.array([0.0, +HALF_D2])
    in_pt  = R @ in_local  + t
    out_pt = R @ out_local + t
    rf_pt  = R @ rf_local  + t
    mid_pt = R @ np.zeros(2) + t
    ax.plot(*in_pt,  "o", color="#1c64f2", markersize=8, zorder=4)
    ax.plot(*out_pt, "o", color="#1c64f2", markersize=8, zorder=4)
    ax.plot(*rf_pt,  "s", color="#d9480f", markersize=9, zorder=4)
    ax.plot(*mid_pt, "x", color="#000000", markersize=10, mew=2, zorder=5)
    return in_pt, out_pt, rf_pt, mid_pt


def label_anchors(ax, in_pt, out_pt, rf_pt, mid_pt, dy_in=-0.45, dy_out=-0.45):
    ax.text(in_pt[0],  in_pt[1] + dy_in,  "in",  color="#1c64f2",
            fontsize=10, fontweight="bold", ha="center")
    ax.text(out_pt[0], out_pt[1] + dy_out, "out", color="#1c64f2",
            fontsize=10, fontweight="bold", ha="center")
    ax.text(rf_pt[0] + 0.15, rf_pt[1] + 0.12, "RFin", color="#d9480f", fontsize=9)
    ax.text(mid_pt[0] + 0.10, mid_pt[1] - 0.30,
            "pivot\n(in+out)/2", color="#000", fontsize=8, ha="left")


def draw_beam(ax, beam_unit, beam_origin, length=3.5, color="#cc2b1f"):
    bx, by = beam_unit
    tail = beam_origin - beam_unit * length
    head = beam_origin + beam_unit * length
    ax.annotate("", xy=head, xytext=tail,
                arrowprops=dict(arrowstyle="->", color=color, lw=2.0, alpha=0.9))


def rot2(angle_rad):
    c, s = np.cos(angle_rad), np.sin(angle_rad)
    return np.array([[c, -s], [s, c]])


fig, axes = plt.subplots(2, 2, figsize=(13, 10))
fig.suptitle(
    "AOM (MT80-A1.5-IR) two-stage Bragg align\n"
    r"Stage 1: snap optical axis $\parallel$ beam   "
    r"$\bullet$   Stage 2: rotate $\theta_B$ about midpoint along $D_3$",
    fontsize=12,
)

# Beam is fixed in lab frame: horizontal, going right.
beam = np.array([1.0, 0.0])

panels = [
    ("A", "Stage 1: initial",   axes[0, 0]),
    ("A", "Stage 2: + Bragg",   axes[0, 1]),
    ("B", "Stage 1: initial",   axes[1, 0]),
    ("B", "Stage 2: + Bragg",   axes[1, 1]),
]

for state, stage, ax in panels:
    ax.set_aspect("equal")
    ax.set_xlim(-5, 5)
    ax.set_ylim(-2.5, 2.5)
    ax.axis("off")

    # Stage 1: optical axis parallel (state A) or anti-parallel (state B) to beam.
    if state == "A":
        body_angle_stage1 = 0.0  # in->out points along +x, same as beam
        entry_local = np.array([-HALF_D1, 0.0])  # "in"
    else:
        body_angle_stage1 = np.pi  # in->out points along -x, opposite to beam
        entry_local = np.array([-HALF_D1, 0.0])  # "in" (still); but in body frame,
                                                  # entry anchor in lab is the
                                                  # "out" port because body is flipped.
        # Actually with body rotated 180 deg, the lab-position of "out_local"
        # = R*[+H,0] = [-H, 0] (left side). So entry on beam = body centre at
        # (+H, 0) in lab so that the lab-rotated "out" anchor sits on the beam.
    # Stage 2: add Bragg rotation theta about midpoint.
    if stage.startswith("Stage 2"):
        bragg = +theta if state == "A" else -theta
        # Sign chosen so the +1 order goes upward in both states (same lab side)
    else:
        bragg = 0.0

    # Build pose: rotation about midpoint = (in+out)/2.
    # Body local origin coincides with midpoint, so rotation is just R*body.
    R = rot2(body_angle_stage1 + bragg)

    # Translation: in stage 1 we want the entry anchor (in or out, lab side) at origin
    # of the beam (we'll put it at x = -1.5 so the body sits in the panel center).
    if state == "A":
        # entry = in (body local [-H, 0])
        entry_lab_target = np.array([-1.5, 0.0])
        entry_local_pt = np.array([-HALF_D1, 0.0])
    else:
        # body axis flipped; lab-side "out" anchor = R*[+H, 0]
        # but we want the BEAM to enter at the "out" port -> place body
        # so that the lab-rotated "out" anchor sits on the beam line.
        entry_lab_target = np.array([-1.5, 0.0])
        entry_local_pt = np.array([+HALF_D1, 0.0])  # "out" port

    rotated_entry = R @ entry_local_pt
    t = entry_lab_target - rotated_entry

    in_pt, out_pt, rf_pt, mid_pt = draw_body(ax, R, t)
    label_anchors(ax, in_pt, out_pt, rf_pt, mid_pt)

    # Lab beam: horizontal arrow.
    draw_beam(ax, beam, np.array([0.0, 0.0]), length=4.0)
    # Beam label (only on top-left for clarity)
    if stage.startswith("Stage 1") and state == "A":
        ax.text(-4.4, 0.2, "incoming beam", color="#cc2b1f",
                fontsize=10, fontweight="bold")

    # In stage 2 panels: draw 0th, +1, -1 orders out of midpoint.
    if stage.startswith("Stage 2"):
        # 0th order: continuation of beam (passes through entry, exits other side).
        ax.plot([mid_pt[0], mid_pt[0] + 4.0],
                [mid_pt[1], mid_pt[1] + 0.0],
                color="#888", lw=1.0, ls="--", zorder=1)
        ax.text(mid_pt[0] + 3.6, -0.25, "0th", color="#888", fontsize=9)
        # +1 / -1 deflection: 2*theta from beam direction.
        for sign, lbl, col in [(+1, "+1", "#0b8a3a"), (-1, "-1", "#7a4ad6")]:
            d = rot2(sign * 2 * theta) @ beam
            head = mid_pt + d * 4.0
            ax.annotate("", xy=head, xytext=mid_pt,
                        arrowprops=dict(arrowstyle="->", color=col, lw=1.7))
            ax.text(head[0] + 0.05, head[1], lbl, color=col,
                    fontsize=10, fontweight="bold")

        # Mark angle theta_B at midpoint between body axis (= R*[1,0]) and beam.
        body_axis_lab = R @ np.array([1.0, 0.0])
        body_axis_deg = np.degrees(np.arctan2(body_axis_lab[1], body_axis_lab[0]))
        if state == "A":
            ax.add_patch(Arc(mid_pt, 1.0, 1.0, angle=0,
                             theta1=0, theta2=body_axis_deg,
                             color="#cc2b1f", lw=1.5))
            mid_a = body_axis_deg / 2
            r = 0.65
            ax.text(mid_pt[0] + r * np.cos(np.deg2rad(mid_a)),
                    mid_pt[1] + r * np.sin(np.deg2rad(mid_a)) + 0.06,
                    r"$\theta_B$", color="#cc2b1f", fontsize=12)
        else:
            ax.add_patch(Arc(mid_pt, 1.0, 1.0, angle=0,
                             theta1=180 + np.degrees(bragg), theta2=180,
                             color="#cc2b1f", lw=1.5))
            mid_a = 180 + np.degrees(bragg) / 2
            r = 0.65
            ax.text(mid_pt[0] + r * np.cos(np.deg2rad(mid_a)) - 0.4,
                    mid_pt[1] + r * np.sin(np.deg2rad(mid_a)) - 0.18,
                    r"$\theta_B$", color="#cc2b1f", fontsize=12)

    # D3 rotation icon at the midpoint
    if stage.startswith("Stage 2"):
        circ = Circle(mid_pt, 0.16, facecolor="white",
                      edgecolor="#444", lw=1.0, zorder=6)
        ax.add_patch(circ)
        dot = Circle(mid_pt, 0.04, facecolor="#444",
                     edgecolor="#444", zorder=7)
        ax.add_patch(dot)

    # Title for each panel
    state_subtitle = {
        "A": r"State A:  $(\mathrm{in}\!\to\!\mathrm{out})\cdot\hat{k}>0$",
        "B": r"State B:  $(\mathrm{in}\!\to\!\mathrm{out})\cdot\hat{k}<0$",
    }[state]
    ax.set_title(f"{state_subtitle}   |   {stage}", fontsize=10, pad=8)


# Equation banner
fig.text(
    0.5, 0.02,
    r"Bragg rotation:  $\sin\theta_B = m\lambda f_a / (2 V_a)$    "
    r"(pivot = midpoint of in,out anchors;  axis = $D_3$ = $D_1\times D_2$)",
    ha="center", fontsize=11,
    bbox=dict(boxstyle="round,pad=0.4", facecolor="#fff8d6", edgecolor="#b08900"),
)

plt.tight_layout(rect=[0, 0.04, 1, 0.94])
out_path = r"C:\Users\admin\OneDrive\桌面\YX\QMsimulation\qmem-digital-twin\docs\aom_align_2stage.png"
plt.savefig(out_path, dpi=140, bbox_inches="tight")
print(f"Saved: {out_path}")
