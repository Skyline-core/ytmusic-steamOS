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
    _last_api_song_sig: str = field(default="", repr=False)
    _last_api_queue_sig: str = field(default="", repr=False)
    # Tras POST /shuffle|/switch-repeat evita que un scrape erróneo revierta el WS.
    _sticky_shuffle_until: float = field(default=0.0, repr=False)
    _sticky_shuffle_set_at: float = field(default=0.0, repr=False)
    _sticky_loop_until: float = field(default=0.0, repr=False)
    _sticky_loop_set_at: float = field(default=0.0, repr=False)

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

    def _emit_api(self, event_type: str, payload: dict[str, Any]) -> None:
        for callback in list(self._api_listeners):
            try:
                callback(event_type, payload)
            except Exception:
                pass

    def build_player_info_event(self) -> tuple[str, dict[str, Any]]:
        snap = self.snapshot()
        return "PLAYER_INFO", self._player_info_payload(snap)

    def update_from_web(self, payload: dict[str, Any]) -> None:
        prev = self.snapshot()
        now = time.monotonic()
        with self._lock:
            self.metadata = TrackMetadata(
                title=payload.get("title", "") or "",
                artist=payload.get("artist", "") or "",
                album=payload.get("album", "") or "",
                art_url=payload.get("artUrl", "") or "",
                track_id=payload.get("trackId", "") or "",
                video_id=payload.get("videoId", "") or "",
                length_us=int(payload.get("lengthUs", 0) or 0),
            )
            self.playback_status = payload.get("playbackStatus", "Stopped")
            self.position_us = int(payload.get("positionUs", 0) or 0)
            self.position_monotonic = time.monotonic()
            self.volume = float(payload.get("volume", self.volume))
            self.muted = bool(payload.get("muted", False))
            self.can_play = bool(payload.get("canPlay", False))
            self.can_pause = bool(payload.get("canPause", False))
            self.can_go_next = bool(payload.get("canGoNext", False))
            self.can_go_previous = bool(payload.get("canGoPrevious", False))
            self.can_seek = bool(payload.get("canSeek", False))

            web_shuffle = payload.get("shuffle", None)
            if web_shuffle is None:
                pass  # scrape desconocido: conservar sticky/estado
            elif now < self._sticky_shuffle_until:
                if bool(web_shuffle) == self.shuffle:
                    self._sticky_shuffle_until = 0.0
                elif now - self._sticky_shuffle_set_at < 1.0:
                    # Primer segundo: proteger optimistic API frente a scrapes malos.
                    pass
                else:
                    # DOM definitivo (tocaste el reproductor): confiar y avisar a Decky.
                    self.shuffle = bool(web_shuffle)
                    self._sticky_shuffle_until = 0.0
            else:
                self.shuffle = bool(web_shuffle)

            web_loop = payload.get("loopStatus", None)
            if web_loop is None:
                pass
            elif web_loop not in ("None", "Track", "Playlist"):
                pass
            elif now < self._sticky_loop_until:
                if web_loop == self.loop_status:
                    self._sticky_loop_until = 0.0
                elif now - self._sticky_loop_set_at < 1.0:
                    pass
                else:
                    self.loop_status = web_loop
                    self._sticky_loop_until = 0.0
            else:
                self.loop_status = web_loop

            queue = payload.get("queue")
            if isinstance(queue, list):
                self.queue_items = queue
        self._notify_api_deltas(prev)
        self._notify()

    def set_playback_status(self, status: str, *, emit: bool = True) -> None:
        prev = self.snapshot()
        with self._lock:
            self.playback_status = status
            self.position_monotonic = time.monotonic()
        if emit:
            self._notify_api_deltas(prev)
            self._notify()

    def _song_signature(self, snap: dict[str, Any]) -> str:
        meta = snap["metadata"]
        return "|".join(
            [
                meta.video_id or "",
                meta.track_id or "",
                meta.title or "",
                meta.artist or "",
                meta.art_url or "",
                snap["playback_status"],
            ]
        )

    def _queue_signature(self, items: list[dict[str, Any]] | None = None) -> str:
        if items is None:
            with self._lock:
                items = list(self.queue_items)
        parts: list[str] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            renderer = item.get("playlistPanelVideoRenderer")
            if not isinstance(renderer, dict):
                wrap = item.get("playlistPanelVideoWrapperRenderer")
                if isinstance(wrap, dict):
                    primary = wrap.get("primaryRenderer")
                    if isinstance(primary, dict):
                        renderer = primary.get("playlistPanelVideoRenderer")
            if not isinstance(renderer, dict):
                continue
            vid = str(renderer.get("videoId") or "")
            title = ""
            runs = (renderer.get("title") or {}).get("runs") or []
            if runs:
                title = str(runs[0].get("text") or "")
            parts.append(f"{vid}:{title}")
        return "|".join(parts)

    def _notify_api_deltas(self, prev: dict[str, Any]) -> None:
        if not self._api_listeners:
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

        if abs(snap["position_us"] - prev.get("position_us", 0)) > 750_000:
            events.append(
                (
                    "POSITION_CHANGED",
                    {"position": snap["position_us"] // 1_000_000},
                )
            )

        if (
            abs(snap["volume"] - float(prev.get("volume", 0))) > 0.005
            or snap["muted"] != prev.get("muted")
        ):
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

        # Decky solo rellena título/carátula desde PLAYER_INFO / VIDEO_CHANGED.
        song_sig = self._song_signature(snap)
        if song_sig != self._last_api_song_sig and (meta.title or meta.art_url):
            self._last_api_song_sig = song_sig
            events.append(("PLAYER_INFO", self._player_info_payload(snap)))

        queue_sig = self._queue_signature(snap.get("queue_items"))
        if queue_sig != self._last_api_queue_sig:
            self._last_api_queue_sig = queue_sig
            events.append(("QUEUE_CHANGED", self.companion_queue()))

        for event_type, payload in events:
            self._emit_api(event_type, payload)

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
        art = meta.art_url or ""
        # Formato compatible con decky-youtube-music / th-ch API Server.
        return {
            "title": meta.title or "",
            "artist": meta.artist or "",
            "album": meta.album or "",
            "albumArt": art,
            "imageSrc": art,
            "videoId": meta.video_id or "",
            "isPaused": snap["playback_status"] != "Playing",
            "elapsedSeconds": position_s,
            "songDuration": duration_s,
        }

    def _player_info_payload(self, snap: dict[str, Any] | None = None) -> dict[str, Any]:
        if snap is None:
            snap = self.snapshot()
        payload = {
            "isPlaying": snap["playback_status"] == "Playing",
            "position": snap["position_us"] // 1_000_000,
            "repeat": self._map_repeat(snap["loop_status"]),
            "shuffle": snap["shuffle"],
            "volume": round(snap["volume"] * 100),
            "muted": snap["muted"],
        }
        meta = snap["metadata"]
        # No mandar song vacío: Decky sobrescribe y deja "Nothing playing".
        if meta.title or meta.art_url or meta.video_id:
            payload["song"] = self._song_payload(snap)
        return payload

    def companion_song(self) -> dict[str, Any]:
        return self._song_payload()

    def _current_queue_item(self) -> dict[str, Any] | None:
        meta = self.metadata
        if not meta.title and not meta.video_id:
            return None
        art = meta.art_url or ""
        return {
            "playlistPanelVideoRenderer": {
                "title": {"runs": [{"text": meta.title or "Playing"}]},
                "shortBylineText": {"runs": [{"text": meta.artist or ""}]},
                "thumbnail": {"thumbnails": [{"url": art}] if art else []},
                "videoId": meta.video_id or "",
                "selected": True,
            }
        }

    def companion_queue(self) -> dict[str, Any]:
        with self._lock:
            items = list(self.queue_items)
            playing_id = str(self.metadata.video_id or "")

        if items:
            filled = []
            seen_ids: set[str] = set()

            for item in items:
                if not isinstance(item, dict):
                    continue

                renderer = item.get("playlistPanelVideoRenderer")
                if not isinstance(renderer, dict):
                    wrap = item.get("playlistPanelVideoWrapperRenderer")
                    if isinstance(wrap, dict):
                        primary = wrap.get("primaryRenderer")
                        if isinstance(primary, dict):
                            renderer = primary.get("playlistPanelVideoRenderer")
                            if not isinstance(renderer, dict):
                                for value in primary.values():
                                    if isinstance(value, dict) and (
                                        value.get("title") or value.get("videoId")
                                    ):
                                        renderer = value
                                        break

                if not isinstance(renderer, dict):
                    continue

                title = ""
                runs = (renderer.get("title") or {}).get("runs") or []
                if runs:
                    title = str(runs[0].get("text") or "")
                if not title.strip():
                    simple = (renderer.get("title") or {}).get("simpleText")
                    if simple:
                        title = str(simple)
                if not title.strip():
                    continue

                video_id = str(renderer.get("videoId") or "")
                if video_id:
                    if video_id in seen_ids:
                        continue
                    seen_ids.add(video_id)

                # Normalizar a forma plana que Decky ya pinta.
                out = {
                    "playlistPanelVideoRenderer": {
                        "title": {"runs": [{"text": title}]},
                        "shortBylineText": renderer.get("shortBylineText")
                        or {"runs": [{"text": ""}]},
                        "thumbnail": renderer.get("thumbnail") or {"thumbnails": []},
                        "videoId": video_id,
                        "selected": bool(playing_id and video_id == playing_id)
                        if playing_id
                        else bool(renderer.get("selected")),
                    }
                }
                length = renderer.get("lengthText")
                if length:
                    out["playlistPanelVideoRenderer"]["lengthText"] = length
                filled.append(out)

            if playing_id and filled:
                any_sel = False
                for item in filled:
                    renderer = item["playlistPanelVideoRenderer"]
                    if renderer.get("selected"):
                        if any_sel:
                            renderer["selected"] = False
                        else:
                            any_sel = True

            if filled:
                return {"items": filled}

        fallback = self._current_queue_item()
        return {"items": [fallback] if fallback else []}

    def companion_volume(self) -> dict[str, Any]:
        with self._lock:
            return {"state": round(self.volume * 100), "isMuted": self.muted}

    def set_shuffle(self, shuffle: bool, *, emit: bool = True) -> None:
        prev = self.snapshot()
        now = time.monotonic()
        with self._lock:
            self.shuffle = bool(shuffle)
            self._sticky_shuffle_set_at = now
            self._sticky_shuffle_until = now + 12.0
        if emit:
            self._notify_api_deltas(prev)
            self._notify()

    def set_loop_status(self, loop_status: str, *, emit: bool = True) -> None:
        prev = self.snapshot()
        now = time.monotonic()
        with self._lock:
            self.loop_status = loop_status
            self._sticky_loop_set_at = now
            self._sticky_loop_until = now + 12.0
        if emit:
            self._notify_api_deltas(prev)
            self._notify()

    def set_position_seconds(self, seconds: float, *, emit: bool = True) -> None:
        prev = self.snapshot()
        with self._lock:
            self.position_us = max(0, int(float(seconds) * 1_000_000))
            self.position_monotonic = time.monotonic()
        if emit:
            self._notify_api_deltas(prev)
            self._notify()

    def set_volume(self, volume: float) -> None:
        prev = self.snapshot()
        with self._lock:
            self.volume = max(0.0, min(1.0, volume))
        self._notify_api_deltas(prev)
        self._notify()
