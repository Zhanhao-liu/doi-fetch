"""HTTP helpers: browser-like sessions, JSON fetch, validated binary download."""

from __future__ import annotations

import hashlib
import random
import time
from dataclasses import dataclass
from typing import Any

import requests

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

HTML_ACCEPT = (
    "text/html,application/xhtml+xml,application/xml;q=0.9,"
    "image/avif,image/webp,*/*;q=0.8"
)
BINARY_ACCEPT = "application/pdf,application/octet-stream,*/*;q=0.8"

MAX_BYTES = 120 * 1024 * 1024
CHUNK = 64 * 1024

# File signatures we are willing to save. A publisher (or a login page) that
# answers 200 with HTML must never be mistaken for a document.
DOC_MAGIC: tuple[bytes, ...] = (
    b"%PDF-",
    b"PK\x03\x04",  # docx / xlsx / pptx / zip
    b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1",  # legacy doc / xls / ppt (OLE2)
    b"{\\rtf",
    b"Rar!\x1a\x07",
    b"\x1f\x8b",  # gzip
)


def is_document_bytes(content: bytes | None) -> bool:
    if not content:
        return False
    return any(content.startswith(magic) for magic in DOC_MAGIC)


class FetchError(Exception):
    """Transport-level problem (DNS, TLS, timeout...)."""


@dataclass
class Binary:
    url: str
    ok: bool
    content: bytes | None = None
    content_type: str = ""
    status_code: int = 0
    error: str = ""
    final_url: str = ""

    @property
    def is_pdf(self) -> bool:
        return bool(self.content) and self.content[:5] == b"%PDF-"

    @property
    def is_document(self) -> bool:
        """True only when the bytes really are a document, not an HTML page."""
        return self.ok and is_document_bytes(self.content)

    @property
    def size(self) -> int:
        return len(self.content) if self.content else 0

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.content).hexdigest() if self.content else ""

    def looks_html(self) -> bool:
        head = (self.content or b"")[:2_000].lstrip().lower()
        return head.startswith(b"<!doctype") or head.startswith(b"<html") or b"<head" in head


def new_session(
    *,
    cookies: dict | None = None,
    proxy: str | None = None,
    accept: str = HTML_ACCEPT,
) -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": UA,
            "Accept": accept,
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate",
            "Connection": "keep-alive",
            "Upgrade-Insecure-Requests": "1",
        }
    )
    if cookies:
        session.cookies.update(cookies)
    if proxy:
        session.proxies.update({"http": proxy, "https": proxy})
    return session


def get_json(
    session: requests.Session,
    url: str,
    *,
    params: dict | None = None,
    timeout: float = 20,
    retries: int = 2,
    headers: dict | None = None,
) -> Any | None:
    """Return parsed JSON, or None when the endpoint has nothing for us.

    Raises FetchError only when every attempt failed at the transport level.
    """
    last = ""
    for attempt in range(retries + 1):
        try:
            resp = session.get(url, params=params, timeout=timeout, headers=headers)
        except requests.RequestException as exc:
            last = f"{type(exc).__name__}: {exc}"
            time.sleep(0.8 * (attempt + 1) + random.random() * 0.4)
            continue

        if resp.status_code == 200:
            try:
                return resp.json()
            except ValueError:
                return None
        if resp.status_code == 404:
            return None
        if resp.status_code in (429, 500, 502, 503, 504):
            last = f"HTTP {resp.status_code}"
            time.sleep(1.2 * (attempt + 1) + random.random())
            continue
        # 401/403/451 and friends: no point retrying
        return None

    if last:
        raise FetchError(last)
    return None


def get_text(
    session: requests.Session,
    url: str,
    *,
    timeout: float = 25,
    retries: int = 1,
    headers: dict | None = None,
) -> tuple[str, str, int]:
    """Return (html, final_url, status_code). html is '' on failure."""
    last_status = 0
    for attempt in range(retries + 1):
        try:
            resp = session.get(url, timeout=timeout, headers=headers, allow_redirects=True)
        except requests.RequestException:
            time.sleep(0.8 * (attempt + 1))
            continue
        last_status = resp.status_code
        if resp.status_code == 200:
            return resp.text, resp.url, 200
        if resp.status_code in (429, 500, 502, 503, 504):
            time.sleep(1.2 * (attempt + 1))
            continue
        return "", resp.url, resp.status_code
    return "", url, last_status


def download(
    session: requests.Session,
    url: str,
    *,
    timeout: float = 40,
    referer: str | None = None,
    max_bytes: int = MAX_BYTES,
) -> Binary:
    """Fetch a URL into memory, validating size and content type."""
    headers = {"Accept": BINARY_ACCEPT}
    if referer:
        headers["Referer"] = referer
    try:
        resp = session.get(url, timeout=timeout, headers=headers, stream=True, allow_redirects=True)
    except requests.RequestException as exc:
        return Binary(url, False, error=f"{type(exc).__name__}: {exc}")

    with resp:
        ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if resp.status_code != 200:
            hint = " (access denied)" if resp.status_code in (401, 403, 451) else ""
            return Binary(
                url,
                False,
                content_type=ctype,
                status_code=resp.status_code,
                error=f"HTTP {resp.status_code}{hint}",
                final_url=resp.url,
            )

        declared = resp.headers.get("Content-Length")
        if declared and declared.isdigit() and int(declared) > max_bytes:
            # bail out before spending the bandwidth
            return Binary(
                url,
                False,
                content_type=ctype,
                status_code=200,
                error=f"too large: {int(declared) // (1024 * 1024)} MB > cap",
            )

        chunks: list[bytes] = []
        total = 0
        try:
            for chunk in resp.iter_content(CHUNK):
                if not chunk:
                    continue
                total += len(chunk)
                if total > max_bytes:
                    return Binary(url, False, content_type=ctype, status_code=200, error="exceeded size cap")
                chunks.append(chunk)
        except requests.RequestException as exc:
            return Binary(url, False, content_type=ctype, status_code=200, error=f"stream: {exc}")

        content = b"".join(chunks)

    if not content:
        return Binary(url, False, content_type=ctype, status_code=200, error="empty body", final_url=resp.url)

    return Binary(url, True, content=content, content_type=ctype, status_code=200, final_url=resp.url)


def looks_like_pdf(binary: Binary) -> bool:
    """A real PDF starts with %PDF-, regardless of what the server claimed."""
    return binary.ok and binary.is_pdf


def looks_like_paywall(binary: Binary | None, html: str = "") -> bool:
    """Heuristic: an HTML page where a PDF should have been."""
    if binary is not None:
        if binary.status_code in (401, 402, 403, 451):
            return True
        if binary.ok and binary.looks_html():
            return True
    lowered = (html or "").lower()
    markers = (
        "access denied",
        "purchase this article",
        "get access",
        "sign in to continue",
        "institutional access",
        "just a moment",
        "cloudflare",
        "captcha",
        "checking your browser",
        "verify you are human",
    )
    return any(m in lowered for m in markers)
