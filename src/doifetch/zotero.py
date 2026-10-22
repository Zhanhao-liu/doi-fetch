"""Zotero connector client.

Zotero runs a local HTTP server (default 127.0.0.1:23119) that its browser
connector talks to. We speak the same protocol so a batch can file papers
straight into the library.

Two protocol details cost real debugging time, so they are worth stating:

* Zotero cancels any request that carries an ``Origin`` header without
  ``X-Zotero-Connector-API-Version`` (``Preventing request from browser``).
  The browser sees a bare ``Failed to fetch``.
* ``X-Metadata`` is an HTTP header, so it must be ISO-8859-1. Non-ASCII titles
  have to be escaped as ``\\uXXXX``; Zotero's ``JSON.parse`` restores them.
"""

from __future__ import annotations

import http.client
import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from urllib.parse import quote

from .models import Metadata

BASE = "http://127.0.0.1:23119"
API_VERSION = "3"
CONNECTOR_HEADERS = {"X-Zotero-Connector-API-Version": API_VERSION}
LOCAL_API_HEADERS = {"Zotero-API-Version": API_VERSION}
MAX_ATTACHMENT_MB = 40


class ZoteroError(RuntimeError):
    pass


@dataclass
class ZoteroTargets:
    current_id: str
    current_name: str
    targets: list[dict]


def _request(url: str, *, data: bytes | None = None, headers: dict | None = None, timeout: float = 30):
    request = urllib.request.Request(url, data=data, headers=headers or {}, method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except (urllib.error.URLError, OSError) as exc:
        raise ZoteroError(f"连不上 Zotero（{BASE}）：{exc}") from exc


def ping(timeout: float = 3.0) -> dict | None:
    """Return connector info when Zotero is reachable, else None."""
    try:
        status, body = _request(
            f"{BASE}/connector/ping",
            data=b"ping",
            headers={**CONNECTOR_HEADERS, "Content-Type": "text/plain"},
            timeout=timeout,
        )
    except ZoteroError:
        return None
    if status != 200:
        return None
    return {"version": "", "raw": body.decode("utf-8", "replace")}


def version(timeout: float = 3.0) -> str:
    connection = http.client.HTTPConnection("127.0.0.1", 23119, timeout=timeout)
    try:
        connection.request("POST", "/connector/ping", body=b"ping", headers=CONNECTOR_HEADERS)
        response = connection.getresponse()
        value = response.getheader("X-Zotero-Version") or ""
        response.read()
        return value
    except (OSError, http.client.HTTPException):
        return ""
    finally:
        connection.close()


def targets() -> ZoteroTargets:
    status, body = _request(
        f"{BASE}/connector/getSelectedCollection",
        data=b"{}",
        headers={**CONNECTOR_HEADERS, "Content-Type": "application/json"},
    )
    if status != 200:
        raise ZoteroError(f"getSelectedCollection 返回 {status}")
    data = json.loads(body.decode("utf-8"))
    return ZoteroTargets(
        current_id=data.get("id") or "",
        current_name=data.get("name") or "",
        targets=data.get("targets") or [],
    )


_DOI_INDEX: set[str] | None = None


def library_dois(force: bool = False, timeout: float = 120.0) -> set[str]:
    """整个库的 DOI 集合，用于判重。

    Zotero 本地 API 的 ``q`` 参数**不检索 DOI 字段**（实测 ``q=10.0000/xxx`` 全部落空，
    而 ``q=测试`` 能命中），所以只能分页枚举，把 DOI 收集成集合缓存起来。
    """
    global _DOI_INDEX
    if _DOI_INDEX is not None and not force:
        return _DOI_INDEX

    dois: set[str] = set()
    start = 0
    page = 100
    deadline = time.monotonic() + timeout

    while time.monotonic() < deadline:
        status, body = _request(
            f"{BASE}/api/users/0/items?limit={page}&start={start}", headers=LOCAL_API_HEADERS
        )
        if status != 200:
            break
        try:
            items = json.loads(body.decode("utf-8"))
        except ValueError:
            break
        if not isinstance(items, list) or not items:
            break

        for item in items:
            data = item.get("data") or {}
            doi = (data.get("DOI") or "").strip().lower()
            if doi:
                dois.add(doi)

        if len(items) < page:
            break
        start += page

    _DOI_INDEX = dois
    return dois


def find_by_doi(doi: str) -> dict | None:
    """Non-None when the DOI already exists in the library."""
    if not doi:
        return None
    needle = doi.strip().lower()
    if needle in library_dois():
        return {"data": {"DOI": doi}}
    return None


def _creators(authors: list[str]) -> list[dict]:
    out: list[dict] = []
    for raw in authors or []:
        value = (raw or "").strip()
        if not value:
            continue
        if "," in value:
            last, _, first = value.partition(",")
            out.append({"creatorType": "author", "lastName": last.strip(), "firstName": first.strip()})
        else:
            parts = value.split()
            if len(parts) == 1:
                out.append({"creatorType": "author", "lastName": value, "firstName": ""})
            else:
                out.append(
                    {"creatorType": "author", "lastName": parts[-1], "firstName": " ".join(parts[:-1])}
                )
    return out


def build_item(meta: Metadata) -> dict:
    item = {
        "id": "doifetch-main",
        "itemType": "journalArticle",
        "title": meta.title or "",
        "creators": _creators(meta.authors),
        "DOI": meta.doi or "",
        "url": meta.url or "",
        "libraryCatalog": "doi-fetch",
    }
    if meta.year:
        item["date"] = meta.year
    if meta.journal:
        item["publicationTitle"] = meta.journal
    if meta.publisher:
        item["publisher"] = meta.publisher
    return item


def _escape_header_json(payload: dict) -> str:
    text = json.dumps(payload, ensure_ascii=False)
    return "".join(
        ch if ord(ch) < 0x7F else "\\u%04x" % ord(ch) for ch in text
    )


def save_item(meta: Metadata, session_id: str, uri: str = "") -> None:
    body = json.dumps(
        {"sessionID": session_id, "uri": uri or meta.url or "", "items": [build_item(meta)]},
        ensure_ascii=False,
    ).encode("utf-8")
    status, text = _request(
        f"{BASE}/connector/saveItems",
        data=body,
        headers={**CONNECTOR_HEADERS, "Content-Type": "application/json"},
    )
    if status not in (200, 201):
        raise ZoteroError(f"saveItems 返回 {status}: {text[:160].decode('utf-8', 'replace')}")


def save_attachment(
    session_id: str,
    parent_key: str,
    data: bytes,
    *,
    title: str,
    url: str,
    mime: str = "application/pdf",
) -> None:
    if len(data) > MAX_ATTACHMENT_MB * 1024 * 1024:
        raise ZoteroError(f"附件超过 {MAX_ATTACHMENT_MB} MB")
    metadata = _escape_header_json(
        {"sessionID": session_id, "parentItemID": parent_key, "title": title, "url": url}
    )
    status, text = _request(
        f"{BASE}/connector/saveAttachment?sessionID={quote(session_id)}",
        data=data,
        headers={
            **CONNECTOR_HEADERS,
            "Content-Type": mime,
            "X-Metadata": metadata,
        },
    )
    if status not in (200, 201):
        raise ZoteroError(f"saveAttachment 返回 {status}: {text[:160].decode('utf-8', 'replace')}")


def move_to_target(session_id: str, target: str) -> bool:
    """Move the just-saved item into another collection (C<id> / L<id>)."""
    body = json.dumps({"sessionID": session_id, "target": target, "tags": [], "note": ""}).encode()
    status, _ = _request(
        f"{BASE}/connector/updateSession",
        data=body,
        headers={**CONNECTOR_HEADERS, "Content-Type": "application/json"},
    )
    return status == 200
