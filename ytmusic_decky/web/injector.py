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
    if (window.__YTM_DECK_TOUCH__) {
      root.classList.add('ytm-deck-touch', 'ytm-deck-steam');
    }
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

# QWebChannel connect (el fuente de qwebchannel.js se antepone en Python: evita
# TrustedScriptURL al hacer <script src="qrc://..."> en music.youtube.com).
INIT_WEBCHANNEL_JS = """
(function() {
  try {
    if (window.bridge && window.bridge.reportState) {
      window.__YTM_DECK_CHANNEL_READY__ = true;
      return 'channel-already';
    }
    if (typeof QWebChannel === 'undefined') {
      return 'channel-no-qwebchannel';
    }
    if (typeof qt === 'undefined' || !qt.webChannelTransport) {
      return 'channel-no-qt-transport';
    }
    if (window.__YTM_DECK_CHANNEL_CONNECTING__) {
      return 'channel-connecting';
    }
    window.__YTM_DECK_CHANNEL_CONNECTING__ = true;
    new QWebChannel(qt.webChannelTransport, function(channel) {
      window.bridge = channel.objects.bridge;
      window.__YTM_DECK_CHANNEL_READY__ = !!(window.bridge && window.bridge.reportState);
      window.__YTM_DECK_CHANNEL_CONNECTING__ = false;
      try {
        if (window.YTMDeck && typeof window.YTMDeck.collectState === 'function' && window.bridge) {
          window.bridge.reportState(JSON.stringify(window.YTMDeck.collectState()));
        }
      } catch (_) {}
    });
    return 'channel-started';
  } catch (e) {
    window.__YTM_DECK_CHANNEL_CONNECTING__ = false;
    return 'channel-error:' + (e && e.message ? e.message : String(e));
  }
})();
"""

PROBE_JS = """
(function() {
  const root = document.documentElement;
  if (!root) return '{"ready":false}';
  const hasCss = !!(window.__YTM_DECK_SHEET__ || document.getElementById('ytm-deck-styles'));
  const uiReady = !!(window.YTMDeck && window.YTMDeck.ready);
  const started = !!window.__YTM_DECK_STARTED__;
  const deckClass = root.classList.contains('ytm-deck-mode');
  return JSON.stringify({
    ready: true,
    deckClass: deckClass,
    dataAttr: root.getAttribute('data-ytm-deck'),
    hasSheet: !!window.__YTM_DECK_SHEET__,
    hasStyleTag: !!document.getElementById('ytm-deck-styles'),
    hasCss: hasCss,
    hasDeck: !!window.YTMDeck,
    started: started,
    uiReady: uiReady,
    // Listo para quitar splash: CSS Deck + layout aplicado (sin ping de red).
    splashReady: !!(hasCss && deckClass && started && uiReady),
    hasBridge: !!(window.bridge && window.bridge.reportState),
    channelReady: !!window.__YTM_DECK_CHANNEL_READY__,
    hasQWebChannel: typeof QWebChannel !== 'undefined',
    hasQtTransport: !!(typeof qt !== 'undefined' && qt && qt.webChannelTransport),
    href: location.href
  });
})()
"""


def _load_qwebchannel_js() -> str:
    """Lee qwebchannel.js del recurso Qt (sin <script src>, compatible con Trusted Types)."""
    try:
        # Sin QCoreApplication el recurso :/ a veces no abre en algunos hosts.
        from PySide6.QtCore import QCoreApplication, QFile, QIODevice

        if QCoreApplication.instance() is None:
            return ""

        # Importar QtWebChannel registra el recurso :/qtwebchannel/qwebchannel.js
        from PySide6.QtWebChannel import QWebChannel  # noqa: F401

        f = QFile(":/qtwebchannel/qwebchannel.js")
        if not f.exists() or not f.open(QIODevice.OpenModeFlag.ReadOnly):
            logger.warning("No se pudo abrir :/qtwebchannel/qwebchannel.js")
            return ""
        data = bytes(f.readAll()).decode("utf-8", errors="replace")
        f.close()
        return data
    except Exception as exc:  # pragma: no cover
        logger.warning("Fallo leyendo qwebchannel.js: %s", exc)
        return ""


class DeckInjector:
    def __init__(self) -> None:
        self._css = (INJECT_DIR / "deck.css").read_text(encoding="utf-8")
        self._bridge = (INJECT_DIR / "bridge.js").read_text(encoding="utf-8")
        self._qwebchannel: str | None = None
        if not self._css.strip():
            raise RuntimeError(f"deck.css vacío o no encontrado en {INJECT_DIR}")
        logger.info(
            "Injector listo (%d bytes CSS, %d bytes JS)",
            len(self._css),
            len(self._bridge),
        )

    def _css_payload_js(self) -> str:
        return f"window.__YTM_DECK_CSS__ = {json.dumps(self._css)};"

    def _qwebchannel_source(self) -> str:
        if self._qwebchannel is None:
            self._qwebchannel = _load_qwebchannel_js()
            logger.info("qwebchannel.js cargado (%d bytes)", len(self._qwebchannel))
        return self._qwebchannel

    def _ensure_qwebchannel_js(self) -> str:
        src = self._qwebchannel_source()
        if not src:
            return "/* qwebchannel.js missing */\n"
        # Solo define la clase si aún no existe (Qt a veces ya la inyectó).
        return (
            "if (typeof QWebChannel === 'undefined') {\n"
            + src
            + "\n}\n"
        )

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
        steam_hint = ""
        touch_ui = (
            os.environ.get("YTMUSIC_DECKY_STEAM", "").strip().lower() in ("1", "true", "yes")
            or os.environ.get("YTMUSIC_DECKY_HIDE_CURSOR", "").strip().lower() in ("1", "true", "yes")
            or bool(os.environ.get("SteamGameId"))
            or getattr(sys, "frozen", False)
        )
        if touch_ui:
            steam_hint = "window.__YTM_DECK_STEAM__ = 1;\nwindow.__YTM_DECK_TOUCH__ = 1;\n"
        # No embeber qwebchannel.js aquí: en Steam/Bazzite hincha el payload
        # y puede tumbar el proceso de render. window.py ya llama webchannel_call().
        return (
            scale_hint
            + steam_hint
            + INIT_WEBCHANNEL_JS
            + "\n"
            "window.__YTM_DECK_BRIDGE_REV_TARGET__ = 32;\n"
            "if (!window.YTMDeck || window.__YTM_DECK_BRIDGE_REV__ !== window.__YTM_DECK_BRIDGE_REV_TARGET__) {\n"
            + self._bridge
            + "\n"
            "  window.__YTM_DECK_BRIDGE_REV__ = window.__YTM_DECK_BRIDGE_REV_TARGET__;\n"
            "}\n"
            "if (window.YTMDeck) {\n"
            "  if (!window.__YTM_DECK_STARTED__) window.YTMDeck.start();\n"
            "  else window.YTMDeck.applyDeckLayout();\n"
            "  try { if (window.bridge && window.bridge.reportState) window.bridge.reportState(JSON.stringify(window.YTMDeck.collectState())); } catch (_) {}\n"
            "  'bridge-ok';\n"
            "}\n"
        )

    def webchannel_call(self) -> str:
        return self._ensure_qwebchannel_js() + INIT_WEBCHANNEL_JS

    def probe_call(self) -> str:
        return PROBE_JS

    def profile_script_source(self) -> str:
        """Solo CSS + flags; QWebChannel se inyecta después vía runJavaScript.

        Envolver qwebchannel.js en DocumentReady hincha el userscript y en
        algunos hosts (Steam/Bazzite) tumba el proceso de render al arrancar.
        """
        touch_hint = ""
        if (
            os.environ.get("YTMUSIC_DECKY_STEAM", "").strip().lower() in ("1", "true", "yes")
            or os.environ.get("YTMUSIC_DECKY_HIDE_CURSOR", "").strip().lower() in ("1", "true", "yes")
            or bool(os.environ.get("SteamGameId"))
            or getattr(sys, "frozen", False)
        ):
            touch_hint = "window.__YTM_DECK_TOUCH__ = 1; window.__YTM_DECK_STEAM__ = 1;\n"
        return touch_hint + self._css_payload_js() + INJECT_CSS_JS
