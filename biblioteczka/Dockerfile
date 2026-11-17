# Obraz aplikacji Biblioteczka dla Home Assistant OS.
# Supervisor buduje go na urządzeniu (BuildKit) i nie przekazuje już BUILD_FROM,
# dlatego obraz bazowy ma wartość domyślną (build.yaml jest przestarzały).
ARG BUILD_FROM=ghcr.io/home-assistant/base:3.24
# hadolint ignore=DL3006
FROM ${BUILD_FROM}

# Pakiety Alpine 3.24: Python 3.14, aiohttp 3.13, Pillow 12, zxing-cpp 2.3
# (dekodowanie kodów kreskowych po stronie serwera). Bez pip i bez kompilacji.
# hadolint ignore=DL3018
RUN apk add --no-cache \
        python3 \
        py3-aiohttp \
        py3-pillow \
        py3-zxing-cpp

# Wersja z config.yaml (Supervisor przekazuje ją jako BUILD_VERSION) – serwer pokazuje ją
# i używa w kluczu pamięci podręcznej przeglądarki. Domyślna wartość = `version` z config.yaml.
# Dopiero po pakietach, żeby zmiana wersji nie unieważniała warstwy z `apk add`.
ARG BUILD_VERSION=0.1.0
ENV PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    BIBLIOTECZKA_VERSION=${BUILD_VERSION}

COPY run.sh /run.sh
COPY app /app

# Porządki po kopiowaniu przez Samba/SSH (pliki ._* i .DS_Store z macOS,
# lokalne __pycache__, końce linii CRLF), bit wykonywalności i prekompilacja.
RUN tr -d '\r' < /run.sh > /run.sh.lf \
    && mv /run.sh.lf /run.sh \
    && chmod 0755 /run.sh \
    && find /app -depth \( -name '__pycache__' -o -name '.DS_Store' -o -name '._*' \) -exec rm -rf {} \; \
    && python3 -m compileall -q /app/biblioteczka

WORKDIR /app

# Bez HEALTHCHECK: Supervisor czekałby z oznaczeniem aplikacji jako uruchomionej do
# pierwszego testu Dockera. Zawieszenie wykrywa watchdog z config.yaml (/healthz).
CMD [ "/run.sh" ]

# BUILD_VERSION jest zadeklarowany wyżej (w tym samym etapie), więc etykiety też go widzą.
ARG BUILD_ARCH=amd64
LABEL \
    io.hass.name="Biblioteczka" \
    io.hass.description="Wspólna domowa biblioteczka – książki, serie, autorzy i brakujące tomy" \
    io.hass.type="app" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.version="${BUILD_VERSION}" \
    org.opencontainers.image.title="Home Assistant App: Biblioteczka" \
    org.opencontainers.image.description="Wspólna domowa biblioteczka – książki, serie, autorzy i brakujące tomy" \
    org.opencontainers.image.source="https://github.com/Krzychurychu3/biblioteczka-ha" \
    org.opencontainers.image.version="${BUILD_VERSION}"
