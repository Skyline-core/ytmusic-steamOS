#!/usr/bin/env bash
# Quita cuarentena/provenance y firma ad-hoc QtWebEngineProcess (pip/PySide6).
# Sin esto, macOS a menudo muestra "está dañado / Mover a la Papelera" al abrir.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${ROOT}/venv"
if [[ ! -d "${VENV}" && -d "${ROOT}/.venv" ]]; then
  VENV="${ROOT}/.venv"
fi

SITE="${VENV}/lib"
if [[ ! -d "${SITE}" ]]; then
  echo "error: no hay venv en ${ROOT}/venv ni ${ROOT}/.venv" >&2
  exit 1
fi

PYSIDE="$(find "${SITE}" -type d -path '*/site-packages/PySide6' 2>/dev/null | head -1 || true)"
SHIBOKEN="$(find "${SITE}" -type d -path '*/site-packages/shiboken6' 2>/dev/null | head -1 || true)"

if [[ -z "${PYSIDE}" ]]; then
  echo "error: PySide6 no instalado en ${VENV}" >&2
  exit 1
fi

echo "Limpiando xattrs en PySide6…"
xattr -cr "${PYSIDE}" 2>/dev/null || true
if [[ -n "${SHIBOKEN}" ]]; then
  echo "Limpiando xattrs en shiboken6…"
  xattr -cr "${SHIBOKEN}" 2>/dev/null || true
fi

APP="$(find "${PYSIDE}" -type d -name 'QtWebEngineProcess.app' 2>/dev/null | head -1 || true)"
if [[ -z "${APP}" ]]; then
  echo "aviso: no se encontró QtWebEngineProcess.app" >&2
  exit 0
fi

echo "Firmando ad-hoc: ${APP}"
# --deep cubre el ejecutable y recursos del bundle; -s - = firma ad-hoc local.
codesign --force --deep --sign - "${APP}" 2>&1 || {
  echo "codesign del .app falló; intentando el binario…" >&2
  BIN="${APP}/Contents/MacOS/QtWebEngineProcess"
  codesign --force --sign - "${BIN}"
}

# Frameworks Qt que macOS también puede rechazar al spawn del helper.
while IFS= read -r fw; do
  codesign --force --sign - "${fw}" >/dev/null 2>&1 || true
done < <(find "${PYSIDE}/Qt/lib" -maxdepth 1 -name 'QtWebEngine*.framework' -type d 2>/dev/null)

echo "Verificando firma…"
codesign -dv --verbose=2 "${APP}" 2>&1 | head -12
echo "Listo. Vuelve a abrir: ${VENV}/bin/python -m ytmusic_decky --windowed -v"
