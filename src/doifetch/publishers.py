"""Publisher landing-page parsing: article PDF links and SI attachments."""

from __future__ import annotations

import re
from urllib.parse import parse_qs, unquote, urljoin, urlparse

from bs4 import BeautifulSoup

from . import net
from .models import Candidate, Metadata

# --- link recognition -------------------------------------------------------

_SI_MARKERS = re.compile(
    r"(supplementary|supplemental|supporting[-_ ]?information|supp[-_ ]?info|"
    r"suppl_file|moesm\d*|_esm\d*|mmc\d+|sapp\d*|suppdata|supplementary-material|"
    r"type=supplementary|table[-_]s\d|figure[-_]s\d|_si_?\d|esm\d*|media-1)",
    re.I,
)

_DOC_EXT = re.compile(r"\.(pdf|docx?|pptx?|odt|rtf|xlsx?|csv|txt|zip|gz)(?:[?#]|$)", re.I)

_PDF_HREF = re.compile(
    r"(\.pdf(?:[?#]|$)|/pdf/|pdfdirect|pdfft|/epdf/|fulltext\.pdf|stamp\.jsp|"
    r"type=printable|/articlepdf/)",
    re.I,
)

# Site help pages that mention "supporting information" but are not this
# article's SI (PLOS /s/supporting-information is the classic trap).
_SI_BLOCKLIST = re.compile(
    r"(/s/supporting-information|/site/|/help/|/faq|/guidelines|/about/|"
    r"/author-|/submit|/permissions)",
    re.I,
)

# Direct PDF endpoints that work across a publisher's whole catalogue.
_DIRECT_TEMPLATES: tuple[tuple[str, str], ...] = (
    ("10.1002/", "https://onlinelibrary.wiley.com/doi/pdfdirect/{doi}?download=true"),
    ("10.1111/", "https://onlinelibrary.wiley.com/doi/pdfdirect/{doi}?download=true"),
    ("10.1007/", "https://link.springer.com/content/pdf/{doi}.pdf"),
    ("10.1023/", "https://link.springer.com/content/pdf/{doi}.pdf"),
    ("10.1021/", "https://pubs.acs.org/doi/pdf/{doi}"),
    ("10.1126/", "https://www.science.org/doi/pdf/{doi}"),
    ("10.1073/", "https://www.pnas.org/doi/pdf/{doi}"),
    ("10.1177/", "https://journals.sagepub.com/doi/pdf/{doi}"),
    ("10.1093/", "https://academic.oup.com/doi/pdf/{doi}"),
    ("10.1080/", "https://www.tandfonline.com/doi/pdf/{doi}"),
    ("10.1088/", "https://iopscience.iop.org/article/{doi}/pdf"),
)


def direct_pdf_candidates(doi: str, landing: str = "") -> list[Candidate]:
    """Publisher-specific PDF endpoints built straight from the DOI."""
    out: list[Candidate] = []
    for prefix, template in _DIRECT_TEMPLATES:
        if doi.startswith(prefix):
            out.append(Candidate(url=template.format(doi=doi), source="publisher:direct"))
            break

    if doi.startswith("10.1038/"):
        suffix = doi.split("10.1038/", 1)[1]
        out.append(
            Candidate(url=f"https://www.nature.com/articles/{suffix}.pdf", source="publisher:direct")
        )

    if doi.startswith("10.1016/") and landing:
        pii = _pii_from_url(landing)
        if pii:
            out.append(
                Candidate(
                    url=(
                        f"https://www.sciencedirect.com/science/article/pii/{pii}/pdfft"
                        "?isDTMRedir=true&download=true"
                    ),
                    source="publisher:direct",
                )
            )
    return out


def _pii_from_url(url: str) -> str:
    match = re.search(r"/pii/([A-Z0-9()\-]+)", url or "", re.I)
    return match.group(1) if match else ""


def parse_landing(html: str, base_url: str) -> tuple[list[Candidate], list[Candidate]]:
    """Return (pdf_candidates, si_candidates) found in the landing page."""
    if not html:
        return [], []

    soup = BeautifulSoup(html, "lxml")
    pdfs: list[Candidate] = []
    sis: list[Candidate] = []
    seen_pdf: set[str] = set()
    seen_si: set[str] = set()
    page_key = (base_url or "").split("#", 1)[0]

    def add_pdf(url: str, source: str) -> None:
        absolute = urljoin(base_url, url).split("#", 1)[0]
        if absolute in seen_pdf or not absolute.lower().startswith("http"):
            return
        seen_pdf.add(absolute)
        pdfs.append(Candidate(url=absolute, source=source, referer=base_url))

    def add_si(url: str, source: str) -> None:
        absolute = urljoin(base_url, url)
        if not absolute.lower().startswith("http"):
            return
        stripped = absolute.split("#", 1)[0]
        # "#MOESM1" is an in-page anchor, not a downloadable file
        if stripped == page_key or stripped in seen_si:
            return
        if _SI_BLOCKLIST.search(stripped):
            return
        seen_si.add(stripped)
        sis.append(Candidate(url=stripped, source=source, referer=base_url))

    # 1. citation_pdf_url is the most reliable signal, across all publishers
    for meta in soup.find_all("meta"):
        name = (meta.get("name") or meta.get("property") or "").lower()
        content = meta.get("content") or ""
        if not content:
            continue
        if name in ("citation_pdf_url", "bepress_citation_pdf_url"):
            add_pdf(content, "landing:citation_pdf_url")

    # 2. <link rel="alternate" type="application/pdf">
    for link in soup.find_all("link"):
        rel = " ".join(link.get("rel") or []).lower()
        if "alternate" in rel and "pdf" in (link.get("type") or "").lower():
            add_pdf(link.get("href") or "", "landing:link-pdf")

    # 3. anchors
    for anchor in soup.find_all("a", href=True):
        href = anchor["href"]
        text = anchor.get_text(" ", strip=True)[:200]
        blob = f"{href} {text}"

        if _SI_MARKERS.search(blob):
            add_si(href, "landing:si-link")
            continue
        if _PDF_HREF.search(href) or "pdf" in text.lower():
            if _DOC_EXT.search(href) and not href.lower().endswith(".pdf"):
                add_si(href, "landing:doc-link")
                continue
            add_pdf(href, "landing:pdf-link")

    return pdfs[:8], sis[:20]


def is_si_url(url: str) -> bool:
    return bool(_SI_MARKERS.search(url or ""))


def looks_like_document(url: str, content_type: str = "", content: bytes | None = None) -> bool:
    """Decide whether a response is a real document.

    When the bytes are available they win outright: publishers answer paywalled
    SI links with an HTTP 200 HTML login page, and a URL ending in ".pdf" says
    nothing about what actually came back.
    """
    if content is not None:
        return net.is_document_bytes(content)
    if _DOC_EXT.search(url or ""):
        return True
    ctype = (content_type or "").lower()
    return any(
        marker in ctype
        for marker in (
            "pdf",
            "wordprocessingml",
            "msword",
            "presentationml",
            "spreadsheetml",
            "octet-stream",
            "zip",
        )
    )


def extension_for(url: str, content_type: str = "") -> str:
    match = re.search(r"\.(pdf|docx?|pptx?|odt|rtf|xlsx?|csv|txt|zip|gz)(?:[?#]|$)", url or "", re.I)
    if match:
        return "." + match.group(1).lower()

    ctype = (content_type or "").lower()
    mapping = (
        ("pdf", ".pdf"),
        ("wordprocessingml", ".docx"),
        ("msword", ".doc"),
        ("presentationml", ".pptx"),
        ("spreadsheetml", ".xlsx"),
        ("zip", ".zip"),
        ("text/plain", ".txt"),
    )
    for needle, ext in mapping:
        if needle in ctype:
            return ext
    return ".bin"


_GENERIC_BASENAMES = {"", "file", "files", "download", "get", "attachment", "pdf", "fulltext", "document"}


def filename_for(url: str, content_type: str = "", fallback: str = "supplementary") -> str:
    parsed = urlparse(url or "")
    path = unquote(parsed.path or "")
    stem = path.rsplit("/", 1)[-1] or ""

    # PLOS-style ".../file?type=supplementary&id=10.1371/journal.pone.0229668.s001"
    if stem.lower() in _GENERIC_BASENAMES:
        qid = parse_qs(parsed.query or "").get("id", [""])[0]
        stem = qid.replace("/", "_") if qid else fallback

    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", stem).strip(". ")
    if not stem or len(stem) > 120:
        stem = fallback

    ext = extension_for(url, content_type)
    if not re.search(r"\.[a-z0-9]{2,5}$", stem, re.I):
        stem += ext
    elif ext != ".bin" and not stem.lower().endswith(ext):
        stem += ext
    return stem


# --- SI fallbacks: sources that mirror SI even behind a paywall -------------


def figshare_si(session, doi: str, meta: Metadata) -> list[Candidate]:
    """ACS/T&F/SAGE/PLOS mirror much of their SI on Figshare."""
    payload = {"search_for": doi, "page_size": 8}
    try:
        resp = session.post("https://api.figshare.com/v2/articles/search", json=payload, timeout=20)
    except Exception:
        return []
    if resp.status_code != 200:
        return []

    try:
        items = resp.json()
    except ValueError:
        return []
    if not isinstance(items, list):
        return []

    title_words = {
        w.lower() for w in re.findall(r"[A-Za-z]{5,}", meta.title or "") if len(w) > 4
    }

    found: list[Candidate] = []
    for item in items[:5]:
        if not isinstance(item, dict):
            continue
        item_title = (item.get("title") or "").lower()
        related = bool(title_words) and len(title_words & set(re.findall(r"[a-z]{5,}", item_title))) >= 2
        mentions_si = bool(re.search(r"(supplement|supporting|\bsi\b|esi)", item_title))
        if not (related or mentions_si):
            continue

        article_id = item.get("id")
        if not article_id:
            continue
        try:
            detail = net.get_json(session, f"https://api.figshare.com/v2/articles/{article_id}", timeout=20)
        except net.FetchError:
            continue
        files = (detail or {}).get("files") or []
        for f in files:
            url = (f or {}).get("download_url")
            name = ((f or {}).get("name") or "").lower()
            if not url:
                continue
            if name.endswith((".pdf", ".docx", ".doc", ".xlsx", ".zip")):
                found.append(Candidate(url=url, source="figshare"))
    return found[:10]


def pmc_si_links(session, pmcid: str) -> list[Candidate]:
    """PMC keeps supplementary files under /bin/ - even for paywalled articles."""
    if not pmcid:
        return []
    try:
        html, final_url, status = net.get_text(
            session, f"https://www.ncbi.nlm.nih.gov/pmc/articles/{pmcid}/", timeout=25
        )
    except Exception:
        return []
    if status != 200 or not html:
        return []

    soup = BeautifulSoup(html, "lxml")
    found: list[Candidate] = []
    seen: set[str] = set()
    for anchor in soup.find_all("a", href=True):
        href = anchor["href"]
        if "/bin/" not in href and not _SI_MARKERS.search(href):
            continue
        absolute = urljoin("https://www.ncbi.nlm.nih.gov", href)
        if absolute in seen or not _DOC_EXT.search(absolute):
            continue
        seen.add(absolute)
        found.append(Candidate(url=absolute, source="pmc:bin", referer=final_url))
    return found[:20]


def europepmc_si(session, pmcid: str) -> list[Candidate]:
    """Europe PMC exposes an SI listing for archived articles."""
    if not pmcid:
        return []
    url = f"https://www.ebi.ac.uk/europepmc/webservices/rest/{pmcid}/supplementaryFiles"
    try:
        resp = session.get(url, timeout=25)
    except Exception:
        return []
    if resp.status_code != 200 or not resp.text:
        return []

    found: list[Candidate] = []
    for href in re.findall(r'href="([^"]+)"', resp.text):
        absolute = urljoin("https://www.ebi.ac.uk", href)
        found.append(Candidate(url=absolute, source="europepmc:si"))
    return found[:20]
