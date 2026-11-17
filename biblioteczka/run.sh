#!/command/with-contenv bashio
# shellcheck shell=bash
# Uruchamia serwer Biblioteczki: dane w /data, port Ingress 8099.
# bashio służy tu wyłącznie do logowania – aplikacja nie ma opcji konfiguracji.

bashio::log.info "Uruchamianie Biblioteczki…"

cd /app || bashio::exit.nok "Brak katalogu /app – obraz jest uszkodzony."

exec python3 -m biblioteczka --data /data --host 0.0.0.0 --port 8099
