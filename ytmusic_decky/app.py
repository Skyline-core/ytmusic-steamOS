"""Orquestación entre Qt WebEngine, inyección web y MPRIS."""

from __future__ import annotations

import logging
import os

from ytmusic_decky.player_state import PlayerState
from ytmusic_decky.web.window import DeckWindow, create_application

logger = logging.getLogger(__name__)


def _start_mpris(state: PlayerState, on_command) -> None:
    try:
        from ytmusic_decky.mpris.server import MPRIServer
    except ImportError:
        logger.warning(
            "MPRIS desactivado: instala dbus-python y PyGObject (solo Linux)"
        )
        return

    server = MPRIServer(state, on_command)
    server.start()


def _start_companion_api(
    state: PlayerState,
    dispatch_command,
    parent,
    *,
    host: str,
    port: int,
) -> None:
    try:
        from ytmusic_decky.api.command_bus import CommandBus
        from ytmusic_decky.api.server import CompanionApiServer
    except ImportError:
        logger.warning(
            "Companion API desactivado: instala aiohttp (pip install aiohttp)"
        )
        return

    try:
        bus = CommandBus(dispatch_command, parent)
        token = os.environ.get("YTMUSIC_DECKY_API_TOKEN", "").strip() or None
        server = CompanionApiServer(state, bus, host=host, port=port, token=token)
        server.start()
    except Exception:
        logger.exception(
            "Companion API no pudo arrancar (la app sigue sin Decky API)"
        )


def run(
    *,
    fullscreen: bool = True,
    enable_mpris: bool = True,
    enable_api: bool = True,
    api_host: str = "127.0.0.1",
    api_port: int = 26538,
) -> int:
    state = PlayerState()
    window: DeckWindow | None = None

    def on_command(command: str, data: dict | None = None) -> None:
        if window is not None:
            window.bridge.dispatch_command(command, data or {})

    if enable_mpris:
        _start_mpris(state, on_command)

    app = create_application()
    window = DeckWindow(state, on_command, fullscreen=fullscreen)

    if enable_api:
        _start_companion_api(
            state,
            window.bridge.dispatch_command,
            window,
            host=api_host,
            port=api_port,
        )

    logger.info(
        "ytmusic-decky iniciado (fullscreen=%s, mpris=%s, api=%s:%s)",
        fullscreen,
        enable_mpris,
        api_host if enable_api else "off",
        api_port if enable_api else "-",
    )
    return app.exec()
