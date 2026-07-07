"""Orquestación entre Qt WebEngine, inyección web y MPRIS."""

from __future__ import annotations

import logging

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


def run(*, fullscreen: bool = True, enable_mpris: bool = True) -> int:
    state = PlayerState()
    window: DeckWindow | None = None

    def on_command(command: str, data: dict | None = None) -> None:
        if window is not None:
            window.bridge.dispatch_command(command, data or {})

    if enable_mpris:
        _start_mpris(state, on_command)

    app = create_application()
    window = DeckWindow(state, on_command, fullscreen=fullscreen)
    logger.info("ytmusic-decky iniciado (fullscreen=%s, mpris=%s)", fullscreen, enable_mpris)
    return app.exec()
