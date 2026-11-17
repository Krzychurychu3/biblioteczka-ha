"""Testy pakowania aplikacji Home Assistant: zgodność wersji, pliki obrazu i klucz plików statycznych."""

import os
import re
import subprocess
import sys

import pytest

import biblioteczka
from biblioteczka import server

from conftest import APP_DIR, TESTS_DIR

# Katalog główny repozytorium aplikacji HA (tu leży repository.yaml).
REPO_ROOT = TESTS_DIR.parent
APP_FOLDER = TESTS_DIR.parent / "biblioteczka"


def config_version() -> str:
    """`version` z config.yaml (wystarczy wyrażenie regularne – bez zależności od PyYAML)."""
    text = (APP_FOLDER / "config.yaml").read_text(encoding="utf-8")
    match = re.search(r"""^version:[ \t]*(["']?)([^"'\s#]+)\1[ \t]*(?:#.*)?$""", text, re.MULTILINE)
    assert match, "config.yaml nie ma klucza version"
    return match.group(2)


# --- Wersja: config.yaml, __init__.py i Dockerfile ---


def test_default_version_matches_config_yaml():
    assert biblioteczka._DEFAULT_VERSION == config_version()


def test_dockerfile_passes_config_version_to_the_app():
    lines = (APP_FOLDER / "Dockerfile").read_text(encoding="utf-8").splitlines()
    from_line = next(i for i, line in enumerate(lines) if line.startswith("FROM "))
    args = [(i, line) for i, line in enumerate(lines) if re.match(r"ARG\s+BUILD_VERSION\b", line)]
    assert len(args) == 1, args
    arg_line, arg = args[0]
    # ARG sprzed FROM nie byłby widoczny w etapie budowania (ani w ENV, ani w LABEL).
    assert arg_line > from_line
    assert arg.split("=", 1)[1].strip().strip("\"'") == config_version()
    env = next(i for i, line in enumerate(lines) if "BIBLIOTECZKA_VERSION=${BUILD_VERSION}" in line)
    assert env > arg_line
    labels = [i for i, line in enumerate(lines) if '"${BUILD_VERSION}"' in line]
    assert labels and min(labels) > arg_line


def test_changelog_describes_current_version():
    text = (APP_FOLDER / "CHANGELOG.md").read_text(encoding="utf-8")
    assert re.search(rf"^## {re.escape(config_version())}\s*$", text, re.MULTILINE)


@pytest.mark.parametrize(
    "value, expected",
    [
        (None, None),
        ("", None),
        ("   \n", None),
        ("0.2.0", "0.2.0"),
        (" 0.2.0\n", "0.2.0"),
    ],
)
def test_resolve_version(value, expected):
    assert biblioteczka._resolve_version(value) == (expected or biblioteczka._DEFAULT_VERSION)


@pytest.mark.parametrize("value, expected", [(" 9.8.7\n", "9.8.7"), ("  ", None)])
def test_version_comes_from_environment(tmp_path, value, expected):
    env = {**os.environ, "PYTHONPATH": str(APP_DIR), "BIBLIOTECZKA_VERSION": value}
    result = subprocess.run(
        [sys.executable, "-c", "import biblioteczka; print(biblioteczka.__version__)"],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.strip() == (expected or biblioteczka._DEFAULT_VERSION)


# --- Pliki, które czyta Supervisor ---


def test_exactly_one_app_config_in_repository():
    """Supervisor szuka `**/config.*` w całym repozytorium – każdy taki plik uznałby za aplikację."""
    if not (REPO_ROOT / "repository.yaml").is_file():
        pytest.skip("brak repository.yaml – katalog nie jest repozytorium aplikacji HA")
    found = []
    for directory, subdirs, names in os.walk(REPO_ROOT):
        subdirs[:] = [name for name in subdirs if not name.startswith(".") and name != "__pycache__"]
        found += [
            os.path.relpath(os.path.join(directory, name), REPO_ROOT)
            for name in names
            if name in ("config.yaml", "config.yml", "config.json")
        ]
    assert found == [os.path.join("biblioteczka", "config.yaml")]


def test_run_script_has_lf_endings_and_bashio_shebang():
    data = (APP_FOLDER / "run.sh").read_bytes()
    assert b"\r" not in data
    assert data.split(b"\n", 1)[0] == b"#!/command/with-contenv bashio"


# --- Klucz plików statycznych (`?v=`) ---


def _tree(root, files):
    for relative, content in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    return root


BASE_FILES = {"index.html": b"<html></html>", "js/app.js": b"export const a = 1;\n", "css/app.css": b"body {}\n"}


def test_static_tree_hash_is_deterministic(tmp_path):
    one = _tree(tmp_path / "one", BASE_FILES)
    two = _tree(tmp_path / "two", dict(reversed(list(BASE_FILES.items()))))
    assert server.static_tree_hash(one) == server.static_tree_hash(two)
    assert re.fullmatch(r"[0-9a-f]{40}", server.static_tree_hash(one))


@pytest.mark.parametrize(
    "change",
    [
        {"js/app.js": b"export const a = 2;\n"},  # zmieniona treść
        {"js/new.js": b"export {};\n"},  # nowy plik
        {"vendor/zxing-wasm/reader.wasm": b"\x00asm"},  # nowy katalog
    ],
)
def test_static_tree_hash_changes_with_files(tmp_path, change):
    before = server.static_tree_hash(_tree(tmp_path / "a", BASE_FILES))
    after = server.static_tree_hash(_tree(tmp_path / "b", {**BASE_FILES, **change}))
    assert before != after


def test_static_tree_hash_sees_renames_and_moved_bytes(tmp_path):
    base = server.static_tree_hash(_tree(tmp_path / "a", {"a.js": b"ab", "b.js": b""}))
    assert base != server.static_tree_hash(_tree(tmp_path / "b", {"a.js": b"a", "b.js": b"b"}))
    assert base != server.static_tree_hash(_tree(tmp_path / "c", {"c.js": b"ab", "b.js": b""}))


def test_static_tree_hash_ignores_hidden_files(tmp_path):
    root = _tree(tmp_path / "s", BASE_FILES)
    before = server.static_tree_hash(root)
    _tree(root, {".DS_Store": b"x", "js/._app.js": b"y", ".cache/z.js": b"z"})
    assert server.static_tree_hash(root) == before


def test_asset_key_changes_when_a_static_file_changes(tmp_path):
    root = _tree(tmp_path / "s", BASE_FILES)
    key = server.make_asset_key(root, "0.2.0")
    assert re.fullmatch(r"0\.2\.0-[0-9a-f]{10}", key)
    assert key == f"0.2.0-{server.static_tree_hash(root)[:10]}"
    (root / "css" / "app.css").write_bytes(b"body { color: red; }\n")
    assert server.make_asset_key(root, "0.2.0") != key
    assert server.make_asset_key(server.STATIC_DIR).startswith(f"{biblioteczka.__version__}-")
