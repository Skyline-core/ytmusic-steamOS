"""Ventana Qt WebEngine con inyección de CSS/JS para modo Deck."""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Callable

from PySide6.QtCore import QObject, Qt, QTimer, QUrl, Slot
from PySide6.QtGui import QGuiApplication
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineCore import (
    QWebEnginePage,
    QWebEngineProfile,
    QWebEngineScript,
    QWebEngineSettings,
)
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QApplication, QMainWindow

from ytmusic_decky.web.injector import DeckInjector
from ytmusic_decky.web.profile import create_deck_profile

if TYPE_CHECKING:
    from ytmusic_decky.player_state import PlayerState

logger = logging.getLogger(__name__)

YTMUSIC_URL = "https://music.youtube.com/"


class DeckWebPage(QWebEnginePage):
    """Página web con captura de errores JS (Qt6 usa método virtual, no signal)."""

    def __init__(
        self,
        profile: QWebEngineProfile,
        on_console: Callable[[QWebEnginePage.JavaScriptConsoleMessageLevel, str, int, str], None] | None = None,
        parent: QObject | None = None,
    ) -> None:
        super().__init__(profile, parent)
        self._on_console = on_console

    def javaScriptConsoleMessage(
        self,
        level: QWebEnginePage.JavaScriptConsoleMessageLevel,
        message: str,
        line_number: int,
        source_id: str,
    ) -> None:
        if self._on_console is not None:
            self._on_console(level, message, line_number, source_id)


class WebBridge(QObject):
    """Puente expuesto a JavaScript vía QWebChannel."""

    def __init__(
        self,
        state: PlayerState,
        on_command: Callable[[str, dict], None],
        parent: QObject | None = None,
    ) -> None:
        super().__init__(parent)
        self._state = state
        self._on_command = on_command
        self._view: QWebEngineView | None = None

    def attach_view(self, view: QWebEngineView) -> None:
        self._view = view

    @Slot(str)
    def reportState(self, payload_json: str) -> None:
        try:
            payload = json.loads(payload_json)
        except json.JSONDecodeError:
            return
        self._state.update_from_web(payload)

    @Slot(str)
    def log(self, message: str) -> None:
        logger.debug("[web] %s", message)

    def run_js(self, script: str) -> None:
        if self._view is None:
            return
        self._view.page().runJavaScript(script)

    def dispatch_command(self, command: str, data: dict | None = None) -> None:
        payload = json.dumps(data or {})
        safe_cmd = json.dumps(command)
        self.run_js(f"window.YTMDeck && window.YTMDeck.handleCommand({safe_cmd}, {payload});")


class DeckWindow(QMainWindow):
    def __init__(
        self,
        state: PlayerState,
        on_command: Callable[[str, dict], None],
        fullscreen: bool = True,
    ) -> None:
        super().__init__()
        self._state = state
        self._on_command = on_command
        self._bridge = WebBridge(state, on_command, self)
        self._injector = DeckInjector()
        self._inject_attempts = 0
        self._inject_timer = QTimer(self)
        self._inject_timer.setInterval(1500)
        self._inject_timer.timeout.connect(self._inject_all)

        self.setWindowTitle("YouTube Music Deck")
        self.setAttribute(Qt.WidgetAttribute.WA_AcceptTouchEvents, True)

        self._profile = create_deck_profile(self)
        self._install_profile_scripts(self._profile)

        page = DeckWebPage(self._profile, on_console=self._on_js_console, parent=self)
        channel = QWebChannel(page)
        channel.registerObject("bridge", self._bridge)
        page.setWebChannel(channel)

        self._view = QWebEngineView(self)
        self._view.setPage(page)
        self._bridge.attach_view(self._view)
        self.setCentralWidget(self._view)

        settings = self._view.settings()
        settings.setAttribute(QWebEngineSettings.WebAttribute.JavascriptEnabled, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.LocalStorageEnabled, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.PlaybackRequiresUserGesture, False)
        settings.setAttribute(QWebEngineSettings.WebAttribute.FullScreenSupportEnabled, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.TouchIconsEnabled, True)

        page.loadFinished.connect(self._on_load_finished)
        page.load(QUrl(YTMUSIC_URL))

        if fullscreen:
            self.showFullScreen()
        else:
            self.resize(1280, 800)
            self.show()

    @property
    def bridge(self) -> WebBridge:
        return self._bridge

    def _install_profile_scripts(self, profile: QWebEngineProfile) -> None:
        """Registra CSS en el perfil Qt (solo DocumentReady, DOM ya existe)."""
        scripts = profile.scripts()
        self._remove_named_scripts(scripts, "ytm-deck")

        source = self._injector.profile_script_source()
        script = QWebEngineScript()
        script.setName("ytm-deck-css-ready")
        script.setSourceCode(source)
        script.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentReady)
        script.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
        script.setRunsOnSubFrames(True)
        scripts.insert(script)
        logger.info("Script de perfil registrado (DocumentReady)")

    @staticmethod
    def _remove_named_scripts(scripts, prefix: str) -> None:
        for item in scripts.toList():
            if item.name().startswith(prefix):
                scripts.remove(item)

    def _on_js_console(self, level: QWebEnginePage.JavaScriptConsoleMessageLevel, message: str, line: int, source: str) -> None:
        if level == QWebEnginePage.JavaScriptConsoleMessageLevel.ErrorMessageLevel:
            logger.warning("JS error [%s:%s] %s", source, line, message)
        elif "ytm-deck" in message:
            logger.info("JS [%s:%s] %s", source, line, message)

    def _inject_all(self) -> None:
        page = self._view.page()
        self._inject_attempts += 1

        page.runJavaScript(self._injector.css_call(), self._on_css_result)
        page.runJavaScript(self._injector.bridge_call(), self._on_bridge_result)

        if self._inject_attempts % 10 == 0:
            page.runJavaScript(self._injector.probe_call(), self._on_probe_result)

        if self._inject_attempts >= 8:
            self._inject_timer.stop()
            logger.info("Inyección inicial completada")

    def _on_css_result(self, result) -> None:
        if self._inject_attempts <= 3 or (isinstance(result, str) and result.startswith("css-error")):
            logger.info("CSS inject → %s", result)

    def _on_bridge_result(self, result) -> None:
        if self._inject_attempts <= 3 or (isinstance(result, str) and "error" in str(result)):
            logger.info("Bridge inject → %s", result)

    def _on_probe_result(self, result) -> None:
        logger.info("Probe inyección → %s", result)
        if result:
            try:
                data = json.loads(result)
                if data.get("deckClass") or data.get("hasStyleTag") or data.get("hasSheet"):
                    self._inject_timer.setInterval(4000)
            except json.JSONDecodeError:
                pass

    def _on_load_finished(self, ok: bool) -> None:
        if not ok:
            logger.error("No se pudo cargar YouTube Music")
            return
        logger.info("Página cargada; iniciando inyección Deck")
        self._inject_attempts = 0
        page = self._view.page()
        self._inject_timer.start()
        for delay in (0, 500, 1500):
            QTimer.singleShot(delay, self._inject_all)

    def keyPressEvent(self, event) -> None:
        key = event.key()
        if key == Qt.Key.Key_Space:
            self._bridge.dispatch_command("playPause")
            event.accept()
            return
        if key == Qt.Key.Key_MediaPlay:
            self._bridge.dispatch_command("play")
            event.accept()
            return
        if key == Qt.Key.Key_MediaPause:
            self._bridge.dispatch_command("pause")
            event.accept()
            return
        if key == Qt.Key.Key_MediaTogglePlayPause:
            self._bridge.dispatch_command("playPause")
            event.accept()
            return
        if key == Qt.Key.Key_MediaNext:
            self._bridge.dispatch_command("next")
            event.accept()
            return
        if key == Qt.Key.Key_MediaPrevious:
            self._bridge.dispatch_command("previous")
            event.accept()
            return
        if key == Qt.Key.Key_Escape:
            self._bridge.dispatch_command("back")
            event.accept()
            return
        super().keyPressEvent(event)


def create_application() -> QApplication:
    import os

    if os.environ.get("YTMUSIC_DECKY_SOFTWARE_GL", "").lower() in ("1", "true", "yes"):
        QGuiApplication.setAttribute(Qt.ApplicationAttribute.AA_UseSoftwareOpenGL, True)

    QGuiApplication.setOrganizationName("ytmusic-decky")
    QGuiApplication.setOrganizationDomain("ytmusic-decky.local")
    QGuiApplication.setApplicationName("ytmusic-decky")
    QGuiApplication.setAttribute(Qt.ApplicationAttribute.AA_EnableHighDpiScaling, True)
    QGuiApplication.setAttribute(Qt.ApplicationAttribute.AA_UseHighDpiPixmaps, True)
    app = QApplication([])
    app.setApplicationName("ytmusic-decky")
    app.setDesktopFileName("ytmusic-decky")
    return app
