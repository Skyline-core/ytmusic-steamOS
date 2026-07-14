#!/usr/bin/env bash
# Compara el API companion (:26538) con lo que espera decky-youtube-music.
set -euo pipefail

HOST="${YTMUSIC_API_HOST:-127.0.0.1}"
PORT="${YTMUSIC_API_PORT:-26538}"
BASE="http://${HOST}:${PORT}/api/v1"

echo "==> Diagnóstico API vs decky-youtube-music (${HOST}:${PORT})"
echo ""

if command -v ss >/dev/null 2>&1; then
  echo "Puerto ${PORT}:"
  ss -tlnp 2>/dev/null | grep ":${PORT} " || echo "  (nada escuchando)"
  echo ""
elif command -v netstat >/dev/null 2>&1; then
  echo "Puerto ${PORT}:"
  netstat -an 2>/dev/null | grep "\.${PORT} " || echo "  (nada escuchando)"
  echo ""
fi

if pgrep -af "ytmusic-steamOS|ytmusic_decky" >/dev/null 2>&1; then
  echo "Proceso ytmusic-decky:"
  pgrep -af "ytmusic-steamOS|ytmusic_decky" || true
else
  echo "Proceso ytmusic-decky: NO está en ejecución"
fi
echo ""

if ! command -v curl >/dev/null 2>&1; then
  echo "error: instala curl" >&2
  exit 1
fi

fail=0

pretty() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -m json.tool 2>/dev/null || cat
  else
    cat
  fi
}

echo -n "GET ${BASE}/song ... "
if song="$(curl -fsS --max-time 4 "${BASE}/song" 2>/dev/null)"; then
  echo "OK"
  printf '%s\n' "${song}" | pretty | sed 's/^/    /'
else
  echo "FALLO"
  curl -v --max-time 3 "${BASE}/song" 2>&1 | tail -n 8 || true
  echo ""
  echo "El API no responde. Abre ytmusic-decky y deja la app abierta."
  exit 1
fi
echo ""

echo -n "GET ${BASE}/queue ... "
if queue="$(curl -fsS --max-time 4 "${BASE}/queue" 2>/dev/null)"; then
  echo "OK"
  printf '%s\n' "${queue}" | pretty | sed 's/^/    /'
else
  echo "FALLO"
  fail=1
  queue='{"items":[]}'
fi
echo ""

echo -n "GET ${BASE}/volume ... "
if volume="$(curl -fsS --max-time 4 "${BASE}/volume" 2>/dev/null)"; then
  echo "OK"
  printf '%s\n' "${volume}" | pretty | sed 's/^/    /'
else
  echo "FALLO"
  fail=1
  volume='{}'
fi
echo ""

echo -n "OPTIONS Private-Network ... "
opts="$(curl -fsS -X OPTIONS "${BASE}/song" \
  -H "Origin: https://steamloopback.host" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Private-Network: true" \
  -D - -o /dev/null 2>/dev/null | tr -d '\r' || true)"
if echo "${opts}" | grep -qi "access-control-allow-private-network: true"; then
  echo "OK"
else
  echo "FALLO (falta Access-Control-Allow-Private-Network)"
  fail=1
fi
echo ""

echo "==> Chequeo de forma (decky SongInfo / QueueItem / volume)"
shape_status=0
SONG_JSON="${song}" QUEUE_JSON="${queue}" VOLUME_JSON="${volume}" python3 - <<'PY' || shape_status=$?
import json, os, sys

song = json.loads(os.environ.get("SONG_JSON") or "{}")
queue = json.loads(os.environ.get("QUEUE_JSON") or "{}")
volume = json.loads(os.environ.get("VOLUME_JSON") or "{}")
ok = True

def fail(msg: str) -> None:
    global ok
    ok = False
    print(f"  FAIL: {msg}")

def good(msg: str) -> None:
    print(f"  OK: {msg}")

for k in (
    "title",
    "artist",
    "album",
    "albumArt",
    "imageSrc",
    "videoId",
    "isPaused",
    "elapsedSeconds",
    "songDuration",
):
    if k not in song:
        fail(f"/song falta campo {k}")
if all(k in song for k in ("title", "artist", "albumArt", "imageSrc", "isPaused")):
    good("/song tiene campos SongInfo del plugin")

if not isinstance(queue.get("items"), list):
    fail("/queue.items debe ser lista")
else:
    good(f"/queue.items lista (n={len(queue['items'])})")
    for i, item in enumerate(queue["items"][:5]):
        r = item.get("playlistPanelVideoRenderer") or (
            ((item.get("playlistPanelVideoWrapperRenderer") or {}).get("primaryRenderer") or {})
            .get("playlistPanelVideoRenderer")
        )
        if not r:
            fail(f"items[{i}] sin playlistPanelVideoRenderer")
            continue
        runs = ((r.get("title") or {}).get("runs") or [])
        title = runs[0].get("text") if runs else None
        if not title:
            fail(f"items[{i}] título vacío (Decky muestra Unknown)")
        else:
            good(f"items[{i}] title={title!r} selected={r.get('selected')}")

if set(volume.keys()) < {"state", "isMuted"}:
    fail("/volume debe tener state + isMuted")
else:
    good(f"/volume state={volume.get('state')} muted={volume.get('isMuted')}")

if not song.get("title"):
    print("  AVISO: /song.title vacío — reproduce una canción y vuelve a correr este script")
    print("         Si sigue vacío con música sonando, QWebChannel/reportState no está conectado.")
else:
    art = song.get("albumArt") or song.get("imageSrc")
    if not art:
        fail("/song sin albumArt/imageSrc (Decky no muestra carátula)")
    else:
        good(f"/song art ok ({str(art)[:48]}...)")

sys.exit(0 if ok else 1)
PY
if [[ "${shape_status}" -ne 0 ]]; then
  fail=1
fi

echo ""
if [[ "${fail}" -ne 0 ]]; then
  echo "Diagnóstico: FALLÓ al menos un chequeo."
  echo "  1. Abre: python -m ytmusic_decky --windowed --no-mpris -v"
  echo "  2. Reproduce una canción"
  echo "  3. Vuelve a correr: ./scripts/diagnose-decky-api.sh"
  exit 1
fi

echo "API OK (forma compatible con decky-youtube-music)."
if ! printf '%s' "${song}" | grep -q '"title": "[^"]'; then
  echo "Nota: con título vacío Decky sigue mostrando Nothing playing aunque el puerto responda."
fi
