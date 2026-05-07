# Physics-time architecture for the QMEM digital twin

**Status:** design phase 0 (2026-05-01).
**Author:** Claude (Opus 4.7) for the QOL group.
**Audience:** anyone touching the optical / RF / quantum / thermal solvers.

---

## 1. Goal

Make **time** a first-class coordinate across every physics module so a single
"experiment run" is a coherent time-evolved trace, not a steady-state snapshot.
The user pain-point: today the optical solver returns CW q-parameters and the
device state is a plain JSON dict — there's no way to ask "what's the photon
number in the memory at t = 32 µs?" because nobody knows what time means.

**Hard requirements** (from user, 2026-05-01):

1. Every physics module must have a time representation. No "this one is CW,
   that one is time-domain".
2. Don't take shortcuts: full wave optics, real GVD propagation, real ρ(t),
   real Lindblad evolution. No "just multiply by an efficiency factor".
3. Each step must be testable in isolation.

**Out of scope (this revision):**

- Ultra-fast (< fs) carrier-resolved fields. We always work in the
  rotating-wave / slowly-varying-envelope approximation (RWA / SVEA). This is
  enough for cold-atom QM and saves 10⁹× compute.
- Real-time hardware-in-the-loop control. We simulate offline only.

---

## 2. The physics modules and their natural time scales

| Module | Native scale | Representation |
|--------|-------------|----------------|
| Optical carrier | 1 fs (~350 THz @ 852 nm) | analytic — never sampled |
| Optical envelope | 1 ps – 100 ns | sampled `E(t)` complex envelope per polarization |
| RF carrier | 100 ps – 100 ns (10 MHz – 10 GHz) | phasor + slow envelope |
| Atomic coherence | 100 ns – 100 µs (Cs/Rb hyperfine) | density matrix `ρ(t)` |
| Atomic population | µs – s | populations + recovery |
| Thermal | s – min | temperature field `T(t, x)` |
| Vacuum / fluid | min – hr | pressure `P(t)` |
| Mechanical / stress | static (most cases) | optionally `σ(t, x)` for vibration |

A single global `dt` is impossible: capturing optical envelope at ps resolution
over a 1-second thermal window is 10¹² steps. **We use per-module time grids**
synchronised at **events** on a global Sequence Timeline.

---

## 3. The big idea: Sequence Timeline + per-module evolvers

```
              ┌─────── Sequence Timeline ───────┐
              │   t=0         t=10µs    t=20µs  │
              │   ↓             ↓         ↓     │
              │ [evt: laser on][evt: AOM][evt: detect]
              └─────────────────────────────────┘
                       │           │            │
                       ▼           ▼            ▼
   Optical:     ╔═══════╗      ╔═══╗       ╔══════════╗
   E(t)         ║ pulse ║      ║gate║       ║ readout ║
                ╚═══════╝      ╚═══╝       ╚══════════╝
   RF:               ╔═══════════════════════════════╗
                     ║   carrier 9.192 GHz @ 5 dBm   ║
                     ╚═══════════════════════════════╝
   Quantum ρ(t):     ╔═══════════════════════════════╗
                     ║  Lindblad evolution           ║
                     ╚═══════════════════════════════╝
   Thermal T(t):     ╔═══════════════════════════════╗
                     ║  ODE, integrated coarsely     ║
                     ╚═══════════════════════════════╝
```

A **Sequence** is a list of **Events**: `(t, channel, action, params)`.
The solver runs each module forward between events; at every event boundary,
modules with cross-physics dependencies exchange state (e.g. the AOM driver
event publishes its current RF amplitude → the optical solver re-computes the
gated envelope at the next optical sample).

### 3.1 Why event-driven, not fixed-step

Cold-atom protocols are *naturally* event-driven (turn AOM on, wait, turn off,
trigger camera). The simulator state between events is **piecewise smooth** and
each module solves its own integration with its own adaptive step size, then
the orchestrator advances global wall-clock time to the next event.

### 3.2 Steady-state is a special case

A scene with no Sequence (today's behaviour) is treated as a single
all-time-on event. Every module runs its **steady-state evaluator** (the
existing CW optical solver, RF carrier-only, ρ_eq for quantum, etc.) and
returns a single time-independent snapshot. **No backward compat break.**

---

## 4. Schema additions

### 4.1 Pulse envelope (optical)

```python
class PulseEnvelope(CamelModel):
    """Slowly-varying complex envelope of an optical field.

    Sampled on a uniform time grid `t = t0 + dt·n`, n = 0..N-1.
    Each sample is a complex amplitude (E.real + i·E.imag) in √mW units, so
    |E(t)|² is instantaneous power.

    For unmodulated CW the entire array is constant.
    """
    t0_ns: float           # absolute time of sample 0 within the sequence
    dt_ps: float           # sample spacing
    n_samples: int
    # Two polarisation channels (Jones x, y); each is N complex samples
    # Stored as flat float arrays for JSON compactness; length 2N each.
    e_x_re: list[float]
    e_x_im: list[float]
    e_y_re: list[float]
    e_y_im: list[float]
    # Carrier frequency the envelope is multiplied by. Used for RWA frame.
    carrier_thz: float
```

- For a CW beam `n_samples=1`, `dt_ps=0` (or marker `is_cw=True`).
- For a 1 ns Gaussian pulse with 10 ps resolution: 100 samples × 4 floats × 2 pol = 3.2 kB.
- For a 1 ms CW beam at 1 ns resolution: 8 MB. **Don't do that.** Use CW marker.

### 4.2 RF signal

```python
class RFSignal(CamelModel):
    """Slowly-varying envelope of an RF channel."""
    t0_ns: float
    dt_ns: float
    n_samples: int
    carrier_hz: float          # may be 0 for baseband/DC channels
    amplitude: list[float]     # √W (so amp² is instantaneous power)
    phase_rad: list[float]     # phase relative to carrier
    # If the channel is a digital trigger (TTL) we just use amplitude ∈ {0, 1}.
```

### 4.3 Quantum state trace

```python
class QuantumTrace(CamelModel):
    """ρ(t) for a small Hilbert space (≤ 64 levels typical for Λ-systems)."""
    t_ns: list[float]                 # M time stamps
    rho_real: list[list[list[float]]]  # M × N × N
    rho_imag: list[list[list[float]]]  # M × N × N
    basis_labels: list[str]            # ["|g⟩", "|s⟩", "|e⟩", ...]
```

For larger systems (memories with many spatial modes) we'll add a sparse
representation later. Out of scope for v1.

### 4.4 Thermal / Pressure scalar trace

```python
class ScalarTrace(CamelModel):
    t_ns: list[float]
    values: list[float]
    unit: str          # "K", "Pa", "V", "A", ...
```

### 4.5 Sequence + Event (DB-backed)

```python
class Sequence(CamelModel):           # new table
    id: UUID
    name: str
    description: str | None
    duration_ns: float
    created_at: datetime
    updated_at: datetime

class SequenceEvent(CamelModel):      # new table
    id: UUID
    sequence_id: UUID
    t_ns: float
    channel: str                      # "AOM_001.rf_amplitude" — dotted path
    action: Literal[
        "set", "ramp", "pulse_gate", "trigger", "wait", "barrier"
    ]
    params: JsonDict                  # action-specific
```

Channel paths reference `{component_name}.{property}`. The solver resolves them
through the existing component graph. Examples:

- `AOM_001.rf_amplitude = 0.7` → drive AOM into 1st-order with 0.7 efficiency
- `laser_852.power_mw = 18.5` → laser output level
- `B_field.bz_mT = 1.2` → coil EM module
- `readout.trigger` → camera/PMT event

### 4.6 Element dispersion params (additive, no breaking changes)

| Element kind | New params |
|--------------|-----------|
| `mirror` | `clearApertureMm`, `groupDelayPs` (typically 0) |
| `lens_spherical` / `cylindrical` | `clearApertureMm`, `gvdFs2`, `material` |
| `waveplate` | `gvdFs2` (often negligible), `groupDelayPs` |
| `aom`, `eom` | `riseTimeNs`, `falltimeNs`, `gvdFs2` |
| `nonlinear_crystal` | `chi2_pmV`, `lengthMm`, `phaseMatchingNm` |
| `fiber_coupler` | `mfdUm` (mode field diameter), `nA` (numerical aperture) |
| `isolator` | `groupDelayPs` |

All optional; when missing the solver assumes ideal (0 dispersion, infinite
aperture).

---

## 5. Solver responsibilities

### 5.1 Optical solver (Phase 1)

Inputs:
- A scene graph (existing).
- A `Sequence` (new) — may be empty → CW mode.
- For each driver event on the sequence, a controller mapping (e.g. AOM
  amplitude bound to RF generator output).

Outputs:
- For each `OpticalLink`, an `OpticalSegmentTrace`: list of `(t_ns, BeamState)`
  samples. In CW mode, length 1.

New propagation primitives:

```python
def propagate_envelope(
    env: PulseEnvelope, distance_mm: float, refractive_index: float = 1.0,
    gvd_fs2_per_mm: float = 0.0
) -> PulseEnvelope:
    """Free-space (or in-medium) envelope propagation.

    Implementation: split-step Fourier — multiply spectrum by
    exp(i·k_z·L) where k_z(ω) = (n·ω)/c + (1/2)·β2·ω² for GVD.
    """
```

```python
def angular_spectrum_propagate(
    field_xy: np.ndarray, dx_um: float, distance_mm: float,
    wavelength_nm: float
) -> np.ndarray:
    """2D spatial field propagation via angular spectrum method.

    Used when the beam profile is NOT Gaussian (post-aperture), or when the
    user requests wave-optics mode. ABCD path stays as fast default.
    """
```

```python
def fiber_overlap(
    beam: BeamState, fiber_mfd_um: float, fiber_z_mm: float,
    transverse_offset_um: tuple[float, float] = (0.0, 0.0),
    tilt_mrad: tuple[float, float] = (0.0, 0.0),
) -> float:
    """Mode-overlap coupling efficiency, Gaussian-Gaussian closed form."""
```

### 5.2 RF / quantum / thermal modules (Phase 2)

Each module exposes:

```python
class PhysicsModule(Protocol):
    name: str  # "optical" | "rf" | "quantum" | "thermal" | "em" | "vacuum"

    def steady_state(self, scene: Scene) -> ModuleResult:
        """CW / equilibrium evaluator. Returns single snapshot."""

    def evolve(
        self, scene: Scene, t_start_ns: float, t_end_ns: float,
        controls: dict[str, ChannelTrace], state_in: ModuleState
    ) -> tuple[ModuleState, ModuleResult]:
        """Integrate forward from state_in over [t_start, t_end]."""
```

The orchestrator pseudo-code:

```python
def run_sequence(scene, sequence):
    state = {m.name: m.initial_state(scene) for m in modules}
    result = {m.name: ModuleResult.empty() for m in modules}
    for t_event, event in sequence.iter_sorted():
        # 1) Roll every module forward to t_event
        for m in modules:
            state[m.name], partial = m.evolve(
                scene, last_t, t_event, current_controls, state[m.name]
            )
            result[m.name].append(partial)
        # 2) Apply event (mutates current_controls or scene)
        apply_event(event, scene, current_controls)
        last_t = t_event
    # 3) Roll to end
    ...
```

### 5.3 Cross-module events

`AOM_001.rf_amplitude` event needs to:
1. Update the RF channel value (RF module).
2. Push a new amplitude into the optical solver's controller mapping.
3. The next optical evolve step samples that amplitude into its envelope.

We **don't** try to do retroactive coupling within an event interval. The
controller value is held constant within an interval; ramps are decomposed
into a series of small events.

---

## 6. Backwards-compatibility plan

| Existing thing | After Phase 1 | After Phase 3 |
|---------------|--------------|--------------|
| `BeamSegment` row with no `sequence_t_ms` | Treated as CW snapshot. | Same; no Sequence ⇒ runs through steady_state path. |
| Existing optical solver `apply_*` functions | Wrapped in `steady_state` of optical module. | Same. |
| `DeviceState` JSON dict | Read as initial state. | Initial state for module's `evolve`. |
| Frontend `RunSolverButton` | Calls `/api/simulations/optical/run` (CW). | Adds `?sequenceId=...` for transient. |

**No breaking changes.** Old scenes keep producing the same numbers.

---

## 7. Numerical libraries

We'll use:
- **NumPy** — array math, FFT. Already a transitive dep via Three.js? No — add to backend `requirements.txt`.
- **SciPy** — `scipy.integrate.solve_ivp` for ODE evolution (thermal, vacuum,
  basic quantum), `scipy.linalg.expm` for unitary propagators.
- **No external optics library** — wave optics implemented from scratch as the
  user requested. This means we own ~600 lines of FFT-based propagation code.
  Trade-off: more code; benefit: no opaque dependency, full control over
  precision/dtype/gauge choices.

For atomic-physics master-equation evolution we can either:
- Vendor a minimal master-equation integrator (~150 lines for Lindblad).
- Or add `qutip` as an optional dep for users who do quantum-heavy work.

The user said "no shortcuts" — so we vendor the integrator. QuTiP can be added
later as an alternative backend.

---

## 8. Phased delivery plan (mapped to the todo list)

| Phase | Items | Acceptance test |
|-------|-------|-----------------|
| **0** | Read current state, write this doc. | This document exists and is reviewed. |
| **1** | Pulse envelope, GVD, AOM/EOM/crystal time-dep, wave optics, fiber overlap. | Single optical chain run with a 10 ns Gaussian pulse through laser→AOM→fiber returns a non-trivial pulse out + correct coupling efficiency. |
| **2** | RF / quantum / thermal modules with per-module evolvers. | EIT-style ρ(t) under control + probe lasers reproduces the textbook dark-state dip. |
| **3** | Sequence DB tables, timeline solver, sequence-editor UI. | A 4-event DLCZ sequence (write-pulse → store → read-pulse → detect) produces a heralded photon trace. |

---

## 9. Open questions to revisit before each phase

- **Q (Phase 1):** When wave-optics mode kicks in (post-aperture truncation),
  do we propagate the entire downstream chain in 2D field representation, or
  do we re-fit a Gaussian after each element? *Tentative answer:* keep wave
  representation until the chain hits a fiber/detector, then collapse via
  overlap integral. Re-fitting loses information.

- **Q (Phase 2):** What's the minimum Hilbert-space size we promise to handle
  cleanly? *Tentative answer:* up to N=64 dense ρ. Beyond that the user
  declares the system manually as a tensor-product factorisation.

- **Q (Phase 3):** Do we let users write Sequence as Python (like ARTIQ) or
  only via the editor UI? *Tentative answer:* both — a simple JSON form for
  the UI, plus a Python DSL exporter that lowers to the same JSON.

- **Q (storage):** Time traces can be 100 MB easily. Where do we put them?
  *Tentative answer:* JSONB stays for short traces (< 1 MB); add a
  `simulation_run_artifacts` table referencing files on disk for big runs.
  Phase 1 goal: just JSONB, accept the size cost; revisit at Phase 3.

---

## 10. What this document is NOT

- It is not the API contract — that's defined by the Pydantic schemas as
  they're added. This doc is a *plan*; if a Pydantic field disagrees with
  this doc, the Pydantic wins and this doc gets updated.
- It is not the user-facing documentation — that comes after the timeline UI
  ships in Phase 3.
- It is not exhaustive of every physics nuance. We pick canonical models
  (RWA optics, Lindblad master eq, lumped-element thermal); domain-experts
  will need to extend per case.
