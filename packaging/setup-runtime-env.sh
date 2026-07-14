#!/usr/bin/env bash
# Entorno runtime AppImage / bundle: libs del host para GL y flags WebEngine.
# Uso: source setup-runtime-env.sh && ytmusic_setup_runtime_env

ytmusic_app_root() {
  if [[ -n "${YTMUSIC_APP_ROOT:-}" ]]; then
    printf '%s' "${YTMUSIC_APP_ROOT}"
    return
  fi
  local here
  here="$(dirname "$(readlink -f "${BASH_SOURCE[0]:-${0}}")")"
  printf '%s' "${here}"
}

ytmusic_host_lib_path() {
  local dirs=() d
  for d in \
    /usr/lib64/mesa \
    /usr/lib64 \
    /usr/lib/x86_64-linux-gnu/mesa \
    /usr/lib/x86_64-linux-gnu \
    /lib64 \
    /lib/x86_64-linux-gnu; do
    [[ -d "${d}" ]] && dirs+=("${d}")
  done
  if ((${#dirs[@]} == 0)); then
    printf '%s' "/usr/lib64:/lib64"
    return
  fi
  local IFS=:
  printf '%s' "${dirs[*]}"
}

ytmusic_pyside6_qt_dir() {
  local python="${1:?python}"
  "${python}" -c "
import os
import PySide6
print(os.path.join(os.path.dirname(PySide6.__file__), 'Qt'))
" 2>/dev/null || true
}

ytmusic_setup_pyside6_qt_env() {
  local python="${1:?python}"
  local qt_dir="${2:-$(ytmusic_pyside6_qt_dir "${python}")}"
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

ytmusic_setup_ld_library_path() {
  local root internal qt host
  root="$(ytmusic_app_root)"
  internal="${root}/_internal"
  if [[ ! -d "${internal}/PySide6/Qt/lib" ]]; then
    return 0
  fi
  qt="${internal}/PySide6/Qt"
  host="$(ytmusic_host_lib_path)"

  export LD_LIBRARY_PATH="${internal}:${qt}/lib:${host}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
  export QT_PLUGIN_PATH="${qt}/plugins"
  export QML2_IMPORT_PATH="${qt}/qml"
  export QTWEBENGINEPROCESS_PATH="${qt}/libexec/QtWebEngineProcess"
  export QTWEBENGINE_RESOURCES_PATH="${qt}/resources"
  export QTWEBENGINE_LOCALES_PATH="${qt}/translations/qtwebengine_locales"
  export QTWEBENGINE_DISABLE_SANDBOX=1
}

ytmusic_setup_qpa_platform() {
  if [[ -n "${YTMUSIC_DECKY_QPA_PLATFORM:-}" ]]; then
    export QT_QPA_PLATFORM="${YTMUSIC_DECKY_QPA_PLATFORM}"
  elif [[ -z "${QT_QPA_PLATFORM:-}" ]]; then
    export QT_QPA_PLATFORM=xcb
  fi
  case "${QT_QPA_PLATFORM}" in
    xcb|wayland|minimal|offscreen) ;;
    *)
      echo "warning: QT_QPA_PLATFORM='${QT_QPA_PLATFORM}' no válido; usando xcb" >&2
      export QT_QPA_PLATFORM=xcb
      ;;
  esac
}

ytmusic_setup_gl_env() {
  local -a chromium=()

  chromium+=(
    --enable-touch-events
    --touch-events=enabled
    --disable-features=ElasticOverscroll
    --disable-dev-shm-usage
    --no-sandbox
    --enable-features=TouchEventFeatureDetection
  )

  # AppImage: GPU por defecto. Software GL solo con YTMUSIC_DECKY_SOFTWARE_GL=1.
  if [[ "${YTMUSIC_DECKY_GPU:-0}" == "1" ]]; then
    export YTMUSIC_DECKY_SOFTWARE_GL=0
  elif [[ "${YTMUSIC_DECKY_SOFTWARE_GL:-0}" == "1" ]]; then
    export YTMUSIC_DECKY_SOFTWARE_GL=1
  elif [[ -n "${YTMUSIC_APP_ROOT:-}" ]]; then
    export YTMUSIC_DECKY_SOFTWARE_GL=0
  fi

  if [[ "${YTMUSIC_DECKY_SOFTWARE_GL:-0}" == "1" ]]; then
    export QT_OPENGL=software
    export LIBGL_ALWAYS_SOFTWARE=1
    export MESA_LOADER_DRIVER_OVERRIDE=llvmpipe
    export GALLIUM_DRIVER=llvmpipe
    export QSG_RHI_BACKEND=opengl
    chromium+=(
      --disable-gpu
      --disable-gpu-compositing
      --enable-software-rasterizer
      --disable-accelerated-2d-canvas
      --disable-accelerated-video-decode
    )
  fi

  if [[ -z "${QTWEBENGINE_CHROMIUM_FLAGS:-}" ]]; then
    QTWEBENGINE_CHROMIUM_FLAGS="${chromium[*]}"
  fi
  export QTWEBENGINE_CHROMIUM_FLAGS
}

ytmusic_setup_steam_env() {
  if [[ -n "${SteamGameId:-}" || -n "${STEAM_RUNTIME:-}" || -n "${GAMESCOPE_WAYLAND_DISPLAY:-}" || "${SteamTenfoot:-}" == "1" ]]; then
    export YTMUSIC_DECKY_STEAM=1
    export SDL_VIDEO_X11_DGAMOUSE=0
  fi
}

ytmusic_setup_runtime_env() {
  ytmusic_setup_ld_library_path
  ytmusic_setup_steam_env
  ytmusic_setup_qpa_platform
  ytmusic_setup_gl_env
}
