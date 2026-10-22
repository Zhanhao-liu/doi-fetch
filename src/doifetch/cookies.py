"""Read cookies straight out of the user's own Chrome / Edge profile.

This sidesteps SSO automation entirely: log in once in the browser you already
use, then let the tool copy the gateway cookie out of Chrome's SQLite store.

On Windows Chrome encrypts cookie values with a key that is itself wrapped in
DPAPI (per-user, no password prompt), so decryption works in-process.
"""

from __future__ import annotations

import base64
import ctypes
import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
from ctypes import wintypes
from pathlib import Path

from .config import temp_dir

# Chrome's newer "App-Bound Encryption" prefix; not decryptable offline.
_APP_BOUND_PREFIX = b"v20"
_AES_PREFIXES = (b"v10", b"v11")


class CookieReadError(RuntimeError):
    """Raised when a browser store exists but cannot be decrypted."""


# --- DPAPI -----------------------------------------------------------------


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _dpapi_unprotect(blob: bytes) -> bytes:
    if not blob:
        raise CookieReadError("empty DPAPI blob")

    buffer_in = ctypes.create_string_buffer(blob, len(blob))
    blob_in = _DataBlob(len(blob), ctypes.cast(buffer_in, ctypes.POINTER(ctypes.c_char)))
    blob_out = _DataBlob()

    ok = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
    )
    if not ok:
        raise CookieReadError("CryptUnprotectData failed (different Windows user?)")

    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)


def _chrome_master_key(user_data_dir: Path) -> bytes:
    state_file = user_data_dir / "Local State"
    if not state_file.exists():
        raise CookieReadError(f"no Local State at {state_file}")

    try:
        state = json.loads(state_file.read_text(encoding="utf-8"))
        wrapped = base64.b64decode(state["os_crypt"]["encrypted_key"])
    except (OSError, ValueError, KeyError) as exc:
        raise CookieReadError(f"cannot read Chrome encryption key: {exc}") from exc

    if wrapped.startswith(b"DPAPI"):
        wrapped = wrapped[5:]
    return _dpapi_unprotect(wrapped)


def _decrypt_value(blob: bytes, key: bytes) -> str:
    if blob.startswith(_AES_PREFIXES):
        try:
            from Crypto.Cipher import AES
        except ImportError as exc:  # pragma: no cover
            raise CookieReadError(
                "reading Chrome cookies needs pycryptodome: "
                "pip install 'doi-fetch[webvpn]'"
            ) from exc

        nonce, payload = blob[3:15], blob[15:]
        if len(payload) <= 16:
            raise CookieReadError("cookie payload too short")
        cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
        plain = cipher.decrypt_and_verify(payload[:-16], payload[-16:])
        return plain.decode("utf-8", "replace")

    if blob.startswith(_APP_BOUND_PREFIX):
        raise CookieReadError(
            "Chrome uses app-bound cookie encryption (v20); "
            "use the manual Cookie paste instead"
        )

    return _dpapi_unprotect(blob).decode("utf-8", "replace")


# --- profile discovery -----------------------------------------------------


def _user_data_dirs() -> list[Path]:
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        return []
    base = Path(local)
    candidates = [
        base / "Google" / "Chrome" / "User Data",
        base / "Google" / "Chrome Beta" / "User Data",
        base / "Google" / "Chrome Dev" / "User Data",
        base / "Microsoft" / "Edge" / "User Data",
        base / "BraveSoftware" / "Brave-Browser" / "User Data",
    ]
    return [path for path in candidates if path.exists()]


def _cookie_dbs(user_data_dir: Path) -> list[Path]:
    found: list[Path] = []
    try:
        profiles = sorted(user_data_dir.iterdir())
    except OSError:
        return found

    for profile in profiles:
        if not profile.is_dir():
            continue
        name = profile.name
        if name not in ("Default", "Guest Profile") and not name.startswith("Profile"):
            continue
        for relative in ("Network/Cookies", "Cookies"):
            db = profile / relative
            if db.exists():
                found.append(db)
                break
    return found


def _read_rows(db_path: Path, sql: str, params: tuple) -> list[tuple]:
    """Query a copy of the DB: Chrome keeps a lock on the live file."""
    work = temp_dir() / "cookie-copy"
    work.mkdir(parents=True, exist_ok=True)
    digest = hashlib.md5(str(db_path).encode("utf-8")).hexdigest()[:12]
    copy = work / f"{digest}.db"

    try:
        shutil.copyfile(db_path, copy)
    except OSError as exc:
        # winerror 32 = sharing violation: Chrome has the DB open right now
        if getattr(exc, "winerror", None) in (32, 33) or isinstance(exc, PermissionError):
            raise CookieReadError(
                "浏览器正在运行，cookie 数据库被占用。请完全退出该浏览器后重试，"
                "或改用「手工 Cookie」粘贴。"
            ) from exc
        raise CookieReadError(f"cannot copy {db_path}: {exc}") from exc
    # WAL holds recent writes; copy it alongside if present
    for suffix in ("-wal", "-shm"):
        sidecar = db_path.with_name(db_path.name + suffix)
        if sidecar.exists():
            try:
                shutil.copyfile(sidecar, copy.with_name(copy.name + suffix))
            except OSError:
                pass

    try:
        connection = sqlite3.connect(f"{copy.as_uri()}?mode=ro", uri=True)
        try:
            return connection.execute(sql, params).fetchall()
        finally:
            connection.close()
    except sqlite3.DatabaseError as exc:
        raise CookieReadError(f"cannot read {db_path}: {exc}") from exc


def chrome_cookies(
    host_contains: str = "ustc.edu.cn",
    *,
    name_prefixes: tuple[str, ...] = ("wengine_vpn_ticket", "route"),
    max_profiles: int = 8,
) -> dict[str, str]:
    """Return decrypted cookies for hosts matching ``host_contains``.

    Later profiles do not overwrite earlier values, so the first hit wins.
    """
    if os.name != "nt":
        raise CookieReadError("reading the browser cookie store is Windows-only")

    collected: dict[str, str] = {}
    seen_error: str = ""

    for user_data in _user_data_dirs():
        try:
            key = _chrome_master_key(user_data)
        except CookieReadError as exc:
            seen_error = str(exc)
            continue

        for db_path in _cookie_dbs(user_data)[:max_profiles]:
            try:
                rows = _read_rows(
                    db_path,
                    "SELECT host_key, name, encrypted_value FROM cookies "
                    "WHERE host_key LIKE ?",
                    (f"%{host_contains}%",),
                )
            except CookieReadError as exc:
                seen_error = str(exc)
                continue

            for host_key, name, blob in rows:
                if name_prefixes and not name.startswith(name_prefixes):
                    continue
                if name in collected:
                    continue
                try:
                    collected[name] = _decrypt_value(blob, key)
                except CookieReadError as exc:
                    seen_error = str(exc)
                except Exception:
                    continue

        if collected:
            return collected

    if not collected and not seen_error:
        seen_error = f"no gateway cookie found for {host_contains}"
    if not collected:
        raise CookieReadError(seen_error)
    return collected


def gateway_cookie_from_chrome(host: str) -> dict[str, str]:
    """Convenience wrapper keyed by the gateway host."""
    domain = host.split("://")[-1].rstrip("/")
    return chrome_cookies(domain)
