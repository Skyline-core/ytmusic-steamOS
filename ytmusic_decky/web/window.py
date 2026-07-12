"""Ventana Qt WebEngine con inyección de CSS/JS para modo Deck."""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Callable

from PySide6.QtCore import QObject, Qt, QTimer, QUrl, Slot, QEvent
from PySide6.QtGui import QCursor, QGuiApplication, QMouseEvent, QPixmap
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineCore import (
    QWebEnginePage,
    QWebEngineProfile,
    QWebEngineScript,
    QWebEngineSettings,
)
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QApplication, QMainWindow, QWidget

from ytmusic_decky.web.injector import DeckInjector
from ytmusic_decky.web.profile import create_deck_profile

if TYPE_CHECKING:
    from ytmusic_decky.player_state import PlayerState

logger = logging.getLogger(__name__)

YTMUSIC_URL = "https://music.youtube.com/"
_BLANK_CURSOR_CACHE: QCursor | None = None


def get_blank_cursor() -> QCursor:
    global _BLANK_CURSOR_CACHE
    if _BLANK_CURSOR_CACHE is None:
        pix = QPixmap(1, 1)
        pix.fill(Qt.GlobalColor.transparent)
        _BLANK_CURSOR_CACHE = QCursor(pix, 0, 0)
    return _BLANK_CURSOR_CACHE


def _apply_app_override_cursor() -> None:
    app = QApplication.instance()
    if app is None:
        return
    cursor = get_blank_cursor()
    if app.overrideCursor() is None:
        app.setOverrideCursor(cursor)
    else:
        app.changeOverrideCursor(cursor)


class TouchDeckWebView(QWebEngineView):
    """WebView táctil: oculta el cursor para que Qt no interfiera con gestos."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setAttribute(Qt.WidgetAttribute.WA_AcceptTouchEvents, True)

    def _apply_blank_cursor(self) -> None:
        if QApplication.instance() is None:
            return
        self.setCursor(get_blank_cursor())

    def showEvent(self, event) -> None:
        super().showEvent(event)
        QTimer.singleShot(0, self._apply_blank_cursor)

    def event(self, event) -> bool:
        if _touch_ui_mode():
            et = event.type()
            if et in (
                QEvent.Type.TouchBegin,
                QEvent.Type.TouchUpdate,
                QEvent.Type.TouchEnd,
                QEvent.Type.TouchCancel,
            ):
                self._apply_blank_cursor()
                window = self.window()
                if isinstance(window, DeckWindow):
                    window._hide_system_cursor()
            elif et in (QEvent.Type.MouseMove, QEvent.Type.MouseButtonPress, QEvent.Type.MouseButtonRelease):
                if isinstance(event, QMouseEvent):
                    src = event.source()
                    if src in (
                        Qt.MouseEventSource.MouseEventSynthesizedBySystem,
                        Qt.MouseEventSource.MouseEventSynthesizedByQt,
                    ):
                        self._apply_blank_cursor()
                        window = self.window()
                        if isinstance(window, DeckWindow):
                            window._hide_system_cursor()
        return super().event(event)


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

    def renderProcessTerminated(
        self,
        termination_status: QWebEnginePage.RenderProcessTerminationStatus,
        exit_code: int,
    ) -> None:
        logger.error(
            "Proceso de render WebEngine terminado (status=%s, exit=%s). "
            "Prueba YTMUSIC_DECKY_SOFTWARE_GL=1 o YTMUSIC_DECKY_GPU=1",
            int(termination_status),
            exit_code,
        )


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
        self._cursor_timer = QTimer(self)
        self._cursor_timer.setInterval(120)
        self._cursor_timer.timeout.connect(self._hide_system_cursor)

        self.setWindowTitle("YouTube Music Deck")
        self.setAttribute(Qt.WidgetAttribute.WA_AcceptTouchEvents, True)

        self._profile = create_deck_profile(self)
        self._install_profile_scripts(self._profile)

        page = DeckWebPage(self._profile, on_console=self._on_js_console, parent=self)
        channel = QWebChannel(page)
        channel.registerObject("bridge", self._bridge)
        page.setWebChannel(channel)

        self._view = TouchDeckWebView(self)
        self._view.setPage(page)
        self._bridge.attach_view(self._view)
        self.setCentralWidget(self._view)

        settings = self._view.settings()
        settings.setAttribute(QWebEngineSettings.WebAttribute.JavascriptEnabled, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.LocalStorageEnabled, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.PlaybackRequiresUserGesture, False)
        settings.setAttribute(QWebEngineSettings.WebAttribute.FullScreenSupportEnabled, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.TouchIconsEnabled, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.TouchEventsApiEnabled, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.ScrollAnimatorEnabled, True)

        page.loadFinished.connect(self._on_load_finished)
        page.loadProgress.connect(self._on_load_progress)
        page.load(QUrl(YTMUSIC_URL))

        if fullscreen:
            self.showFullScreen()
        else:
            self.resize(1280, 800)
            self.show()
        self.raise_()
        self.activateWindow()

        if _touch_ui_mode():
            self._hide_system_cursor()
            QTimer.singleShot(0, self._view._apply_blank_cursor)
            self._cursor_timer.start()

    def _hide_system_cursor(self) -> None:
        if not _touch_ui_mode():
            return
        cursor = get_blank_cursor()
        self.setCursor(cursor)
        if self._view is not None:
            self._view.setCursor(cursor)
        _apply_app_override_cursor()

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

    def _on_load_progress(self, progress: int) -> None:
        if progress in (0, 25, 50, 75, 100):
            logger.info("Carga YouTube Music: %s%%", progress)

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


def _steam_touch_mode() -> bool:
    import os

    if os.environ.get("YTMUSIC_DECKY_STEAM", "").strip().lower() in ("1", "true", "yes"):
        return True
    return bool(os.environ.get("SteamGameId") or os.environ.get("STEAM_RUNTIME"))


def _touch_ui_mode() -> bool:
    import os
    import sys

    hide = os.environ.get("YTMUSIC_DECKY_HIDE_CURSOR", "").strip().lower()
    if hide in ("0", "false", "no"):
        return False
    if hide in ("1", "true", "yes"):
        return True
    if getattr(sys, "frozen", False):
        return True
    return _steam_touch_mode()


def _use_software_gl() -> bool:
    import os
    import sys

    if os.environ.get("YTMUSIC_DECKY_GPU", "").strip().lower() in ("1", "true", "yes"):
        return False
    if os.environ.get("YTMUSIC_DECKY_SOFTWARE_GL", "").strip().lower() in ("0", "false", "no"):
        return False
    if getattr(sys, "frozen", False):
        return os.environ.get("YTMUSIC_DECKY_SOFTWARE_GL", "").strip().lower() in ("1", "true", "yes")
    return os.environ.get("YTMUSIC_DECKY_SOFTWARE_GL", "").strip().lower() in ("1", "true", "yes")


def create_application() -> QApplication:
    if _use_software_gl():
        QGuiApplication.setAttribute(Qt.ApplicationAttribute.AA_UseSoftwareOpenGL, True)
        QGuiApplication.setAttribute(Qt.ApplicationAttribute.AA_ShareOpenGLContexts, True)

    if _touch_ui_mode():
        QGuiApplication.setAttribute(
            Qt.ApplicationAttribute.AA_SynthesizeMouseForUnhandledTouchEvents, False
        )
        QGuiApplication.setAttribute(
            Qt.ApplicationAttribute.AA_SynthesizeMouseForUnhandledTabletEvents, False
        )
        QGuiApplication.setAttribute(Qt.ApplicationAttribute.AA_CompressTabletEvents, True)

    QGuiApplication.setOrganizationName("ytmusic-decky")
    QGuiApplication.setOrganizationDomain("ytmusic-decky.local")
    QGuiApplication.setApplicationName("ytmusic-decky")
    QGuiApplication.setAttribute(Qt.ApplicationAttribute.AA_EnableHighDpiScaling, True)
    QGuiApplication.setAttribute(Qt.ApplicationAttribute.AA_UseHighDpiPixmaps, True)
    app = QApplication([])
    app.setApplicationName("ytmusic-decky")
    app.setDesktopFileName("ytmusic-decky")
    if _touch_ui_mode():
        _apply_app_override_cursor()
    return app
