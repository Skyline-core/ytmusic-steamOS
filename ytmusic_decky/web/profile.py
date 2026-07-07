"""Perfil Qt WebEngine persistente para la sesión de YouTube Music."""

from __future__ import annotations

import logging
import os
import stat
from pathlib import Path

from PySide6.QtCore import QStandardPaths
from PySide6.QtWebEngineCore import QWebEngineProfile, QWebEngineSettings

logger = logging.getLogger(__name__)

PROFILE_NAME = "ytmusic-decky"


def _secure_dir(path: Path) -> None:
    """Restringe el directorio al usuario actual (Unix)."""
    path.mkdir(parents=True, exist_ok=True)
    if os.name != "posix":
        return
    try:
        os.chmod(path, stat.S_IRWXU)
    except OSError as exc:
        logger.debug("No se pudo aplicar chmod en %s: %s", path, exc)


def profile_data_root() -> Path:
    base = Path(QStandardPaths.writableLocation(QStandardPaths.StandardLocation.AppDataLocation))
    root = base / "session"
    _secure_dir(root)
    return root


def create_deck_profile(parent=None) -> QWebEngineProfile:
    """Perfil nombrado con cookies y almacenamiento en disco (no defaultProfile)."""
    root = profile_data_root()
    storage = root / "storage"
    cache = root / "cache"
    _secure_dir(storage)
    _secure_dir(cache)

    profile = QWebEngineProfile(PROFILE_NAME, parent)
    profile.setPersistentStoragePath(str(storage))
    profile.setCachePath(str(cache))
    profile.setPersistentCookiesPolicy(
        QWebEngineProfile.PersistentCookiesPolicy.ForcePersistentCookies
    )
    profile.setPersistentPermissionsPolicy(
        QWebEngineProfile.PersistentPermissionsPolicy.StoreOnDisk
    )
    profile.setHttpCacheType(QWebEngineProfile.HttpCacheType.DiskHttpCache)
    profile.setHttpCacheMaximumSize(256 * 1024 * 1024)

    settings = profile.settings()
    settings.setAttribute(QWebEngineSettings.WebAttribute.JavascriptEnabled, True)
    settings.setAttribute(QWebEngineSettings.WebAttribute.LocalStorageEnabled, True)
    settings.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessRemoteUrls, True)
    settings.setAttribute(QWebEngineSettings.WebAttribute.PlaybackRequiresUserGesture, False)
    settings.setAttribute(QWebEngineSettings.WebAttribute.FullScreenSupportEnabled, True)

    logger.info("Perfil WebEngine: almacenamiento en %s", root)
    return profile
