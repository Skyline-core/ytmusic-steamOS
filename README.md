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
```

## Instalación rápida

```bash
git clone https://github.com/Skyline-core/ytmusic-steamOS.git
cd ytmusic-steamOS
chmod +x scripts/launch.sh
./scripts/launch.sh
```

El script crea un `.venv`, instala dependencias y lanza la app en pantalla completa.

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

# Logs detallados
./scripts/launch.sh -v
```

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
