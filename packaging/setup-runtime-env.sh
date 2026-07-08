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

ytmusic_setup_ld_library_path() {
  local root internal qt host
  root="$(ytmusic_app_root)"
  internal="${root}/_internal"
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

  # AppImage: software GL por defecto (llvmpipe del host). GPU solo si YTMUSIC_DECKY_GPU=1.
  if [[ "${YTMUSIC_DECKY_GPU:-0}" == "1" ]]; then
    export YTMUSIC_DECKY_SOFTWARE_GL=0
  elif [[ "${YTMUSIC_DECKY_SOFTWARE_GL:-1}" != "0" ]]; then
    export YTMUSIC_DECKY_SOFTWARE_GL=1
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
