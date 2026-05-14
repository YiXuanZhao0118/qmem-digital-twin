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
  {
    id: "ad9959-recon-lpf",
    name: "AD9959 200 MHz reconstruction LPF",
    description: "DAC-output reconstruction filter from AD9958/59 EVB schematic 02-038696-01 — elliptic ladder, 50 ohm in/out.",
    netlist: `* AD9958/59 EVB 200 MHz reconstruction LPF (one DAC output filter)
* Transcribed verbatim from ADI eval board schematic 02-038696-01 (Rev C, 2004).
* Each AD9959 DAC channel feeds an identical instance of this filter.
*
* Topology: 50-ohm source/load elliptic ladder, 6 poles + 3 transmission zeros.
*   Series tanks (L || C_par => transmission zero):
*     L11 33 nH || C34  10 pF   -> notch near 277 MHz
*     L10 47 nH || C10   5 pF   -> notch near 329 MHz
*     L12 56 nH || C9  0.75 pF  -> notch near 776 MHz
*   Shunt cap pairs at each node (top + bottom on schematic) sum to:
*     N1 = C3 + C6 =  5p +  5p = 10 pF
*     N2 = C1 + C5 = 10p + 10p = 20 pF
*     N3 = C2 + C7 = 12p + 12p = 24 pF
V1 in 0 AC 1
Rsrc in n1 50
Cn1 n1 0 10p
La  n1 n2 33n
Ca  n1 n2 10p
Cn2 n2 0 20p
Lb  n2 n3 47n
Cb  n2 n3 5p
Cn3 n3 0 24p
Lc  n3 out 56n
Cc  n3 out 0.75p
Rload out 0 50
.AC DEC 50 1Meg 2G
.end
`,
  },
  {
    id: "ad9959-dds-sampled",
    name: "AD9959 sampled DDS → 200 MHz LPF",
    description: "Behavioral DDS DAC (10-bit, zero-order-hold at SYSCLK) into the EVB reconstruction LPF — shows staircase + Fourier images.",
    netlist: `* AD9959 sampled DDS DAC output, reconstructed by the EVB 200 MHz LPF.
* Filter values from ADI eval board schematic 02-038696-01.
*
* Behavioral model of one DDS channel (replaces the chip's internal blocks):
*   Phase accumulator + sin ROM   -> sin(2*pi*Fout*n*Ts)
*   10-bit DAC quantization step  -> Q = 1/512 of half-scale
*   Zero-order hold at SYSCLK=Fs  -> floor(time/Ts) picks current sample n
*
* Sampling equation (continuous-time output of the DAC):
*   for n*Ts <= t < (n+1)*Ts :
*     V_DAC(t) = A * Q * floor( sin(2*pi*Fout*n*Ts) / Q + 0.5 )
*
* After .tran + .four expect:
*   v(dac): staircase, fundamental at Fout + images at k*Fs +- Fout
*           rolling off with sinc(pi*f/Fs) envelope.
*   v(out): images above ~200 MHz attenuated by the elliptic LPF.
.param Fout=80Meg Fs=500Meg A=0.5 Ts={1/Fs} Q={1/512}
Bdac dac 0 V = A*Q*floor( sin(2*pi*Fout*Ts*floor(time/Ts))/Q + 0.5 )
* 50-ohm source impedance into the LPF (collapses the balun + 50R pullup)
Rsrc dac n1 50
Cn1 n1 0 10p
La  n1 n2 33n
Ca  n1 n2 10p
Cn2 n2 0 20p
Lb  n2 n3 47n
Cb  n2 n3 5p
Cn3 n3 0 24p
Lc  n3 out 56n
Cc  n3 out 0.75p
Rload out 0 50
.tran 100p 500n 0 200p uic
.four 80Meg v(dac) v(out)
.end
`,
  },
];

export function findExampleById(id: string): CircuitExample | undefined {
  return CIRCUIT_EXAMPLES.find((e) => e.id === id);
}
