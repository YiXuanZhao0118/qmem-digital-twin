from __future__ import annotations

import asyncio
import random
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone


StatePublisher = Callable[[str, dict[str, object]], Awaitable[None]]


async def fake_poll_device_state(
    component_id: str,
    publish: StatePublisher,
    interval_seconds: float = 1.0,
) -> None:
    """Emit fake device states until cancelled.

    The publisher is responsible for writing to device_states and broadcasting
    device_state.updated. Real drivers can keep the same output contract.
    """

    while True:
        state: dict[str, object] = {
            "enabled": random.choice([True, False]),
            "rfPowerDbm": 20 + random.uniform(-0.2, 0.2),
            "temperatureC": 30 + random.uniform(-1, 1),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        await publish(component_id, state)
        await asyncio.sleep(interval_seconds)

