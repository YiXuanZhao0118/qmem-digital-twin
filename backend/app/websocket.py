from __future__ import annotations

from fastapi import APIRouter, WebSocket, WebSocketDisconnect


router = APIRouter()


class ConnectionManager:
    def __init__(self) -> None:
        self.active_connections: set[WebSocket] = set()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active_connections.add(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        self.active_connections.discard(websocket)

    async def broadcast(self, event_type: str, payload: dict[str, object]) -> None:
        event = {"type": event_type, "payload": payload}
        disconnected: list[WebSocket] = []
        for websocket in self.active_connections:
            try:
                await websocket.send_json(event)
            except RuntimeError:
                disconnected.append(websocket)
        for websocket in disconnected:
            self.disconnect(websocket)


manager = ConnectionManager()


@router.websocket("/scene")
async def scene_websocket(websocket: WebSocket) -> None:
    await manager.connect(websocket)
    await websocket.send_json({"type": "scene.connected", "payload": {}})
    try:
        while True:
            message = await websocket.receive_json()
            if message.get("type") == "ping":
                await websocket.send_json({"type": "pong", "payload": {}})
    except WebSocketDisconnect:
        manager.disconnect(websocket)

