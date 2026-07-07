#!/usr/bin/env bash
# Construye la AppImage dentro de Docker (útil en macOS/Windows).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${YTMUSIC_STEAMOS_BUILD_IMAGE:-ytmusic-steamOS-appimage-builder}"

if ! command -v docker >/dev/null 2>&1; then
  echo "error: Docker no está instalado." >&2
  echo "Instala Docker o construye directamente en Linux/Steam Deck:" >&2
  echo "  ./scripts/build-appimage.sh" >&2
  exit 1
fi

echo "==> Construir imagen ${IMAGE}"
docker build -t "${IMAGE}" -f "${ROOT}/packaging/Dockerfile.appimage" "${ROOT}"

echo "==> Ejecutar build dentro del contenedor"
docker run --rm \
  --platform linux/amd64 \
  -v "${ROOT}:/src" \
  -w /src \
  "${IMAGE}" \
  bash -lc './scripts/build-appimage.sh'

echo ""
echo "AppImage generada en: ${ROOT}/dist/ytmusic-steamOS-x86_64.AppImage"
