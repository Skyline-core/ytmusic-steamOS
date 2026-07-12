#!/usr/bin/env python3
"""Captura automática de la barra del reproductor + métricas del área de texto."""

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
MAX_WAIT_MS = 90_000

BAR_PROBE = """
(() => {
  const snap = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      minWidth: cs.minWidth,
      flex: cs.flex,
      gridColumn: cs.gridColumn,
    };
  };
  const bar = document.querySelector('ytmusic-player-bar');
  const root = document.documentElement;
  return JSON.stringify({
    deck: root.getAttribute('data-ytm-deck'),
    wide: root.classList.contains('ytm-deck-wide'),
    mediaActive: root.classList.contains('ytm-deck-media-active'),
    cssTextMin: getComputedStyle(root).getPropertyValue('--deck-media-text-min').trim(),
    gridCols: bar ? getComputedStyle(bar).gridTemplateColumns : null,
    bar: snap(bar),
    left: snap(document.querySelector('ytmusic-player-bar .left-controls')),
    mediaInfo: snap(document.querySelector('ytmusic-player-bar .deck-media-info')),
    mediaText: snap(document.querySelector('ytmusic-player-bar .deck-media-text')),
    mediaTitle: document.querySelector('ytmusic-player-bar .deck-media-title')?.textContent?.trim() || null,
    mediaArtist: document.querySelector('ytmusic-player-bar .deck-media-artist')?.textContent?.trim() || null,
    titleMarquee: !!document.querySelector('ytmusic-player-bar .deck-media-title .deck-title-marquee-active'),
    artistMarquee: !!document.querySelector('ytmusic-player-bar .deck-media-artist .deck-title-marquee-active'),
    likesInInfo: !!document.querySelector('ytmusic-player-bar .deck-media-info .middle-controls-buttons'),
    middleVisible: snap(document.querySelector('ytmusic-player-bar .middle-controls')),
    right: snap(document.querySelector('ytmusic-player-bar .right-controls')),
    toggle: snap(document.querySelector('ytmusic-player-bar .toggle-player-page-button')),
    toggleVisible: !!document.querySelector('ytmusic-player-bar .toggle-player-page-button yt-icon-button, ytmusic-player-bar .toggle-player-page-button button'),
  }, null, 2);
})()
"""


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    app = create_application()
    state = PlayerState()
    window = DeckWindow(state, lambda *_: None, fullscreen=False)
    window.resize(1280, 800)
    window.show()

    elapsed = 0
    print("Esperando barra con texto (reproduce una canción si hace falta)...")

    def finish(metrics: str | None) -> None:
        metrics_path = OUT_DIR / "player-bar-metrics.json"
        if metrics:
            metrics_path.write_text(metrics if isinstance(metrics, str) else json.dumps(metrics, indent=2))
            print(f"Métricas → {metrics_path}")
            print(metrics)

        shot = window.grab()
        shot_path = OUT_DIR / "player-bar.png"
        shot.save(str(shot_path))
        print(f"Screenshot → {shot_path}")
        app.quit()

    def poll() -> None:
        nonlocal elapsed
        elapsed += POLL_MS

        def on_probe(data) -> None:
            try:
                payload = json.loads(data) if isinstance(data, str) else data
            except json.JSONDecodeError:
                payload = {}
            text_w = (payload.get("mediaText") or {}).get("w") or 0
            ready = text_w >= 80 and payload.get("mediaTitle")
            if ready or elapsed >= MAX_WAIT_MS:
                finish(data if isinstance(data, str) else json.dumps(payload, indent=2))
                return
            QTimer.singleShot(POLL_MS, poll)

        window._view.page().runJavaScript(BAR_PROBE, on_probe)

    QTimer.singleShot(12_000, poll)
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
