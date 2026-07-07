"""Genera un icono PNG simple para la AppImage (sin dependencias extra)."""

from __future__ import annotations

import struct
import sys
import zlib


def _chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def write_icon(path: str, size: int = 256) -> None:
    # Fondo ámbar oscuro + nota musical simplificada (rectángulos)
    pixels = bytearray()
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            cx, cy = size // 2, size // 2
            dx, dy = abs(x - cx), abs(y - cy)
            # círculo exterior
            if (x - cx) ** 2 + (y - cy) ** 2 <= (size * 0.46) ** 2:
                r, g, b = 168, 118, 72
                # cabeza de nota
                if (x - cx * 0.82) ** 2 + (y - cy * 1.05) ** 2 <= (size * 0.11) ** 2:
                    r, g, b = 245, 236, 220
                # asta
                elif cx * 0.72 <= x <= cx * 1.05 and cy * 0.55 <= y <= cy * 1.35:
                    r, g, b = 245, 236, 220
                # banda central
                elif dx < size * 0.08 and dy < size * 0.34:
                    r, g, b = 120, 82, 48
            else:
                r, g, b = 0, 0, 0
            row.extend((r, g, b, 0 if r == g == b == 0 else 255))
        pixels.extend(row)

    raw = zlib.compress(bytes(pixels), 9)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", raw) + _chunk(b"IEND", b"")

    with open(path, "wb") as fh:
        fh.write(png)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "ytmusic-decky.png"
    write_icon(out)
    print(f"icon: {out}")
