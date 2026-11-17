"""Wspólna konfiguracja testów: pakiet aplikacji i ścieżki do danych testowych."""

import sys
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
APP_DIR = TESTS_DIR.parent / "biblioteczka" / "app"
FIXTURES_DIR = TESTS_DIR / "fixtures"
VECTORS_DIR = TESTS_DIR / "vectors"

if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))
