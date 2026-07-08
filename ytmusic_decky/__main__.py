"""Punto de entrada de la aplicación."""

from __future__ import annotations

import argparse
import logging
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="YouTube Music para Steam Deck con MPRIS y UI táctil"
    )
    parser.add_argument(
        "--windowed",
        action="store_true",
        help="Abrir en ventana en lugar de pantalla completa",
    )
    parser.add_argument(
        "--no-mpris",
        action="store_true",
        help="Desactivar servidor MPRIS (útil para depurar)",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Logs de depuración",
    )
    args = parser.parse_args(argv)

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Importar Qt solo tras parsear args (--help no debe cargar WebEngine).
    from ytmusic_decky.app import run

    return run(fullscreen=not args.windowed, enable_mpris=not args.no_mpris)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
