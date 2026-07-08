"""Runtime hook PyInstaller: software OpenGL antes de crear QApplication."""

from __future__ import annotations

import os
import sys


def _truthy(name: str, default: str = "") -> bool:
    value = os.environ.get(name, default).strip().lower()
    return value in ("1", "true", "yes")


def _use_software_gl() -> bool:
    if _truthy("YTMUSIC_DECKY_GPU"):
        return False
    if os.environ.get("YTMUSIC_DECKY_SOFTWARE_GL", "").strip().lower() in ("0", "false", "no"):
        return False
    if getattr(sys, "frozen", False):
        return _truthy("YTMUSIC_DECKY_SOFTWARE_GL", "1")
    return _truthy("YTMUSIC_DECKY_SOFTWARE_GL")


if _use_software_gl():
    os.environ.setdefault("QT_OPENGL", "software")
    os.environ.setdefault("LIBGL_ALWAYS_SOFTWARE", "1")
    os.environ.setdefault("MESA_LOADER_DRIVER_OVERRIDE", "llvmpipe")
    try:
        from PySide6.QtCore import Qt
        from PySide6.QtGui import QGuiApplication

        QGuiApplication.setAttribute(Qt.ApplicationAttribute.AA_UseSoftwareOpenGL, True)
        QGuiApplication.setAttribute(Qt.ApplicationAttribute.AA_ShareOpenGLContexts, True)
    except Exception:
        pass
