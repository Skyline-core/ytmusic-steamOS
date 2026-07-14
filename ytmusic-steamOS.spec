# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec — empaquetar ytmusic-steamOS con PySide6 WebEngine."""

import glob
import os
import sys
import sysconfig

from PyInstaller.utils.hooks import collect_all

ROOT = os.path.abspath(SPECPATH)

block_cipher = None

datas = [
    (os.path.join(ROOT, "ytmusic_decky", "inject", "deck.css"), "ytmusic_decky/inject"),
    (os.path.join(ROOT, "ytmusic_decky", "inject", "bridge.js"), "ytmusic_decky/inject"),
]
binaries = []

_libpython_candidates = []
_libdir = sysconfig.get_config_var("LIBDIR")
if _libdir:
    _libpython_candidates.extend(glob.glob(os.path.join(_libdir, "libpython*.so*")))
for _base in (sys.base_prefix, sys.prefix):
    _libpython_candidates.extend(glob.glob(os.path.join(_base, "lib", "libpython*.so*")))

_seen = set()
for _path in _libpython_candidates:
    _real = os.path.realpath(_path)
    if _real in _seen or not os.path.isfile(_real):
        continue
    _seen.add(_real)
    binaries.append((_real, "."))
    break

hiddenimports = [
    "ytmusic_decky",
    "ytmusic_decky.__main__",
    "ytmusic_decky.app",
    "ytmusic_decky.player_state",
    "ytmusic_decky.web.window",
    "ytmusic_decky.web.injector",
    "ytmusic_decky.web.profile",
    "ytmusic_decky.mpris.server",
    "ytmusic_decky.api",
    "ytmusic_decky.api.server",
    "ytmusic_decky.api.command_bus",
    "aiohttp",
    "aiohttp.web",
    "aiohttp.web_runner",
    "aiohttp.http_parser",
    "aiohttp.http_writer",
    "aiohttp.helpers",
    "aiohttp.client",
    "aiohttp.connector",
    "multidict",
    "yarl",
    "frozenlist",
    "aiosignal",
    "aiohappyeyeballs",
    "propcache",
    "dbus",
    "dbus.mainloop",
    "gi",
    "gi.repository",
    "gi.repository.GLib",
]

for pkg in ("PySide6", "shiboken6", "aiohttp", "multidict", "yarl", "frozenlist", "aiosignal"):
    tmp_ret = collect_all(pkg)
    datas += tmp_ret[0]
    binaries += tmp_ret[1]
    hiddenimports += tmp_ret[2]

a = Analysis(
    [os.path.join(ROOT, "ytmusic_decky", "__main__.py")],
    pathex=[ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[os.path.join(ROOT, "packaging", "pyi_rth_ytmusic_gl.py")],
    excludes=["PySide6.scripts"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="ytmusic-steamOS",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="ytmusic-steamOS",
)
