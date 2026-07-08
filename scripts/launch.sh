#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${ROOT}/.venv"

if [[ ! -d "${VENV}" ]]; then
  echo "Creando entorno virtual en ${VENV}..."
  python3 -m venv "${VENV}"
  "${VENV}/bin/pip" install --upgrade pip
  if [[ "$(uname -s)" == "Darwin" ]]; then
    "${VENV}/bin/pip" install -r "${ROOT}/requirements.txt"
  else
    "${VENV}/bin/pip" install -r "${ROOT}/requirements-linux.txt"
  fi
fi

# Linux / AppImage: librerías GL del host (llvmpipe por defecto en AppRun).
if [[ "$(uname -s)" == "Linux" && -f "${ROOT}/packaging/setup-runtime-env.sh" ]]; then
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

exec "${VENV}/bin/python" -m ytmusic_decky "$@"
