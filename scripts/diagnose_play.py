#!/usr/bin/env python3
"""Diagnóstico: errores JS/Python al reproducir una canción (solo para depuración)."""

from __future__ import annotations

import logging
import sys
from pathlib import Path

from PySide6.QtCore import QTimer
from PySide6.QtWebEngineCore import QWebEnginePage

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ytmusic_decky.player_state import PlayerState  # noqa: E402
from ytmusic_decky.web.window import DeckWindow, create_application  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

ERRORS: list[str] = []


def main() -> int:
    app = create_application()
    state = PlayerState()
    window = DeckWindow(state, lambda *_: None, fullscreen=False)
    window.resize(1280, 800)

    page = window._view.page()
    orig_console = page._on_console

    def on_console(level, message, line, source):
        entry = f"[{source}:{line}] {message}"
        if level == QWebEnginePage.JavaScriptConsoleMessageLevel.ErrorMessageLevel:
            ERRORS.append(entry)
            print("JS ERROR", entry)
        orig_console(level, message, line, source)

    page._on_console = on_console

    step = 0

    def js(code: str, cb=None):
        page.runJavaScript(code, cb or (lambda _: None))

    def probe(label: str):
        js(
            """
            JSON.stringify({
              href: location.href,
              deck: !!window.YTMDeck,
              started: !!window.__YTM_DECK_STARTED__,
              bar: !!document.querySelector('ytmusic-player-bar'),
              playBtn: !!document.querySelector('ytmusic-player-bar .play-pause-button'),
              title: document.querySelector('ytmusic-player-bar .title')?.textContent?.trim() || '',
              video: !!document.querySelector('video'),
            })
            """,
            lambda r: print(label, r),
        )

    def finish():
        probe("final")
        print(f"\nTotal JS errors: {len(ERRORS)}")
        for e in ERRORS:
            print(" ", e)
        app.quit()

    def next_step(_=None):
        nonlocal step
        step += 1
        print(f"--- step {step} ---")
        if step == 1:
            QTimer.singleShot(
                18000,
                lambda: js(
                    "document.querySelector('ytmusic-two-row-item-renderer a')?.click(); 'ok'",
                    lambda r: (print("item click:", r), QTimer.singleShot(6000, next_step)),
                ),
            )
        elif step == 2:
            probe("before play")
            js(
                "document.querySelector('ytmusic-player-bar .play-pause-button')?.click(); 'ok'",
                lambda r: (print("play click:", r), QTimer.singleShot(5000, finish)),
            )

    QTimer.singleShot(2000, next_step)
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
