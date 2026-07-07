#!/usr/bin/env bash
# Calcula QT_SCALE_FACTOR / YTMUSIC_DECKY_UI_SCALE para handheld y Steam Big Picture.
# Uso: source packaging/detect-ui-scale.sh && detect_ui_scale

detect_ui_scale() {
  if [[ -n "${YTMUSIC_DECKY_UI_SCALE:-}" ]]; then
    export QT_SCALE_FACTOR="${YTMUSIC_DECKY_UI_SCALE}"
    return
  fi
  if [[ -n "${QT_SCALE_FACTOR:-}" && "${QT_SCALE_FACTOR}" != "1" ]]; then
    export YTMUSIC_DECKY_UI_SCALE="${QT_SCALE_FACTOR}"
    return
  fi

  local w=1280 h=800
  if command -v xrandr >/dev/null 2>&1; then
    local geom
    geom="$(xrandr --current 2>/dev/null | grep -E '\*' | head -1 | grep -oE '[0-9]+x[0-9]+' | head -1 || true)"
    if [[ -n "${geom}" ]]; then
      w="${geom%x*}"
      h="${geom#*x}"
    fi
  fi

  local scale
  scale="$(awk -v w="$w" -v h="$h" 'BEGIN {
    s = (w/1280 < h/800) ? w/1280 : h/800;
    if (s < 1.0) s = 1.0;
    if (s > 1.75) s = 1.75;
    printf "%.2f", s
  }')"

  if [[ -n "${SteamGameId:-}" || -n "${STEAM_RUNTIME:-}" || -n "${GAMESCOPE_WAYLAND_DISPLAY:-}" || "${SteamTenfoot:-}" == "1" ]]; then
    scale="$(awk -v s="$scale" 'BEGIN {
      if (s < 1.38) printf "%.2f", 1.38;
      else printf "%.2f", s;
    }')"
  fi

  export QT_SCALE_FACTOR="${scale}"
  export YTMUSIC_DECKY_UI_SCALE="${scale}"
}
