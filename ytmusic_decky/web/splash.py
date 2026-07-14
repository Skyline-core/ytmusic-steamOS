"""Splash de arranque nativo (Qt): logo + spinner, sin red."""

from __future__ import annotations

import time

from PySide6.QtCore import QRectF, Qt, QTimer
from PySide6.QtGui import QColor, QFont, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import QWidget


class BootSplash(QWidget):
    """Logo YouTube Music arriba y spinner blanco abajo."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setStyleSheet("background-color: #000000;")
        self.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self._angle = 0.0
        self._shown_at = time.monotonic()
        self._dismissing = False
        self._on_done = None
        self._spin = QTimer(self)
        self._spin.timeout.connect(self._tick)
        self._spin.start(16)

    def mark_shown(self) -> None:
        """Reinicia el reloj cuando la ventana ya tiene tamaño real."""
        self._shown_at = time.monotonic()
        self.update()

    def _tick(self) -> None:
        self._angle = (self._angle + 8.0) % 360.0
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802
        del event
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        w, h = self.width(), self.height()

        mark = 72.0
        cx = w * 0.5
        cy = h * 0.28
        p.setBrush(QColor("#ff0033"))
        p.setPen(Qt.PenStyle.NoPen)
        p.drawEllipse(QRectF(cx - mark / 2, cy - mark / 2, mark, mark))

        play = QPainterPath()
        play.moveTo(cx - 8, cy - 14)
        play.lineTo(cx - 8, cy + 14)
        play.lineTo(cx + 16, cy)
        play.closeSubpath()
        p.setBrush(QColor("#ffffff"))
        p.drawPath(play)

        font = QFont()
        font.setPixelSize(28)
        font.setWeight(QFont.Weight.DemiBold)
        p.setFont(font)
        p.setPen(QColor("#ffffff"))
        text = "YouTube Music"
        fm = p.fontMetrics()
        tw = fm.horizontalAdvance(text)
        p.drawText(int(cx - tw / 2), int(cy + mark / 2 + 36), text)

        radius = 14.0
        sx, sy = cx, h * 0.86
        pen = QPen(QColor(255, 255, 255, 56))
        pen.setWidthF(2.5)
        pen.setCapStyle(Qt.PenCapStyle.RoundCap)
        p.setPen(pen)
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawEllipse(QRectF(sx - radius, sy - radius, radius * 2, radius * 2))
        pen.setColor(QColor("#ffffff"))
        p.setPen(pen)
        span = 90 * 16
        start = int((-self._angle) * 16)
        p.drawArc(QRectF(sx - radius, sy - radius, radius * 2, radius * 2), start, -span)
        p.end()

    def dismiss(self, *, min_ms: int = 900, on_done=None) -> None:
        if self._dismissing:
            return
        self._dismissing = True
        self._on_done = on_done
        elapsed_ms = (time.monotonic() - self._shown_at) * 1000.0
        wait = max(0, int(min_ms - elapsed_ms))
        QTimer.singleShot(wait, self._hide_now)

    def _hide_now(self) -> None:
        self._spin.stop()
        done = self._on_done
        self._on_done = None
        if done is not None:
            done()
        else:
            self.hide()
            self.deleteLater()
