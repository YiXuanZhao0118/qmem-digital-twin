"""SQLAlchemy declarative base + shared JSON type aliases.

Every themed model module imports ``Base``, ``JsonDict``, and
``JsonList`` from here so the declarative registry stays unified.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


JsonDict = dict[str, Any]
JsonList = list[Any]
