#!/usr/bin/env python3
"""Diagnóstico del scroll del menú lateral (guide / playlists)."""

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
PROBE = """
(() => {
  const snap = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      cls: (el.className || "").toString().slice(0, 80) || null,
      w: Math.round(r.width),
      h: Math.round(r.height),
      scrollH: el.scrollHeight,
      clientH: el.clientHeight,
      overflowY: s.overflowY,
      touchAction: s.touchAction,
      canScroll: el.scrollHeight > el.clientHeight + 2,
    };
  };
  if (window.YTMDeck?.applyDeckLayout) window.YTMDeck.applyDeckLayout();
  const drawer = document.querySelector("tp-yt-app-drawer#guide");
  const guideContent = document.querySelector("#guide-content");
  const wrap = document.querySelector(".deck-guide-scroll");
  const guideRenderer = document.querySelector("#guide-content > ytmusic-guide-renderer")
    || document.querySelector("ytmusic-guide-renderer");
  const entries = document.querySelectorAll("ytmusic-guide-entry-renderer").length;
  return JSON.stringify({
    deck: document.documentElement.getAttribute("data-ytm-deck"),
    touch: document.documentElement.classList.contains("ytm-deck-touch"),
    entries,
    drawer: snap(drawer),
    guideContent: snap(guideContent),
    wrap: snap(wrap),
    guideRenderer: snap(guideRenderer),
    hasWrapFn: typeof window.YTMDeck?.applyDeckLayout === "function",
  }, null, 2);
})();
"""


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    app = create_application()
    state = PlayerState()
    window = DeckWindow(state, lambda _c, _d: None, fullscreen=False)
    window.show()

    def finish(payload: str) -> None:
        data = json.loads(payload) if payload else {}
        out = OUT_DIR / "guide_scroll_probe.json"
        out.write_text(json.dumps(data, indent=2), encoding="utf-8")
        print(out)
        print(json.dumps(data, indent=2))
        app.quit()

    def poll(attempts: int = 0) -> None:
        if attempts > 90:
            finish("{}")
            return

        def on_result(payload: str) -> None:
            try:
                data = json.loads(payload or "{}")
            except json.JSONDecodeError:
                data = {}
            if data.get("entries", 0) > 0 or attempts >= 89:
                finish(payload or "{}")
            else:
                QTimer.singleShot(1000, lambda: poll(attempts + 1))

        window.bridge.run_js(f"(function(){{ return {PROBE}; }})()")

        # run_js has no callback in this bridge - use page directly
        window._view.page().runJavaScript(PROBE, on_result)

    QTimer.singleShot(8000, lambda: poll(0))
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
