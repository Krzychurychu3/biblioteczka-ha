#!/usr/bin/env bash
# Uruchamia Biblioteczkę lokalnie w trybie deweloperskim (bez Home Assistanta).
#
# Użycie: tools/dev.sh [--sample-data] [--host ADRES] [--port PORT] [--data KATALOG]
#   --sample-data   wczytuje przykładowe dane przy starcie (tylko do testów)
#   --host ADRES    adres nasłuchu (domyślnie 127.0.0.1; 0.0.0.0 = dostęp z innych urządzeń w sieci)
#   --port PORT     port (domyślnie 8099)
#   --data KATALOG  katalog danych (domyślnie devdata/ w katalogu repozytorium; ścieżka względna – od bieżącego katalogu)
#
# Domyślnie dane trafiają do devdata/ w katalogu repozytorium (katalog jest w .gitignore).
# Tryb deweloperski wyłącza ograniczenie dostępu do adresu proxy Ingress, więc
# nie wystawiaj go poza zaufaną sieć.

set -euo pipefail

HA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="$HA_DIR/.venv/bin/python"

usage() {
  sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

host="127.0.0.1"
port="8099"
data="$HA_DIR/devdata"
extra=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sample-data) extra+=("--sample-data"); shift ;;
    --host)
      [[ $# -ge 2 ]] || { echo "dev.sh: brak wartości dla --host" >&2; exit 2; }
      host="$2"; shift 2 ;;
    --port)
      [[ $# -ge 2 && "$2" =~ ^[0-9]+$ ]] || { echo "dev.sh: --port wymaga liczby" >&2; exit 2; }
      port="$2"; shift 2 ;;
    --data)
      [[ $# -ge 2 && -n "$2" ]] || { echo "dev.sh: brak wartości dla --data" >&2; exit 2; }
      # Ścieżka względna liczy się od katalogu, z którego uruchomiono skrypt (niżej jest `cd`).
      case "$2" in
        /*) data="$2" ;;
        *) data="$PWD/$2" ;;
      esac
      shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "dev.sh: nieznana opcja: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ! -x "$PYTHON" ]]; then
  cat >&2 << 'EOF'
dev.sh: brak środowiska .venv w katalogu głównym repozytorium. Utwórz je tam poleceniami:
  python3 -m venv .venv && .venv/bin/python -m pip install -r requirements-dev.txt
EOF
  exit 1
fi

mkdir -p "$data"
data="$(cd "$data" && pwd)"
cd "$HA_DIR"
export PYTHONPATH="$HA_DIR/biblioteczka/app${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONUNBUFFERED=1

echo "Biblioteczka (tryb deweloperski): http://$host:$port/  – dane: $data"
# "${extra[@]+...}" – bash 3.2 (macOS) traktuje pustą tablicę jako niezdefiniowaną przy set -u.
exec "$PYTHON" -m biblioteczka --data "$data" --host "$host" --port "$port" --dev ${extra[@]+"${extra[@]}"}
