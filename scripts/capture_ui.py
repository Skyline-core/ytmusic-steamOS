#!/usr/bin/env python3
"""Captura screenshot y estructura DOM de ytmusic-decky para depuración (solo browse/home).

No reproduce música ni abre el reproductor. Para capturar la vista expandida del
reproductor tras abrirla manualmente, usa scripts/capture_player.py.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PySide6.QtCore import QTimer, QUrl
from PySide6.QtGui import QGuiApplication
from PySide6.QtWidgets import QApplication

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ytmusic_decky.player_state import PlayerState  # noqa: E402
from ytmusic_decky.web.window import DeckWindow, create_application  # noqa: E402

OUT_DIR = ROOT / "scripts" / "captures"
DOM_PROBE = """
(() => {
  const layout = document.querySelector("ytmusic-app-layout");
  if (!layout) return JSON.stringify({ error: "no layout" });
  const kids = Array.from(layout.children).map((el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    cls: el.className || null,
    rect: (() => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) };
    })(),
    display: getComputedStyle(el).display,
    position: getComputedStyle(el).position,
    gridArea: getComputedStyle(el).gridArea,
    zIndex: getComputedStyle(el).zIndex,
    bg: getComputedStyle(el).backgroundColor,
  }));
  const bar = document.querySelector("ytmusic-player-bar");
  const browse = document.querySelector("ytmusic-browse-response");
  const content = document.querySelector("#content");
  const snap = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      rect: { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) },
      display: s.display,
      position: s.position,
      gridArea: s.gridArea,
      visibility: s.visibility,
      opacity: s.opacity,
      bg: s.backgroundColor,
    };
  };
  const shelves = document.querySelectorAll(
    "ytmusic-carousel-shelf-renderer, ytmusic-chip-cloud-renderer, ytmusic-two-row-item-renderer"
  ).length;
  const guideEntries = document.querySelectorAll("ytmusic-guide-entry-renderer").length;
  const chip = document.querySelector("ytmusic-chip-cloud-chip-renderer");
  const chipKids = chip
    ? Array.from(chip.querySelectorAll("*")).slice(0, 12).map((el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          cls: (el.className || "").toString().slice(0, 60),
          rect: { w: Math.round(r.width), h: Math.round(r.height) },
          bg: s.backgroundColor,
          border: s.border,
          boxShadow: s.boxShadow !== "none" ? s.boxShadow.slice(0, 40) : "none",
        };
      })
    : [];
  const chipSnap = chip
    ? (() => {
        const r = chip.getBoundingClientRect();
        const s = getComputedStyle(chip);
        return {
          rect: { w: Math.round(r.width), h: Math.round(r.height) },
          bg: s.backgroundColor,
          border: s.border,
        };
      })()
    : null;
  const gradients = Array.from(document.querySelectorAll(".gradient-box")).map((el) => ({
    parent: el.parentElement ? el.parentElement.tagName.toLowerCase() : null,
    rect: (() => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    })(),
    display: getComputedStyle(el).display,
  }));
  const shelfBtn = document.querySelector("ytmusic-carousel-shelf-renderer yt-icon-button, ytmusic-carousel-shelf-renderer tp-yt-paper-icon-button");
  const shelfBtnKids = shelfBtn
    ? Array.from(shelfBtn.querySelectorAll("*")).slice(0, 8).map((el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return {
          tag: el.tagName.toLowerCase(),
          cls: (el.className || "").toString().slice(0, 50),
          rect: { w: Math.round(r.width), h: Math.round(r.height) },
          display: s.display,
          visibility: s.visibility,
          opacity: s.opacity,
          bg: s.backgroundColor,
        };
      })
    : [];
  const shelfBtnSnap = shelfBtn
    ? (() => {
        const r = shelfBtn.getBoundingClientRect();
        const s = getComputedStyle(shelfBtn);
        return {
          tag: shelfBtn.tagName.toLowerCase(),
          rect: { w: Math.round(r.width), h: Math.round(r.height) },
          display: s.display,
          visibility: s.visibility,
          bg: s.backgroundColor,
          border: s.border,
        };
      })()
    : null;
  return JSON.stringify({ layoutKids: kids, bar: snap(bar), browse: snap(browse), content: snap(content), shelves, guideEntries, chipSnap, chipKids, shelfBtnSnap, shelfBtnKids, gradients }, null, 2);
})()
"""


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    app = create_application()
    state = PlayerState()
    window = DeckWindow(state, lambda *_: None, fullscreen=False)
    window.resize(1280, 800)

    def finish() -> None:
        page = window._view.page()

        def on_dom(data) -> None:
            dom_path = OUT_DIR / "dom.json"
            dom_path.write_text(data if isinstance(data, str) else json.dumps(data, indent=2))
            print(f"DOM → {dom_path}")

        page.runJavaScript(DOM_PROBE, on_dom)

        shot = window.grab()
        shot_path = OUT_DIR / "window.png"
        shot.save(str(shot_path))
        print(f"Screenshot → {shot_path}")
        app.quit()

    QTimer.singleShot(18000, finish)
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
