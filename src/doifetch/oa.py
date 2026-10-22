"""Open-access candidate discovery (tier 1-3 of the ladder).

Each resolver is independent and tolerant: a dead API never fails the fetch.
"""

from __future__ import annotations

import re

import requests

from . import net
from .models import Candidate, Metadata

_ARXIV_DOI = re.compile(r"10\.48550/arxiv\.(.+)$", re.I)
_ARXIV_XML_ID = re.compile(r"<id>(?:https?://arxiv\.org/abs/)?([^<]+)</id>")


def oa_candidates(
    session: requests.Session,
    doi: str,
    meta: Metadata,
    email: str = "",
) -> tuple[list[Candidate], list[str]]:
    """Collect OA PDF candidates from the free indexes, best guess first."""
    out: list[Candidate] = []
    notes: list[str] = []

    out.extend(_unpaywall(session, doi, email, notes))
    out.extend(_openalex(session, doi, notes))
    out.extend(_europepmc(session, doi, notes))
    out.extend(_semantic_scholar(session, doi, notes))
    out.extend(_arxiv_by_doi(doi, notes))

    seen: set[str] = set()
    unique: list[Candidate] = []
    for cand in out:
        key = cand.url.split("#", 1)[0]
        if key in seen:
            continue
        seen.add(key)
        unique.append(cand)
    return unique, notes


def _unpaywall(session: requests.Session, doi: str, email: str, notes: list[str]) -> list[Candidate]:
    if not email:
        notes.append("unpaywall: skipped (no contact email)")
        return []
    try:
        data = net.get_json(
            session, f"https://api.unpaywall.org/v2/{doi}", params={"email": email}, timeout=20
        )
    except net.FetchError:
        notes.append("unpaywall: unreachable")
        return []
    if not isinstance(data, dict):
        notes.append("unpaywall: no record")
        return []

    found: list[Candidate] = []
    best = data.get("best_oa_location") or {}
    for loc in [best] + list(data.get("oa_locations") or []):
        if not isinstance(loc, dict):
            continue
        url = loc.get("url_for_pdf") or loc.get("url")
        if not url or not str(url).lower().startswith("http"):
            continue
        label = f"unpaywall:{loc.get('host_type') or 'oa'}"
        found.append(Candidate(url=url, source=label))
        if len(found) >= 4:
            break

    if not found:
        notes.append(f"unpaywall: no OA location (is_oa={data.get('is_oa')})")
    return found


def _openalex(session: requests.Session, doi: str, notes: list[str]) -> list[Candidate]:
    try:
        data = net.get_json(
            session, f"https://api.openalex.org/works/doi:{doi}", timeout=20
        )
    except net.FetchError:
        notes.append("openalex: unreachable")
        return []
    if not isinstance(data, dict):
        notes.append("openalex: no record")
        return []

    found: list[Candidate] = []
    for loc in [data.get("best_oa_location") or {}] + list(data.get("locations") or []):
        if not isinstance(loc, dict):
            continue
        url = loc.get("pdf_url") or loc.get("landing_page_url")
        if url and str(url).lower().startswith("http"):
            found.append(Candidate(url=str(url), source="openalex"))
        if len(found) >= 3:
            break
    return found


def _europepmc(session: requests.Session, doi: str, notes: list[str]) -> list[Candidate]:
    record = europepmc_record(session, doi)
    if not record:
        notes.append("europepmc: no record")
        return []

    found: list[Candidate] = []
    pmcid = record.get("pmcid")
    if pmcid:
        found.append(
            Candidate(url=f"https://europepmc.org/articles/{pmcid}?pdf=render", source="europepmc")
        )
        found.append(
            Candidate(url=f"https://www.ncbi.nlm.nih.gov/pmc/articles/{pmcid}/pdf/", source="pmc")
        )
    if record.get("isOpenAccess") == "Y" and not pmcid:
        notes.append("europepmc: open access but no PMCID")
    return found


def _semantic_scholar(session: requests.Session, doi: str, notes: list[str]) -> list[Candidate]:
    try:
        data = net.get_json(
            session,
            f"https://api.semanticscholar.org/graph/v1/paper/DOI:{doi}",
            params={"fields": "openAccessPdf,externalIds"},
            timeout=20,
        )
    except net.FetchError:
        notes.append("semantic_scholar: unreachable/rate-limited")
        return []
    if not isinstance(data, dict):
        return []

    pdf = data.get("openAccessPdf") or {}
    url = pdf.get("url") if isinstance(pdf, dict) else None
    if url:
        return [Candidate(url=url, source="semantic_scholar")]
    return []


def _arxiv_by_doi(doi: str, notes: list[str]) -> list[Candidate]:
    match = _ARXIV_DOI.search(doi)
    if not match:
        return []
    # strip the version suffix only; a plain split('v') would mangle ids such
    # as "solv-int/9701001"
    arxiv_id = re.sub(r"v\d+$", "", match.group(1))
    notes.append(f"arxiv: doi maps to {arxiv_id}")
    return [Candidate(url=f"https://arxiv.org/pdf/{arxiv_id}", source="arxiv")]


def arxiv_by_title(session: requests.Session, meta: Metadata) -> Candidate | None:
    """Last-resort arXiv lookup. Slow (~3s) and only called when nothing else worked."""
    title = (meta.title or "").strip()
    if len(title) < 12:
        return None
    words = [w for w in re.findall(r"[A-Za-z0-9-]+", title)][:12]
    if not words:
        return None
    query = " AND ".join(f"ti:{w}" for w in words[:6])
    try:
        resp = session.get(
            "http://export.arxiv.org/api/query",
            params={"search_query": query, "max_results": 1},
            timeout=25,
        )
    except requests.RequestException:
        return None
    if resp.status_code != 200:
        return None
    ids = _ARXIV_XML_ID.findall(resp.text or "")
    if not ids:
        return None
    return Candidate(url=f"https://arxiv.org/pdf/{ids[0].split('/abs/')[-1]}", source="arxiv:title")


def europepmc_record(session: requests.Session, doi: str) -> dict | None:
    try:
        data = net.get_json(
            session,
            "https://www.ebi.ac.uk/europepmc/webservices/rest/search",
            params={"query": f'DOI:"{doi}"', "format": "json", "resultType": "core", "pageSize": 1},
            timeout=20,
        )
    except net.FetchError:
        return None
    if not isinstance(data, dict):
        return None
    results = ((data.get("resultList") or {}).get("result")) or []
    return results[0] if results and isinstance(results[0], dict) else None


def pmc_oa_pdf(session: requests.Session, pmcid: str) -> list[Candidate]:
    """Ask the PMC OA service for a packaged PDF."""
    try:
        resp = session.get(
            "https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi",
            params={"id": pmcid},
            timeout=20,
        )
    except requests.RequestException:
        return []
    if resp.status_code != 200:
        return []

    found: list[Candidate] = []
    for href in re.findall(r'href="([^"]+)"', resp.text or ""):
        # oa.fcgi often hands back ftp:// links; https on the same host works
        url = href.replace("ftp://ftp.ncbi.nlm.nih.gov", "https://ftp.ncbi.nlm.nih.gov")
        if url.lower().endswith(".pdf"):
            found.append(Candidate(url=url, source="pmc_oa"))
    return found[:2]
