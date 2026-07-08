#!/usr/bin/env bash
# Construye la AppImage dentro de Docker (útil en macOS/Windows).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RAW_IMAGE="${YTMUSIC_STEAMOS_BUILD_IMAGE:-ytmusic-steamos-appimage-builder}"
IMAGE="$(printf '%s' "${RAW_IMAGE}" | tr '[:upper:]' '[:lower:]')"
PLATFORM="${YTMUSIC_STEAMOS_BUILD_PLATFORM:-linux/amd64}"

if [[ "${RAW_IMAGE}" != "${IMAGE}" ]]; then
  echo "warning: YTMUSIC_STEAMOS_BUILD_IMAGE contiene mayúsculas, se normaliza a: ${IMAGE}" >&2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "error: Docker no está instalado." >&2
  echo "Instala Docker o construye directamente en Linux/Steam Deck:" >&2
  echo "  ./scripts/build-appimage.sh" >&2
  exit 1
fi

if [[ "${PLATFORM}" != "linux/amd64" ]]; then
  echo "error: este build genera AppImage x86_64 para Steam Deck." >&2
  echo "Usa YTMUSIC_STEAMOS_BUILD_PLATFORM=linux/amd64 (valor por defecto)." >&2
  exit 1
fi

echo "==> Construir imagen ${IMAGE} (${PLATFORM})"
echo "    (reconstruye sin caché si cambiaste de Mac ARM a amd64: docker build --no-cache ...)"
docker build --platform "${PLATFORM}" -t "${IMAGE}" -f "${ROOT}/packaging/Dockerfile.appimage" "${ROOT}"

if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "error: la imagen local '${IMAGE}' no existe tras docker build." >&2
  echo "Verifica los errores del build y vuelve a intentar." >&2
  exit 1
fi

CONTAINER_ARCH="$(docker run --rm --pull=never --platform "${PLATFORM}" "${IMAGE}" uname -m 2>/dev/null || true)"
if [[ "${CONTAINER_ARCH}" != "x86_64" ]]; then
  echo "error: el contenedor no es x86_64 (obtuvo: ${CONTAINER_ARCH:-desconocido})." >&2
  echo "Elimina la imagen vieja y reconstruye:" >&2
  echo "  docker rmi ${IMAGE}" >&2
  echo "  YTMUSIC_STEAMOS_BUILD_PLATFORM=linux/amd64 ./scripts/build-appimage-docker.sh" >&2
  exit 1
fi
echo "==> Contenedor verificado: ${CONTAINER_ARCH}"

echo "==> Ejecutar build dentro del contenedor"
docker run --rm \
  --pull=never \
  --platform "${PLATFORM}" \
  -e YTMUSIC_BUILD_IN_DOCKER=1 \
  -v "${ROOT}:/src" \
  -w /src \
  "${IMAGE}" \
  bash -lc './scripts/build-appimage.sh'

echo ""
echo "AppImage generada en: ${ROOT}/dist/ytmusic-steamOS-x86_64.AppImage"
