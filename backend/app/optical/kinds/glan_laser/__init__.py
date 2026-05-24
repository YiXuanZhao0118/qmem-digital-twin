"""Glan-Laser variant ops (glan_transmit_p, glan_reject_s) registered
under the polarizer kind. Importing this module forces polarizer/physics
to load first (Python module import is transitive)."""

from . import physics  # noqa: F401
