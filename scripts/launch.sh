#!/usr/bin/env bash
# Lanza ytmusic-decky o solo prepara el venv (--setup-only, útil vía SSH).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${ROOT}/.venv"
SETUP_ONLY=0
APP_ARGS=()

usage() {
  cat <<'EOF'
Uso: ./scripts/launch.sh [opciones] [-- args de la app]

Opciones del script:
  --setup-only   Solo crea/actualiza .venv e instala dependencias (sin GUI).
                 Útil compilando por SSH; ejecuta la app en el dispositivo destino.

Args de la app (tras --): --windowed, -v, --no-api, etc.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --setup-only)
      SETUP_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      APP_ARGS+=("$@")
      break
      ;;
    *)
      APP_ARGS+=("$1")
      shift
      ;;
  esac
done

ensure_venv() {
  if [[ ! -d "${VENV}" ]]; then
    echo "Creando entorno virtual en ${VENV}..."
    if [[ "$(uname -s)" == "Linux" ]]; then
      python3 -m venv --system-site-packages "${VENV}"
    else
      python3 -m venv "${VENV}"
    fi
    return
  fi

  if [[ "$(uname -s)" == "Linux" ]] && ! grep -q 'include-system-site-packages = true' "${VENV}/pyvenv.cfg" 2>/dev/null; then
    # No borrar .venv automáticamente (rompe installs en Bazzite / atomic).
    echo "Aviso: ${VENV} sin system-site-packages. Si PySide6 falla, recrea con:"
    echo "  rm -rf .venv && python3 -m venv --system-site-packages .venv && ./scripts/launch.sh"
  fi
}

imports_ok() {
  # No instanciar QGuiApplication aquí (requiere pantalla).
  "${VENV}/bin/python" -c "import PySide6, aiohttp; import PySide6.QtCore" 2>/dev/null
}

install_venv_pip() {
  if [[ ! -x "${VENV}/bin/python" ]]; then
    echo "error: no se pudo crear ${VENV}. ¿python3-venv instalado?" >&2
    exit 1
  fi

  # Si ya importa, no re-pip (falla sin red y retrasa Game Mode / Bazzite).
  if imports_ok; then
    return 0
  fi

  if ! "${VENV}/bin/python" -m pip --version >/dev/null 2>&1; then
    echo "Instalando pip en el venv..."
    "${VENV}/bin/python" -m ensurepip --upgrade
  fi

  echo "Instalando dependencias Python en ${VENV}..."
  "${VENV}/bin/python" -m pip install --upgrade pip wheel
  if [[ -f "${ROOT}/requirements-linux.txt" && "$(uname -s)" == "Linux" ]]; then
    "${VENV}/bin/python" -m pip install -r "${ROOT}/requirements-linux.txt"
  elif [[ -f "${ROOT}/requirements.txt" ]]; then
    "${VENV}/bin/python" -m pip install -r "${ROOT}/requirements.txt"
  else
    "${VENV}/bin/python" -m pip install "PySide6>=6.6.0" "aiohttp>=3.9.0"
  fi
}

verify_imports() {
  if imports_ok; then
    return 0
  fi

  echo ""
  echo "ERROR: PySide6 no carga correctamente (conflicto con Qt del sistema)." >&2
  echo "" >&2
  if command -v apt-get >/dev/null 2>&1; then
    echo "En Debian / Deepin prueba:" >&2
    echo "  git pull && ./scripts/launch.sh" >&2
    echo "  o instala PySide6 del sistema y evita pip:" >&2
    echo "  sudo apt install python3-pyside6.qtwebenginewidgets python3-aiohttp python3-dbus python3-gi" >&2
    echo "  rm -rf .venv && ./scripts/launch.sh" >&2
  elif command -v pacman >/dev/null 2>&1 || command -v rpm-ostree >/dev/null 2>&1; then
    echo "En SteamOS / Bazzite / Arch:" >&2
    echo "  ./scripts/install-runtime-deps.sh" >&2
    echo "  rm -rf .venv && ./scripts/launch.sh" >&2
  else
    echo "  ${VENV}/bin/python -m pip install 'PySide6>=6.6.0' 'aiohttp>=3.9.0'" >&2
  fi
  echo "" >&2
  exit 1
}

warn_mpris() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    return
  fi
  if ! "${VENV}/bin/python" -c "import dbus" 2>/dev/null; then
    echo ""
    echo "Aviso: MPRIS desactivado (falta python-dbus del sistema)."
    echo "  ./scripts/install-runtime-deps.sh"
    echo ""
  fi
}

setup_pyside6_qt_env() {
  local python="${1:?python}"
  local qt_dir
  qt_dir="$("${python}" -c "
import os
import PySide6
print(os.path.join(os.path.dirname(PySide6.__file__), 'Qt'))
" 2>/dev/null || true)"
  [[ -n "${qt_dir}" && -d "${qt_dir}/lib" ]] || return 0

  export LD_LIBRARY_PATH="${qt_dir}/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
  export QT_PLUGIN_PATH="${qt_dir}/plugins"
  export QML2_IMPORT_PATH="${qt_dir}/qml"
  if [[ -x "${qt_dir}/libexec/QtWebEngineProcess" ]]; then
    export QTWEBENGINEPROCESS_PATH="${qt_dir}/libexec/QtWebEngineProcess"
  fi
  if [[ -d "${qt_dir}/resources" ]]; then
    export QTWEBENGINE_RESOURCES_PATH="${qt_dir}/resources"
  fi
  if [[ -d "${qt_dir}/translations/qtwebengine_locales" ]]; then
    export QTWEBENGINE_LOCALES_PATH="${qt_dir}/translations/qtwebengine_locales"
  fi
  export QTWEBENGINE_DISABLE_SANDBOX=1
}

setup_qt_platform() {
  # Solo si el usuario lo pide; no forzar xcb (antes tampoco se forzaba).
  if [[ -n "${YTMUSIC_DECKY_QPA_PLATFORM:-}" ]]; then
    export QT_QPA_PLATFORM="${YTMUSIC_DECKY_QPA_PLATFORM}"
  fi
}

has_display_session() {
  [[ -n "${DISPLAY:-}" || -n "${WAYLAND_DISPLAY:-}" ]]
}

check_runtime() {
  if ! has_display_session; then
    echo ""
    echo "ERROR: no hay sesión gráfica (DISPLAY y WAYLAND_DISPLAY vacíos)." >&2
    echo "ytmusic-decky necesita pantalla (terminal en escritorio o Steam Game Mode)." >&2
    echo "" >&2
    exit 1
  fi
  # Nota: libxcb-cursor puede faltar; igual que antes, no abortamos por eso.
}

setup_webengine_flags() {
  if [[ -n "${QTWEBENGINE_CHROMIUM_FLAGS:-}" ]]; then
    return
  fi
  QTWEBENGINE_CHROMIUM_FLAGS="--enable-touch-events --touch-events=enabled --disable-features=ElasticOverscroll --disable-dev-shm-usage --no-sandbox --enable-features=TouchEventFeatureDetection"
  export QTWEBENGINE_CHROMIUM_FLAGS
}

ensure_venv
install_venv_pip

if [[ "$(uname -s)" == "Linux" ]]; then
  setup_pyside6_qt_env "${VENV}/bin/python"
  setup_qt_platform
  setup_webengine_flags
fi

verify_imports
warn_mpris

if [[ "${SETUP_ONLY}" -eq 1 ]]; then
  echo ""
  echo "Entorno listo en ${VENV} (sin lanzar GUI)."
  echo "  AppImage: ./scripts/build-appimage.sh"
  echo "  En Bazzite/Deck: copia el .AppImage o ejecuta ./scripts/launch.sh allí."
  exit 0
fi

check_runtime

# AppImage / bundle PyInstaller (no aplica al venv de desarrollo).
if [[ "$(uname -s)" == "Linux" && -f "${ROOT}/packaging/setup-runtime-env.sh" && -d "${ROOT}/_internal/PySide6/Qt/lib" ]]; then
  export YTMUSIC_APP_ROOT="${ROOT}"
  # shellcheck disable=SC1091
  source "${ROOT}/packaging/setup-runtime-env.sh"
  ytmusic_setup_runtime_env
fi

# SteamOS / Gamescope / Big Picture
if [[ -n "${SteamGameId:-}" || -n "${STEAM_RUNTIME:-}" || -n "${GAMESCOPE_WAYLAND_DISPLAY:-}" ]]; then
  export YTMUSIC_DECKY_STEAM=1
  export SDL_VIDEO_X11_DGAMOUSE=0
fi
export QT_AUTO_SCREEN_SCALE_FACTOR=1
# shellcheck disable=SC1091
source "${ROOT}/packaging/detect-ui-scale.sh"
detect_ui_scale

exec "${VENV}/bin/python" -m ytmusic_decky "${APP_ARGS[@]}"
