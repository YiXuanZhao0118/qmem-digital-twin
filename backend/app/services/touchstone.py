"""Touchstone file parser — Phase B.7.

Wraps ``scikit-rf`` to turn an uploaded ``.sNp`` file (S-parameter data
from a VNA, EM solver, vendor data sheet, etc.) into a JSON payload the
frontend can plot on a Smith chart and S-parameter magnitude/phase plot.

Phase B.7 keeps it stateless: parse on POST, return the data, the caller
can plot it. No persistence — touchstones are user uploads, not first-class
project artifacts. Phase F may add a persisted ``touchstones`` table when
cross-module coupling needs reusable network blocks.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class TouchstoneResult:
    filename: str
    n_ports: int
    z0: float
    freq_hz: list[float]
    # s_params keyed by 'sNM' (1-indexed, e.g. 's11', 's21', ...). Each
    # value is a list of [re, im] pairs aligned with freq_hz.
    s_params: dict[str, list[list[float]]]


class TouchstoneError(ValueError):
    pass


def parse_touchstone(filename: str, content: bytes) -> TouchstoneResult:
    """Parse a Touchstone (.sNp) file into a JSON-friendly payload.

    Raises ``TouchstoneError`` on malformed input or anything scikit-rf
    refuses to load (wrong extension, garbage data, etc.).
    """
    # Lazy import so the rest of the module-import path doesn't pay for
    # numpy + scipy + scikit-rf when nothing in the request needs them.
    try:
        import skrf as rf
    except ImportError as exc:
        raise TouchstoneError(
            "scikit-rf not installed (pip install scikit-rf)"
        ) from exc

    # scikit-rf reads from a file path. Stash the upload in a tmp file
    # named with the original extension so the .sNp port-count detection
    # (built into rf.Network) works.
    import tempfile
    from pathlib import Path

    suffix = Path(filename).suffix or ".s2p"
    if not suffix.lower().startswith(".s") or not suffix[2:-1].isdigit():
        raise TouchstoneError(
            f"unsupported file extension {suffix!r} — expected .sNp like "
            f".s2p, .s3p, .s4p"
        )

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as fh:
        fh.write(content)
        tmp_path = Path(fh.name)

    try:
        try:
            network = rf.Network(str(tmp_path))
        except Exception as exc:
            raise TouchstoneError(f"scikit-rf failed to parse: {exc}") from exc

        n_ports = int(network.nports)
        if n_ports < 1:
            raise TouchstoneError(f"network has 0 ports")

        freq_hz = network.f.tolist()

        # Z0 may be per-port; collapse to a scalar if uniform, else NaN.
        z0_arr = network.z0
        if z0_arr.ndim >= 1 and z0_arr.size > 0:
            z0_first = complex(z0_arr.flat[0])
            z0_scalar = z0_first.real
        else:
            z0_scalar = 50.0

        s_params: dict[str, list[list[float]]] = {}
        s = network.s  # shape (n_freq, n_ports, n_ports), complex
        for i in range(n_ports):
            for j in range(n_ports):
                key = f"s{i + 1}{j + 1}"
                col = s[:, i, j]
                s_params[key] = [
                    [float(c.real), float(c.imag)] for c in col
                ]

        return TouchstoneResult(
            filename=filename,
            n_ports=n_ports,
            z0=z0_scalar,
            freq_hz=freq_hz,
            s_params=s_params,
        )
    finally:
        try:
            tmp_path.unlink()
        except OSError:
            pass


def to_dict(result: TouchstoneResult) -> dict[str, Any]:
    return {
        "filename": result.filename,
        "nPorts": result.n_ports,
        "z0": result.z0,
        "freqHz": result.freq_hz,
        "sParams": result.s_params,
    }
