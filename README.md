# ytmusic-steamOS

Reproductor de **YouTube Music** pensado para **SteamOS / Steam Deck** en modo Big Picture y **Bazzite**. Carga la interfaz web oficial e inyecta CSS y JavaScript para adaptarla a pantallas de 7" con controles táctiles grandes, además de exponer **MPRIS2** sobre D-Bus para que los botones del Deck y el overlay de Steam controlen la reproducción.

## Características

- **Python + PySide6 (Qt WebEngine)** — ventana fullscreen con soporte touch
- **MPRIS2** — Play/Pause, Anterior/Siguiente, Seek, Volumen vía D-Bus
- **Inyección CSS/JS** — oculta barras laterales, agranda botones, layout dual (reproductor | cola)
- **Teclas multimedia** — Space, Media Play/Pause, Next/Previous
- **Barra de progreso táctil** — arrastre con dedo o trackpad

## Requisitos (SteamOS / Arch / Fedora)

```bash
# SteamOS (modo escritorio) — dependencias del sistema
sudo pacman -S python python-pyside6 python-dbus python-gobject qt6-webengine

# Fedora / Bazzite
sudo dnf install python3 python3-pyside6 python3-dbus python3-gobject qt6-qtwebengine

# Debian / Ubuntu (modo escritorio)
sudo apt install python3 python3-pyside6 python3-dbus python3-gi python3-venv qt6-webengine-dev
```

`python-dbus` y `python-gobject` (o `python3-dbus` / `python3-gi`) son para **MPRIS** (botones del Deck). La app y el API Decky funcionan sin ellos; MPRIS quedará desactivado con un aviso.

## Instalación rápida

**SteamOS / Deck (recomendado):**

```bash
git clone https://github.com/Skyline-core/ytmusic-steamOS.git
cd ytmusic-steamOS
chmod +x scripts/*.sh
./scripts/install-runtime-deps.sh   # paquetes del sistema (PySide6, aiohttp, Qt…)
rm -rf .venv                          # si ya existía un venv roto
./scripts/launch.sh
```

**Solo con pip en venv** (si ya tienes Qt/WebEngine del sistema):

```bash
chmod +x scripts/launch.sh
rm -rf .venv
./scripts/launch.sh
```

**Preparar venv por SSH** (sin pantalla, sin lanzar la app):

```bash
./scripts/launch.sh --setup-only
./scripts/build-appimage.sh   # genera el .AppImage para copiar a Bazzite/Deck
```

> **No uses `pip install` del sistema** (error `externally-managed-environment`).
> `launch.sh` instala PySide6 y aiohttp dentro de `.venv/`.

### Problemas comunes (Deepin / Debian)

**`undefined symbol: QObjectPrivate, version Qt_6_PRIVATE_API`** — PySide6 de pip (6.11) choca con Qt6 del sistema (más viejo). `launch.sh` ya prioriza las libs Qt del venv. Si persiste:

```bash
git pull
./scripts/launch.sh
```

O usa solo paquetes del sistema (sin PySide6 de pip):

```bash
sudo apt install python3-pyside6.qtwebenginewidgets python3-aiohttp python3-dbus python3-gi
rm -rf .venv && ./scripts/launch.sh
```

### `could not connect to display` / `libxcb-cursor0`

**Sin pantalla:** `launch.sh` debe ejecutarse en el **escritorio** o vía **Steam**, no desde SSH:

```bash
echo "DISPLAY=$DISPLAY WAYLAND=$WAYLAND_DISPLAY"
```

Si ambos están vacíos, abre una terminal en el escritorio del Rog Ally o añade la app a Steam.

**Falta libxcb-cursor** (Qt 6.5+):

```bash
sudo apt install libxcb-cursor0 libxcb-xinerama0 libxkbcommon-x11-0
# o
./scripts/install-runtime-deps.sh
```

### Añadir a Steam (Big Picture)

1. En Steam → **Añadir juego** → **Añadir programa externo**
2. Selecciona `scripts/launch.sh` de este repositorio
3. Opcional: en Propiedades → **Forzar compatibilidad** desactivada; **Resolución** nativa 1280×800

También puedes copiar `ytmusic-steamOS.desktop` a `~/.local/share/applications/`.

## AppImage (Steam Deck / Linux)

La AppImage incluye Python, PySide6, Qt WebEngine y la app. **No hace falta instalar dependencias** en el Deck.

### Construir en Steam Deck, Bazzite o PC Linux

El script detecta el gestor de paquetes del sistema (`rpm-ostree` en Bazzite, `dnf`, `pacman` en SteamOS, `apt` en Ubuntu):

```bash
git clone https://github.com/Skyline-core/ytmusic-steamOS.git
cd ytmusic-steamOS
chmod +x scripts/build-appimage.sh packaging/AppRun scripts/install-build-deps.sh
./scripts/build-appimage.sh
```

En **Bazzite** (sistema inmutable), la primera vez puede instalar capas con `rpm-ostree` y pedir **reinicio** antes de continuar el build.

Salida: `dist/ytmusic-steamOS-x86_64.AppImage`

### Construir con Docker (macOS / Windows)

```bash
chmod +x scripts/build-appimage-docker.sh
./scripts/build-appimage-docker.sh
```

### Ejecutar en Steam Deck

```bash
chmod +x ytmusic-steamOS-x86_64.AppImage
./ytmusic-steamOS-x86_64.AppImage
```

Primera vez en SteamOS (modo escritorio), si FUSE falla:

```bash
./ytmusic-steamOS-x86_64.AppImage --appimage-extract-and-run
```

### Añadir la AppImage a Steam

1. Copia `ytmusic-steamOS-x86_64.AppImage` al Deck (p. ej. `~/Applications/`)
2. Steam → **Añadir juego** → **Añadir programa externo**
3. Selecciona la AppImage y en **Opciones de lanzamiento** deja vacío o usa `--fullscreen`
4. MPRIS funciona con el bus D-Bus de la sesión del host

## Uso

```bash
# Pantalla completa (por defecto)
./scripts/launch.sh

# Ventana (desarrollo)
./scripts/launch.sh --windowed

# Sin MPRIS
./scripts/launch.sh --no-mpris

# Sin API companion (Decky)
./scripts/launch.sh --no-api

# Logs detallados
./scripts/launch.sh -v
```

## Control desde Decky Loader

Compatible con el plugin [decky-youtube-music](https://github.com/artistro08/decky-youtube-music) (mismo API que th-ch/youtube-music en el puerto **26538**).

### Requisitos

1. **ytmusic-decky** en ejecución (AppImage o `launch.sh`) en Game Mode
2. Plugin **YouTube Music** instalado en Decky Loader
3. En el plugin de Decky, autorización **No authorization** (o deja el token vacío)

### Uso en Steam Deck

1. Añade ytmusic-decky a Steam y ábrelo en Game Mode
2. Abre el plugin **YouTube Music** en el panel lateral de Decky
3. Controla play/pause, volumen, shuffle, repeat y cola sin salir del juego

El API escucha en `http://127.0.0.1:26538/api/v1` y WebSocket en `ws://127.0.0.1:26538/api/v1/ws`.

Variables opcionales:

- `YTMUSIC_DECKY_API_TOKEN` — si defines un token, el plugin Decky debe usarlo como Bearer
- `--api-port` / `--api-host` — cambiar puerto u host
- `--no-api` — desactivar el servidor companion

**Nota:** la cola se lee de la interfaz web de YouTube Music; para verla en Decky abre el reproductor expandido (cola lateral) al menos una vez.

### Si Decky no muestra nada / «Not Connected»

1. **Orden:** abre primero **ytmusic-decky** (AppImage o `launch.sh`), reproduce una canción, **luego** abre el plugin en Decky.
2. **Auth:** en el plugin Decky → configuración → **No authorization** (token vacío). Si definiste `YTMUSIC_DECKY_API_TOKEN`, el mismo token debe estar en el plugin.
3. **Puerto libre:** no tengas Pear/th-ch YouTube Music con API Server en **26538** a la vez.
4. **Diagnóstico** (con la app abierta):

```bash
chmod +x scripts/diagnose-decky-api.sh
./scripts/diagnose-decky-api.sh
```

Debe devolver JSON con `title` / `artist`. Si falla, el API no está activo (reconstruye AppImage reciente o usa `launch.sh -v`).

5. En Decky: **recarga el plugin** (menú Decky → icono de recargar plugins).

## Arquitectura

```
┌─────────────────┐     QWebChannel      ┌──────────────────┐
│  YouTube Music  │ ◄──────────────────► │  bridge.js       │
│  (WebEngine)    │     reportState      │  + deck.css      │
└────────┬────────┘                      └────────┬─────────┘
         │                                        │
         │ handleCommand                          │ update_from_web
         ▼                                        ▼
┌─────────────────┐     PropertiesChanged  ┌──────────────────┐
│  DeckWindow     │ ◄────────────────────► │  PlayerState     │
│  (PySide6)      │                        └────────┬─────────┘
└─────────────────┘                                 │
                                                      ▼
                                            ┌──────────────────┐
                                            │  MPRIServer      │
                                            │  (D-Bus)         │
                                            └──────────────────┘
                                                      ▲
                                                      │ Steam / KDE / GNOME

┌──────────────────┐   HTTP/WS :26538   ┌──────────────────┐
│  decky-youtube-  │ ◄────────────────► │  CompanionApi    │
│  music (Decky)   │                    │  Server (aiohttp)│
└──────────────────┘                    └────────┬─────────┘
                                                 │
                                                 ▼
                                        ┌──────────────────┐
                                        │  PlayerState     │
                                        └──────────────────┘
```

## Personalizar la interfaz

Edita estos archivos y reinicia la app:

| Archivo | Propósito |
|---------|-----------|
| `ytmusic_decky/inject/deck.css` | Ocultar elementos, tamaños táctiles, Grid/Flex |
| `ytmusic_decky/inject/bridge.js` | Estado del player, comandos, UI inyectada |

YouTube Music cambia su DOM con frecuencia. Si algo deja de verse, inspecciona la página con `--windowed -v` y ajusta selectores en `deck.css` / `bridge.js`.

## MPRIS

Servicio D-Bus: `org.mpris.MediaPlayer2.ytmusicdecky`

```bash
# Probar desde terminal
busctl --user call org.mpris.MediaPlayer2.ytmusicdecky \
  /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player PlayPause
```

En Steam Deck, con la app en primer plano, los botones **Steam + X/B/Y** suelen mapear a controles multimedia si el sistema enruta hacia el reproductor MPRIS activo.

## Licencia

MIT
