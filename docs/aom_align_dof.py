"""Final design diagram: Bragg DoF accounting and alignment algorithm.

Principle:
  Bragg geometry constrains ONLY beam.D2 = sin(theta_B).
  - 1 equation on rotation -> 2 rotational DoF remain free.
  - "entry anchor on beam line" is 2 equations on translation -> 1 translational DoF remains.

Total free DoF after Bragg + entry-on-beam:
  - translation along beam (1 DoF)        -> pinned by midpoint pivot choice
  - rotation about beam direction (1 DoF) -> pinned by Stage 1 (a)/(b)/(c)
  - rotation about D3 (1 DoF)             -> pinned by Stage 2 sign convention

The plot shows:
  Top: cone of allowed D2 directions (D2 must satisfy beam.D2 = sin theta_B).
  Bottom: how Stage 1's three options pick a specific point on the cone.
"""
import numpy as np
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection


THETA_DEG = 18.0  # exaggerated
theta = np.deg2rad(THETA_DEG)


def setup_3d(ax, title):
    R = 1.4
    ax.set_xlim(-R, R); ax.set_ylim(-R, R); ax.set_zlim(-R, R)
    ax.set_box_aspect((1, 1, 1))
    ax.view_init(elev=22, azim=-58)
    ax.set_xticks([]); ax.set_yticks([]); ax.set_zticks([])
    for pane in (ax.xaxis.pane, ax.yaxis.pane, ax.zaxis.pane):
        pane.fill = False; pane.set_edgecolor("#e0e0e0")
    ax.set_title(title, fontsize=11, pad=4)


def normalize(v):
    return v / np.linalg.norm(v)


fig = plt.figure(figsize=(15, 8))
fig.suptitle(
    r"Bragg constraint: $\hat{\mathbf{k}}_{\rm beam} \cdot \hat{D}_2 = \sin\theta_B$"
    "    -- 1 equation on rotation, so 2 rotational DoF remain free.",
    fontsize=12,
)

# --- Panel 1: cone of allowed D2 directions ---
ax1 = fig.add_subplot(1, 2, 1, projection="3d")
setup_3d(ax1, r"$\hat{D}_2$ must lie on a circle (cone with beam, half-angle $\frac{\pi}{2}-\theta_B$)")

# Beam along +x in this view for clarity.
beam = np.array([1.0, 0.0, 0.0])
ax1.quiver(-1.3, 0, 0, 2.6, 0, 0, color="#cc2b1f", lw=2.4, arrow_length_ratio=0.06)
ax1.text(1.35, 0, -0.05, r"$\hat{\mathbf{k}}_{\rm beam}$", color="#cc2b1f", fontsize=11)

# Cone = all unit vectors v with v.beam = sin theta_B.
# Parametrise: v = sin(theta_B)*beam + cos(theta_B)*(cos(phi)*e2 + sin(phi)*e3)
# with e2=lab+y, e3=lab+z.
phis = np.linspace(0, 2 * np.pi, 200)
circle_x = np.full_like(phis, np.sin(theta))
circle_y = np.cos(theta) * np.cos(phis)
circle_z = np.cos(theta) * np.sin(phis)
ax1.plot(circle_x, circle_y, circle_z, color="#9c1c8e", lw=2.0)
# Cone shading
for phi_a, phi_b in zip(phis[:-1:5], phis[1::5]):
    pa = [np.sin(theta), np.cos(theta) * np.cos(phi_a), np.cos(theta) * np.sin(phi_a)]
    pb = [np.sin(theta), np.cos(theta) * np.cos(phi_b), np.cos(theta) * np.sin(phi_b)]
    poly = Poly3DCollection([[(0, 0, 0), tuple(pa), tuple(pb)]],
                            alpha=0.06, facecolor="#9c1c8e", edgecolor="none")
    ax1.add_collection3d(poly)

# Three example D2 picks corresponding to options (a), (b), (c).
# For visualization, pick three angles:
phi_b = np.pi / 2     # pointing toward +z (option b: D3 closest to lab+z makes D2 horizontal-ish)
phi_a = np.pi / 2 - 0.45
phi_c = np.pi / 2 + 0.45
for phi, lbl, col in [
    (phi_a, "(a) min-rot $\\hat{D}_2$",      "#1c64f2"),
    (phi_b, "(b) upright $\\hat{D}_2$",      "#0b8a3a"),
    (phi_c, "(c) keep-$\\hat{D}_2$ direction","#d9480f"),
]:
    p = np.array([np.sin(theta),
                  np.cos(theta) * np.cos(phi),
                  np.cos(theta) * np.sin(phi)])
    ax1.quiver(0, 0, 0, *p, color=col, lw=1.8, arrow_length_ratio=0.12)
    ax1.text(p[0] * 1.05, p[1] * 1.05, p[2] * 1.05,
             lbl, color=col, fontsize=9)

# Annotation
ax1.text2D(0.02, 0.95,
           r"all $\hat{D}_2$ on this circle satisfy $\hat{\mathbf{k}}\cdot\hat{D}_2 = \sin\theta_B$"
           "\nrotation around $\\hat{\\mathbf{k}}_{\\rm beam}$ slides $\\hat{D}_2$ around the circle"
           "\n-- this is the free DoF Stage 1 (a)/(b)/(c) pins.",
           transform=ax1.transAxes, fontsize=9, va="top",
           bbox=dict(boxstyle="round,pad=0.3",
                     facecolor="#fff8d6", edgecolor="#b08900"))

# --- Panel 2: DoF accounting flow ---
ax2 = fig.add_subplot(1, 2, 2)
ax2.axis("off")
ax2.set_xlim(0, 1); ax2.set_ylim(0, 1)

txt = (
    "Total rigid-body DoF: 6 (3 translation + 3 rotation)\n\n"
    r"$\bullet$ entry anchor on beam line (perpendicular distance = 0):  "
    r"  -2 translational DoF" "\n"
    r"$\bullet$ Bragg constraint  $\hat{\mathbf{k}}\cdot\hat{D}_2 = \sin\theta_B$ :  "
    r"  -1 rotational DoF" "\n\n"
    "Remaining 3 DoF are user choices:\n\n"
    r"  $\bullet$ translation along beam  --  pivot pinned at $(\mathrm{pos}_{\rm in}+\mathrm{pos}_{\rm out})/2$" "\n\n"
    r"  $\bullet$ rotation about $\hat{\mathbf{k}}_{\rm beam}$  --  Stage 1 picks (a)/(b)/(c):" "\n"
    r"     (a) min-rot from current pose -- least disturbance" "\n"
    r"     (b) $\hat{D}_3$ closest to lab$+Z$ -- AOM stays upright on table" "\n"
    r"     (c) $\hat{D}_2$ closest to current $\hat{D}_2$ -- RFin direction stable" "\n\n"
    r"  $\bullet$ rotation about $\hat{D}_3$  --  Stage 2 picks sign convention:" "\n"
    r"     CONV-1: $\omega = m\,\cdot\,(\pm 1\text{ for state A/B})\,\cdot\,\theta_B$  -- physical order" "\n"
    r"     CONV-2: $\omega = m\,\cdot\,\theta_B$  -- user's '+1' always same lab side" "\n"
)
ax2.text(0.0, 0.98, txt, va="top", ha="left", fontsize=10, family="serif",
         bbox=dict(boxstyle="round,pad=0.5", facecolor="#f5f5f5", edgecolor="#aaa"))

# Recommended defaults box
ax2.text(0.0, 0.10,
         "Recommendation if you don't have a strong preference:\n"
         "  Stage 1: (b) D3 || lab+Z   -- most physically intuitive on a horizontal table\n"
         "  Stage 2: CONV-1            -- matches existing rayTrace.ts AOM branch sign",
         va="top", ha="left", fontsize=10, family="serif", color="#0b6a3a",
         bbox=dict(boxstyle="round,pad=0.5", facecolor="#e8f5e9", edgecolor="#0b6a3a"))

plt.tight_layout(rect=[0, 0, 1, 0.93])
out_path = r"C:\Users\admin\OneDrive\桌面\YX\QMsimulation\qmem-digital-twin\docs\aom_align_dof.png"
plt.savefig(out_path, dpi=140, bbox_inches="tight")
print(f"Saved: {out_path}")
