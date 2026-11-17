"""Uruchomienie serwera: `python -m biblioteczka --data DIR [--host H] [--port P] [--dev] [--sample-data]`."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path
from typing import Optional, Sequence

from aiohttp import web

from . import __version__

logger = logging.getLogger("biblioteczka")


def _port(value: str) -> int:
    try:
        port = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("port musi być liczbą") from None
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("port musi być z zakresu 1–65535")
    return port


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m biblioteczka",
        description="Serwer Biblioteczki – domowej biblioteczki dla Home Assistant OS.",
    )
    parser.add_argument("--data", required=True, type=Path, help="katalog danych (baza SQLite i okładki)")
    parser.add_argument("--host", default="0.0.0.0", help="adres nasłuchu (domyślnie 0.0.0.0)")
    parser.add_argument("--port", default=8099, type=_port, help="port (domyślnie 8099)")
    parser.add_argument(
        "--dev",
        action="store_true",
        help="tryb deweloperski: dostęp z dowolnego adresu (bez ograniczenia do proxy Ingress)",
    )
    parser.add_argument(
        "--sample-data", action="store_true", help="przykładowe dane przy starcie (tylko do pustej bazy)"
    )
    parser.add_argument("--version", action="version", version=f"Biblioteczka {__version__}")
    return parser.parse_args(argv)


def configure_logging(dev: bool) -> None:
    """Logi na standardowe wyjście (Home Assistant pokazuje je w zakładce „Dziennik”)."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s", "%Y-%m-%d %H:%M:%S"))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(logging.INFO)
    # Dziennik dostępu (każde odświeżenie stanu) tylko w trybie deweloperskim.
    logging.getLogger("aiohttp.access").setLevel(logging.INFO if dev else logging.WARNING)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    configure_logging(args.dev)

    from .server import create_app

    try:
        app = create_app(args.data, dev=args.dev, sample_data=args.sample_data)
    except Exception:
        logger.exception("Nie udało się uruchomić Biblioteczki")
        return 1

    logger.info("Serwer nasłuchuje na http://%s:%d/", args.host, args.port)
    web.run_app(
        app,
        host=args.host,
        port=args.port,
        access_log=logging.getLogger("aiohttp.access") if args.dev else None,
        shutdown_timeout=5.0,
        print=None,
        handle_signals=True,
    )
    logger.info("Biblioteczka zatrzymana")
    return 0


if __name__ == "__main__":
    sys.exit(main())
