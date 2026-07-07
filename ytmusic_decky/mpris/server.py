"""Servidor MPRIS2 sobre D-Bus para integración con Steam Deck / Bazzite."""

from __future__ import annotations

import logging
import threading
from typing import TYPE_CHECKING, Callable

import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop

if TYPE_CHECKING:
    from ytmusic_decky.player_state import PlayerState

logger = logging.getLogger(__name__)

MPRIS_PATH = "/org/mpris/MediaPlayer2"
PLAYER_PATH = "/org/mpris/MediaPlayer2"
SERVICE_NAME = "org.mpris.MediaPlayer2.ytmusicdecky"
ROOT_IFACE = "org.mpris.MediaPlayer2"
PLAYER_IFACE = "org.mpris.MediaPlayer2.Player"
PROPERTIES_IFACE = "org.freedesktop.DBus.Properties"


class MPRISRoot(dbus.service.Object):
    def __init__(self, bus_name: dbus.service.BusName, state: PlayerState) -> None:
        super().__init__(bus_name, MPRIS_PATH)
        self._state = state

    @dbus.service.method(PROPERTIES_IFACE, in_signature="ss", out_signature="v")
    def Get(self, interface: str, prop: str):
        return self.GetAll(interface)[prop]

    @dbus.service.method(PROPERTIES_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface: str):
        if interface != ROOT_IFACE:
            raise dbus.exceptions.DBusException(
                f"org.freedesktop.DBus.Error.UnknownInterface: {interface}"
            )
        return {
            "CanQuit": True,
            "CanRaise": True,
            "HasTrackList": False,
            "Identity": "YouTube Music Deck",
            "DesktopEntry": "ytmusic-decky",
            "SupportedUriSchemes": dbus.Array([], signature="s"),
            "SupportedMimeTypes": dbus.Array([], signature="s"),
        }

    @dbus.service.method(ROOT_IFACE, in_signature="", out_signature="")
    def Quit(self) -> None:
        self._state._notify()

    @dbus.service.method(ROOT_IFACE, in_signature="", out_signature="")
    def Raise(self) -> None:
        pass


class MPRISPlayer(dbus.service.Object):
    LOOP_MAP = {"None": "None", "Track": "Track", "Playlist": "Playlist"}

    def __init__(
        self,
        bus_name: dbus.service.BusName,
        state: PlayerState,
        on_command: Callable[[str, dict], None],
    ) -> None:
        super().__init__(bus_name, PLAYER_PATH)
        self._state = state
        self._on_command = on_command
        state.subscribe(self._emit_changes)

    def _dbus_metadata(self) -> dbus.Dictionary:
        snap = self._state.snapshot()
        meta = snap["metadata"]
        mapping = {
            "mpris:trackid": dbus.ObjectPath(
                f"/org/mpris/MediaPlayer2/track/{meta.track_id or 'none'}"
            ),
            "xesam:title": meta.title or "YouTube Music",
            "xesam:artist": dbus.Array([meta.artist] if meta.artist else [], signature="s"),
            "xesam:album": meta.album or "",
        }
        if meta.art_url:
            mapping["mpris:artUrl"] = meta.art_url
        if meta.length_us:
            mapping["mpris:length"] = dbus.Int64(meta.length_us)
        return dbus.Dictionary(mapping, signature="sv")

    def _properties(self) -> dict:
        snap = self._state.snapshot()
        return {
            "PlaybackStatus": snap["playback_status"],
            "LoopStatus": self.LOOP_MAP.get(snap["loop_status"], "None"),
            "Rate": dbus.Double(1.0),
            "Shuffle": bool(snap["shuffle"]),
            "Metadata": self._dbus_metadata(),
            "Volume": dbus.Double(snap["volume"]),
            "Position": dbus.Int64(snap["position_us"]),
            "MinimumRate": dbus.Double(1.0),
            "MaximumRate": dbus.Double(1.0),
            "CanGoNext": bool(snap["can_go_next"]),
            "CanGoPrevious": bool(snap["can_go_previous"]),
            "CanPlay": bool(snap["can_play"]),
            "CanPause": bool(snap["can_pause"]),
            "CanSeek": bool(snap["can_seek"]),
            "CanControl": True,
        }

    def _emit_changes(self) -> None:
        props = self._properties()
        self.PropertiesChanged(PLAYER_IFACE, props, [])

    @dbus.service.signal(PROPERTIES_IFACE, signature="sa{sv}as")
    def PropertiesChanged(self, interface, changed, invalidated):
        pass

    @dbus.service.method(PROPERTIES_IFACE, in_signature="ss", out_signature="v")
    def Get(self, interface: str, prop: str):
        return self.GetAll(interface)[prop]

    @dbus.service.method(PROPERTIES_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface: str):
        if interface != PLAYER_IFACE:
            raise dbus.exceptions.DBusException(
                f"org.freedesktop.DBus.Error.UnknownInterface: {interface}"
            )
        return self._properties()

    @dbus.service.method(PLAYER_IFACE, in_signature="", out_signature="")
    def Next(self) -> None:
        self._on_command("next", {})

    @dbus.service.method(PLAYER_IFACE, in_signature="", out_signature="")
    def Previous(self) -> None:
        self._on_command("previous", {})

    @dbus.service.method(PLAYER_IFACE, in_signature="", out_signature="")
    def Pause(self) -> None:
        self._on_command("pause", {})

    @dbus.service.method(PLAYER_IFACE, in_signature="", out_signature="")
    def Play(self) -> None:
        self._on_command("play", {})

    @dbus.service.method(PLAYER_IFACE, in_signature="", out_signature="")
    def PlayPause(self) -> None:
        self._on_command("playPause", {})

    @dbus.service.method(PLAYER_IFACE, in_signature="x", out_signature="")
    def Seek(self, offset: int) -> None:
        self._on_command("seek", {"offsetUs": int(offset)})

    @dbus.service.method(PLAYER_IFACE, in_signature="ox", out_signature="")
    def SetPosition(self, _track_id: dbus.ObjectPath, position: int) -> None:
        self._on_command("setPosition", {"positionUs": int(position)})

    @dbus.service.method(PLAYER_IFACE, in_signature="d", out_signature="")
    def SetVolume(self, volume: float) -> None:
        self._state.set_volume(float(volume))
        self._on_command("setVolume", {"volume": float(volume)})

    @dbus.service.method(PLAYER_IFACE, in_signature="", out_signature="")
    def Stop(self) -> None:
        self._on_command("pause", {})

    @dbus.service.method(PLAYER_IFACE, in_signature="s", out_signature="")
    def SetLoopStatus(self, status: str) -> None:
        self._on_command("setLoop", {"status": status})

    @dbus.service.method(PLAYER_IFACE, in_signature="b", out_signature="")
    def SetShuffle(self, shuffle: bool) -> None:
        self._on_command("setShuffle", {"shuffle": bool(shuffle)})


class MPRIServer:
    """Runs the MPRIS D-Bus service in a background GLib loop thread."""

    def __init__(self, state: PlayerState, on_command: Callable[[str, dict], None]) -> None:
        self._state = state
        self._on_command = on_command
        self._thread: threading.Thread | None = None
        self._bus_name: dbus.service.BusName | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="mpris-server", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        DBusGMainLoop(set_as_default=True)
        try:
            bus = dbus.SessionBus()
            self._bus_name = dbus.service.BusName(SERVICE_NAME, bus, do_not_queue=True)
            MPRISRoot(self._bus_name, self._state)
            MPRISPlayer(self._bus_name, self._state, self._on_command)
            logger.info("MPRIS registrado como %s", SERVICE_NAME)
            from gi.repository import GLib

            GLib.MainLoop().run()
        except Exception:
            logger.exception("No se pudo iniciar MPRIS (¿falta sesión D-Bus?)")
