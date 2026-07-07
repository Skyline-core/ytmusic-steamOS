"""Estado compartido del reproductor entre la web, MPRIS y la UI."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass
class TrackMetadata:
    title: str = ""
    artist: str = ""
    album: str = ""
    art_url: str = ""
    track_id: str = ""
    length_us: int = 0


@dataclass
class PlayerState:
    """Thread-safe player snapshot consumed by the MPRIS server."""

    metadata: TrackMetadata = field(default_factory=TrackMetadata)
    playback_status: str = "Stopped"  # Playing | Paused | Stopped
    position_us: int = 0
    position_monotonic: float = 0.0
    volume: float = 1.0
    can_play: bool = False
    can_pause: bool = False
    can_go_next: bool = False
    can_go_previous: bool = False
    can_seek: bool = False
    shuffle: bool = False
    loop_status: str = "None"  # None | Track | Playlist

    _lock: threading.RLock = field(default_factory=threading.RLock, repr=False)
    _listeners: list[Callable[[], None]] = field(default_factory=list, repr=False)

    def subscribe(self, callback: Callable[[], None]) -> None:
        with self._lock:
            self._listeners.append(callback)

    def _notify(self) -> None:
        listeners = list(self._listeners)

        for callback in listeners:
            try:
                callback()
            except Exception:
                pass

    def update_from_web(self, payload: dict[str, Any]) -> None:
        with self._lock:
            self.metadata = TrackMetadata(
                title=payload.get("title", ""),
                artist=payload.get("artist", ""),
                album=payload.get("album", ""),
                art_url=payload.get("artUrl", ""),
                track_id=payload.get("trackId", ""),
                length_us=int(payload.get("lengthUs", 0)),
            )
            self.playback_status = payload.get("playbackStatus", "Stopped")
            self.position_us = int(payload.get("positionUs", 0))
            self.position_monotonic = time.monotonic()
            self.volume = float(payload.get("volume", self.volume))
            self.can_play = bool(payload.get("canPlay", False))
            self.can_pause = bool(payload.get("canPause", False))
            self.can_go_next = bool(payload.get("canGoNext", False))
            self.can_go_previous = bool(payload.get("canGoPrevious", False))
            self.can_seek = bool(payload.get("canSeek", False))
            self.shuffle = bool(payload.get("shuffle", False))
            self.loop_status = payload.get("loopStatus", "None")
        self._notify()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            elapsed = 0.0
            if self.playback_status == "Playing":
                elapsed = time.monotonic() - self.position_monotonic
            position_us = self.position_us + int(elapsed * 1_000_000)
            return {
                "metadata": self.metadata,
                "playback_status": self.playback_status,
                "position_us": max(0, position_us),
                "volume": self.volume,
                "can_play": self.can_play,
                "can_pause": self.can_pause,
                "can_go_next": self.can_go_next,
                "can_go_previous": self.can_go_previous,
                "can_seek": self.can_seek,
                "shuffle": self.shuffle,
                "loop_status": self.loop_status,
            }

    def set_volume(self, volume: float) -> None:
        with self._lock:
            self.volume = max(0.0, min(1.0, volume))
        self._notify()
