"""Biblioteczka – domowa biblioteczka dla Home Assistant OS."""

import os
from typing import Optional

# Musi być równa `version` z config.yaml i `ARG BUILD_VERSION` z Dockerfile (pilnuje tego
# tests/test_packaging.py). Używana poza kontenerem: tools/dev.sh, testy, `docker build` bez argumentów.
_DEFAULT_VERSION = "0.1.0"


def _resolve_version(value: Optional[str]) -> str:
    """Wersja ze zmiennej środowiskowej (bez białych znaków) albo wartość domyślna, gdy jej brak."""
    version = (value or "").strip()
    return version or _DEFAULT_VERSION


# W kontenerze wersja pochodzi z config.yaml: Supervisor przekazuje ją przy budowaniu obrazu
# jako BUILD_VERSION, a Dockerfile zapisuje ją w zmiennej BIBLIOTECZKA_VERSION.
__version__ = _resolve_version(os.environ.get("BIBLIOTECZKA_VERSION"))
