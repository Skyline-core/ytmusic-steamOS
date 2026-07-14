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
    # Decky / Chromium Private Network Access: el cliente envía
    # Access-Control-Request-Private-Network y el servidor debe responder Allow.
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Authorization,Content-Type",
        "Access-Control-Allow-Private-Network": "true",
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

    async def _emit_player_snapshot(self, *, is_playing: bool | None = None) -> None:
        snap = self._state.snapshot()
        playing = (
            is_playing
            if is_playing is not None
            else snap["playback_status"] == "Playing"
        )
        await self._broadcast_async(
            "PLAYER_STATE_CHANGED",
            {
                "isPlaying": playing,
                "position": snap["position_us"] // 1_000_000,
            },
        )
        meta = snap["metadata"]
        if not (meta.title or meta.art_url or meta.video_id):
            return
        info_type, info_payload = self._state.build_player_info_event()
        if is_playing is not None:
            info_payload = {**info_payload, "isPlaying": is_playing}
            if isinstance(info_payload.get("song"), dict):
                info_payload["song"] = {
                    **info_payload["song"],
                    "isPaused": not is_playing,
                }
        await self._broadcast_async(info_type, info_payload)

    async def _handle_play(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        self._state.set_playback_status("Playing", emit=False)
        self._command_bus.post("play")
        await self._emit_player_snapshot(is_playing=True)
        return self._no_content()

    async def _handle_pause(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        self._state.set_playback_status("Paused", emit=False)
        self._command_bus.post("pause")
        await self._emit_player_snapshot(is_playing=False)
        return self._no_content()

    async def _handle_toggle_play(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        snap = self._state.snapshot()
        playing = snap["playback_status"] == "Playing"
        next_playing = not playing
        self._state.set_playback_status(
            "Playing" if next_playing else "Paused", emit=False
        )
        self._command_bus.post("playPause")
        await self._emit_player_snapshot(is_playing=next_playing)
        return self._no_content()

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
        seconds = max(0.0, float(seconds))
        # Optimistic: Decky barra de progreso se actualiza al instante.
        self._state.set_position_seconds(seconds, emit=False)
        self._command_bus.post("seekTo", {"seconds": seconds})
        await self._broadcast_async(
            "POSITION_CHANGED",
            {"position": int(seconds)},
        )
        await self._emit_player_snapshot()
        return self._no_content()

    async def _handle_volume_post(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        body = await request.json() if request.can_read_body else {}
        volume = body.get("volume")
        if not isinstance(volume, (int, float)):
            return self._json({"error": "volume required"}, status=400)
        level = float(volume)
        self._state.set_volume(level / 100.0)
        self._command_bus.post("setVolume", {"volume": level / 100.0})
        snap = self._state.snapshot()
        await self._broadcast_async(
            "VOLUME_CHANGED",
            {"volume": round(level), "muted": snap["muted"]},
        )
        return self._no_content()

    async def _handle_toggle_mute(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        snap = self._state.snapshot()
        self._command_bus.post("toggleMute")
        await self._broadcast_async(
            "VOLUME_CHANGED",
            {
                "volume": round(snap["volume"] * 100),
                "muted": not snap["muted"],
            },
        )
        return self._no_content()

    async def _handle_shuffle(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        # Plugin: POST /shuffle sin body (toggle). Ver apiClient.shuffle().
        snap = self._state.snapshot()
        next_shuffle = not snap["shuffle"]
        self._state.set_shuffle(next_shuffle, emit=False)
        self._command_bus.post("setShuffle", {"shuffle": next_shuffle})
        await self._broadcast_async("SHUFFLE_CHANGED", {"shuffle": next_shuffle})
        await self._emit_player_snapshot()
        asyncio.create_task(self._reinforce_mode("shuffle", next_shuffle))
        return self._no_content()

    async def _handle_switch_repeat(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        # Plugin: POST /switch-repeat { iteration } — PlayerView siempre manda 1.
        body = await request.json() if request.can_read_body else {}
        iteration = body.get("iteration", 1)
        if not isinstance(iteration, int):
            iteration = 1
        iteration = max(1, min(5, iteration))
        # Ciclo None → Playlist → Track → None (th-ch / Decky RepeatMode).
        order = ["None", "Playlist", "Track"]
        snap = self._state.snapshot()
        try:
            idx = order.index(snap["loop_status"])
        except ValueError:
            idx = 0
        next_status = order[(idx + iteration) % len(order)]
        self._state.set_loop_status(next_status, emit=False)
        # Mandamos status objetivo para un solo click verificado (evitar doble avance).
        self._command_bus.post("setLoop", {"status": next_status, "iteration": 1})
        mapped = self._state._map_repeat(next_status)
        await self._broadcast_async("REPEAT_CHANGED", {"repeat": mapped})
        await self._emit_player_snapshot()
        asyncio.create_task(self._reinforce_mode("repeat", mapped))
        return self._no_content()

    async def _reinforce_mode(self, kind: str, value: Any) -> None:
        """Reafirma WS una vez; refresca cola tras shuffle (sin multi-clicks)."""
        await asyncio.sleep(1.2)
        if kind == "shuffle":
            self._command_bus.post("refreshQueue")
        snap = self._state.snapshot()
        if kind == "shuffle":
            if snap["shuffle"] != bool(value):
                return
            await self._broadcast_async("SHUFFLE_CHANGED", {"shuffle": bool(value)})
        else:
            mapped = self._state._map_repeat(snap["loop_status"])
            if mapped != value:
                return
            await self._broadcast_async("REPEAT_CHANGED", {"repeat": mapped})
        await self._emit_player_snapshot()

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
        self._command_bus.post("refreshQueue")
        # El plugin Decky solo pide la cola una vez al abrir; esperamos a que
        # bridge.js reporte ítems (o al menos la canción actual).
        loop = asyncio.get_running_loop()
        deadline = loop.time() + 2.5
        while loop.time() < deadline:
            queue = self._state.companion_queue()
            if queue.get("items"):
                return self._json(queue)
            await asyncio.sleep(0.25)
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

        snap = self._state.snapshot()
        meta = snap["metadata"]
        if meta.title or meta.art_url or meta.video_id:
            event_type, payload = self._state.build_player_info_event()
            await ws.send_str(json.dumps({"type": event_type, **payload}))
        else:
            await ws.send_str(
                json.dumps(
                    {
                        "type": "PLAYER_STATE_CHANGED",
                        "isPlaying": snap["playback_status"] == "Playing",
                        "position": snap["position_us"] // 1_000_000,
                    }
                )
            )

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

    async def _player_info_heartbeat(self) -> None:
        """Reenvía estado periódicamente. Solo manda song si hay metadatos."""
        while True:
            await asyncio.sleep(2)
            if not self._ws_clients:
                continue
            snap = self._state.snapshot()
            meta = snap["metadata"]
            if meta.title or meta.art_url or meta.video_id:
                event_type, payload = self._state.build_player_info_event()
                await self._broadcast_async(event_type, payload)
            else:
                await self._broadcast_async(
                    "PLAYER_STATE_CHANGED",
                    {
                        "isPlaying": snap["playback_status"] == "Playing",
                        "position": snap["position_us"] // 1_000_000,
                    },
                )

    async def _serve(self) -> None:
        app = self._build_app()
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self._host, self._port)
        try:
            await site.start()
        except OSError as exc:
            logger.error(
                "No se pudo abrir el puerto %s:%s (¿otra app en 26538?): %s",
                self._host,
                self._port,
                exc,
            )
            raise
        logger.info(
            "Companion API activo en http://%s:%s%s",
            self._host,
            self._port,
            API_PREFIX,
        )
        asyncio.create_task(self._player_info_heartbeat())
        while True:
            await asyncio.sleep(3600)

    def _run_loop(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._serve())
        except Exception:
            logger.exception("Companion API detenido por error")
