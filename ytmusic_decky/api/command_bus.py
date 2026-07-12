"""Despacha comandos del API HTTP al hilo principal de Qt."""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Callable

from PySide6.QtCore import QObject, Q_ARG, QMetaObject, Qt, Slot

if TYPE_CHECKING:
    from ytmusic_decky.player_state import PlayerState

logger = logging.getLogger(__name__)


class CommandBus(QObject):
    """Puente thread-safe hacia bridge.dispatch_command."""

    def __init__(
        self,
        dispatch: Callable[[str, dict], None],
        parent: QObject | None = None,
    ) -> None:
        super().__init__(parent)
        self._dispatch = dispatch

    @Slot(str, str)
    def _run(self, command: str, data_json: str) -> None:
        try:
            data = json.loads(data_json) if data_json else {}
        except json.JSONDecodeError:
            data = {}
        try:
            self._dispatch(command, data)
        except Exception:
            logger.exception("Comando companion falló: %s", command)

    def post(self, command: str, data: dict | None = None) -> None:
        payload = json.dumps(data or {})
        QMetaObject.invokeMethod(
            self,
            "_run",
            Qt.ConnectionType.QueuedConnection,
            Q_ARG(str, command),
            Q_ARG(str, payload),
        )
