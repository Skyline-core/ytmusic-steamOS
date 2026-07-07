"""Inyección robusta de CSS/JS en YouTube Music (Qt WebEngine)."""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path

logger = logging.getLogger(__name__)


def _inject_dir() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS) / "ytmusic_decky" / "inject"
    return Path(__file__).resolve().parent.parent / "inject"


INJECT_DIR = _inject_dir()

_DOM_GUARD = """
function __ytmDeckWhenReady(fn) {
  if (document.documentElement) {
    fn();
    return;
  }
  const run = function() {
    if (document.documentElement) fn();
  };
  document.addEventListener('readystatechange', run);
  document.addEventListener('DOMContentLoaded', run);
}
"""

INJECT_CSS_JS = (
    _DOM_GUARD
    + """
__ytmDeckWhenReady(function() {
  try {
    const root = document.documentElement;
    root.classList.add('ytm-deck-mode');
    root.setAttribute('data-ytm-deck', '1');
    root.style.setProperty(
      'background',
      'linear-gradient(160deg, #1f1035 0%, #0d0618 45%, #08040f 100%)',
      'important'
    );

    const css = window.__YTM_DECK_CSS__;
    if (!css) return 'css-no-data';

    if (window.__YTM_DECK_SHEET__) {
      window.__YTM_DECK_SHEET__.replaceSync(css);
      return 'css-updated';
    }

    if (typeof CSSStyleSheet !== 'undefined' && 'adoptedStyleSheets' in Document.prototype) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      window.__YTM_DECK_SHEET__ = sheet;
      return 'css-adopted';
    }

    let el = document.getElementById('ytm-deck-styles');
    if (!el) {
      el = document.createElement('style');
      el.id = 'ytm-deck-styles';
      el.type = 'text/css';
      (document.head || root).appendChild(el);
    }
    if (el.styleSheet) {
      el.styleSheet.cssText = css;
    } else {
      el.textContent = '';
      el.appendChild(document.createTextNode(css));
    }
    return 'css-style-tag';
  } catch (err) {
    console.error('[ytm-deck] CSS inject failed:', err);
    return 'css-error:' + err.message;
  }
});
"""
)

# QWebChannel: qrc:// es una URL confiable, no usa eval
INIT_WEBCHANNEL_JS = """
(function() {
  try {
    if (window.__YTM_DECK_CHANNEL_READY__) return;
    function connect() {
      if (typeof QWebChannel === 'undefined' || typeof qt === 'undefined') return;
      window.__YTM_DECK_CHANNEL_READY__ = true;
      new QWebChannel(qt.webChannelTransport, function(channel) {
        window.bridge = channel.objects.bridge;
      });
    }
    if (typeof QWebChannel !== 'undefined') {
      connect();
      return;
    }
    if (document.querySelector('script[data-ytm-deck-channel]')) return;
    const s = document.createElement('script');
    s.dataset.ytmDeckChannel = '1';
    try {
      s.src = 'qrc:///qtwebchannel/qwebchannel.js';
    } catch (e) {
      return;
    }
    s.onload = connect;
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {
  }
})();
"""

PROBE_JS = """
(function() {
  const root = document.documentElement;
  if (!root) return '{"ready":false}';
  return JSON.stringify({
    ready: true,
    deckClass: root.classList.contains('ytm-deck-mode'),
    dataAttr: root.getAttribute('data-ytm-deck'),
    hasSheet: !!window.__YTM_DECK_SHEET__,
    hasStyleTag: !!document.getElementById('ytm-deck-styles'),
    hasDeck: !!window.YTMDeck,
    started: !!window.__YTM_DECK_STARTED__,
    href: location.href
  });
})()
"""


class DeckInjector:
    def __init__(self) -> None:
        self._css = (INJECT_DIR / "deck.css").read_text(encoding="utf-8")
        self._bridge = (INJECT_DIR / "bridge.js").read_text(encoding="utf-8")
        if not self._css.strip():
            raise RuntimeError(f"deck.css vacío o no encontrado en {INJECT_DIR}")
        logger.info("Injector listo (%d bytes CSS, %d bytes JS)", len(self._css), len(self._bridge))

    def _css_payload_js(self) -> str:
        return f"window.__YTM_DECK_CSS__ = {json.dumps(self._css)};"

    def css_call(self) -> str:
        return self._css_payload_js() + INJECT_CSS_JS

    def bridge_call(self) -> str:
        """Ejecuta bridge.js vía runJavaScript (idempotente en navegaciones SPA)."""
        scale_hint = ""
        raw_scale = os.environ.get("YTMUSIC_DECKY_UI_SCALE", "").strip()
        if raw_scale:
            try:
                scale_hint = f"window.__YTM_DECK_UI_SCALE__ = {float(raw_scale)};\n"
            except ValueError:
                scale_hint = ""
        return (
            scale_hint
            + "if (!window.YTMDeck) {\n"
            + self._bridge
            + "\n}\n"
            "if (window.YTMDeck) {\n"
            "  if (!window.__YTM_DECK_STARTED__) window.YTMDeck.start();\n"
            "  else window.YTMDeck.applyDeckLayout();\n"
            "  'bridge-ok';\n"
            "}\n"
        )

    def webchannel_call(self) -> str:
        return INIT_WEBCHANNEL_JS

    def probe_call(self) -> str:
        return PROBE_JS

    def profile_script_source(self) -> str:
        return self._css_payload_js() + INJECT_CSS_JS
