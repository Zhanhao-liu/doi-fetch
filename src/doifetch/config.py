"""Local config + state paths, with graceful fallbacks.

The default lives in the user profile, but locked-down machines (or sandboxed
runners) may refuse writes there. Every path helper therefore probes for a
writable location instead of assuming one.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

_PACKAGE_ROOT = Path(__file__).resolve().parents[2]


def _writable(candidate: Path) -> bool:
    try:
        candidate.mkdir(parents=True, exist_ok=True)
        probe = candidate / ".write-probe"
        probe.write_text("", encoding="utf-8")
        probe.unlink()
        return True
    except OSError:
        return False


def first_writable(candidates: list[Path]) -> Path:
    for candidate in candidates:
        if _writable(candidate):
            return candidate
    return candidates[-1]


def _config_candidates() -> list[Path]:
    env = os.environ.get("DOIFETCH_HOME")
    if env:
        return [Path(env).expanduser()]

    home = Path.home()
    options = [home / ".doifetch"]
    local = os.environ.get("LOCALAPPDATA")
    if local:
        options.append(Path(local) / "doi-fetch")
    options.append(_PACKAGE_ROOT / "_data")
    return options


CONFIG_DIR: Path = first_writable(_config_candidates())
CONFIG_PATH: Path = CONFIG_DIR / "config.json"
STATE_PATH: Path = CONFIG_DIR / "state.json"  # Playwright storage / cookie jar
PROFILE_DIR: Path = CONFIG_DIR / "chrome-profile"

# Unpaywall requires a contact address. Override with UNPAYWALL_EMAIL or config.
DEFAULT_EMAIL = "doi-fetch@users.noreply.github.com"


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def config_path() -> Path:
    return CONFIG_PATH


def load_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_config(data: dict) -> bool:
    """Persist settings; never raise just because the disk said no."""
    try:
        ensure_dir(CONFIG_DIR)
        CONFIG_PATH.write_text(
            json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        return True
    except OSError:
        return False


def set_value(key: str, value: str) -> None:
    cfg = load_config()
    cfg[key] = value
    save_config(cfg)


def contact_email() -> str:
    return os.environ.get("UNPAYWALL_EMAIL") or load_config().get("email") or DEFAULT_EMAIL


def default_out_dir() -> Path:
    """Where papers land when the user has not chosen a directory."""
    raw = os.environ.get("DOIFETCH_OUT") or load_config().get("out_dir")
    if raw:
        return Path(raw).expanduser()

    home = Path.home()
    candidates = [home / "doifetch-papers"]
    documents = home / "Documents"
    if _writable(documents):
        candidates.append(documents / "doi-fetch-papers")
    candidates.append(_PACKAGE_ROOT / "papers")
    return first_writable(candidates)


def proxy_url() -> str | None:
    return os.environ.get("DOIFETCH_PROXY") or load_config().get("proxy") or None


def max_si_mb() -> int:
    """Cap for a single SI file.

    Science occasionally ships a 100 MB+ replication package; pulling that on a
    single click turns a 20-second job into a 10-minute one. 0 means no cap.
    """
    raw = os.environ.get("DOIFETCH_MAX_SI_MB") or load_config().get("max_si_mb")
    try:
        return max(0, int(raw)) if raw is not None else 80
    except (TypeError, ValueError):
        return 80


def si_timeout_s() -> float:
    """Total budget for the SI phase, so one slow mirror cannot hang a click."""
    raw = os.environ.get("DOIFETCH_SI_TIMEOUT") or load_config().get("si_timeout_s")
    try:
        return max(10.0, float(raw)) if raw is not None else 120.0
    except (TypeError, ValueError):
        return 120.0


def temp_dir() -> Path:
    """A temp directory that actually accepts writes.

    Playwright's driver calls mkdtemp without a fallback: if %TEMP% is unusable
    it dies with EPERM instead of degrading like Python's tempfile does.
    """
    return first_writable([CONFIG_DIR / "tmp", _PACKAGE_ROOT / "_data" / "tmp"])
