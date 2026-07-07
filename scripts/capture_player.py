#!/usr/bin/env python3
"""Captura el reproductor expandido — NO reproduce ni abre el player automáticamente.

Uso:
  1. Ejecuta este script.
  2. En la ventana: reproduce una canción y pulsa el triángulo (abrir página del reproductor).
  3. El script detecta la vista expandida y guarda screenshot + DOM.

Para capturar solo el home/browse sin tocar el reproductor, usa capture_ui.py.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QApplication

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ytmusic_decky.player_state import PlayerState  # noqa: E402
from ytmusic_decky.web.window import DeckWindow, create_application  # noqa: E402

OUT_DIR = ROOT / "scripts" / "captures"
POLL_MS = 1000
MAX_WAIT_MS = 120_000

IS_PLAYER_OPEN = """
(() => {
  const btn = document.querySelector(
    'ytmusic-player-bar .toggle-player-page-button yt-icon-button, ytmusic-player-bar .toggle-player-page-button button'
  );
  if (!btn) return false;
  const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
  return /cerrar|close|collapse|contraer/.test(aria);
})()
"""

PLAYER_PROBE = """
(() => {
  const page = document.querySelector('ytmusic-player-page');
  const side = document.querySelector('#side-panel');
  const hero = document.querySelector('.deck-hero-wrap');
  const snap = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) };
  };
  return JSON.stringify({
    deckPlaying: document.documentElement.classList.contains('ytm-deck-playing'),
    playerOpen: (() => {
      const btn = document.querySelector('ytmusic-player-bar .toggle-player-page-button button');
      return btn ? btn.getAttribute('aria-label') : null;
    })(),
    page: snap(page),
    sidePanel: snap(side),
    hero: snap(hero),
    queueItems: document.querySelectorAll('ytmusic-queue-item, ytmusic-playlist-panel-video-renderer').length,
    title: document.querySelector('.deck-now-playing-meta .deck-title')?.textContent?.trim() || null,
    barTitle: document.querySelector('ytmusic-player-bar .title')?.textContent?.trim() || null,
  }, null, 2);
})()
"""


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    app = create_application()
    state = PlayerState()
    window = DeckWindow(state, lambda *_: None, fullscreen=False)
    window.resize(1280, 800)

    elapsed = 0
    print("Esperando que abras el reproductor manualmente (máx. 120 s)...")

    def finish() -> None:
        page = window._view.page()

        def on_dom(data) -> None:
            dom_path = OUT_DIR / "player-dom.json"
            dom_path.write_text(data if isinstance(data, str) else json.dumps(data, indent=2))
            print(f"DOM → {dom_path}")

        page.runJavaScript(PLAYER_PROBE, on_dom)

        shot = window.grab()
        shot_path = OUT_DIR / "player.png"
        shot.save(str(shot_path))
        print(f"Screenshot → {shot_path}")
        app.quit()

    def poll() -> None:
        nonlocal elapsed
        elapsed += POLL_MS

        def on_open(is_open) -> None:
            if is_open:
                print("Reproductor detectado, capturando...")
                QTimer.singleShot(1500, finish)
                return
            if elapsed >= MAX_WAIT_MS:
                print("Tiempo agotado — capturando estado actual.")
                finish()
                return
            QTimer.singleShot(POLL_MS, poll)

        window._view.page().runJavaScript(IS_PLAYER_OPEN, on_open)

    QTimer.singleShot(8000, poll)
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
