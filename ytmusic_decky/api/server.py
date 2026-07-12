"""Servidor HTTP + WebSocket compatible con decky-youtube-music."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from typing import TYPE_CHECKING, Any, Callable

from aiohttp import web
import aiohttp

if TYPE_CHECKING:
    from ytmusic_decky.api.command_bus import CommandBus
    from ytmusic_decky.player_state import PlayerState

logger = logging.getLogger(__name__)

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 26538
API_PREFIX = "/api/v1"


def _cors_headers() -> dict[str, str]:
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Authorization,Content-Type",
        "Access-Control-Request-Private-Network": "true",
    }


class CompanionApiServer:
    """API companion en segundo plano (mismo puerto que th-ch/youtube-music)."""

    def __init__(
        self,
        state: PlayerState,
        command_bus: CommandBus,
        *,
        host: str = DEFAULT_HOST,
        port: int = DEFAULT_PORT,
        token: str | None = None,
    ) -> None:
        self._state = state
        self._command_bus = command_bus
        self._host = host
        self._port = port
        self._token = token or os.environ.get("YTMUSIC_DECKY_API_TOKEN", "").strip() or None
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._runner: web.AppRunner | None = None
        self._ws_clients: set[web.WebSocketResponse] = set()
        self._broadcast: Callable[[str, dict[str, Any]], None] | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._broadcast = self._schedule_broadcast
        self._state.subscribe_api(self._on_api_event)
        self._thread = threading.Thread(target=self._run_loop, name="companion-api", daemon=True)
        self._thread.start()
        logger.info("Companion API en http://%s:%s%s", self._host, self._port, API_PREFIX)

    def stop(self) -> None:
        if not self._loop:
            return

        async def _shutdown() -> None:
            if self._runner:
                await self._runner.cleanup()

        asyncio.run_coroutine_threadsafe(_shutdown(), self._loop)

    def _authorized(self, request: web.Request) -> bool:
        if not self._token:
            return True
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer ") and auth[7:].strip() == self._token:
            return True
        query_token = request.query.get("token")
        return query_token == self._token

    def _unauthorized(self) -> web.Response:
        return web.json_response({"error": "Unauthorized"}, status=401, headers=_cors_headers())

    def _no_content(self) -> web.Response:
        return web.Response(status=204, headers=_cors_headers())

    def _json(self, payload: Any, *, status: int = 200) -> web.Response:
        return web.json_response(payload, status=status, headers=_cors_headers())

    def _command(self, name: str, data: dict | None = None) -> web.Response:
        self._command_bus.post(name, data or {})
        return self._no_content()

    def _on_api_event(self, event_type: str, payload: dict[str, Any]) -> None:
        if self._broadcast:
            self._broadcast(event_type, payload)

    def _schedule_broadcast(self, event_type: str, payload: dict[str, Any]) -> None:
        if not self._loop:
            return
        asyncio.run_coroutine_threadsafe(
            self._broadcast_async(event_type, payload),
            self._loop,
        )

    async def _broadcast_async(self, event_type: str, payload: dict[str, Any]) -> None:
        message = json.dumps({"type": event_type, **payload})
        dead: list[web.WebSocketResponse] = []
        for ws in list(self._ws_clients):
            try:
                await ws.send_str(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._ws_clients.discard(ws)

    async def _handle_options(self, request: web.Request) -> web.Response:
        return web.Response(status=204, headers=_cors_headers())

    async def _handle_play(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        return self._command("play")

    async def _handle_pause(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        return self._command("pause")

    async def _handle_toggle_play(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        return self._command("playPause")

    async def _handle_next(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        return self._command("next")

    async def _handle_previous(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        return self._command("previous")

    async def _handle_seek_to(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        body = await request.json() if request.can_read_body else {}
        seconds = body.get("seconds")
        if not isinstance(seconds, (int, float)):
            return self._json({"error": "seconds required"}, status=400)
        return self._command("seekTo", {"seconds": float(seconds)})

    async def _handle_volume_post(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        body = await request.json() if request.can_read_body else {}
        volume = body.get("volume")
        if not isinstance(volume, (int, float)):
            return self._json({"error": "volume required"}, status=400)
        return self._command("setVolume", {"volume": float(volume) / 100.0})

    async def _handle_toggle_mute(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        return self._command("toggleMute")

    async def _handle_shuffle(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        return self._command("setShuffle")

    async def _handle_switch_repeat(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        return self._command("setLoop")

    async def _handle_song(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        return self._json(self._state.companion_song())

    async def _handle_volume_get(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        return self._json(self._state.companion_volume())

    async def _handle_queue_get(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        return self._json(self._state.companion_queue())

    async def _handle_queue_patch(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        body = await request.json() if request.can_read_body else {}
        index = body.get("index")
        if not isinstance(index, int):
            return self._json({"error": "index required"}, status=400)
        return self._command("queueIndex", {"index": index})

    async def _handle_queue_delete(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        return self._command("queueClear")

    async def _handle_queue_delete_index(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        try:
            index = int(request.match_info["index"])
        except (KeyError, TypeError, ValueError):
            return self._json({"error": "invalid index"}, status=400)
        return self._command("queueRemove", {"index": index})

    async def _handle_queue_post(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        # Añadir a cola requiere búsqueda/navegación YTM; no soportado aún.
        return self._json({"error": "add-to-queue not implemented"}, status=501)

    async def _handle_search(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        return self._json([], status=200)

    async def _handle_ws(self, request: web.Request) -> web.StreamResponse:
        if not self._authorized(request):
            return self._unauthorized()

        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        self._ws_clients.add(ws)

        event_type, payload = self._state.build_player_info_event()
        await ws.send_str(json.dumps({"type": event_type, **payload}))

        try:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    continue
                if msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.ERROR):
                    break
        finally:
            self._ws_clients.discard(ws)
        return ws

    def _build_app(self) -> web.Application:
        app = web.Application()
        p = API_PREFIX

        for path in (
            f"{p}/play",
            f"{p}/pause",
            f"{p}/toggle-play",
            f"{p}/next",
            f"{p}/previous",
            f"{p}/seek-to",
            f"{p}/volume",
            f"{p}/toggle-mute",
            f"{p}/shuffle",
            f"{p}/switch-repeat",
            f"{p}/song",
            f"{p}/queue",
            f"{p}/search",
            f"{p}/ws",
            f"{p}/queue/{{index}}",
        ):
            app.router.add_route("OPTIONS", path, self._handle_options)

        app.router.add_post(f"{p}/play", self._handle_play)
        app.router.add_post(f"{p}/pause", self._handle_pause)
        app.router.add_post(f"{p}/toggle-play", self._handle_toggle_play)
        app.router.add_post(f"{p}/next", self._handle_next)
        app.router.add_post(f"{p}/previous", self._handle_previous)
        app.router.add_post(f"{p}/seek-to", self._handle_seek_to)
        app.router.add_post(f"{p}/volume", self._handle_volume_post)
        app.router.add_get(f"{p}/volume", self._handle_volume_get)
        app.router.add_post(f"{p}/toggle-mute", self._handle_toggle_mute)
        app.router.add_post(f"{p}/shuffle", self._handle_shuffle)
        app.router.add_post(f"{p}/switch-repeat", self._handle_switch_repeat)
        app.router.add_get(f"{p}/song", self._handle_song)
        app.router.add_get(f"{p}/queue", self._handle_queue_get)
        app.router.add_patch(f"{p}/queue", self._handle_queue_patch)
        app.router.add_delete(f"{p}/queue", self._handle_queue_delete)
        app.router.add_post(f"{p}/queue", self._handle_queue_post)
        app.router.add_delete(f"{p}/queue/{{index}}", self._handle_queue_delete_index)
        app.router.add_post(f"{p}/search", self._handle_search)
        app.router.add_get(f"{p}/ws", self._handle_ws)
        return app

    async def _serve(self) -> None:
        app = self._build_app()
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self._host, self._port)
        await site.start()
        while True:
            await asyncio.sleep(3600)

    def _run_loop(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._serve())
        except Exception:
            logger.exception("Companion API detenido por error")
