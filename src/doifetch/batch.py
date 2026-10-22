"""Batch pipeline: spreadsheet in, papers (and Zotero entries) out.

Design notes worth keeping:

* Batch runs look like crawlers. A per-paper delay plus a stop-loss on repeated
  ``blocked`` results matters more than raw speed — one ACS block can outlive
  the whole run.
* Zotero's connector can only attach files to items created in the same
  session, so an existing DOI cannot receive a new PDF. We detect it first and
  skip, instead of silently creating a duplicate entry.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable

from openpyxl import Workbook, load_workbook

from . import zotero
from .fetch import fetch as run_fetch
from .metadata import DOI_RE
from .models import PdfStatus, Report

Logger = Callable[[str], None]

MAX_ZOTERO_ATTACHMENT_MB = zotero.MAX_ATTACHMENT_MB


def _noop(_: str) -> None:
    return None


@dataclass
class Row:
    source_row: int
    doi: str
    title: str = ""
    status: str = "pending"
    detail: str = ""
    workdir: str = ""
    zotero_state: str = ""


@dataclass
class BatchSummary:
    total: int = 0
    downloaded: int = 0
    skipped: int = 0
    failed: int = 0
    no_doi: int = 0
    zotero_added: int = 0
    zotero_skipped: int = 0
    aborted: str = ""
    report_path: str = ""


def _clean_doi(raw: str) -> str:
    return raw.strip().rstrip(".,;)]}>'\"”“’")


def read_manifest(path: Path) -> list[Row]:
    """Pull every DOI out of an .xlsx, keeping row numbers and a title hint."""
    workbook = load_workbook(filename=str(path), read_only=True, data_only=True)
    rows: list[Row] = []
    seen: set[str] = set()

    for sheet_index, sheet in enumerate(workbook.worksheets):
        for index, cells in enumerate(sheet.iter_rows(values_only=True), start=1):
            dois: list[str] = []
            title_hint = ""

            for cell in cells:
                if not isinstance(cell, str):
                    continue
                text = cell.strip()
                if not text:
                    continue
                found = [_clean_doi(m) for m in DOI_RE.findall(text)]
                if found:
                    dois.extend(found)
                elif not title_hint and len(text) > 8:
                    title_hint = text

            if not dois:
                # 首个工作表的第一行通常是表头，不计入无 DOI 行
                if index == 1 and sheet_index == 0:
                    continue
                rows.append(Row(source_row=index, doi="", title=title_hint, status="no-doi"))
                continue

            for doi in dois:
                key = doi.lower()
                if key in seen:
                    continue
                seen.add(key)
                rows.append(Row(source_row=index, doi=doi, title=title_hint))

    workbook.close()
    return rows


def read_previous_report(path: Path) -> dict[str, str]:
    """doi(lower) -> status, so ``--resume`` can skip finished work."""
    if not path.exists():
        return {}
    workbook = load_workbook(filename=str(path), read_only=True, data_only=True)
    sheet = workbook.worksheets[0]
    result: dict[str, str] = {}
    for index, cells in enumerate(sheet.iter_rows(values_only=True), start=1):
        if index == 1 or not cells:
            continue
        doi = str(cells[1] or "").strip().lower()
        status = str(cells[2] or "").strip()
        if doi:
            result[doi] = status
    workbook.close()
    return result


def write_report(path: Path, rows: Iterable[Row]) -> None:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "结果"
    sheet.append(["源行", "DOI", "状态", "说明", "保存目录", "Zotero"])
    for row in rows:
        sheet.append(
            [row.source_row, row.doi, row.status, row.detail, row.workdir, row.zotero_state]
        )
    for column, width in zip("ABCDEF", (6, 42, 12, 46, 60, 22)):
        sheet.column_dimensions[column].width = width
    path.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(str(path))


def _attachment_files(report: Report) -> list[tuple[str, Path, str, str]]:
    """(title, path, url, mime) for the main PDF plus every SI file on disk."""
    items: list[tuple[str, Path, str, str]] = []
    if report.pdf_path:
        main = Path(report.pdf_path)
        if main.exists():
            items.append(("正文 PDF", main, report.landing_url or "", "application/pdf"))
    for asset in report.si_assets or []:
        path = Path(report.workdir) / asset.filename
        if path.exists():
            mime = asset.content_type or "application/octet-stream"
            items.append((asset.filename, path, asset.url, mime))
    return items


def push_to_zotero(report: Report, *, target: str = "") -> tuple[str, int]:
    """Create the item and hang the downloaded files on it. Returns (state, added)."""
    session_id = "doifetch-" + uuid.uuid4().hex[:12]
    zotero.save_item(report.metadata, session_id, uri=report.landing_url or "")

    if target:
        zotero.move_to_target(session_id, target)

    added = 0
    for title, path, url, mime in _attachment_files(report):
        if path.stat().st_size > MAX_ZOTERO_ATTACHMENT_MB * 1024 * 1024:
            continue
        zotero.save_attachment(
            session_id,
            "doifetch-main",
            path.read_bytes(),
            title=title,
            url=url,
            mime=mime,
        )
        added += 1
    return ("已入库", added)


def run_batch(
    rows: list[Row],
    *,
    out: Path | None = None,
    want_si: bool = True,
    delay: float = 3.0,
    limit: int = 0,
    use_zotero: bool = False,
    zotero_target: str = "",
    resume: dict[str, str] | None = None,
    log: Logger | None = None,
) -> BatchSummary:
    log = log or _noop
    summary = BatchSummary(total=len([r for r in rows if r.doi]))
    resume = resume or {}

    usable = [row for row in rows if row.doi]
    if limit:
        usable = usable[:limit]

    if use_zotero:
        if zotero.ping():
            log(f"  Zotero 已连接（{zotero.version() or '版本未知'}）")
        else:
            log("  Zotero 没有响应，本次不写入 Zotero")
            use_zotero = False

    blocked_streak = 0

    for position, row in enumerate(usable, start=1):
        if resume.get(row.doi.lower()) == "downloaded":
            row.status = "skipped"
            row.detail = "上次已下载"
            summary.skipped += 1
            log(f"[{position}/{len(usable)}] {row.doi}  跳过（上次已完成）")
            continue

        log(f"[{position}/{len(usable)}] {row.doi}")

        try:
            report = run_fetch(
                row.doi,
                out=out,
                want_si=want_si,
                log=lambda message: log("   " + message),
            )
        except Exception as exc:
            row.status = "failed"
            row.detail = f"{type(exc).__name__}: {exc}"
            summary.failed += 1
            log(f"   失败：{row.detail}")
            continue

        row.workdir = report.workdir
        row.detail = report.pdf_source or report.pdf_error

        if report.ok:
            row.status = "downloaded"
            summary.downloaded += 1
        else:
            row.status = "failed"
            summary.failed += 1

        if report.pdf_status == PdfStatus.BLOCKED.value:
            blocked_streak += 1
            if blocked_streak >= 2:
                summary.aborted = "连续两篇被出版商拒绝，已停止（换网络或稍后再跑）"
                log("   " + summary.aborted)
                break
        else:
            blocked_streak = 0

        if use_zotero and report.ok:
            existing = zotero.find_by_doi(report.metadata.doi or row.doi)
            if existing:
                row.zotero_state = "跳过（库中已有）"
                summary.zotero_skipped += 1
                log("   Zotero：库中已有，跳过建档")
            else:
                try:
                    state, added = push_to_zotero(report, target=zotero_target)
                    row.zotero_state = f"{state}（{added} 个附件）"
                    summary.zotero_added += 1
                    log(f"   Zotero：{row.zotero_state}")
                except zotero.ZoteroError as exc:
                    row.zotero_state = f"失败：{exc}"
                    log(f"   Zotero 失败：{exc}")

        if delay and position < len(usable):
            time.sleep(delay)

    summary.no_doi = len([r for r in rows if not r.doi])
    return summary
