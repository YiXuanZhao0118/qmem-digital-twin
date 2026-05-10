"""UUIDv7 generator (RFC 9562 draft) — opaque, time-ordered string IDs.

UUIDv7 is the format the V2 schema uses for every persisted id (DB rows,
JSONB-child records like asset anchors, anchor bindings, optical sources,
ports, links, revisions, simulation runs). It encodes 48 bits of millisecond
Unix time at the front, so ids generated later sort lexicographically after
earlier ids — useful for index locality and human-eyeballed ordering.

Python's stdlib `uuid` does not yet ship a v7 generator (proposed but not
landed as of 3.13), so this module provides one.

Output is a 36-char string in canonical hyphenated form. Use `uuid7()` for
new V2 records; existing DB rows continue to use `uuid.uuid4()` until their
respective migrations land.
"""

from __future__ import annotations

import os
import time
import uuid


def uuid7() -> uuid.UUID:
    """Generate a UUIDv7 (time-ordered, opaque) UUID.

    Layout per RFC 9562:
      - 48 bits: unix_ts_ms (big-endian)
      - 4 bits:  version (= 7)
      - 12 bits: rand_a
      - 2 bits:  variant (= 10)
      - 62 bits: rand_b
    """
    ts_ms = int(time.time() * 1000) & ((1 << 48) - 1)
    rand = int.from_bytes(os.urandom(10), "big")  # 80 bits of randomness

    # Compose 128 bits.
    rand_a = rand & ((1 << 12) - 1)               # 12 bits
    rand_b = (rand >> 12) & ((1 << 62) - 1)       # 62 bits

    value = (ts_ms << 80) | (0x7 << 76) | (rand_a << 64) | (0b10 << 62) | rand_b
    return uuid.UUID(int=value)


def uuid7_str() -> str:
    """Return a UUIDv7 as a canonical hyphenated string."""
    return str(uuid7())
