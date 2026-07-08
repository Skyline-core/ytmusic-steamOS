#!/usr/bin/env bash
# Empaqueta ytmusic-steamOS como AppImage (Linux x86_64).
# Ejecutar en Steam Deck, PC Linux o dentro de Docker (scripts/build-appimage-docker.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${ROOT}/build/appimage"
DIST_DIR="${BUILD_DIR}/dist"
WORKDIR="${BUILD_DIR}/work"
APPDIR="${BUILD_DIR}/AppDir"
VENV="${BUILD_DIR}/venv"
OUTPUT="${ROOT}/dist/ytmusic-steamOS-x86_64.AppImage"

APPIMAGETOOL="${BUILD_DIR}/appimagetool-x86_64.AppImage"
APPIMAGETOOL_BIN="${APPIMAGETOOL_BIN:-}"
APPIMAGETOOL_URL="https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"
RUNTIME="${BUILD_DIR}/runtime-x86_64"
RUNTIME_URL="https://github.com/AppImage/AppImageKit/releases/download/continuous/runtime-x86_64"
SQUASHFS="${BUILD_DIR}/ytmusic-steamOS.squashfs"

build_appimage_runtime() {
  echo "==> Empaquetar AppImage (runtime + mksquashfs)"
  if ! command -v mksquashfs >/dev/null 2>&1; then
    echo "error: falta mksquashfs (paquete squashfs-tools)" >&2
    exit 1
  fi

  if [[ ! -f "${RUNTIME}" ]]; then
    echo "==> Descargar runtime x86_64"
    wget -q -O "${RUNTIME}" "${RUNTIME_URL}"
    chmod +x "${RUNTIME}"
  fi

  if ! file -b "${RUNTIME}" 2>/dev/null | grep -q 'x86-64'; then
    echo "error: runtime descargado no es x86_64 válido:" >&2
    file "${RUNTIME}" >&2 || true
    exit 1
  fi

  rm -f "${SQUASHFS}" "${OUTPUT}"
  mksquashfs "${APPDIR}" "${SQUASHFS}" -root-owned -noappend -comp xz -no-xattrs
  cat "${RUNTIME}" "${SQUASHFS}" > "${OUTPUT}"
  chmod a+x "${OUTPUT}"
  rm -f "${SQUASHFS}"
}

ensure_appimagetool() {
  if [[ -n "${APPIMAGETOOL_BIN}" && -x "${APPIMAGETOOL_BIN}" ]]; then
    echo "==> Usar appimagetool del sistema: ${APPIMAGETOOL_BIN}"
    return 0
  fi

  if [[ -x "${APPIMAGETOOL}" ]]; then
    if file -b "${APPIMAGETOOL}" 2>/dev/null | grep -q 'x86-64'; then
      return 0
    fi
    echo "warning: appimagetool existente no es x86_64; volviendo a descargar" >&2
    rm -f "${APPIMAGETOOL}"
  fi

  echo "==> Descargar appimagetool (x86_64)"
  wget -q -O "${APPIMAGETOOL}" "${APPIMAGETOOL_URL}"
  chmod +x "${APPIMAGETOOL}"

  if ! file -b "${APPIMAGETOOL}" 2>/dev/null | grep -q 'x86-64'; then
    echo "error: appimagetool descargado no es un binario x86_64 válido:" >&2
    file "${APPIMAGETOOL}" >&2 || true
    head -c 200 "${APPIMAGETOOL}" >&2 || true
    exit 1
  fi
}

run_appimagetool() {
  echo "==> appimagetool"
  if [[ -n "${APPIMAGETOOL_BIN}" && -x "${APPIMAGETOOL_BIN}" ]]; then
    ARCH=x86_64 "${APPIMAGETOOL_BIN}" "${APPDIR}" "${OUTPUT}"
    return 0
  fi

  if APPIMAGE_EXTRACT_AND_RUN=1 ARCH=x86_64 "${APPIMAGETOOL}" "${APPDIR}" "${OUTPUT}"; then
    return 0
  fi

  echo "warning: appimagetool no pudo ejecutarse; usando runtime + mksquashfs" >&2
  build_appimage_runtime
}

package_appimage() {
  # Docker en Mac (qemu amd64): no ejecutar AppImages; empaquetar con runtime estático.
  if [[ "${YTMUSIC_BUILD_IN_DOCKER:-}" == "1" ]]; then
    build_appimage_runtime
    return
  fi

  ensure_appimagetool
  run_appimagetool
}

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "error: AppImage solo se puede construir en Linux x86_64." >&2
  echo "Usa: ./scripts/build-appimage-docker.sh (Docker) o GitHub Actions." >&2
  exit 1
fi

if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "error: Steam Deck usa x86_64; arquitectura actual: $(uname -m)" >&2
  echo "En macOS usa: ./scripts/build-appimage-docker.sh (con linux/amd64)." >&2
  exit 1
fi

echo "==> Arquitectura de build: $(uname -m)"

# shellcheck disable=SC1091
source "${ROOT}/scripts/install-build-deps.sh"
_install_build_deps

cd "${ROOT}"

echo "==> Limpiar build anterior"
rm -rf "${BUILD_DIR}" "${ROOT}/dist"
mkdir -p "${BUILD_DIR}" "${ROOT}/dist" "${DIST_DIR}" "${WORKDIR}" "${APPDIR}"

echo "==> Entorno virtual de build"
python3 -m venv "${VENV}"
# shellcheck disable=SC1091
source "${VENV}/bin/activate"
pip install --upgrade pip wheel setuptools
pip install pyinstaller "PySide6>=6.6.0"
pip install dbus-python PyGObject 2>/dev/null || true
pip install -e "${ROOT}" --no-deps

ENTRY="${ROOT}/ytmusic_decky/__main__.py"
if [[ ! -f "${ENTRY}" ]]; then
  echo "error: no se encontró el entrypoint ${ENTRY}" >&2
  echo "¿Estás en la raíz del proyecto ytmusic-steamOS?" >&2
  exit 1
fi

echo "==> PyInstaller (spec: ${ROOT}/ytmusic-steamOS.spec)"
pyinstaller "${ROOT}/ytmusic-steamOS.spec" \
  --distpath "${DIST_DIR}" \
  --workpath "${WORKDIR}" \
  --noconfirm

BUNDLE="${DIST_DIR}/ytmusic-steamOS"
if [[ ! -x "${BUNDLE}/ytmusic-steamOS" ]]; then
  echo "error: no se generó ${BUNDLE}/ytmusic-steamOS" >&2
  exit 1
fi

chmod +x "${ROOT}/packaging/fix-bundle-libs.sh"
"${ROOT}/packaging/fix-bundle-libs.sh" "${BUNDLE}" "${VENV}"
cp "${ROOT}/packaging/setup-runtime-env.sh" "${BUNDLE}/setup-runtime-env.sh"
chmod +x "${BUNDLE}/setup-runtime-env.sh"

echo "==> AppDir"
cp -a "${BUNDLE}/." "${APPDIR}/"
cp "${ROOT}/packaging/ytmusic-steamOS.desktop" "${APPDIR}/ytmusic-steamOS.desktop"
cp "${ROOT}/packaging/AppRun" "${APPDIR}/AppRun"
cp "${ROOT}/packaging/detect-ui-scale.sh" "${APPDIR}/detect-ui-scale.sh"
cp "${ROOT}/packaging/setup-runtime-env.sh" "${APPDIR}/setup-runtime-env.sh"
chmod +x "${APPDIR}/AppRun" "${APPDIR}/detect-ui-scale.sh" "${APPDIR}/setup-runtime-env.sh"

python3 "${ROOT}/packaging/make_icon.py" "${APPDIR}/ytmusic-steamOS.png"

echo "==> Empaquetar AppImage"
package_appimage

echo ""
echo "Listo: ${OUTPUT}"
echo "Prueba desde cualquier carpeta:"
echo "  cp ${OUTPUT} ~/Desktop/ && cd ~ && ~/Desktop/$(basename "${OUTPUT}") --windowed --no-mpris -v"
ls -lh "${OUTPUT}"
