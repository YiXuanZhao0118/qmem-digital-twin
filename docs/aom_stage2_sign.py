"""Visual comparison of Stage 2 sign convention choices.

After Stage 1, body D1 is parallel (state A) or anti-parallel (state B) to
the beam, and the entry anchor sits on the beam line. Stage 2 rotates the
body about the midpoint pivot, axis = D3.

Two candidate sign conventions for the user-facing diffraction-order radio:

  CONV-1 ("traversal-flipped", what the existing code does):
    state A, m=+1:  body rotates +theta_B   (CCW from +D3)
    state A, m=-1:  body rotates -theta_B
    state B, m=+1:  body rotates -theta_B   (sign flips with traversal)
    state B, m=-1:  body rotates +theta_B
    => User selects "+1" but physical "+1 lab side" depends on state.

  CONV-2 ("lab-fixed +1 side", simpler UX):
    state A, m=+1:  body rotates +theta_B
    state A, m=-1:  body rotates -theta_B
    state B, m=+1:  body rotates +theta_B   (no sign flip)
    state B, m=-1:  body rotates -theta_B
    => User's "+1" always means the same physical lab side
       (e.g. always the side where +D2 happens to point in lab).

Drawn with theta exaggerated to ~12 deg.
"""
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle


THETA_DEG = 12.0
theta = np.deg2rad(THETA_DEG)
HALF_D1 = 1.4
HALF_D2 = 0.50

beam = np.array([1.0, 0.0])  # horizontal in lab


def rot2(ang):
    c, s = np.cos(ang), np.sin(ang)
    return np.array([[c, -s], [s, c]])


def draw_body(ax, R, t, label_state):
    corners = np.array([
        [-HALF_D1, -HALF_D2],
        [+HALF_D1, -HALF_D2],
        [+HALF_D1, +HALF_D2],
        [-HALF_D1, +HALF_D2],
    ])
    rotated = (R @ corners.T).T + t
    poly = plt.Polygon(rotated, closed=True, facecolor="#dde6f5",
                       edgecolor="#234", lw=1.0, zorder=2)
    ax.add_patch(poly)
    in_local  = np.array([-HALF_D1, 0.0])
    out_local = np.array([+HALF_D1, 0.0])
    rf_local  = np.array([0.0, +HALF_D2])
    in_pt  = R @ in_local + t
    out_pt = R @ out_local + t
    rf_pt  = R @ rf_local + t
    ax.plot(*in_pt,  "o", color="#1c64f2", markersize=6, zorder=4)
    ax.plot(*out_pt, "o", color="#1c64f2", markersize=6, zorder=4)
    ax.plot(*rf_pt,  "s", color="#d9480f", markersize=7, zorder=4)
    ax.plot(*t, "x", color="#000000", markersize=8, mew=1.6, zorder=5)


def draw_panel(ax, state, m, conv):
    ax.set_aspect("equal")
    ax.set_xlim(-3.6, 3.6)
    ax.set_ylim(-2.2, 2.2)
    ax.axis("off")

    # Stage 1 base orientation: A=0 deg, B=180 deg.
    base = 0.0 if state == "A" else np.pi

    # Stage 2 Bragg angle sign per convention.
    if conv == "CONV-1":
        traversal = +1 if state == "A" else -1
        bragg = m * traversal * theta
    else:  # CONV-2
        bragg = m * theta

    R = rot2(base + bragg)
    t = np.array([0.0, 0.0])
    draw_body(ax, R, t, state)

    # Beam through midpoint (= origin)
    ax.annotate("", xy=( 3.0, 0), xytext=(-3.0, 0),
                arrowprops=dict(arrowstyle="->", color="#cc2b1f", lw=1.8))

    # 0th order (continuation of beam) shown dashed
    ax.plot([0, 3.2], [0, 0], color="#888", lw=0.9, ls="--", zorder=1)
    ax.text(3.0, -0.20, "0th", color="#888", fontsize=8)

    # +1 / -1 from midpoint, rotated 2*theta from beam direction.
    # Physical +1 = beam rotated +2theta in lab (toward lab +y) for m>0.
    # CONV-1: lab side flips with state. CONV-2: always same lab side.
    if conv == "CONV-1":
        traversal = +1 if state == "A" else -1
    else:
        traversal = +1
    ang_p = +2 * theta * traversal
    ang_m = -2 * theta * traversal
    dp = rot2(ang_p) @ beam
    dm = rot2(ang_m) @ beam
    ax.annotate("", xy=(dp[0] * 3.0, dp[1] * 3.0), xytext=(0, 0),
                arrowprops=dict(arrowstyle="->", color="#0b8a3a", lw=1.4))
    ax.text(dp[0] * 3.05, dp[1] * 3.05, "+1", color="#0b8a3a", fontsize=9, fontweight="bold")
    ax.annotate("", xy=(dm[0] * 3.0, dm[1] * 3.0), xytext=(0, 0),
                arrowprops=dict(arrowstyle="->", color="#7a4ad6", lw=1.4))
    ax.text(dm[0] * 3.05, dm[1] * 3.05, "-1", color="#7a4ad6", fontsize=9, fontweight="bold")

    sign_str = ("+" if bragg >= 0 else "-") + f"{abs(np.degrees(bragg)):.0f}^\\circ"
    title = (
        f"State {state}, user picks m={'+1' if m > 0 else '-1'}\n"
        f"body rotation: $\\omega = {sign_str}$"
    )
    ax.set_title(title, fontsize=9, pad=4)


fig, axes = plt.subplots(2, 4, figsize=(16, 7.5))
fig.suptitle(
    "Stage 2 sign convention — what does user-selected $m=\\pm1$ map to in lab?",
    fontsize=12,
)

cases = [
    ("CONV-1\n(existing)", [
        ("A", +1, "CONV-1"), ("A", -1, "CONV-1"),
        ("B", +1, "CONV-1"), ("B", -1, "CONV-1"),
    ]),
    ("CONV-2\n(lab-fixed +1)", [
        ("A", +1, "CONV-2"), ("A", -1, "CONV-2"),
        ("B", +1, "CONV-2"), ("B", -1, "CONV-2"),
    ]),
]

for row, (label, panels) in enumerate(cases):
    for col, (state, m, conv) in enumerate(panels):
        draw_panel(axes[row, col], state, m, conv)
    axes[row, 0].text(-0.30, 0.5, label, transform=axes[row, 0].transAxes,
                      fontsize=12, fontweight="bold", color="#444",
                      ha="right", va="center")

# Footnote summary
fig.text(
    0.5, 0.02,
    "CONV-1: physical '+1 lab side' flips between A and B (= existing code's traversalSign behaviour).\n"
    "CONV-2: physical '+1 lab side' is the same in A and B; user's '+1 selection' always means same lab side.",
    ha="center", fontsize=10,
    bbox=dict(boxstyle="round,pad=0.4", facecolor="#fff8d6", edgecolor="#b08900"),
)

plt.tight_layout(rect=[0.03, 0.07, 1, 0.93])
out_path = r"C:\Users\admin\OneDrive\桌面\YX\QMsimulation\qmem-digital-twin\docs\aom_stage2_sign.png"
plt.savefig(out_path, dpi=140, bbox_inches="tight")
print(f"Saved: {out_path}")
