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
    video_id: str = ""
    length_us: int = 0


@dataclass
class PlayerState:
    """Thread-safe player snapshot consumed by the MPRIS server."""

    metadata: TrackMetadata = field(default_factory=TrackMetadata)
    playback_status: str = "Stopped"  # Playing | Paused | Stopped
    position_us: int = 0
    position_monotonic: float = 0.0
    volume: float = 1.0
    muted: bool = False
    can_play: bool = False
    can_pause: bool = False
    can_go_next: bool = False
    can_go_previous: bool = False
    can_seek: bool = False
    shuffle: bool = False
    loop_status: str = "None"  # None | Track | Playlist
    queue_items: list[dict[str, Any]] = field(default_factory=list)

    _lock: threading.RLock = field(default_factory=threading.RLock, repr=False)
    _listeners: list[Callable[[], None]] = field(default_factory=list, repr=False)
    _api_listeners: list[Callable[[str, dict[str, Any]], None]] = field(
        default_factory=list, repr=False
    )
    _last_api_track_id: str = field(default="", repr=False)

    def subscribe(self, callback: Callable[[], None]) -> None:
        with self._lock:
            self._listeners.append(callback)

    def subscribe_api(self, callback: Callable[[str, dict[str, Any]], None]) -> None:
        with self._lock:
            self._api_listeners.append(callback)

    def _notify(self) -> None:
        for callback in list(self._listeners):
            try:
                callback()
            except Exception:
                pass

    def build_player_info_event(self) -> tuple[str, dict[str, Any]]:
        snap = self.snapshot()
        return "PLAYER_INFO", self._player_info_payload(snap)

    def update_from_web(self, payload: dict[str, Any]) -> None:
        prev = self.snapshot()
        with self._lock:
            self.metadata = TrackMetadata(
                title=payload.get("title", ""),
                artist=payload.get("artist", ""),
                album=payload.get("album", ""),
                art_url=payload.get("artUrl", ""),
                track_id=payload.get("trackId", ""),
                video_id=payload.get("videoId", ""),
                length_us=int(payload.get("lengthUs", 0)),
            )
            self.playback_status = payload.get("playbackStatus", "Stopped")
            self.position_us = int(payload.get("positionUs", 0))
            self.position_monotonic = time.monotonic()
            self.volume = float(payload.get("volume", self.volume))
            self.muted = bool(payload.get("muted", False))
            self.can_play = bool(payload.get("canPlay", False))
            self.can_pause = bool(payload.get("canPause", False))
            self.can_go_next = bool(payload.get("canGoNext", False))
            self.can_go_previous = bool(payload.get("canGoPrevious", False))
            self.can_seek = bool(payload.get("canSeek", False))
            self.shuffle = bool(payload.get("shuffle", False))
            self.loop_status = payload.get("loopStatus", "None")
            queue = payload.get("queue")
            if isinstance(queue, list):
                self.queue_items = queue
        self._notify_api_deltas(prev)
        self._notify()

    def _notify_api_deltas(self, prev: dict[str, Any]) -> None:
        listeners = list(self._api_listeners)
        if not listeners:
            return

        snap = self.snapshot()
        events: list[tuple[str, dict[str, Any]]] = []
        meta = snap["metadata"]
        track_id = meta.video_id or meta.track_id or meta.title
        if track_id and track_id != self._last_api_track_id:
            self._last_api_track_id = track_id
            events.append(("VIDEO_CHANGED", {"song": self._song_payload(snap)}))

        if snap["playback_status"] != prev.get("playback_status"):
            events.append(
                (
                    "PLAYER_STATE_CHANGED",
                    {
                        "isPlaying": snap["playback_status"] == "Playing",
                        "position": snap["position_us"] // 1_000_000,
                    },
                )
            )

        if abs(snap["position_us"] - prev.get("position_us", 0)) > 1_500_000:
            events.append(
                (
                    "POSITION_CHANGED",
                    {"position": snap["position_us"] // 1_000_000},
                )
            )

        if snap["volume"] != prev.get("volume") or snap["muted"] != prev.get("muted"):
            events.append(
                (
                    "VOLUME_CHANGED",
                    {
                        "volume": round(snap["volume"] * 100),
                        "muted": snap["muted"],
                    },
                )
            )

        if snap["shuffle"] != prev.get("shuffle"):
            events.append(("SHUFFLE_CHANGED", {"shuffle": snap["shuffle"]}))

        if snap["loop_status"] != prev.get("loop_status"):
            events.append(
                (
                    "REPEAT_CHANGED",
                    {"repeat": self._map_repeat(snap["loop_status"])},
                )
            )

        for event_type, payload in events:
            for callback in listeners:
                try:
                    callback(event_type, payload)
                except Exception:
                    pass

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
                "muted": self.muted,
                "can_play": self.can_play,
                "can_pause": self.can_pause,
                "can_go_next": self.can_go_next,
                "can_go_previous": self.can_go_previous,
                "can_seek": self.can_seek,
                "shuffle": self.shuffle,
                "loop_status": self.loop_status,
                "queue_items": list(self.queue_items),
            }

    @staticmethod
    def _map_repeat(loop_status: str) -> str:
        return {"None": "NONE", "Track": "ONE", "Playlist": "ALL"}.get(loop_status, "NONE")

    def _song_payload(self, snap: dict[str, Any] | None = None) -> dict[str, Any]:
        if snap is None:
            snap = self.snapshot()
        meta = snap["metadata"]
        position_s = snap["position_us"] // 1_000_000
        duration_s = meta.length_us // 1_000_000 if meta.length_us else 0
        art = meta.art_url
        return {
            "title": meta.title,
            "artist": meta.artist,
            "album": meta.album,
            "albumArt": art,
            "imageSrc": art,
            "videoId": meta.video_id,
            "isPaused": snap["playback_status"] != "Playing",
            "elapsedSeconds": position_s,
            "songDuration": duration_s,
        }

    def _player_info_payload(self, snap: dict[str, Any] | None = None) -> dict[str, Any]:
        if snap is None:
            snap = self.snapshot()
        return {
            "song": self._song_payload(snap),
            "isPlaying": snap["playback_status"] == "Playing",
            "position": snap["position_us"] // 1_000_000,
            "repeat": self._map_repeat(snap["loop_status"]),
            "shuffle": snap["shuffle"],
            "volume": round(snap["volume"] * 100),
            "muted": snap["muted"],
        }

    def companion_song(self) -> dict[str, Any]:
        return self._song_payload()

    def companion_queue(self) -> dict[str, Any]:
        with self._lock:
            return {"items": list(self.queue_items)}

    def companion_volume(self) -> dict[str, Any]:
        with self._lock:
            return {"state": round(self.volume * 100), "isMuted": self.muted}

    def set_volume(self, volume: float) -> None:
        with self._lock:
            self.volume = max(0.0, min(1.0, volume))
        self._notify()
