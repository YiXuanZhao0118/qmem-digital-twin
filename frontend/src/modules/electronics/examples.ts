/**
 * Built-in SPICE circuit examples — Phase B polish.
 *
 * The "Examples" dropdown in the Electronics sidebar uses these to
 * create-from-template. Each example must be a valid ngspice netlist
 * that runs to completion in under a few seconds.
 *
 * Conventions:
 *   - Use `.AC DEC` for frequency response (10 pts/decade is fine for
 *     UI demos; user can crank it).
 *   - Use `.TRAN` with `.options method=trap` if oscillation matters.
 *   - End with `.end` (not `.END` — ngspice case-insensitive but the
 *     examples should look clean).
 */

export type CircuitExample = {
  id: string;
  name: string;
  description: string;
  netlist: string;
};

export const CIRCUIT_EXAMPLES: CircuitExample[] = [
  {
    id: "rlc-bandpass",
    name: "RLC band-pass",
    description: "Series RLC with output across the capacitor — second-order low-pass with resonance peak.",
    netlist: `* RLC band-pass response across the capacitor
V1 in 0 AC 1
R1 in n1 100
L1 n1 n2 1m
C1 n2 0 1u
.AC DEC 20 100 1Meg
.end
`,
  },
  {
    id: "rc-divider",
    name: "RC voltage divider (DC)",
    description: "Two resistors + DC source — operating-point sanity check.",
    netlist: `* RC voltage divider — DC operating point
V1 in 0 5
R1 in mid 10k
R2 mid 0 10k
.op
.end
`,
  },
  {
    id: "transient-rc",
    name: "RC step response",
    description: "1V step into RC; observe v(out) charging exponentially toward 1 V (tau = RC).",
    netlist: `* RC step response — transient
V1 in 0 PULSE(0 1 0 1n 1n 100u 200u)
R1 in out 1k
C1 out 0 1u
.tran 1u 200u
.end
`,
  },
  {
    id: "common-emitter",
    name: "Common-emitter amplifier (BJT)",
    description: "2N3904 single-stage CE amp; AC sweep shows mid-band gain + roll-offs.",
    netlist: `* Common-emitter amplifier with 2N3904
V1 vcc 0 12
Vin in 0 AC 0.01
RB1 vcc base 100k
RB2 base 0 22k
RC vcc collector 4.7k
RE emitter 0 1k
CE emitter 0 100u
CIN in base 1u
COUT collector out 1u
RL out 0 10k
Q1 collector base emitter Q2N3904
.model Q2N3904 NPN(IS=1e-14 BF=200 VAF=100)
.AC DEC 10 1 10Meg
.end
`,
  },
  {
    id: "lc-tank",
    name: "LC tank (parallel resonator)",
    description: "Parallel LC fed by a current source — voltage peaks at resonance frequency.",
    netlist: `* Parallel LC tank — current source excitation
I1 0 n1 AC 1m
L1 n1 0 100u
C1 n1 0 100p
R1 n1 0 10k
.AC DEC 20 100k 100Meg
.end
`,
  },
];

export function findExampleById(id: string): CircuitExample | undefined {
  return CIRCUIT_EXAMPLES.find((e) => e.id === id);
}
