"""DOI normalisation and Crossref metadata."""

from __future__ import annotations

import re

import requests

from . import net
from .models import Metadata

DOI_RE = re.compile(r"10\.\d{4,9}/[^\s\"'<>,;]+", re.I)
_ARXIV_DOI = re.compile(r"10\.48550/arxiv\.(.+)$", re.I)
_TRIM = ".,;)"


def normalize_doi(raw: str) -> str:
    """Accept a bare DOI, a doi.org URL, or 'doi: 10.1234/x' and return the DOI."""
    text = (raw or "").strip()
    if not text:
        raise ValueError("empty DOI")

    for prefix in ("https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "http://dx.doi.org/"):
        if text.lower().startswith(prefix):
            text = text[len(prefix):]
            break

    lowered = text.lower()
    if lowered.startswith("doi:"):
        text = text[4:].strip()

    match = DOI_RE.search(text)
    if not match:
        raise ValueError(f"not a DOI: {raw!r}")

    doi = match.group(0).rstrip(_TRIM)
    if doi.lower().startswith("10.48550/arxiv."):
        # arXiv DOIs are case-insensitive but conventionally keep the id case
        pass
    return doi


def resolve_landing(session: requests.Session, doi: str, timeout: float = 20) -> str:
    """Follow doi.org redirects without loading the publisher page."""
    url = f"https://doi.org/{doi}"
    current = url
    for _ in range(4):
        try:
            resp = session.get(current, timeout=timeout, allow_redirects=False)
        except requests.RequestException:
            return current

        location = resp.headers.get("Location")
        if resp.status_code in (301, 302, 303, 307, 308) and location:
            if location.startswith("/"):
                location = f"https://doi.org{location}"
            current = location
            continue
        return current
    return current


def crossref(session: requests.Session, doi: str, email: str = "", timeout: float = 20) -> Metadata:
    """Best-effort Crossref record; empty Metadata when unavailable."""
    headers = {"User-Agent": net.UA}
    if email:
        headers["User-Agent"] = f"doi-fetch/0.1 (mailto:{email})"

    data = None
    try:
        data = net.get_json(
            session, f"https://api.crossref.org/works/{doi}", timeout=timeout, headers=headers
        )
    except net.FetchError:
        data = None

    meta = Metadata(doi=doi)
    if not isinstance(data, dict):
        return meta

    msg = data.get("message") or {}
    meta.title = _first(msg.get("title")) or ""
    meta.journal = _first(msg.get("container-title")) or ""
    meta.publisher = msg.get("publisher") or ""
    meta.type = msg.get("type") or ""
    meta.url = msg.get("URL") or ""

    authors: list[str] = []
    for author in msg.get("author") or []:
        if not isinstance(author, dict):
            continue
        family = (author.get("family") or "").strip()
        given = (author.get("given") or "").strip()
        if family and given:
            authors.append(f"{family}, {given}")
        elif family:
            authors.append(family)
        elif author.get("name"):
            authors.append(str(author["name"]).strip())
    meta.authors = authors

    meta.year = _year(msg)
    return meta


def _first(value) -> str:
    if isinstance(value, list) and value:
        return str(value[0]).strip()
    if isinstance(value, str):
        return value.strip()
    return ""


def resolve(session: requests.Session, doi: str, email: str = "") -> Metadata:
    """Crossref first; DataCite and arXiv catch what Crossref does not hold.

    arXiv DOIs (10.48550/*) are registered with DataCite, never with Crossref,
    so a bare Crossref lookup leaves them without a title.
    """
    meta = crossref(session, doi, email)
    if meta.title:
        return meta

    arxiv_match = _ARXIV_DOI.search(doi)
    if arxiv_match:
        alt = arxiv_metadata(session, re.sub(r"v\d+$", "", arxiv_match.group(1)))
        if alt and alt.title:
            alt.doi = doi
            alt.url = f"https://arxiv.org/abs/{re.sub(r'v\d+$', '', arxiv_match.group(1))}"
            return alt

    alt = datacite(session, doi)
    if alt and alt.title:
        alt.doi = doi
        return alt
    return meta


def datacite(session: requests.Session, doi: str, timeout: float = 20) -> Metadata | None:
    """DataCite holds arXiv, Zenodo, figshare and dataset DOIs."""
    try:
        data = net.get_json(session, f"https://api.datacite.org/dois/{doi}", timeout=timeout)
    except net.FetchError:
        return None
    if not isinstance(data, dict):
        return None
    attr = ((data.get("data") or {}).get("attributes")) or {}
    if not isinstance(attr, dict):
        return None

    meta = Metadata(doi=doi)
    titles = attr.get("titles") or []
    if isinstance(titles, list) and titles:
        meta.title = str((titles[0] or {}).get("title") or "").strip()

    authors: list[str] = []
    for creator in attr.get("creators") or []:
        if not isinstance(creator, dict):
            continue
        family = (creator.get("familyName") or "").strip()
        given = (creator.get("givenName") or "").strip()
        name = (creator.get("name") or "").strip()
        if family and given:
            authors.append(f"{family}, {given}")
        elif name:
            authors.append(name)
        elif family:
            authors.append(family)
    meta.authors = authors
    meta.year = str(attr.get("publicationYear") or "")
    meta.publisher = str(attr.get("publisher") or "")
    meta.type = str(((attr.get("types") or {}).get("resourceTypeGeneral")) or "")
    return meta


def arxiv_metadata(session: requests.Session, arxiv_id: str, timeout: float = 25) -> Metadata | None:
    """Atom metadata straight from the arXiv API."""
    try:
        resp = session.get(
            "http://export.arxiv.org/api/query", params={"id_list": arxiv_id}, timeout=timeout
        )
    except requests.RequestException:
        return None
    if resp.status_code != 200:
        return None
    text = resp.text or ""

    entry = re.search(r"<entry>(.*?)</entry>", text, re.S)
    if not entry:
        return None
    block = entry.group(1)

    meta = Metadata(doi=f"10.48550/arXiv.{arxiv_id}", type="posted-content")
    title_match = re.search(r"<title>(.*?)</title>", block, re.S)
    if title_match:
        meta.title = re.sub(r"\s+", " ", title_match.group(1)).strip()
    meta.authors = [
        re.sub(r"\s+", " ", name).strip()
        for name in re.findall(r"<name>(.*?)</name>", block, re.S)
    ]
    published = re.search(r"<published>(\d{4})", block)
    if published:
        meta.year = published.group(1)
    meta.journal = "arXiv"
    meta.publisher = "arXiv"
    meta.url = f"https://arxiv.org/abs/{arxiv_id}"
    return meta


def _year(msg: dict) -> str:
    for key in ("published-print", "published-online", "issued", "created"):
        block = msg.get(key)
        if isinstance(block, dict):
            parts = (block.get("date-parts") or [[None]])[0]
            if parts and parts[0]:
                return str(parts[0])
    return ""
