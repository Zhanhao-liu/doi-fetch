"""Data models shared across the pipeline."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import asdict, dataclass, field
from enum import Enum


class PdfStatus(str, Enum):
    DOWNLOADED = "downloaded"
    NEEDS_AUTH = "needs_auth"
    BLOCKED = "blocked"
    NOT_FOUND = "not_found"
    INVALID = "invalid_pdf"
    ERROR = "error"


class SiStatus(str, Enum):
    DOWNLOADED = "downloaded"
    PARTIAL = "partial"
    NONE = "none"
    BLOCKED = "blocked"
    SKIPPED = "skipped"
    ERROR = "error"


@dataclass
class Candidate:
    """A URL that may serve the article PDF."""

    url: str
    source: str
    referer: str | None = None
    needs_auth: bool = False


@dataclass
class Metadata:
    doi: str = ""
    title: str = ""
    authors: list[str] = field(default_factory=list)
    year: str = ""
    journal: str = ""
    publisher: str = ""
    type: str = ""
    url: str = ""

    @property
    def first_author(self) -> str:
        if not self.authors:
            return "Unknown"
        name = self.authors[0]
        if "," in name:
            return name.split(",")[0].strip()
        return name.split()[-1]

    @property
    def slug(self) -> str:
        text = unicodedata.normalize("NFKD", self.title or self.doi)
        text = text.encode("ascii", "ignore").decode()
        text = re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-").lower()
        words = [w for w in text.split("-") if w][:9]
        return ("-".join(words) or "untitled")[:90]

    @property
    def dirname(self) -> str:
        parts = [p for p in (self.year, self.first_author, self.slug) if p]
        return re.sub(r'[<>:"/\\|?*]', "", "_".join(parts)) or "unknown"


@dataclass
class Asset:
    filename: str
    source: str
    url: str
    size: int = 0
    sha256: str = ""
    content_type: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Report:
    doi: str
    metadata: Metadata = field(default_factory=Metadata)
    landing_url: str = ""
    pdf_status: str = PdfStatus.NOT_FOUND.value
    pdf_path: str = ""
    pdf_source: str = ""
    pdf_error: str = ""
    pdf_pages: int = 0
    si_status: str = SiStatus.NONE.value
    si_assets: list[Asset] = field(default_factory=list)
    si_error: str = ""
    workdir: str = ""
    elapsed: float = 0.0
    notes: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.pdf_status == PdfStatus.DOWNLOADED.value

    def to_dict(self) -> dict:
        d = asdict(self)
        d["ok"] = self.ok
        return d
