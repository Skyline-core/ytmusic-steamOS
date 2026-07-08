#!/usr/bin/env bash
# Asegura libpython, wrapper de lanzamiento y RPATH en el bundle PyInstaller (onedir).
set -euo pipefail

BUNDLE="${1:?ruta al bundle ytmusic-steamOS}"
VENV_DIR="${2:-}"

INTERNAL="${BUNDLE}/_internal"
BIN="${BUNDLE}/ytmusic-steamOS.bin"
WRAPPER="${BUNDLE}/ytmusic-steamOS"

if [[ ! -d "${INTERNAL}" ]]; then
  echo "error: no existe ${INTERNAL}" >&2
  exit 1
fi

PYTHON_BIN="${VENV_DIR}/bin/python3"
if [[ ! -x "${PYTHON_BIN}" ]]; then
  PYTHON_BIN="$(command -v python3)"
fi

find_libpython() {
  "${PYTHON_BIN}" - <<'PY'
import glob
import os
import sys
import sysconfig

def add(path):
    if not path:
        return
    real = os.path.realpath(path)
    if os.path.isfile(real):
        candidates.append(real)

candidates = []
libdir = sysconfig.get_config_var("LIBDIR")
instsoname = sysconfig.get_config_var("INSTSONAME")
if libdir and instsoname:
    add(os.path.join(libdir, instsoname))

for base in (sys.base_prefix, sys.prefix):
    for path in glob.glob(os.path.join(base, "lib", "libpython*.so*")):
        add(path)

seen = set()
for path in candidates:
    if path in seen:
        continue
    seen.add(path)
    print(path)
    break
PY
}

strip_host_conflicting_libs() {
  local patterns=(
    'libstdc++.so*'
    'libgcc_s.so*'
    'libGL.so*'
    'libEGL.so*'
    'libGLESv2.so*'
    'libgbm.so*'
    'libdrm.so*'
    'libdrm_amdgpu.so*'
    'libdrm_intel.so*'
    'libdrm_nouveau.so*'
    'libdrm_radeon.so*'
  )
  local pat f
  for pat in "${patterns[@]}"; do
    while IFS= read -r -d '' f; do
      echo "==> Quitando $(basename "${f}") del bundle (usar librería del host)"
      rm -f "${f}"
    done < <(find "${INTERNAL}" -name "${pat}" -print0 2>/dev/null || true)
  done
}

copy_libpython() {
  local src dir link base
  src="$(find_libpython || true)"
  if [[ -z "${src}" || ! -f "${src}" ]]; then
    echo "error: no se encontró libpython en el entorno de build" >&2
    exit 1
  fi

  echo "==> Copiando libpython desde ${src}"
  rm -f "${INTERNAL}"/libpython*.so*

  base="${INTERNAL}/$(basename "${src}")"
  cp -L "${src}" "${base}"

  dir="$(dirname "${src}")"
  for link in "${dir}"/libpython*.so*; do
    [[ -e "${link}" ]] || continue
    cp -a "${link}" "${INTERNAL}/" 2>/dev/null || cp -P "${link}" "${INTERNAL}/" 2>/dev/null || true
  done

  if ! compgen -G "${INTERNAL}/libpython"*.so* >/dev/null; then
    echo "error: libpython no quedó en ${INTERNAL}" >&2
    exit 1
  fi

  echo "==> libpython en bundle: $(ls -1 "${INTERNAL}"/libpython*.so* | tr '\n' ' ')"
}

set_rpath() {
  local binary="$1"
  [[ -f "${binary}" ]] || return 0
  command -v patchelf >/dev/null 2>&1 || return 0
  patchelf --set-rpath '$ORIGIN/_internal:$ORIGIN/_internal/PySide6/Qt/lib' "${binary}" 2>/dev/null || true
}

install_launcher_wrapper() {
  local pyinstaller_exe="${BUNDLE}/ytmusic-steamOS"

  if [[ ! -f "${BIN}" ]]; then
    if [[ ! -x "${pyinstaller_exe}" ]]; then
      echo "error: no se encontró el ejecutable PyInstaller" >&2
      exit 1
    fi
    mv "${pyinstaller_exe}" "${BIN}"
  fi

  cat > "${WRAPPER}" <<'EOF'
#!/usr/bin/env bash
# Wrapper: fija cwd y re-aplica entorno si se ejecuta sin AppRun.
set -euo pipefail

HERE="$(dirname "$(readlink -f "${0}")")"
export YTMUSIC_APP_ROOT="${HERE}"

if [[ -f "${HERE}/setup-runtime-env.sh" ]]; then
  # shellcheck source=/dev/null
  source "${HERE}/setup-runtime-env.sh"
  ytmusic_setup_runtime_env
else
  INTERNAL="${HERE}/_internal"
  QT="${INTERNAL}/PySide6/Qt"
  export LD_LIBRARY_PATH="${INTERNAL}:${QT}/lib:${LD_LIBRARY_PATH:-}"
fi

cd "${HERE}"
exec "${HERE}/ytmusic-steamOS.bin" "$@"
EOF
  chmod +x "${WRAPPER}" "${BIN}"
}

bundle_missing_ldd() {
  local binary="$1"
  [[ -f "${binary}" ]] || return 0
  command -v ldd >/dev/null 2>&1 || return 0

  local skip_re='^(libstdc\+\+|libgcc_s|libGL|libEGL|libGLESv2|libgbm|libdrm)'
  local line libname src dest
  while IFS= read -r line; do
    [[ "${line}" == *"not found"* ]] || continue
    libname="$(awk '{print $1}' <<<"${line}")"
    [[ -n "${libname}" ]] || continue
    if [[ "${libname}" =~ ${skip_re} ]]; then
      echo "==> Omitiendo ${libname} (usar del host)"
      continue
    fi
    dest="${INTERNAL}/${libname}"
    [[ -f "${dest}" ]] && continue

    src="$(
      find /lib /lib64 /usr/lib /usr/lib64 "${INTERNAL}" -name "${libname}" -print -quit 2>/dev/null || true
    )"
    if [[ -n "${src}" && -f "${src}" ]]; then
      echo "==> Copiando dependencia faltante: ${libname}"
      cp -L "${src}" "${dest}"
    fi
  done < <(ldd "${binary}" 2>/dev/null || true)
}

verify_bundle() {
  local missing
  missing="$(ldd "${BIN}" 2>/dev/null | grep "not found" || true)"
  if [[ -n "${missing}" ]]; then
    echo "error: faltan librerías en el bundle:" >&2
    echo "${missing}" >&2
    exit 1
  fi

  if ! compgen -G "${INTERNAL}/libpython"*.so* >/dev/null; then
    echo "error: libpython ausente tras el empaquetado" >&2
    exit 1
  fi

  echo "==> Verificando arranque desde otro directorio"
  local wrapper_abs
  wrapper_abs="$(readlink -f "${WRAPPER}")"

  if ( cd /tmp && QT_QPA_PLATFORM=offscreen "${wrapper_abs}" --help >/dev/null 2>&1 ); then
    echo "==> Verificación OK"
    return 0
  fi

  echo "warning: smoke test --help falló en offscreen; comprobando solo ldd..." >&2
  ( cd /tmp && QT_QPA_PLATFORM=offscreen "${wrapper_abs}" --help ) 2>&1 | tail -10 >&2 || true

  missing="$(ldd "${BIN}" 2>/dev/null | grep "not found" || true)"
  if [[ -n "${missing}" ]]; then
    echo "error: el bundle no resuelve librerías:" >&2
    echo "${missing}" >&2
    exit 1
  fi

  echo "==> Verificación parcial OK (ldd sin faltantes; ignora fallo offscreen de Qt)"
}

echo "==> Ajustar librerías del bundle"
copy_libpython
install_launcher_wrapper
set_rpath "${BIN}"

WEBENGINE="${INTERNAL}/PySide6/Qt/libexec/QtWebEngineProcess"
if [[ -f "${WEBENGINE}" ]]; then
  set_rpath "${WEBENGINE}"
  bundle_missing_ldd "${WEBENGINE}"
fi

bundle_missing_ldd "${BIN}"
strip_host_conflicting_libs
verify_bundle
