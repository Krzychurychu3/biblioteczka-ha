#!/usr/bin/env bash
# Odtwarza pliki bibliotek JS w static/vendor z paczek npm (npm pack, bez instalacji
# i bez uruchamiania skryptów) i sprawdza ich sumy SHA-256.
#
# Użycie:
#   tools/vendor.sh          pobiera paczki i nadpisuje pliki w static/vendor
#   tools/vendor.sh --check  tylko sprawdza sumy plików już zapisanych w repozytorium
#
# Zmiana wersji biblioteki: zaktualizuj specyfikację paczki i sumę w tabeli FILES,
# uruchom skrypt, przejrzyj różnice i uzupełnij static/vendor/NOTICE.md.

set -euo pipefail

HA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="$HA_DIR/biblioteczka/app/biblioteczka/static/vendor"

# Paczka npm | plik w paczce | plik w static/vendor | SHA-256
FILES=(
  "htm@3.1.1|package/preact/standalone.module.js|preact-htm.js|72284e8e9079c87817145df1110f74e8a2aa040b2fc384922e18dfcb46fc1fd7"
  "htm@3.1.1|package/LICENSE|htm/LICENSE|740725f7252e750af735d0028cc534970772f513331e9f68150fede8fb3ce00f"
  "preact@10.5.14|package/LICENSE|preact/LICENSE|1fe6958409c8c257a70c587a18b6f7f412b179b456630790d30b2ec9a8e4b7d4"
  "barcode-detector@3.2.3|package/dist/es/ponyfill.js|barcode-detector/ponyfill.js|47c5899850108764cc762a203555c43396f25c885ae303cd543841e982a0313a"
  "barcode-detector@3.2.3|package/dist/es/zxing-exported.js|barcode-detector/zxing-exported.js|1832f3789359d15a8117dfd6b8b1d45de6c20dacd1976350f43080d57447736f"
  "barcode-detector@3.2.3|package/LICENSE|barcode-detector/LICENSE|fb506e4ade12d7a9efa67c9d76a9a28c8e15d347ca49a69e48e29b40b34ad2ab"
  "zxing-wasm@3.1.6|package/dist/reader/zxing_reader.wasm|zxing-wasm/zxing_reader.wasm|5003fb4b88c4fbd1fd518a2fd8c8ad365c519e183a08c03a322dddfea3cea84e"
  "zxing-wasm@3.1.6|package/LICENSE|zxing-wasm/LICENSE|fb506e4ade12d7a9efa67c9d76a9a28c8e15d347ca49a69e48e29b40b34ad2ab"
)

die() {
  echo "vendor.sh: $*" >&2
  exit 1
}

sha256() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum > /dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    die "brak programu sha256sum ani shasum"
  fi
}

# Sprawdza sumę pliku; zwraca 1 przy niezgodności (komunikat na stderr).
verify() {
  local file="$1" expected="$2" label="$3" actual
  [[ -f "$file" ]] || { echo "BRAK      $label" >&2; return 1; }
  actual="$(sha256 "$file")"
  if [[ "$actual" != "$expected" ]]; then
    echo "NIEZGODNA $label" >&2
    echo "          oczekiwano $expected" >&2
    echo "          jest       $actual" >&2
    return 1
  fi
  echo "OK        $label"
}

check_only() {
  local entry pkg src dest hash failed=0
  for entry in "${FILES[@]}"; do
    IFS='|' read -r pkg src dest hash <<< "$entry"
    verify "$VENDOR_DIR/$dest" "$hash" "$dest" || failed=1
  done
  [[ "$failed" -eq 0 ]] || die "pliki w static/vendor różnią się od zapisanych sum"
  echo "Wszystkie pliki w static/vendor są zgodne."
}

revendor() {
  command -v npm > /dev/null 2>&1 || die "brak npm (potrzebny Node.js)"
  command -v tar > /dev/null 2>&1 || die "brak programu tar"

  local work
  work="$(mktemp -d "${TMPDIR:-/tmp}/biblioteczka-vendor.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '$work'" EXIT

  mkdir -p "$work/packs" "$work/stage"

  # Każda paczka pobierana raz, do pustego katalogu; npm sprawdza jej integralność
  # z rejestrem, a --ignore-scripts wyklucza uruchamianie czegokolwiek z paczki.
  local entry pkg src dest hash dir
  local -a seen=() tarballs=()
  for entry in "${FILES[@]}"; do
    IFS='|' read -r pkg src dest hash <<< "$entry"
    dir="$work/packs/${pkg//[@\/]/_}"
    if [[ ! -d "$dir" ]]; then
      mkdir -p "$dir/tgz" "$dir/x"
      echo "Pobieranie $pkg…"
      (cd "$dir/tgz" && npm pack --silent --ignore-scripts --pack-destination "$dir/tgz" "$pkg" > /dev/null) \
        || die "npm pack nie pobrał paczki $pkg"
      seen+=("$pkg")
    fi
    tarballs=("$dir/tgz/"*.tgz)
    [[ ${#tarballs[@]} -eq 1 && -f "${tarballs[0]}" ]] || die "npm pack nie utworzył paczki dla $pkg"
    tar -xzf "${tarballs[0]}" -C "$dir/x" "$src" || die "w paczce $pkg nie ma pliku $src"
    mkdir -p "$(dirname "$work/stage/$dest")"
    cp "$dir/x/$src" "$work/stage/$dest"
  done

  # Najpierw weryfikacja wszystkich plików, dopiero potem zapis do repozytorium.
  local failed=0
  for entry in "${FILES[@]}"; do
    IFS='|' read -r pkg src dest hash <<< "$entry"
    verify "$work/stage/$dest" "$hash" "$dest ($pkg)" || failed=1
  done
  [[ "$failed" -eq 0 ]] || die "sumy SHA-256 się nie zgadzają – nic nie zostało zmienione"

  for entry in "${FILES[@]}"; do
    IFS='|' read -r pkg src dest hash <<< "$entry"
    mkdir -p "$(dirname "$VENDOR_DIR/$dest")"
    cp "$work/stage/$dest" "$VENDOR_DIR/$dest"
    chmod 0644 "$VENDOR_DIR/$dest"
  done
  echo "Zaktualizowano static/vendor (paczki: ${seen[*]})."
}

case "${1:-}" in
  "") revendor ;;
  --check) check_only ;;
  -h | --help)
    sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;
  *) die "nieznana opcja: $1 (dozwolone: --check, --help)" ;;
esac
