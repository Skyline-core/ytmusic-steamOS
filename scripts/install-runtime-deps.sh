#!/usr/bin/env bash
# Dependencias del SISTEMA para ejecutar ytmusic-decky (no pip global).
set -euo pipefail

if command -v pacman >/dev/null 2>&1; then
  echo "==> SteamOS / Arch: instalando paquetes de runtime..."
  sudo pacman -S --needed --noconfirm \
    python python-pip python-virtualenv \
    python-pyside6 python-aiohttp \
    python-dbus python-gobject \
    qt6-webengine \
    xcb-util-cursor libxkbcommon-x11
  exit 0
fi

if command -v apt-get >/dev/null 2>&1; then
  echo "==> Debian / Ubuntu / Deepin: instalando paquetes de runtime..."
  sudo apt-get update -qq
  sudo apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip \
    python3-pyside6.qtcore python3-pyside6.qtgui python3-pyside6.qtwidgets \
    python3-pyside6.qtwebenginewidgets python3-aiohttp \
    python3-dbus python3-gi \
    libqt6webenginewidgets6 \
    libxcb-cursor0 libxcb-xinerama0 libxcb-icccm4 libxcb-image0 \
    libxcb-keysyms1 libxcb-randr0 libxcb-render-util0 libxcb-shape0 \
    libxcb-sync1 libxcb-xfixes0 libxkbcommon-x11-0 libegl1 libgl1
  exit 0
fi

if command -v dnf >/dev/null 2>&1; then
  echo "==> Fedora: instalando paquetes de runtime..."
  sudo dnf install -y \
    python3 python3-pip \
    python3-pyside6 python3-aiohttp \
    python3-dbus python3-gobject \
    qt6-qtwebengine \
    xcb-util-cursor libxkbcommon-x11
  exit 0
fi

echo "error: no se encontró pacman, apt-get ni dnf." >&2
echo "Instala manualmente: PySide6, aiohttp, Qt WebEngine, libxcb-cursor0, python-dbus, python-gobject" >&2
exit 1
