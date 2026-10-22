"""Offline unit tests - no network, no browser."""

from __future__ import annotations

import json

import pytest

from doifetch import net, publishers, schools
from doifetch.auth import WebVPN, parse_cookie_header
from doifetch.metadata import normalize_doi
from doifetch.models import Candidate, Metadata

WRDVPN_MAGIC = "77726476706e69737468656265737421"


# --- DOI normalisation ------------------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("10.1038/s41467-023-44674-1", "10.1038/s41467-023-44674-1"),
        ("https://doi.org/10.1038/nature12373", "10.1038/nature12373"),
        ("doi: 10.1126/science.abc1234", "10.1126/science.abc1234"),
        ("  10.1016/j.joule.2023.05.001.  ", "10.1016/j.joule.2023.05.001"),
        ("See 10.1038/xyz for details", "10.1038/xyz"),
    ],
)
def test_normalize_doi(raw, expected):
    assert normalize_doi(raw) == expected


@pytest.mark.parametrize("bad", ["", "   ", "not-a-doi", "http://example.com/paper"])
def test_normalize_doi_rejects(bad):
    with pytest.raises(ValueError):
        normalize_doi(bad)


# --- WebVPN URL rewriting ---------------------------------------------------


def test_webvpn_ustc_is_registered():
    school = schools.get("ustc")
    assert school.host == "wvpn.ustc.edu.cn"
    assert school.base == "https://wvpn.ustc.edu.cn"


def test_webvpn_convert_format():
    gateway = WebVPN(schools.get("中国科学技术大学"))
    url = "https://www.sciencedirect.com/science/article/pii/S2542435123002015"
    out = gateway.convert(url)

    parts = out.split("/")
    assert out.startswith("https://wvpn.ustc.edu.cn/https/")
    # ['https:', '', 'wvpn.ustc.edu.cn', 'https', '<hex>', 'science', ...]
    hexed = parts[4]
    assert hexed.startswith(WRDVPN_MAGIC), "IV must be prepended in hex"
    # only the hostname is encrypted: path stays readable
    assert out.endswith("/science/article/pii/S2542435123002015")
    assert len(hexed) > len(WRDVPN_MAGIC)
    assert int(len(hexed) - len(WRDVPN_MAGIC)) % 2 == 0


def test_webvpn_convert_keeps_query_and_port():
    gateway = WebVPN(schools.get("中国科学技术大学"))
    out = gateway.convert("https://ieeexplore.ieee.org:443/stamp/stamp.jsp?tp=&arnumber=123")
    assert "/https-443/" in out
    assert out.endswith("?tp=&arnumber=123")


def test_webvpn_convert_no_hostname_is_passthrough():
    gateway = WebVPN(schools.get("中国科学技术大学"))
    assert gateway.convert("mailto:a@b.c") == "mailto:a@b.c"


def test_parse_cookie_header():
    assert parse_cookie_header("a=1; b=2; c=x=y") == {"a": "1", "b": "2", "c": "x=y"}
    assert parse_cookie_header("") == {}
    assert parse_cookie_header("garbage") == {}


# --- school lookup ----------------------------------------------------------


def test_school_aliases():
    assert schools.get("USTC").name == "中国科学技术大学"
    assert schools.get("中科大").host == "wvpn.ustc.edu.cn"


def test_schools_search_by_province():
    hits = schools.search("安徽")
    assert hits and all(h.province == "安徽" for h in hits)


def test_school_unknown_raises():
    with pytest.raises(ValueError):
        schools.get("不存在的学校xyz")


# --- landing page parsing ---------------------------------------------------


NATURE_HTML = """
<html><head>
<meta name="citation_pdf_url" content="https://www.nature.com/articles/s1.pdf">
</head><body>
<a href="#MOESM1">Supplementary information</a>
<a href="https://media.springernature.com/esm/art/MediaObjects/41467_2023_44674_MOESM1_ESM.pdf">MOESM1</a>
<a href="https://media.springernature.com/esm/art/MediaObjects/41467_2023_44674_MOESM2_ESM.docx">MOESM2</a>
</body></html>
"""

PLOS_HTML = """
<html><body>
<a href="https://journals.plos.org/plosone/s/supporting-information">Supporting information</a>
<a href="/plosone/article/file?type=supplementary&amp;id=10.1371/journal.pone.0229668.s001">S1 Fig</a>
<a href="/plosone/article/file?type=supplementary&amp;id=10.1371/journal.pone.0229668.s002">S2 Fig</a>
<a href="/plosone/article/file?type=printable&amp;id=10.1371/journal.pone.0229668">PDF</a>
</body></html>
"""


def test_parse_landing_finds_citation_pdf_and_moesm():
    pdfs, sis = publishers.parse_landing(NATURE_HTML, "https://www.nature.com/articles/s1")
    assert [c.url for c in pdfs] == ["https://www.nature.com/articles/s1.pdf"]
    assert len(sis) == 2
    assert all("MOESM" in c.url for c in sis)


def test_parse_landing_drops_same_page_anchor():
    _, sis = publishers.parse_landing(NATURE_HTML, "https://www.nature.com/articles/s1")
    assert not any("#" in c.url for c in sis)


def test_parse_landing_drops_plos_help_page():
    pdfs, sis = publishers.parse_landing(
        PLOS_HTML, "https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0229668"
    )
    assert not any("/s/supporting-information" in c.url for c in sis)
    # both SI files survive; the printable PDF is the article, not SI
    assert len(sis) == 2
    assert all("s00" in c.url for c in sis)
    assert any("type=printable" in c.url for c in pdfs)


def test_parse_landing_keeps_distinct_plos_query_urls():
    """Regression: dedupe must not key on a query-stripped URL."""
    _, sis = publishers.parse_landing(
        PLOS_HTML, "https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0229668"
    )
    assert len({c.url for c in sis}) == 2


def test_parse_landing_empty_html():
    assert publishers.parse_landing("", "https://x.org") == ([], [])


# --- filenames and extension detection --------------------------------------


def test_filename_from_plos_query_id():
    url = "https://journals.plos.org/plosone/article/file?type=supplementary&id=10.1371/journal.pone.0229668.s001"
    assert publishers.filename_for(url, "application/pdf") == "10.1371_journal.pone.0229668.s001.pdf"


def test_filename_from_plain_path():
    url = "https://media.springernature.com/x/41467_2023_44674_MOESM1_ESM.pdf"
    assert publishers.filename_for(url) == "41467_2023_44674_MOESM1_ESM.pdf"


def test_filename_adds_extension_from_content_type():
    url = "https://example.org/download/attachment"
    assert publishers.filename_for(url, "application/vnd.openxmlformats-officedocument.wordprocessingml.document").endswith(".docx")


def test_looks_like_document():
    assert publishers.looks_like_document("https://x.org/a.pdf")
    assert publishers.looks_like_document("https://x.org/x", "application/pdf")
    assert not publishers.looks_like_document("https://x.org/x", "text/html")


# --- content beats the URL --------------------------------------------------


HTML_LOGIN = b'<!doctype html><html><head><title>u\xe7\xbb\x9f\xe4\xb8\x80</title></head></html>'


def test_is_document_bytes_recognises_real_files():
    assert net.is_document_bytes(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3")
    assert net.is_document_bytes(b"PK\x03\x04" + b"\x00" * 20)  # docx/xlsx/zip
    assert net.is_document_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")  # legacy xls
    assert net.is_document_bytes(b"{\\rtf1")


def test_is_document_bytes_rejects_html_and_empty():
    assert not net.is_document_bytes(HTML_LOGIN)
    assert not net.is_document_bytes(b"")
    assert not net.is_document_bytes(None)


def test_url_extension_cannot_fake_a_document():
    """Regression: paywalled SI returns 200 + HTML at a .pdf URL and was saved."""
    url = "https://www.science.org/doi/suppl/10.1126/science.1253506/suppl_file/1253506.muller.sm.pdf"
    assert publishers.looks_like_document(url, "text/html")  # legacy guess
    assert not publishers.looks_like_document(url, "text/html", HTML_LOGIN)


def test_real_pdf_content_still_passes_with_content():
    url = "https://x.org/a.pdf"
    assert publishers.looks_like_document(url, "application/pdf", b"%PDF-1.7 ...")


def test_binary_is_document_property():
    pdf = net.download  # noqa: F841 - just documents the import path
    from doifetch.net import Binary

    assert Binary("u", True, content=b"%PDF-1.4 x").is_document
    assert not Binary("u", True, content=HTML_LOGIN).is_document
    assert not Binary("u", False, content=b"%PDF-1.4").is_document


# --- directory naming -------------------------------------------------------


def test_metadata_dirname_and_slug():
    meta = Metadata(
        doi="10.1038/s41467-023-44674-1",
        title="Machine-Learning-Accelerated Design: of High-Performance Catalysts!",
        authors=["Yin, Peng"],
        year="2024",
    )
    assert meta.first_author == "Yin"
    assert meta.dirname == "2024_Yin_machine-learning-accelerated-design-of-high-performance-catalysts"


def test_metadata_slug_is_filesystem_safe():
    meta = Metadata(title='What: a <weird> / title? with "chars"', authors=["Doe, Jane"], year="2020")
    name = meta.dirname
    assert not any(ch in name for ch in '<>:"/\\|?*')


# --- batch manifest ---------------------------------------------------------


def test_read_manifest_extracts_and_dedupes(tmp_path):
    from openpyxl import Workbook

    from doifetch.batch import read_manifest

    path = tmp_path / "list.xlsx"
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["题目", "DOI"])
    sheet.append(["Paper A", "10.1038/s41467-023-44674-1"])
    sheet.append(["重复项", "https://doi.org/10.1038/s41467-023-44674-1"])
    sheet.append(["Paper B", "10.1371/journal.pone.0229668."])
    sheet.append(["没有 DOI 的一行", "只是备注"])
    workbook.save(path)

    rows = read_manifest(path)
    dois = [row.doi for row in rows if row.doi]
    assert dois == ["10.1038/s41467-023-44674-1", "10.1371/journal.pone.0229668"]
    # 表头被跳过，无 DOI 的数据行保留下来提示用户
    assert rows[0].source_row == 2
    assert any(row.status == "no-doi" for row in rows)


def test_clean_doi_strips_trailing_punctuation():
    from doifetch.batch import _clean_doi

    assert _clean_doi("10.1038/x).") == "10.1038/x"
    assert _clean_doi("  10.1/y  ") == "10.1/y"


# --- Zotero client ----------------------------------------------------------


def test_zotero_header_json_stays_ascii():
    """X-Metadata travels in an HTTP header: only ISO-8859-1 is legal there."""
    from doifetch.zotero import _escape_header_json

    header = _escape_header_json({"title": "正文 PDF", "parentItemID": "doifetch-main"})
    assert all(ord(ch) < 0x80 for ch in header)
    assert json.loads(header)["title"] == "正文 PDF"


def test_zotero_creators_split():
    from doifetch.zotero import _creators

    assert _creators(["Yin, Peng"])[0] == {
        "creatorType": "author",
        "lastName": "Yin",
        "firstName": "Peng",
    }
    assert _creators(["Vaswani"])[0]["lastName"] == "Vaswani"
    assert _creators(["Ashish Vaswani"])[0]["firstName"] == "Ashish"
    assert _creators([""]) == []
