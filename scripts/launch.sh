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

# SteamOS / Gamescope / Big Picture
export QT_AUTO_SCREEN_SCALE_FACTOR=1
# shellcheck disable=SC1091
source "${ROOT}/packaging/detect-ui-scale.sh"
detect_ui_scale
export QTWEBENGINE_CHROMIUM_FLAGS="${QTWEBENGINE_CHROMIUM_FLAGS:---enable-touch-events --touch-events=enabled --disable-features=ElasticOverscroll}"

exec "${VENV}/bin/python" -m ytmusic_decky "$@"
